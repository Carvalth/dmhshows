#!/usr/bin/env node
/**
 * Demontfort Hall scraper → stdout JSON array
 * Node 18+/20+, Puppeteer
 *
 * Usage:
 *   node scrape-dmh.js
 *
 * Env (optional):
 *   START_URL=https://www.demontforthall.co.uk/whats-on/
 *   HEADLESS=true|false
 *   MAX_PAGES=3          // how many "load more" paginations to attempt (safety)
 *   DEBUG=true           // extra console logs
 */

const puppeteer = require('puppeteer');

const START_URL =
  process.env.START_URL || 'https://www.demontforthall.co.uk/whats-on/';
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '12', 10);
const DEBUG = (process.env.DEBUG || 'false').toLowerCase() === 'true';

//––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
// Helpers
//––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

/** Tight bands for common scarcity labels on event / Ticketsolve pages */
const LABEL_TO_PCT = [
  { re: /last few|almost gone|final (seats?|tickets?)/i, pct: 92 },
  { re: /limited/i, pct: 78 },
  { re: /selling fast/i, pct: 66 },
  { re: /just added|new date/i, pct: 55 },
];

/** Normalise whitespace */
function squish(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

/** Parse a date string to ISO (UTC) if possible */
function toISODateOrNull(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Basic “status from CTA text” as a last resort */
function statusFromText(txt) {
  const t = (txt || '').toLowerCase();
  if (/\bsold\s*out\b/.test(t)) return 'SOLD OUT';
  if (/\bcancelled|canceled|postponed|rescheduled/.test(t)) return 'CANCELLED';
  if (/book|tickets?/.test(t)) return 'BOOK NOW';
  return '';
}

/** Robustly get absolute URL */
function absolutize(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** Dedupe events by (title, start) */
function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const key = `${e.title}__${e.start || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** Ticketsolve refinement for status + percentage */
async function refineStatusFromTicketsolve(page, tsUrl) {
  try {
    await page.goto(tsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 1) Heavyweight check: SOLD OUT / CANCELLED / etc
    const html = await page.content();
    const pageText = html.toLowerCase();

    if (/\bsold\s*out\b|no\s*tickets\s*available|allocation\s*exhausted/i.test(pageText)) {
      return { status: 'SOLD OUT', override_pct: 100, via: 'sold-out-text' };
    }
    if (/\bcancelled|canceled|postponed|rescheduled/i.test(pageText)) {
      return { status: 'CANCELLED', override_pct: 0, via: 'cancel-text' };
    }

    // 2) aria-valuenow on a progressbar (most accurate when present)
    const ariaNow = await page
      .$eval('[role="progressbar"][aria-valuenow]', el =>
        parseFloat(el.getAttribute('aria-valuenow'))
      )
      .catch(() => null);

    if (Number.isFinite(ariaNow)) {
      const pct = Math.max(0, Math.min(100, ariaNow));
      return {
        status: pct >= 100 ? 'SOLD OUT' : 'BOOK NOW',
        override_pct: pct,
        via: 'aria-progress',
      };
    }

    // 3) style width % (e.g., style="width: 73%")
    const styleWidth = await page
      .$eval(
        '[role="progressbar"], .progress-bar, .tickets-progress, .availability-progress',
        el => {
          const s = el.getAttribute('style') || '';
          const m = s.match(/width\s*:\s*([0-9.]+)%/i);
          return m ? parseFloat(m[1]) : null;
        }
      )
      .catch(() => null);

    if (Number.isFinite(styleWidth)) {
      const pct = Math.max(0, Math.min(100, styleWidth));
      return {
        status: pct >= 100 ? 'SOLD OUT' : 'BOOK NOW',
        override_pct: pct,
        via: 'style-width',
      };
    }

    // 4) Scarcity label → banded % (keeps numbers realistic)
    for (const { re, pct } of LABEL_TO_PCT) {
      if (re.test(pageText)) {
        return { status: 'BOOK NOW', override_pct: pct, via: 'label-map' };
      }
    }

    // 5) Default if the page is plainly bookable
    return { status: 'BOOK NOW', override_pct: 48, via: 'default' };
  } catch (err) {
    if (DEBUG) console.error('Ticketsolve refine error:', tsUrl, err?.message || err);
    // On failure, return a conservative default (still bookable)
    return { status: 'BOOK NOW', override_pct: 48, via: 'error-fallback' };
  }
}

/** Scrape the listing (card grid) and return event stubs */
async function extractCardsOnPage(page, baseUrl) {
  // We try to accommodate common WordPress + custom card markup patterns.
  // If the site changes, these selectors are easy to tune.
  return await page.$$eval(
    [
      // articles/cards
      'article, .card, .c-card, .event-card, .listing-item',
    ].join(','),
    (cards, baseUrl) => {
      function squish(s) {
        return (s || '').replace(/\s+/g, ' ').trim();
      }
      function absolutize(href) {
        try {
          return new URL(href, baseUrl).toString();
        } catch {
          return null;
        }
      }
      function getDateFromCard(card) {
        // Try multiple patterns: <time datetime>, date text, data-attrs, etc.
        const timeEl = card.querySelector('time[datetime]') || card.querySelector('time');
        const attr = timeEl?.getAttribute('datetime') || '';
        const raw = squish(timeEl?.textContent || attr || '');
        return raw || null;
      }
      function statusFromText(txt) {
        const t = (txt || '').toLowerCase();
        if (/\bsold\s*out\b/.test(t)) return 'SOLD OUT';
        if (/\bcancelled|canceled|postponed|rescheduled/.test(t)) return 'CANCELLED';
        if (/book|tickets?/.test(t)) return 'BOOK NOW';
        return '';
      }

      const items = [];
      for (const card of cards) {
        // A title – usually in <h2>/<h3> within the card
        const titleEl =
          card.querySelector('h2, h3, .card-title, .c-card__title, .event-title') ||
          card.querySelector('a[aria-label], a[title]');
        let title = squish(titleEl?.textContent || '');

        // Fallback: sometimes the only visible text is an anchor inside the card
        if (!title) {
          const a = card.querySelector('a');
          title = squish(a?.textContent || '');
        }

        // Skip empty cards
        if (!title) continue;

        // Skip obvious noise rows (we’ll also filter later)
        if (/^\s*(more info|book now)\s*$/i.test(title)) continue;

        // CTA (button/link) for quick status
        const cta =
          card.querySelector('a[role="button"], button, .btn, .button, a.btn') ||
          card.querySelector('a');

        const ctaText = squish(cta?.textContent || '');
        const provisionalStatus = statusFromText(ctaText);

        // Event link (prefer CTA if it looks like a booking link)
        const href =
          cta?.getAttribute('href') ||
          card.querySelector('a')?.getAttribute('href') ||
          null;
        const absoluteHref = href ? absolutize(href) : null;

        // Date
        const rawDate = getDateFromCard(card);
        items.push({
          title,
          rawDate,
          href: absoluteHref,
          provisionalStatus,
        });
      }
      return items;
    },
    baseUrl
  );
}

/** Try clicking “Load more” or walking pagination (best-effort, safe to no-op) */
async function paginate(page) {
  let pages = 0;
  while (pages < MAX_PAGES) {
    const clicked = await page.evaluate(() => {
      // Common “Load more” patterns
      const btn =
        document.querySelector('button.load-more, .load-more button, a.load-more, .c-load-more button') ||
        Array.from(document.querySelectorAll('button, a'))
          .find(
            el =>
              /load more|show more|more events|more results/i.test(el.textContent || '') &&
              !el.hasAttribute('disabled')
          );
      if (btn) {
        btn.click();
        return true;
      }
      // Pagination “Next”
      const next =
        document.querySelector('a[rel="next"]') ||
        Array.from(document.querySelectorAll('a')).find(a =>
          /next|older/i.test(a.textContent || '')
        );
      if (next) {
        next.click();
        return true;
      }
      return false;
    });

    if (!clicked) break;

    pages += 1;
    try {
      // Wait for new cards (or at least a small delay if DOM doesn’t change)
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(600);
    } catch (_) {}
  }
}

/** Main flow */
(async () => {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 1600 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  const results = [];

  try {
    if (DEBUG) console.error('Navigating to', START_URL);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

    // Give JS-driven card grids time to render
    await page.waitForTimeout(900);

    // Try to expand more items
    await paginate(page);

    // Extract cards on the (possibly expanded) listing
    const stubs = await extractCardsOnPage(page, START_URL);

    if (DEBUG) console.error(`Found ${stubs.length} raw cards`);

    // Process each card → final event object
    for (const stub of stubs) {
      let { title, rawDate, href, provisionalStatus } = stub;

      // Filter out noisy titles
      if (/^\s*(more info|book now)\s*$/i.test(title)) continue;

      // Drop “Featured event - X” prefix, keep the event name
      title = title.replace(/^\s*featured event\s*[-:]\s*/i, '').trim();

      // Derive start ISO
      let start = toISODateOrNull(rawDate);

      // If the title looks like a date-less “DICK WHITTINGTON” + listing page only,
      // we’ll keep start = null (your downstream can group/expand later)

      // Decide status/percentage
      let status = '';
      let override_pct = 30; // neutral placeholder (visually dim)
      const hrefLower = (href || '').toLowerCase();

      // If the card already says SOLD OUT in CTA or badge, honour it
      if (provisionalStatus === 'SOLD OUT') {
        status = 'SOLD OUT';
        override_pct = 100;
      } else if (provisionalStatus === 'CANCELLED') {
        status = 'CANCELLED';
        override_pct = 0;
      } else if (href && /ticketsolve\.com/.test(hrefLower)) {
        // Ticketsolve refinement (most accurate)
        const { status: s, override_pct: p } = await refineStatusFromTicketsolve(page, href);
        status = s;
        override_pct = p;
      } else if (provisionalStatus === 'BOOK NOW') {
        status = 'BOOK NOW';
        override_pct = 48;
      }

      // Guarantee a non-empty status
      if (!status) {
        status = 'BOOK NOW';
        override_pct = 48;
      }

      results.push({
        title,
        start,
        status,
        override_pct,
      });
    }
  } catch (err) {
    console.error('Scrape error:', err?.stack || err?.message || err);
  } finally {
    await browser.close();
  }

  // Deduplicate and clean
  let clean = results
    .filter(e => e && e.title) // sanity
    .map(e => ({
      title: e.title,
      start: e.start || null,
      status: e.status || 'BOOK NOW',
      override_pct: Number.isFinite(e.override_pct) ? e.override_pct : 48,
    }));

  clean = dedupe(clean);

  // Optional: sort by start (nulls last), then title
  clean.sort((a, b) => {
    if (a.start && b.start) return a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
    if (a.start && !b.start) return -1;
    if (!a.start && b.start) return 1;
    return a.title.localeCompare(b.title);
  });

  // Emit JSON to stdout
  process.stdout.write(JSON.stringify(clean, null, 2));
})();

