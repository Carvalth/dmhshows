#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "fs";

const START_URL = "https://www.demontforthall.co.uk/whats-on/";
const MAX_PAGES = 10;

async function extractFromListing(page) {
  const rows = await page.$$eval(
    'article, li, .card, .event, .grid-item, .content, .col',
    (cards) => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      function statusFromText(txt = "") {
        const s = txt.toLowerCase();
        if (s.includes("sold out")) return "SOLD OUT";
        if (/very\s*limited|limited|last\s*(few|remaining)|almost\s*sold|low\s*availability/.test(s)) return "LIMITED";
        if (s.includes("selling fast") || s.includes("best availability")) return "SELLING FAST";
        if (s.includes("book now") || s.includes("on sale") || s.includes("available")) return "BOOK NOW";
        return "";
      }

      return cards
        .map((card) => {
          const title =
            clean(
              card.querySelector("h2,h3,h4,.event-title,.card-title")?.textContent
            ) ||
            clean(
              card.querySelector('a[href*="/event/"],a[href*="/events/"]')
                ?.textContent
            );
          if (!title || /^more info$/i.test(title)) return null;

          const dateText =
            clean(
              card.querySelector(
                "time,.date,.event-date,.when,[class*='date']"
              )?.textContent
            ) || "";

          const full = clean(card.innerText || "");
          let status = statusFromText(full);

          // Also check any button/anchor inside the card specifically
          if (!status) {
            const btn = clean(
              card.querySelector(
                "a,button,.buy-btn,.cta,[class*='book']"
              )?.textContent
            );
            if (btn) status = statusFromText(btn);
          }

          return { title, dateText, status };
        })
        .filter(Boolean);
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
    })(),
  }));
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const events = [];

  for (let i = 1; i <= MAX_PAGES; i++) {
    const url = i === 1 ? START_URL : `${START_URL}page/${i}/`;
    console.log(`[info] ${url}`);
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(1000); // small extra wait so text swaps in
      const items = await extractFromListing(page);
      console.log(`   -> ${items.length} cards`);
      if (!items.length && i > 1) break;
      events.push(...items);
    } catch (err) {
      console.warn(`[warn] failed on ${url}`, err.message);
    }
  }

  await browser.close();

  if (!fs.existsSync("./public")) fs.mkdirSync("./public", { recursive: true });
  fs.writeFileSync("./public/dmh-events.json", JSON.stringify(events, null, 2));
  console.log(`Wrote ${events.length} events -> public/dmh-events.json`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

