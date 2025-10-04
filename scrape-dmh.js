// npm run scrape
// Writes: public/dmh-events.json

import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const OUT_PATH = path.join(ROOT, "public", "dmh-events.json");
const LIST_URL = "https://www.demontforthall.co.uk/whats-on/";
const MAX_PAGES = 12;

/* ---------------- helpers ---------------- */

function fallbackPct(statusText = "") {
  const s = statusText.toLowerCase();
  if (s.includes("sold")) return 100;
  if (s.includes("limited")) return 85;
  if (s.includes("last") || s.includes("low")) return 75;
  if (s.includes("book now")) return 48;
  return 30;
}

async function sleep(ms = 500) {
  await new Promise(r => setTimeout(r, ms));
}

/* Parse "Friday 3 October 2025, 19:30" -> ISO */
function parseUkDateTimeToISO(input) {
  if (!input) return null;
  const str = input.replace(/\s+/g, " ").trim();

  // Fri 3 Oct 2025, 19:30  OR  Friday 03 October 2025, 7:30 PM
  const re =
    /(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i;

  const m = str.match(re);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const monName = m[2].toLowerCase();
  const year = parseInt(m[3], 10);
  let hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const ampm = (m[6] || "").toUpperCase();

  const months = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const month = months[monName];
  if (month == null) return null;

  if (ampm) {
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
  }

  // Treat as Europe/London local then output ISO in UTC
  // Using a naive approach is fine for our use-case.
  const dt = new Date(Date.UTC(year, month, day, hour, minute, 0));
  return dt.toISOString();
}

async function getStartISOFromTicketsolve(page) {
  // 1) JSON-LD
  const ld = await page.$$eval('script[type="application/ld+json"]', nodes =>
    nodes.map(n => n.textContent || "")
  );
  for (const txt of ld) {
    try {
      const obj = JSON.parse(txt);
      const arr = Array.isArray(obj) ? obj : [obj];
      for (const j of arr) {
        if (j["@type"] === "Event" && j.startDate) {
          return new Date(j.startDate).toISOString();
        }
        if (j.event && j.event.startDate) {
          return new Date(j.event.startDate).toISOString();
        }
      }
    } catch {}
  }

  // 2) Visible header text like: "Friday 3 October 2025, 19:30"
  const headerTxt = await page
    .$eval("body", el => el.innerText || "")
    .catch(() => "");
  const iso = parseUkDateTimeToISO(headerTxt);
  if (iso) return iso;

  // 3) Meta tags sometimes include date/time
  const metas = await page.$$eval("meta", els =>
    els.map(e => [e.getAttribute("property") || e.getAttribute("name"), e.getAttribute("content")])
  );
  for (const [k, v] of metas) {
    if (!v) continue;
    const guess = parseUkDateTimeToISO(v);
    if (guess) return guess;
    // Some installations put ISO already
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
      try { return new Date(v).toISOString(); } catch {}
    }
  }

  return null;
}

async function computePctSoldFromTicketsolve(page) {
  // Seat map only appears after a zone is selected on some installs
  try {
    const zoneBtn = await page.$('button:has-text("Select a zone"), [role="button"]:has-text("Select a zone"), button:has-text("Stalls and Circles")');
    if (zoneBtn) {
      await zoneBtn.click();
      const prefer = await page.$('text="Stalls and Circles"');
      if (prefer) await prefer.click();
      else {
        const first = await page.$('[role="listbox"] [role="option"], .select__menu [role="option"]');
        if (first) await first.click();
      }
      await sleep(700);
    }
  } catch {}

  const { available, unavailable } = await page.evaluate(() => {
    const q = s => Array.from(document.querySelectorAll(s));
    let available = 0, unavailable = 0;

    const byAttr = q("[data-seat-status]");
    for (const el of byAttr) {
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

/* ---------------- list page ---------------- */

async function scrapeListPage(page, pageNo) {
  const url = pageNo === 1 ? LIST_URL : `${LIST_URL}?_paged=${pageNo}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const cards = await page.$$(
    ".card-event, [class*='card-event'], article:has(a:has-text('BOOK NOW')), article:has(.cta)"
  );

  const rows = [];
  for (const card of cards) {
    const title =
      (await card.$eval(".title, h3, h2", el => el.textContent?.trim()).catch(() => null)) ||
      (await card.$eval("a[href*='/event/']", el => el.textContent?.trim()).catch(() => null));
    if (!title) continue;

    const primary =
      (await card.$("a.cta.cta-primary")) ||
      (await card.$("a:has-text('BOOK NOW')")) ||
      (await card.$("a:has-text('SOLD OUT')")) ||
      (await card.$("a[href*='ticketsolve']"));

    let status = "More info";
    let bookHref = null;
    if (primary) {
      status = (await primary.textContent())?.trim() || status;
      bookHref = await primary.getAttribute("href");
    }

    rows.push({ title, status, bookHref });
  }
  return rows;
}

/* ---------------- main ---------------- */

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const all = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const batch = await scrapeListPage(page, p);
    if (!batch.length) break;
    all.push(...batch);
  }

  const out = [];
  for (const r of all) {
    let startISO = null;
    let pct = null;

    if (r.bookHref) {
      try {
        const href = r.bookHref.startsWith("http")
          ? r.bookHref
          : new URL(r.bookHref, "https://demontforthall.ticketsolve.com").toString();

        await page.goto(href, { waitUntil: "domcontentloaded" });

        // Get start (robust)
        startISO = await getStartISOFromTicketsolve(page);

        // Quick SOLD OUT check
        const soldBadge = await page.$(":is(button, a, span):has-text('SOLD OUT')");
        if (soldBadge) pct = 100;

        // Seat map % sold if not already known
        if (pct === null) pct = await computePctSoldFromTicketsolve(page);
      } catch {
        // fallbacks apply below
      }
    }

    const override_pct = Number.isFinite(pct) ? pct : fallbackPct(r.status);

    out.push({
      title: r.title,
      start: startISO,       // <-- no longer null in normal cases
      status: r.status,
      override_pct
    });
  }

  // Dedup by title+start (start can still be null on some rare pages)
  const seen = new Set();
  const unique = out.filter(ev => {
    const key = `${ev.title}__${ev.start || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(unique, null, 2));
  console.log(`Wrote ${unique.length} events -> ${OUT_PATH}`);

  await browser.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
