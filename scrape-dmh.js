// npm run scrape
// Writes: public/dmh-events.json

import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const OUT_PATH = path.join(ROOT, "public", "dmh-events.json");
const LIST_URL = "https://www.demontforthall.co.uk/whats-on/";
const MAX_PAGES = 12;

/* ---------- helpers ---------- */

function fallbackPct(statusText = "") {
  const s = statusText.toLowerCase();
  if (s.includes("sold")) return 100;
  if (s.includes("limited")) return 85;
  if (s.includes("last") || s.includes("low")) return 75;
  if (s.includes("book now")) return 48;
  return 30;
}

async function waitLittle(page, ms = 600) {
  await page.waitForTimeout(ms);
}

async function parseJsonLdEventStart(page) {
  // Ticketsolve pages usually include JSON-LD with "startDate"
  const jsons = await page.$$eval('script[type="application/ld+json"]', nodes =>
    nodes.map(n => n.textContent || "")
  );
  for (const txt of jsons) {
    try {
      const obj = JSON.parse(txt);
      const maybe = Array.isArray(obj) ? obj : [obj];
      for (const j of maybe) {
        if (j["@type"] === "Event" && j.startDate) return new Date(j.startDate).toISOString();
        if (j.event && j.event.startDate) return new Date(j.event.startDate).toISOString();
      }
    } catch {}
  }
  return null;
}

// Try to count seats on the Ticketsolve seat map
async function computePctSoldFromTicketsolve(page) {
  // Pick a “complete” zone if there is a zone picker.
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
    }
  } catch {}
  await waitLittle(page);

  // Count a variety of seat markups used by Ticketsolve skins
  const { available, unavailable } = await page.evaluate(() => {
    const qAll = s => Array.from(document.querySelectorAll(s));
    let available = 0, unavailable = 0;

    // 1) data-seat-status attr
    const byAttr = qAll("[data-seat-status]");
    for (const el of byAttr) {
      const st = (el.getAttribute("data-seat-status") || "").toLowerCase();
      if (st.includes("available")) available++;
      else if (st.includes("unavailable") || st.includes("in_cart") || st.includes("reserved") || st.includes("held")) {
        unavailable++;
      }
    }

    // 2) class patterns
    if (available + unavailable === 0) {
      const av = qAll(".seat--available, .seat.available, .available.seat, [class*='seat'][class*='available']");
      const un = qAll(".seat--unavailable, .seat.unavailable, .unavailable.seat, .seat.in-cart, .seat.selected, [class*='seat'][class*='unavailable']");
      available = av.length;
      unavailable = un.length;
    }

    // 3) aria label fallback
    if (available + unavailable === 0) {
      const aria = qAll("[aria-label]");
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

/* ---------- list page scraping ---------- */

async function scrapeListPage(page, pageNo) {
  const url = pageNo === 1 ? LIST_URL : `${LIST_URL}?_paged=${pageNo}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // A card always has a "BOOK NOW" or "SOLD OUT" button and a title block.
  const cards = await page.$$(
    ".card-event, [class*='card-event'], article:has(a:has-text('BOOK NOW')), article:has(.cta)"
  );

  const rows = [];
  for (const card of cards) {
    const title =
      (await card.$eval(".title, h3, h2", el => el.textContent?.trim()).catch(() => null)) ||
      (await card.$eval("a[href*='/event/']", el => el.textContent?.trim()).catch(() => null));
    if (!title) continue;

    const dateText = await card.$eval(".date", el => el.textContent?.trim()).catch(() => null);

    // IMPORTANT: take PRIMARY action first (BOOK NOW/SOLD OUT), not "More info"
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

    rows.push({ title, dateText, status, bookHref });
  }
  return rows;
}

/* ---------- main ---------- */

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

        // 1) precise start datetime via JSON-LD
        startISO = await parseJsonLdEventStart(page);

        // 2) SOLD OUT on the tickets page => 100% (quick win)
        const soldBadge = await page.$(":is(button, a, span):has-text('SOLD OUT')");
        if (soldBadge) pct = 100;

        // 3) seat map % sold
        if (pct === null) pct = await computePctSoldFromTicketsolve(page);
      } catch (e) {
        // ignore and fall back
      }
    }

    const override_pct = Number.isFinite(pct) ? pct : fallbackPct(r.status);

    out.push({
      title: r.title,
      start: startISO || null, // we prefer Ticketsolve time; list page date is often missing time
      status: r.status,
      override_pct
    });
  }

  // Filter dupes (title + start)
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

