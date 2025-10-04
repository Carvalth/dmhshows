// scrape-dmh.js (ESM)
// Scrapes De Montfort Hall "What's On", follows each BOOK NOW link to Ticketsolve,
// opens the seat map zone, counts seats and computes sold_pct.
// Writes JSON to public/dmh-events.json

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT = 'https://www.demontforthall.co.uk/whats-on/';
const OUTPUT = path.join('public', 'dmh-events.json');

// ---- Helpers ---------------------------------------------------------------

function statusHeuristicToPct(statusText) {
  const s = (statusText || '').toLowerCase();
  if (s.includes('sold')) return 100;
  if (s.includes('limited')) return 85;
  if (s.includes('last') || s.includes('low')) return 75;
  if (s.includes('book')) return 48;
  return 30;
}

function parseDateFromCardText(txt) {
  // examples on cards: "FRI 17 OCT 2025" 
  // We try to feed it straight to Date; if it fails we leave start null
  try {
    // Add a time to avoid TZ midnight shifts
    const d = new Date(`${txt} 20:00`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

async function paginateCards(page) {
  const all = [];
  while (true) {
    // wait cards
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.card-event, .card', { timeout: 15000 }).catch(()=>{});

    const cards = await page.$$eval('.card-event, .card', nodes => {
      const items = [];
      for (const n of nodes) {
        const title = (n.querySelector('h3, .title, .card .title')?.textContent || '').trim();
        const date = (n.querySelector('.date')?.textContent || '').trim();
        const statusBtn = n.querySelector('a.cta.cta-primary, a[aria-label*="BOOK"], a.cta-primary');
        const moreInfo = n.querySelector('a[href*="/event/"], a[href*="/events/"], a[href*="/event/"]');
        // Prefer the explicit BOOK NOW button; fallback to "more info"
        const bookHref = statusBtn?.getAttribute('href') || moreInfo?.getAttribute('href') || '';
        const btnText = (statusBtn?.textContent || '').trim().toUpperCase();
        items.push({ title, date, bookHref, btnText });
      }
      return items.filter(i => i.title && i.bookHref);
    });

    all.push(...cards);

    // next page?
    const next = await page.$('a.page-numbers.next, a[rel="next"], .pagination a[aria-label="Next"]');
    if (!next) break;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      next.click()
    ]);
  }
  return all;
}

// Try to normalize a DMH relative URL to absolute
function toAbsoluteUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  if (href.startsWith('/')) return new URL(href, 'https://www.demontforthall.co.uk').href;
  return href;
}

// On a Ticketsolve event page, select a zone and count seats.
async function computeSeatSoldPctOnTicketsolve(page) {
  // 1) Some DMH "BOOK NOW" buttons go straight to ticketsolve seat map.
  // 2) Others go to an intermediate "Select a zone" page.
  // We try to select first option and then wait for the SVG seats.

  // Open the zone dropdown if present and choose the first enabled option
  const zoneSelect = await page.$('button:has-text("Select a zone"), [aria-haspopup="listbox"], select');
  if (zoneSelect) {
    try {
      // If it's a native <select>
      if ((await zoneSelect.evaluate(n => n.tagName)).toLowerCase() === 'select') {
        const options = await page.$$eval('select option', opts =>
          opts
            .filter(o => !o.disabled && o.value)
            .map(o => ({ value: o.value, label: o.textContent.trim() }))
        );
        if (options.length) {
          await page.selectOption('select', options[0].value);
        }
      } else {
        // Custom menu button
        await zoneSelect.click();
        const first = await page.waitForSelector(
          'div[role="listbox"] [role="option"]:not([aria-disabled="true"]), [role="menuitem"]:not([aria-disabled="true"])',
          { timeout: 4000 }
        );
        if (first) await first.click();
      }
    } catch {
      // ignore; some events don’t have zones
    }
  }

  // Wait for a seat map to appear (best-effort)
  // Seatsolve maps are usually an <svg> with many circles.
  await page.waitForTimeout(800); // brief settle
  const svg = await page.waitForSelector('svg', { timeout: 6000 }).catch(() => null);
  if (!svg) return null; // no map visible

  // Evaluate in page: count seats by status using multiple fallbacks.
  const result = await page.evaluate(() => {
    // Helper to count nodes matching any of the selectors
    const countBySelectors = (selectors) => {
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        if (nodes && nodes.length > 0) return nodes.length;
      }
      return 0;
    };

    // 1) Unavailable / sold seats (pink or grey depending on skin)
    const unavailableSelectors = [
      'svg .cts-seat--unavailable',
      'svg [data-status="unavailable"]',
      'svg [data-state="unavailable"]',
      'svg [class*="unavailable"]',
      'svg [class*="Sold"], svg [data-sold="true"]'
    ];
    const unavailable = countBySelectors(unavailableSelectors);

    // 2) All seats (we’ll exclude unavailable for available)
    const totalSelectors = [
      'svg .cts-seat',                // common
      'svg [data-seat]',             // sometimes used
      'svg circle[data-id]',         // very generic fallback
      'svg g[class*="seat"] circle', // theme variant
    ];
    let total = countBySelectors(totalSelectors);

    // If we couldn’t find a total, try to infer by combining unavailable + available:
    if (!total) {
      const availableSelectors = [
        'svg .cts-seat--available',
        'svg [data-status="available"]',
        'svg [data-state="available"]',
        'svg [class*="available"]'
      ];
      const available = countBySelectors(availableSelectors);
      if (available + unavailable > 0) {
        total = available + unavailable;
      }
    }

    if (!total) return null; // nothing reliable found

    const soldPct = Math.round((unavailable / total) * 100);
    return { unavailable, total, soldPct };
  });

  if (!result || !result.total) return null;
  return Math.max(0, Math.min(100, result.soldPct));
}

// Extract ticketsolve link from an event card on DMH site
function extractBookNowHref(rawHref) {
  const abs = toAbsoluteUrl(rawHref);
  if (!abs) return null;
  // “More info” DMH pages often redirect to ticketsolve; we follow whatever we got.
  return abs;
}

// ---- Main scrape -----------------------------------------------------------

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const out = [];

  try {
    await page.goto(ROOT, { waitUntil: 'domcontentloaded' });

    const cards = await paginateCards(page);

    for (const card of cards) {
      const event = {
        title: card.title || '',
        start: parseDateFromCardText(card.date) || null,
        status: card.btnText || '',
        override_pct: statusHeuristicToPct(card.btnText)
      };

      const href = extractBookNowHref(card.bookHref);
      if (!href) {
        out.push(event);
        continue;
      }

      // Only try the ticketsolve deep scrape if it’s a ticketsolve domain or a DMH event that sends us there
      let sold_pct = null;
      try {
        const evPage = await browser.newPage();
        await evPage.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });

        // If this is a DMH event detail page (not yet ticketsolve), find any “Book” link to ticketsolve
        if (!/ticketsolve\.com/i.test(evPage.url())) {
          const ts = await evPage.$('a[href*="ticketsolve.com"]');
          if (ts) {
            const tsHref = await ts.getAttribute('href');
            if (tsHref) {
              await evPage.goto(tsHref, { waitUntil: 'domcontentloaded', timeout: 45000 });
            }
          }
        }

        // If we’re on ticketsolve, try to compute seat map percentage
        if (/ticketsolve\.com/i.test(evPage.url())) {
          // small wait for their app-y code
          await evPage.waitForTimeout(800);
          sold_pct = await computeSeatSoldPctOnTicketsolve(evPage);
        }

        await evPage.close();
      } catch {
        // swallow — we’ll keep heuristic
      }

      if (typeof sold_pct === 'number') {
        event.sold_pct = sold_pct;
        // keep override_pct for debugging/visibility but you can remove it if you prefer
      }

      out.push(event);
    }

    // Ensure output dir
    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    await fs.writeFile(OUTPUT, JSON.stringify(out, null, 2), 'utf8');
    console.log(`Wrote ${out.length} events -> ${OUTPUT}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Scrape error:', err);
  process.exit(1);
});
