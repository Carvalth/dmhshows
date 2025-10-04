// scrape-dmh.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { chromium } from 'playwright';

dayjs.extend(utc);
dayjs.extend(tz);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTFILE = path.join(ROOT, 'public', 'dmh-events.json');

// ---------- utils ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const trim = (s) => (s || '').replace(/\s+/g, ' ').trim();

function inferOverridePct(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('sold')) return 100;
  if (s.includes('limited')) return 85;
  if (s.includes('last') || s.includes('low')) return 75;
  if (s.includes('book')) return 48;
  return 30; // more info / unknown
}

function toISOLondon(dateText) {
  // expects text like "Friday 3 October 2025, 19:30"
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}).*?(\d{1,2}):(\d{2})/i.exec(dateText || '');
  if (!m) return null;
  const [, d, monthStr, y, hh, mm] = m;
  const dt = dayjs.tz(`${d} ${monthStr} ${y} ${hh}:${mm}`, 'D MMMM YYYY HH:mm', 'Europe/London');
  return dt.isValid() ? dt.toDate().toISOString() : null;
}

// Prefer SOLD OUT > BOOK NOW > MORE INFO
function pickStatusFromButtons(btnTexts) {
  const upper = btnTexts.map(t => t.toUpperCase());
  if (upper.some(t => t.includes('SOLD OUT'))) return 'SOLD OUT';
  if (upper.some(t => t.includes('BOOK'))) return 'BOOK NOW';
  return 'More info';
}

// ---------- ticketsolve helpers ----------

async function openSeatMapAndMeasure(page, eventUrl) {
  // open the ticketsolve seat page (already a /seats or /events URL)
  await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Grab the human-readable date/time block
  let startIso = null;
  try {
    const whenText = await page.locator('text=,').first().innerText().catch(() => null);
    // The line with comma usually is "Friday 3 October 2025, 19:30"
    if (whenText) {
      const iso = toISOLondon(whenText);
      if (iso) startIso = iso;
    }
  } catch (_) {}

  // Select a zone if needed
  try {
    // Ticketsolve pages vary: sometimes there is a <select>, sometimes a button menu.
    const select = page.locator('select').first();
    if (await select.count()) {
      const options = await select.evaluateAll(els => els[0] ? Array.from(els[0].options).map(o => o.textContent) : []);
      let valueToPick = null;
      if (options.some(t => /stalls.*circles/i.test(t))) {
        valueToPick = (await select.locator('option', { hasText: /stalls.*circles/i }).first().getAttribute('value'));
      } else {
        // choose first non-empty option
        valueToPick = await select.locator('option:not([disabled])').nth(0).getAttribute('value');
      }
      if (valueToPick) {
        await select.selectOption(valueToPick);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{});
      }
    } else {
      const zoneBtn = page.locator('button:has-text("Select a zone"), [role="combobox"]').first();
      if (await zoneBtn.count()) {
        await zoneBtn.click().catch(()=>{});
        const option =
          page.locator('[role="option"] :text("Stalls and Circles")').first()
            .or(page.locator('[role="option"]', { hasText: /Stalls.*Circles/i }).first())
            .or(page.locator('[role="option"]').first());
        if (await option.count()) {
          await option.click().catch(()=>{});
          await page.keyboard.press('Escape').catch(()=>{});
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{});
        }
      }
    }
  } catch (_) {}

  // wait a tick for seatmap to render
  await sleep(800);

  // Try to count seats
  const counts = await page.evaluate(() => {
    const out = { available: 0, unavailable: 0, total: 0 };

    // Collect likely seat nodes inside svg/canvas areas
    const nodes = Array.from(document.querySelectorAll('svg circle, svg path, [data-seat-id], [data-status]'));
    if (!nodes.length) return out;

    for (const el of nodes) {
      // common attributes we can read
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const status = (el.getAttribute('data-status') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      const cls = (el.getAttribute('class') || '').toLowerCase();

      const markUnavailable =
        aria.includes('unavailable') || aria.includes('not available') ||
        status.includes('unavailable') || status.includes('sold') ||
        cls.includes('unavailable') || title.includes('unavailable');

      const markAvailable =
        aria.includes('available') || status.includes('available') || cls.includes('available') || title.includes('available');

      if (markUnavailable) out.unavailable++;
      else if (markAvailable) out.available++;
    }

    out.total = out.available + out.unavailable;
    return out;
  }).catch(() => ({ available: 0, unavailable: 0, total: 0 }));

  if (counts.total > 0) {
    const pct = Math.round((counts.unavailable / counts.total) * 100);
    return { sold_pct: pct, start: startIso };
  }

  return { sold_pct: null, start: startIso };
}

async function followToTicketsolveAndMeasure(browser, card) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // If we already have a direct book link, use it
    if (card.bookUrl) {
      return await openSeatMapAndMeasure(page, card.bookUrl);
    }

    // Otherwise open the event page, then click its Book Now
    if (card.moreInfoUrl) {
      await page.goto(card.moreInfoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const bookLink = page.locator('a:has-text("BOOK NOW")').first();
      if (await bookLink.count()) {
        const href = await bookLink.getAttribute('href');
        if (href) {
          const absolute = href.startsWith('http') ? href : new URL(href, page.url()).href;
          return await openSeatMapAndMeasure(page, absolute);
        }
      }
    }
  } catch (_) {
    // ignore measurement failure
  } finally {
    await context.close();
  }
  return { sold_pct: null, start: null };
}

// ---------- scraping cards ----------

async function scrapeListCards(pageUrl, page) {
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const cards = await page.$$eval('[class*="card"], article, .whats-on__item, .event', nodes => {
    const items = [];
    for (const el of nodes) {
      // Filter to only true event cards (must have a visible date block and a title)
      const dateEl = el.querySelector(':scope :is(time, .date, [class*="date"])');
      const titleEl = el.querySelector(':scope a, :scope h3, :scope h2');
      if (!titleEl) continue;

      const title = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title) continue;

      // Buttons / links inside card
      const links = Array.from(el.querySelectorAll('a'));
      const btnTexts = links.map(a => (a.textContent || '').replace(/\s+/g, ' ').trim());

      // URLs
      let bookUrl = null;
      let moreInfoUrl = null;
      for (const a of links) {
        const t = (a.textContent || '').toUpperCase();
        const href = a.getAttribute('href') || '';
        if (t.includes('BOOK') || t.includes('SOLD')) {
          bookUrl = href;
        } else if (!moreInfoUrl && t.includes('MORE')) {
          moreInfoUrl = href;
        }
        if (bookUrl && moreInfoUrl) break;
      }

      items.push({
        title,
        status: 'More info',         // placeholder, fix below
        btnTexts,
        bookUrl,
        moreInfoUrl,
        dateText: dateEl ? dateEl.textContent : null,
      });
    }
    return items;
  });

  // Normalise URLs/status
  for (const c of cards) {
    c.status = pickStatusFromButtons(c.btnTexts || []);
    // absolute URLs
    if (c.bookUrl && !/^https?:\/\//i.test(c.bookUrl)) {
      c.bookUrl = new URL(c.bookUrl, pageUrl).href;
    }
    if (c.moreInfoUrl && !/^https?:\/\//i.test(c.moreInfoUrl)) {
      c.moreInfoUrl = new URL(c.moreInfoUrl, pageUrl).href;
    }
  }

  return cards;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const base = 'https://www.demontforthall.co.uk/whats-on/';
  let current = 1;
  const all = [];

  while (true) {
    const url = current === 1 ? base : `${base}?page=${current}`;
    const cards = await scrapeListCards(url, page);
    // stop if a page returns no cards
    if (!cards.length) break;

    // measure each card
    for (const card of cards) {
      let start = null;
      let sold_pct = null;

      if (card.status === 'SOLD OUT' || card.status === 'BOOK NOW') {
        // Try to measure on Ticketsolve
        try {
          const res = await followToTicketsolveAndMeasure(browser, card);
          if (res.start) start = res.start;
          if (Number.isFinite(res.sold_pct)) sold_pct = res.sold_pct;
        } catch (_) {}
      }

      // Fallbacks
      if (!start && card.dateText) {
        // date on card might not have time; leave null if we can’t parse time
        // We’ll keep day-only ISO if possible at 00:00Z; UI will still place it on calendar day.
        const cardDate = dayjs(card.dateText.replace(/[,\.]/g,' '), 'ddd D MMM YYYY', 'en', true);
        if (cardDate.isValid()) start = cardDate.toDate().toISOString();
      }

      const status = card.status;
      const override_pct = Number.isFinite(sold_pct) ? undefined : inferOverridePct(status);

      all.push({
        title: card.title,
        start: start || null,
        status,
        ...(Number.isFinite(sold_pct) ? { sold_pct } : { override_pct }),
      });
    }

    current += 1;
    // be polite between pages
    await sleep(400);
  }

  await browser.close();

  // Write out
  await fs.mkdir(path.dirname(OUTFILE), { recursive: true });
  // Sort by start (nulls last)
  all.sort((a, b) => {
    const da = a.start ? +new Date(a.start) : Infinity;
    const db = b.start ? +new Date(b.start) : Infinity;
    return da - db;
  });

  await fs.writeFile(OUTFILE, JSON.stringify(all, null, 2), 'utf8');
  console.log(`Wrote ${all.length} events → ${OUTFILE}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
