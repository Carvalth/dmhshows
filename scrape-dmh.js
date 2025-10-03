// scrape-dmh.js
// De Montfort Hall (What's On) → public/dmh-events.json
// Requires: Playwright (chromium)

import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const ROOT = "https://www.demontforthall.co.uk";
const LISTING_URLS = [
  `${ROOT}/whats-on/`,
  `${ROOT}/whats-on/page/2/`,
  `${ROOT}/whats-on/page/3/`,
  `${ROOT}/whats-on/page/4/`,
  `${ROOT}/whats-on/page/5/`,
  `${ROOT}/whats-on/page/6/`,
  `${ROOT}/whats-on/page/7/`,
  `${ROOT}/whats-on/page/8/`,
];

const OUT_DIR = "./public";
const DEBUG_DIR = path.join(OUT_DIR, "debug");
const OUT_JSON = path.join(OUT_DIR, "dmh-events.json");

// ---------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

function slug(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function statusFromText(raw) {
  const t = (raw || "").toUpperCase().replace(/\s+/g, " ").trim();

  // strong SOLD OUT indicators (venue & Ticketsolve wordings)
  if (/\bSOLD[-\s]*OUT\b/.test(t)) return "SOLD OUT";
  if (/\bNO TICKETS (LEFT|AVAILABLE)\b/.test(t)) return "SOLD OUT";
  if (/\bCURRENTLY NOT ON SALE\b/.test(t)) return "SOLD OUT";
  if (/\bFULLY BOOKED\b/.test(t)) return "SOLD OUT";
  if (/\bUNAVAILABLE\b/.test(t)) return "SOLD OUT";

  // other states we may care about
  if (/\bON SALE SOON\b/.test(t)) return "ON SALE SOON";
  if (/\bLIMITED\b/.test(t)) return "LIMITED";

  if (/\bBOOK\s*NOW\b/.test(t)) return "BOOK NOW";
  return "";
}

function overridePct(status) {
  if (status === "SOLD OUT") return 100;
  if (status === "BOOK NOW") return 48;
  return 30; // unknown / generic
}

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function parseDate(text) {
  // Examples seen on site: "Mon 6 Oct 2025"
  // We'll grab "6 Oct 2025"
  const m = (text || "").match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const mon = m[2].slice(0, 3).toUpperCase();
  const year = parseInt(m[3], 10);
  const monthIdx = MONTHS[mon];
  if (Number.isNaN(day) || Number.isNaN(year) || monthIdx == null) return null;
  return new Date(Date.UTC(year, monthIdx, day));
}

// ---------------- Ticketsolve checker (robust)

async function getTicketsolveStatus(context, url, dbg = { save: false, title: "" }) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Give the page a moment to hydrate
    await sleep(600);

    // 1) scan visible CTA/button/link text
    const ctaText = await page.$$eval("a,button", (els) =>
      els
        .filter((e) => {
          const s = getComputedStyle(e);
          return s && s.display !== "none" && s.visibility !== "hidden";
        })
        .map((e) => (e.innerText || e.textContent || "").trim())
        .join("\n")
    );
    let status = statusFromText(ctaText);
    if (status) return status;

    // 2) fall back to overall visible text
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    status = statusFromText(bodyText);
    if (status) return status;

    // 3) disabled buttons = treat as sold out
    const disabled = await page.$(
      'button[disabled], .btn[disabled], .button[disabled], [aria-disabled="true"]'
    );
    if (disabled) return "SOLD OUT";

    // 4) attributes sometimes carry it
    const attrVals = await page.$$eval(
      "[aria-label],[data-status],[data-availability]",
      (els) =>
        els.map(
          (e) =>
            e.getAttribute("aria-label") ||
            e.getAttribute("data-status") ||
            e.getAttribute("data-availability") ||
            ""
        )
    );
    for (const a of attrVals) {
      const s = statusFromText(a);
      if (s) return s;
    }

    // Debug-dump if we couldn't classify
    if (dbg.save) {
      const html = await page.content();
      const file = path.join(
        DEBUG_DIR,
        `ticketsolve-${slug(dbg.title || url)}.html`
      );
      await fs.promises.writeFile(file, html);
      console.log(`[debug] saved ${file}`);
    }

    // Default if nothing screamed otherwise
    return "BOOK NOW";
  } catch (err) {
    console.warn(`[warn] ticketsolve check failed for ${url}: ${err.message}`);
    return "";
  } finally {
    await page.close();
  }
}

// ---------------- Listing extraction

async function extractFromListing(page, context, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

  // Save the raw listing for debugging
  const listingHtml = await page.content();
  const listingFile = path.join(DEBUG_DIR, `listing-${slug(url)}.html`);
  await fs.promises.writeFile(listingFile, listingHtml).catch(() => {});
  console.log(`[info] ${url} -> listing saved`);

  // The cards appear as <div class="card-event"> ... </div>
  const cards = await page.$$("div.card-event");
  console.log(`[info] ${url} -> ${cards.length} cards`);

  const events = [];

  for (const el of cards) {
    try {
      // Pull the basics inside the browser context
      const card = await el.evaluate((root) => {
        const getText = (sel) =>
          (root.querySelector(sel)?.innerText || "").trim();

        const title =
          (root.querySelector("h3.title a")?.textContent ||
            root.querySelector("h3.title")?.textContent ||
            "").trim();

        const dateText = getText("span.date");

        // CTA anchor (usually Ticketsolve) + all text inside the card
        const cta = root.querySelector('a.cta.cta-primary, a[aria-label*="BOOK"]');
        const ctaHref = cta?.getAttribute("href") || "";
        const cardText = (root.innerText || "").trim();

        return { title, dateText, ctaHref, cardText };
      });

      if (!card.title) continue;

      // Normalize date
      const startDate = parseDate(card.dateText);
      const startISO = startDate ? startDate.toISOString() : null;

      // Initial status from card text
      let status = statusFromText(card.cardText);

      // If the card didn't reveal status and we have a Ticketsolve link,
      // go check the live availability there.
      let absoluteHref = card.ctaHref;
      if (absoluteHref && absoluteHref.startsWith("/")) {
        absoluteHref = `${ROOT}${absoluteHref}`;
      }

      if (!status && absoluteHref && /ticketsolve\.com/i.test(absoluteHref)) {
        status = await getTicketsolveStatus(context, absoluteHref, {
          save: true,
          title: card.title,
        });
      }

      // Final fallback if we have a CTA but still empty
      if (!status && absoluteHref) status = "BOOK NOW";

      events.push({
        title: card.title,
        start: startISO,
        status,
        override_pct: overridePct(status),
      });
    } catch (err) {
      console.warn(`[warn] failed on ${url} card: ${err.message}`);
    }
  }

  return events;
}

// ---------------- main

(async () => {
  ensureDirs();

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    // DMH has a cookie banner; dumping it is enough for our purposes
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });

  const page = await context.newPage();

  const allEvents = [];
  for (const url of LISTING_URLS) {
    try {
      const events = await extractFromListing(page, context, url);
      allEvents.push(...events);
    } catch (err) {
      console.warn(`[warn] listing failed ${url}: ${err.message}`);
    }
  }

  // Basic de-dupe by (title + start)
  const seen = new Set();
  const unique = [];
  for (const e of allEvents) {
    const key = `${e.title}|${e.start || "null"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }

  await fs.promises.writeFile(OUT_JSON, JSON.stringify(unique, null, 2), "utf8");
  console.log(`Wrote ${unique.length} events -> ${OUT_JSON}`);

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
