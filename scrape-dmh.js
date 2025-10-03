#!/usr/bin/env node
// scrape-dmh.js (ESM)
// Node 18+/20+, Puppeteer

import puppeteer from 'puppeteer';

// –– Config ––
const START_URL =
  process.env.START_URL || 'https://www.demontforthall.co.uk/whats-on/';
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '12', 10);
const DEBUG = (process.env.DEBUG || 'false').toLowerCase() === 'true';

// –– Helpers ––
const LABEL_TO_PCT = [
  { re: /last few|almost gone|final (seats?|tickets?)/i, pct: 92 },
  { re: /limited/i, pct: 78 },
  { re: /selling fast/i, pct: 66 },
  { re: /just added|new date/i, pct: 55 },
];

const squish = (s) => (s || '').replace(/\s+/g, ' ').trim();

const toISODateOrNull = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

const statusFromText = (txt) => {
  const t = (txt || '').toLowerCase();
  if (/\bsold\s*out\b/.test(t)) return 'SOLD OUT';
  if (/\bcancelled|canceled|postponed|rescheduled/.test(t)) return 'CANCELLED';
  if (/book|tickets?/.test(t)) return 'BOOK NOW';
  return '';
};

const absolutize = (base, href) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
};

const dedupe = (events) => {
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
};

async function refineStatusFromTicketsolve(page, tsUrl) {
  try {
    await page.goto(tsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const html = await page.content();
    const pageText = html.toLowerCase();

    if (/\bsold\s*out\b|no\s*tickets\s*available|allocation\s*exhausted/i.test(pageText)) {
      return { status: 'SOLD OUT', override_pct: 100, via: 'sold-out-text' };
    }
    if (/\bcancelled|canceled|postponed|rescheduled/i.test(pageText)) {
      return { status: 'CANCELLED', override_pct: 0, via: 'cancel-text' };
    }

    const ariaNow = await page
      .$eval('[role="progressbar"][aria-valuenow]', el =>
        parseFloat(el.getAttribute('aria-valuenow'))
      )
      .catch(() => null);

    if (Number.isFinite(ariaNow)) {
      const pct = Math.max(0, Math.min(100, ariaNow));
      return { status: pct >= 100 ? 'SOLD OUT' : 'BOOK NOW', override_pct: pct, via: 'aria-progress' };
    }

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
      return { status: pct >= 100 ? 'SOLD OUT' : 'BOOK NOW', override_pct: pct, via: 'style-width' };
    }

    for (const { re, pct } of LABEL_TO_PCT) {
      if (re.test(pageText)) return { status: 'BOOK NOW', override_pct: pct, via: 'label-map' };
    }

    return { status: 'BOOK NOW', override_pct: 48, via: 'default' };
  } catch (err) {
    if (DEBUG) console.error('Ticketsolve refine error:', tsUrl, err?.message || err);
    return { status: 'BOOK NOW', override_pct: 48, via: 'error-fallback' };
  }
}

async function extractCardsOnPage(page, baseUrl) {
  return await page.$$eval(
    'article, .card, .c-card, .event-card, .listing-item',
    (cards, baseUrl) => {
      const squish = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const absolutize = (href) => {
        try { return new URL(href, baseUrl).toString(); } catch { return null; }
      };
      const statusFromText = (txt) => {
        const t = (txt || '').toLowerCase();
        if (/\bsold\s*out\b/.test(t)) return 'SOLD OUT';
        if (/\bcancelled|canceled|postponed|rescheduled/.test(t)) return 'CANCELLED';
        if (/book|tickets?/.test(t)) return 'BOOK NOW';
        return '';
      };
      const getDateFromCard = (card) => {
        const t = card.querySelector('time[datetime]') || card.querySelector('time');
        const attr = t?.getAttribute('datetime') || '';
        const raw = squish(t?.textContent || attr || '');
        return raw || null;
      };

      const items = [];
      for (const card of cards) {
        const titleEl =
          card.querySelector('h2, h3, .card-title, .c-card__title, .event-title') ||
          card.querySelector('a[aria-label], a[title]');
        let title = squish(titleEl?.textContent || '');
        if (!title) title = squish(card.querySelector('a')?.textContent || '');
        if (!title) continue;
        if (/^\s*(more info|book now)\s*$/i.test(title)) continue;

        const cta =
          card.querySelector('a[role="button"], button, .btn, .button, a.btn') ||
          card.querySelector('a');
        const ctaText = squish(cta?.textContent || '');
        const provisionalStatus = statusFromText(ctaText);

        const href =
          cta?.getAttribute('href') ||
          card.querySelector('a')?.getAttribute('href') ||
          null;

        items.push({
          title,
          rawDate: getDateFromCard(card),
          href: href ? absolutize(href) : null,
          provisionalStatus,
        });
      }
      return items;
    },
    baseUrl
  );
}

async function paginate(page) {
  let pages = 0;
  while (pages < MAX_PAGES) {
    const clicked = await page.evaluate(() => {
      const btn =
        document.querySelector('button.load-more, .load-more button, a.load-more, .c-load-more button') ||
        Array.from(document.querySelectorAll('button, a')).find(
          el => /load more|show more|more events|more results/i.test(el.textContent || '') &&
                !el.hasAttribute('disabled')
        );
      if (btn) { btn.click(); return true; }

      const next =
        document.querySelector('a[rel="next"]') ||
        Array.from(document.querySelectorAll('a')).find(a => /next|older/i.test(a.textContent || ''));
      if (next) { next.click(); return true; }

      return false;
    });

    if (!clicked) break;
    pages += 1;
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
  }
}

async function main() {
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
    await page.waitForTimeout(900);
    await paginate(page);

    const stubs = await extractCardsOnPage(page, START_URL);
    if (DEBUG) console.error(`Found ${stubs.length} raw cards`);

    for (const stub of stubs) {
      let { title, rawDate, href, provisionalStatus } = stub;

      if (/^\s*(more info|book now)\s*$/i.test(title)) continue;
      title = title.replace(/^\s*featured event\s*[-:]\s*/i, '').trim();
      const start = toISODateOrNull(rawDate);

      let status = '';
      let override_pct = 30;

      if (provisionalStatus === 'SOLD OUT') {
        status = 'SOLD OUT'; override_pct = 100;
      } else if (provisionalStatus === 'CANCELLED') {
        status = 'CANCELLED'; override_pct = 0;
      } else if (href && /ticketsolve\.com/.test((href || '').toLowerCase())) {
        const { status: s, override_pct: p } = await refineStatusFromTicketsolve(page, href);
        status = s; override_pct = p;
      } else if (provisionalStatus === 'BOOK NOW') {
        status = 'BOOK NOW'; override_pct = 48;
      }

      if (!status) { status = 'BOOK NOW'; override_pct = 48; }

      results.push({ title, start, status, override_pct });
    }
  } catch (err) {
    console.error('Scrape error:', err?.stack || err?.message || err);
  } finally {
    await browser.close();
  }

  let clean = results
    .filter(e => e && e.title)
    .map(e => ({
      title: e.title,
      start: e.start || null,
      status: e.status || 'BOOK NOW',
      override_pct: Number.isFinite(e.override_pct) ? e.override_pct : 48,
    }));

  clean = dedupe(clean);

  clean.sort((a, b) => {
    if (a.start && b.start) return a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
    if (a.start && !b.start) return -1;
    if (!a.start && b.start) return 1;
    return a.title.localeCompare(b.title);
  });

  process.stdout.write(JSON.stringify(clean, null, 2));
}

// ESM entrypoint
main().catch(err => {
  console.error(err);
  process.exit(1);
});
