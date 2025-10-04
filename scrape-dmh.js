// Scrape De Montfort Hall -> public/dmh-events.json
// node scripts/scrape-dmh.mjs

import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "public", "dmh-events.json");
const LIST_URL = "https://www.demontforthall.co.uk/whats-on/";
const MAX_PAGES = 12;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/* ---------- utils ---------- */

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function pad2(n){ return String(n).padStart(2, "0"); }

function asISOFromLocal(y, m0, d, hh = 19, mm = 30) {
  // treat as Europe/London local, export ISO UTC
  const iso = new Date(Date.UTC(y, m0, d, hh, mm, 0)).toISOString();
  return iso;
}

function fallbackPct(status = "") {
  const s = String(status).toLowerCase();
  if (s.includes("sold")) return 100;
  if (s.includes("limited")) return 85;
  if (s.includes("last") || s.includes("low")) return 75;
  if (s.includes("book now")) return 48;
  return 30;
}

async function delay(ms = 350) { await new Promise(r => setTimeout(r, ms)); }

/* ---------- date parsing ---------- */

// e.g. "Friday 3 October 2025, 19:30" or "Fri 3 Oct 2025, 7:30 PM"
function parseLongUkDateTime(txt) {
  if (!txt) return null;
  const t = txt.replace(/\s+/g, " ").trim();

  const re1 =
    /(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i;
  const m = t.match(re1);
  if (!m) return null;

  const day = +m[1];
  const monName = m[2].toLowerCase();
  const year = +m[3];
  let hour = +m[4];
  const minute = +m[5];
  const ampm = (m[6] || "").toUpperCase();

  const month = MONTHS[monName];
  if (month == null) return null;

  if (ampm) {
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
  }
  return asISOFromLocal(year, month, day, hour, minute);
}

// e.g. the card date: "FRI 24 OCT 2025" or "MON 6 OCT 2025"
function parseCardDateOnly(txt) {
  if (!txt) return null;
  const t = txt.replace(/\s+/g, " ").trim();
  const m = t.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i);
  if (!m) return null;

  const day = +m[1];
  const monName = m[2].toLowerCase();
  const year = +m[3];
  const month = MONTHS[monName];
  if (month == null) return null;

  // default time 19:30 if only date is available
  return asISOFromLocal(year, month, day, 19, 30);
}

/* ---------- ticketsolve ---------- */

async function getStartFromTicketsolve(page) {
  // 1) JSON-LD
  try {
    const blocks = await page.$$eval('script[type="application/ld+json"]', ns => ns.map(n => n.textContent || ""));
    for (const b of blocks) {
      try {
        const j = JSON.parse(b);
        const arr = Array.isArray(j) ? j : [j];
        for (const o of arr) {
          if (o?.["@type"] === "Event" && o.startDate) return new Date(o.startDate).toISOString();
          if (o?.event?.startDate) return new Date(o.event.startDate).toISOString();
        }
      } catch {}
    }
  } catch {}

  // 2) Visible long date line
  try {
    const text = await page.$eval("body", el => el.innerText || "");
    const iso = parseLongUkDateTime(text);
    if (iso) return iso;
  } catch {}

  // 3) Meta content hints
  try {
    const metas = await page.$$eval("meta", els =>
      els.map(e => [e.getAttribute("property") || e.getAttribute("name"), e.getAttribute("content")])
    );
    for (const [, v] of metas) {
      if (!v) continue;
      const byLong = parseLongUkDateTime(v);
      if (byLong) return byLong;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
        try { return new Date(v).toISOString(); } catch {}
      }
    }
  } catch {}

  return null;
}

async function percentSoldFromTicketsolve(page) {
  // If possible, pick a common "Stalls and Circles" option to render the seat-map
  try {
    const trigger =
      (await page.$('button:has-text("Select a zone")')) ||
      (await page.$('[role="button"]:has-text("Select a zone")')) ||
      (await page.$('button:has-text("Stalls and Circles")'));
    if (trigger) {
      await trigger.click();
      const prefer = await page.$('text="Stalls and Circles"');
      if (prefer) await prefer.click();
      else {
        const first = await page.$('[role="listbox"] [role="option"], .select__menu [role="option"]');
        if (first) await first.click();
      }
      await delay(700);
    }
  } catch {}

  const { available, unavailable } = await page.evaluate(() => {
    const q = s => Array.from(document.querySelectorAll(s));
    let available = 0, unavailable = 0;

    const attr = q("[data-seat-status]");
    for (const el of attr) {
      const st = (el.getAttribute("data-seat-status") || "").toLowerCase();
      if (st.includes("available")) available++;
      else if (st.includes("unavailable") || st.includes("in_cart") || st.includes("reserved") || st.includes("held")) {
        unavailable++;
      }
    }
    if (available + unavailable === 0) {
      const av = q(".seat--available, .seat.available, [class*='seat'][class*='available']");
      const un = q(".seat--unavailable, .seat.unavailable, .seat.in-cart, .seat.selected, [class*='seat'][class*='unavailable']");
      available = av.length; unavailable = un.length;
    }
    if (available + unavailable === 0) {
      const aria = q("[aria-label]");
      for (const el of aria) {
        const lab = (el.getAttribute("aria-label") || "").toLowerCase();
        if (lab.includes("available")) available++;
        else if (lab.includes("unavailable") || lab.includes("in cart") || lab.includes("reserved")) unavailable++;
      }
    }
    return { available, unavailable };
  });

  const total = available + unavailable;
  if (!total) return null;
  return Math.round((unavailable / total) * 100);
}

/* ---------- DMH pages ---------- */

function normaliseUrl(href, base) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

async function scrapeListCards(page, pageNo) {
  const url = pageNo === 1 ? LIST_URL : `${LIST_URL}?_paged=${pageNo}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  return await page.$$eval("body", (body) => {
    const out = [];
    const cards = body.querySelectorAll(".card-event, [class*='card-event'], article");
    for (const card of cards) {
      // title
      let title =
        card.querySelector(".title")?.textContent?.trim() ||
        card.querySelector("h3, h2")?.textContent?.trim();
      if (!title) {
        const a = card.querySelector("a[href*='/event/']");
        title = a?.textContent?.trim() || null;
      }
      if (!title) continue;

      // date label on the card (e.g. "FRI 24 OCT 2025")
      const dateTxt =
        card.querySelector(".date")?.textContent?.trim() ||
        card.querySelector("[class*='date']")?.textContent?.trim() ||
        null;

      // links
      const bookA =
        card.querySelector("a.cta.cta-primary") ||
        card.querySelector("a[href*='ticketsolve']") ||
        card.querySelector("a:has(> span:contains('BOOK NOW'))");

      const infoA =
        card.querySelector("a.cta.cta-secondary") ||
        card.querySelector("a[href*='/event/']");

      const status = (bookA?.textContent || infoA?.textContent || "More info").trim();

      out.push({
        title,
        dateTxt,
        bookHref: bookA?.getAttribute("href") || null,
        infoHref: infoA?.getAttribute("href") || null,
        status
      });
    }
    return out;
  });
}

async function getStartFromDmhInfo(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const text = await page.$eval("body", el => el.innerText || "");
    const iso = parseLongUkDateTime(text);
    if (iso) return iso;

    // sometimes date & time are split; make a second attempt
    // common pattern: "Fri 24 Oct 2025" … "7:30 pm"
    const d = text.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}/i);
    const t = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (d && t) {
      const isoFromCombined = parseLongUkDateTime(`${d[0]}, ${t[0]}`);
      if (isoFromCombined) return isoFromCombined;
    }
  } catch {}
  return null;
}

/* ---------- runner ---------- */

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const collected = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const rows = await scrapeListCards(page, p);
    if (!rows.length) break;
    collected.push(...rows);
  }

  const results = [];
  for (const row of collected) {
    let startISO = null;
    let pct = null;

    const bookUrl = row.bookHref ? normaliseUrl(row.bookHref, "https://demontforthall.co.uk/") : null;
    const infoUrl = row.infoHref ? normaliseUrl(row.infoHref, "https://www.demontforthall.co.uk/") : null;

    // 1) Ticketsolve (best)
    if (bookUrl) {
      try {
        await page.goto(bookUrl, { waitUntil: "domcontentloaded" });

        // Get start
        startISO = await getStartFromTicketsolve(page);

        // Quick sold out badge on ticketsolve
        const soldBadge = await page.$(":is(button, a, span):has-text('SOLD OUT')");
        if (soldBadge) pct = 100;

        // Seat map percentage (if available)
        if (pct == null) pct = await percentSoldFromTicketsolve(page);
      } catch {}
    }

    // 2) DMH info page (fallback for start date)
    if (!startISO && infoUrl) {
      startISO = await getStartFromDmhInfo(page, infoUrl);
    }

    // 3) Card date only (ultimate fallback, default time 19:30)
    if (!startISO && row.dateTxt) {
      startISO = parseCardDateOnly(row.dateTxt);
    }

    const override_pct = Number.isFinite(pct) ? pct : fallbackPct(row.status);

    results.push({
      title: row.title,
      start: startISO,             // should now be non-null in the vast majority of cases
      status: row.status,
      override_pct
    });

    await delay(200);
  }

  // Deduplicate by title+start
  const seen = new Set();
  const unique = results.filter(e => {
    const key = `${e.title}__${e.start || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(unique, null, 2));
  console.log(`Wrote ${unique.length} events → ${OUT}`);

  await browser.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
