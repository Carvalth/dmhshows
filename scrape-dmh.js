// Run with: npm run scrape
// Writes: public/dmh-events.json

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const OUT_PATH = path.join(ROOT, 'public', 'dmh-events.json');
const LIST_URL = 'https://www.demontforthall.co.uk/whats-on/';

// How many "page numbers" to attempt (stop early when a page has no cards)
const MAX_PAGES = 12;

// Fallback mapping when we cannot see a seat map
function fallbackPct(statusText) {
  const s = (statusText || '').toLowerCase();
  if (s.includes('sold')) return 100;
  if (s.includes('limited')) return 85;
  if (s.includes('last') || s.includes('low')) return 75;
  if (s.includes('book now')) return 48;
  return 30;
}

// Robust seat counting inside Ticketsolve
async function computePctSoldFromTicketsolve(page) {
  // If there is a “Select a zone” control, pick the first entry that contains
  // “Stalls and Circles”, otherwise select the first option in the listbox.
  try {
    const zoneToggle = await page.waitForSelector('text=/^Select a zone|Stalls and Circles$/', { timeout: 5000 });
    await zoneToggle.click().catch(() => {});
    // Try most-complete zone first
    const prefer = await page.$('text="Stalls and Circles"');
    if (prefer) {
      await prefer.click();
    } else {
      // fall back to the first option in the dropdown listbox
      const first = await page.$('[role="listbox"] [role="option"], .select__menu div[role="option"]');
      if (first) await first.click();
    }
  } catch { /* zone picker may not exist (unreserved/standing) */ }

  // Wait for an SVG map (Ticketsolve renders an SVG with lots of <circle>/<rect>)
  // Then count elements marked as available/unavailable.
  await page.waitForTimeout(800); // small render pause

  const counts = await page.evaluate(() => {
    const getAll = (sel) => Array.from(document.querySelectorAll(sel));

    // Common patterns seen on Ticketsolve maps
    const byAttr = getAll('[data-seat-status]');
    let available = 0;
    let unavailable = 0;

    if (byAttr.length) {
      for (const el of byAttr) {
        const st = (el.getAttribute('data-seat-status') || '').toLowerCase();
        if (st.includes('available')) available++;
        else if (st.includes('unavailable') || st.includes('in_cart') || st.includes('reserved') || st.includes('held')) {
          unavailable++;
        }
      }
    } else {
      // Class name fallbacks (Ticketsolve themes vary)
      const availNodes = getAll('.seat--available, .available.seat, .seat.available');
      const unavailNodes = getAll('.seat--unavailable, .unavailable.seat, .seat.unavailable, .seat.in-cart, .seat.selected');
      available = availNodes.length;
      unavailable = unavailNodes.length;
    }

    // Some layouts render cursor “dots” as <circle> without attributes, but set
    // aria-labels. Add a last-resort pass:
    if (available + unavailable === 0) {
      const aria = getAll('[aria-label]');
      for (const el of aria) {
        const lab = el.getAttribute('aria-label')?.toLowerCase() || '';
        if (lab.includes('available')) available++;
        else if (lab.includes('unavailable') || lab.includes('in cart') || lab.includes('reserved')) unavailable++;
      }
    }

    return { available, unavailable };
  });

  const total = counts.available + counts.unavailable;
  if (total === 0) return null; // No map / not a reserved-seat show

  const pctSold = Math.round((counts.unavailable / total) * 100);
  return Math.max(0, Math.min(100, pctSold));
}

function parseDateFromCardBits(dateStr) {
  // Cards usually show like "FRI 17 OCT 2025" and time is on the Ticketsolve page.
  // We keep date only; time will be regularized after following the book link.
  try {
    // Try to let Date parse it; if not, return null and let event page overwrite.
    const d = new Date(dateStr);
    if (!Number.isNaN(d.valueOf())) return d.toISOString();
  } catch {}
  return null;
}

async function scrapeListPage(ctx, pageNo) {
  const url = pageNo === 1 ? LIST_URL : `${LIST_URL}?_paged=${pageNo}`;
  await ctx.goto(url, { waitUntil: 'domcontentloaded' });

  // Event cards
  const cards = await ctx.$$('[class*="card-event"], .card-event, article:has(a:has-text("BOOK NOW")), article:has(.cta)');
  const items = [];

  for (const card of cards) {
    const title = (await card.$eval('.title, h3, h2', el => el.textContent?.trim()).catch(() => null)) ||
                  (await card.$eval('a[href*="/event/"]', el => el.textContent?.trim()).catch(() => null));

    if (!title) continue;

    const dateText = await card.$eval('.date', el => el.textContent?.trim()).catch(() => null);

    // Find status button (BOOK NOW / SOLD OUT / MORE INFO)
    let status = await card.$eval('.cta.cta-primary', el => el.textContent?.trim()).catch(() => null);
    if (!status) {
      status = await card.$eval('a[aria-label], .cta', el => el.textContent?.trim()).catch(() => '');
    }

    // Book link if present
    const bookHref =
      await card.$eval('a.cta.cta-primary[href], a[href*="ticketsolve"][href]', el => el.getAttribute('href')).catch(() => null);

    items.push({ title, dateText, status, bookHref });
  }

  return items;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const all = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const batch = await scrapeListPage(page, p);
    if (!batch.length) break;
    all.push(...batch);
  }

  // Visit Ticketsolve pages to enrich with accurate date/time and % sold
  const results = [];
  for (const row of all) {
    // Skip duplicates by title+date when WP shows multiple tiles across pages
    const exists = results.find(r => r.title === row.title && r.start?.slice(0, 10) === row.start?.slice(0, 10));
    if (exists) continue;

    let startISO = null;
    let pct = null;

    if (row.bookHref) {
      try {
        // Some DMH links are relative to ticketsolve domain; ensure absolute.
        const href = row.bookHref.startsWith('http')
          ? row.bookHref
          : new URL(row.bookHref, 'https://demontforthall.ticketsolve.com').toString();

        await page.goto(href, { waitUntil: 'domcontentloaded' });

        // Extract exact datetime shown on Ticketsolve page (usually “Friday 3 October 2025, 19:30”)
        const dtText = await page.textContent('text=/\\d{1,2}:[0-5]\\d/').catch(() => null);
        // There is also an icon row containing the date – try a broader scrape:
        const headerDt =
          (await page.textContent('xpath=//*[contains(@class,"Date") or contains(text(), ",")]').catch(() => null)) ||
          dtText;

        if (headerDt) {
          const parsed = Date.parse(headerDt);
          if (!Number.isNaN(parsed)) startISO = new Date(parsed).toISOString();
        }

        // Seat percentages (reserved seating only)
        pct = await computePctSoldFromTicketsolve(page);
      } catch {
        // ignore – fallbacks will handle
      }
    }

    const status = (row.status || '').trim();
    const override_pct = Number.isFinite(pct) ? pct : fallbackPct(status);

    // If we still have no date, fall back to card’s date text
    if (!startISO && row.dateText) {
      startISO = parseDateFromCardBits(row.dateText);
    }

    // If we still have no date, leave null (index will display without it)
    results.push({
      title: row.title,
      start: startISO || null,
      status,
      override_pct
    });
  }

  // Deduplicate (title+start)
  const unique = [];
  const seen = new Set();
  for (const e of results) {
    const key = `${e.title}__${e.start || ''}`;
    if (!seen.has(key)) { seen.add(key); unique.push(e); }
  }

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(unique, null, 2));
  console.log(`Wrote ${unique.length} events -> ${OUT_PATH}`);

  await browser.close();
}

run().catch(err => {
  console.error('Scrape error:', err);
  process.exit(1);
});

