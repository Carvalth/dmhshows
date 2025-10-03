#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "fs";

const START_URL = "https://www.demontforthall.co.uk/whats-on/";
const MAX_PAGES = 10; // change if they ever add more

async function extractFromListing(page) {
  // Scroll a bit to trigger lazy loading
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(250);
  }

  const rows = await page.$$eval(
    'a[href*="/event/"], a[href*="/events/"]',
    (as) => {
      // ---- Everything below runs IN THE BROWSER ----
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

      function statusFromText(txt = "") {
        const s = txt.toLowerCase();
        if (s.includes("sold out")) return "SOLD OUT";
        if (/very\s*limited|limited|last\s*(few|remaining)|almost\s*sold|low\s*availability/.test(s)) return "LIMITED";
        if (s.includes("selling fast") || s.includes("best availability")) return "SELLING FAST";
        if (s.includes("book now") || s.includes("on sale") || s.includes("available")) return "BOOK NOW";
        return "";
      }

      const junkAnchor = (a) => {
        const t = (a.textContent || "").trim();
        const titleAttr = (a.getAttribute("title") || "").trim();
        return /^more info$/i.test(t) || /^more info about /i.test(titleAttr);
      };

      const cards = new Set();
      for (const a of as) {
        if (junkAnchor(a)) continue;
        const card =
          a.closest("article, li, .card, .event, .grid-item, .content, .col") ||
          a.parentElement;
        if (card) cards.add(card);
      }

      const results = [];
      cards.forEach((card) => {
        const pick = (sel) =>
          (card.querySelector(sel)?.textContent || "").replace(/\s+/g, " ").trim();

        let title =
          pick("h2, h3, h4, .event-title, .card-title") ||
          (card.querySelector('a[href*="/event/"], a[href*="/events/"]')
            ?.textContent || "");

        title = clean(title);
        if (!title || /^more info$/i.test(title)) return;

        const dateText = pick("time, .date, .event-date, .when, [class*='date']");

        // Look at full text for status
        const full = clean(card.innerText || "");
        let status = statusFromText(full);
        if (!status) {
          const badge = pick(".availability, .status, .badge, [class*='availability'], .label, .pill");
          status = statusFromText(badge);
        }

        results.push({ title, dateText, status });
      });

      const seen = new Set();
      return results.filter((r) => {
        const key = `${r.title}|${r.dateText}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  );

  return rows.map((r) => ({
    title: r.title,
    start: (() => {
      const t = (r.dateText || "").trim();
      if (!t) return null;
      if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t;
      const d = Date.parse(t);
      return Number.isFinite(d) ? new Date(d).toISOString() : null;
    })(),
    status: r.status,
    override_pct: (() => {
      const s = (r.status || "").toLowerCase();
      if (s === "sold out") return 100;
      if (s === "limited") return 92;
      if (s === "selling fast") return 70;
      if (s === "book now") return 48;
      return 30;
    })()
  }));
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const allEvents = [];

  for (let i = 1; i <= MAX_PAGES; i++) {
    const url = i === 1 ? START_URL : `${START_URL}page/${i}/`;
    console.log(`[info] ${url}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const events = await extractFromListing(page);
      console.log(`   -> ${events.length} cards`);
      if (!events.length && i > 1) break; // stop if no more events on deeper pages
      allEvents.push(...events);
    } catch (err) {
      console.warn(`[warn] failed on ${url}`, err.message);
    }
  }

  await browser.close();

  const outDir = "./public";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(
    `${outDir}/dmh-events.json`,
    JSON.stringify(allEvents, null, 2)
  );
  console.log(`Wrote ${allEvents.length} events -> ${outDir}/dmh-events.json`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
