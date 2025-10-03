// Scraper for De Montfort Hall -> public/dmh-events.json
// Node >=18 / Playwright >=1.47
// package.json should have:  "type": "module",  "scripts": { "scrape": "node scrape-dmh.js" }

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// -------- Config --------
const LIST_URL = 'https://demontforthall.co.uk/whats-on/';
const OUTFILE = path.join('public', 'dmh-events.json');

const PAGE_TIMEOUT = 35000;
const NAV_WAIT = 'domcontentloaded';
const NETWORK_IDLE = 6000;
const SCROLL_PAUSE = 300;

const TS_CONCURRENCY = 3; // Ticketsolve concurrency
const HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';

// -------- Utilities --------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const round = (n) => Math.round(n);

const statusToPct = (status = '') => {
  const s = status.toLowerCase();
  if (s.includes('sold')) return 100;
  if (s.includes('limited')) return 85;
  if (s.includes('last') || s.includes('few') || s.includes('low')) return 75;
  if (s.includes('book')) return 48;
  return 30;
};

const iso = (str) => {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? null : d.toISOString();
};

const normalizeUrl = (maybe, base) => {
  try {
    if (!maybe) return '';
    return maybe.startsWith('/') ? new URL(maybe, base).href : maybe;
  } catch { return maybe || ''; }
};

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

// Find a pair of {capacity, remaining} in unknown JSON trees
function findCapRemaining(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const todo = [obj];
  const seen = new Set();
  const candidates = [];

  const keyHits = (k, re) => re.test(String(k).toLowerCase());

  while (todo.length) {
    const node = todo.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    const keys = Object.keys(node);
    const capKey = keys.find(k => keyHits(k, /(^|_)(capacity|totalcapacity|max|quota|seats(total)?)(_|$)/));
    const remKey = keys.find(k => keyHits(k, /(^|_)(remaining|available|left|free|seatsavailable|ticketsremaining)(_|$)/));

    if (capKey && remKey) {
      const cap = Number(node[capKey]);
      const rem = Number(node[remKey]);
      if (Number.isFinite(cap) && Number.isFinite(rem) && cap > 0 && rem >= 0) {
        candidates.push({ capacity: cap, remaining: rem });
      }
    }

    for (const k of keys) {
      const v = node[k];
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) v.forEach(it => it && typeof it === 'object' && todo.push(it));
        else todo.push(v);
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.capacity - a.capacity);
  return candidates[0];
}

async function probeTicketsolve(page, url) {
  // Listen for JSON responses that might include inventory
  let best = null;

  const onResponse = async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!/json|javascript/.test(ct)) return;
      const u = resp.url();
      if (!/(avail|inventory|seat|ticket|capacity|performance|event|shows)/i.test(u)) return;

      const text = await resp.text();
      if (!text) return;
      let data; try { data = JSON.parse(text); } catch { return; }
      const ex = findCapRemaining(data);
      if (ex && (!best || ex.capacity > best.capacity)) best = ex;
    } catch {}
  };

  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: NAV_WAIT, timeout: PAGE_TIMEOUT });
    // let the seatmap/app boot
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE }).catch(() => {});
    // Nudge lazy loaders
    await page.locator('button, [role="button"]').first().click({ timeout: 1000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
  } catch {} finally {
    page.off('response', onResponse);
  }

  // Fallback to scanning bootstrapped JSON present in window or script tags
  if (!best) {
    try {
      const dumped = await page.evaluate(() => {
        const out = {};
        const globs = [
          '__PRELOADED_STATE__', '__INITIAL_STATE__', 'TS_BOOTSTRAP', '__TS_INITIAL_STATE__'
        ];
        for (const g of globs) if (window[g]) out[g] = window[g];
        const jsonScripts = Array.from(document.querySelectorAll('script[type="application/json"]'))
          .map(s => { try { return JSON.parse(s.textContent || '') } catch { return null } })
          .filter(Boolean);
        if (jsonScripts.length) out.scripts = jsonScripts;
        return out;
      });
      best = findCapRemaining(dumped) || findCapRemaining(dumped?.scripts?.[0]);
    } catch {}
  }

  if (!best) return null;

  const capacity = best.capacity;
  const remaining = clamp(best.remaining, 0, capacity);
  const sold = capacity - remaining;
  const pct = clamp(round((sold / capacity) * 100), 0, 100);
  return { capacity, remaining, sold, pct };
}

// Try to extract a ticketsolve link from the event page if the card didn’t have one
async function findTicketsolveOnEventPage(page, eventUrl) {
  try {
    await page.goto(eventUrl, { waitUntil: NAV_WAIT, timeout: PAGE_TIMEOUT });
    const a = page.locator('a[href*="ticketsolve"]');
    if (await a.count()) {
      const href = await a.first().getAttribute('href');
      if (href) return normalizeUrl(href, eventUrl);
    }
    const btn = page.locator('[data-href*="ticketsolve"]');
    if (await btn.count()) {
      const href = await btn.first().getAttribute('data-href');
      if (href) return normalizeUrl(href, eventUrl);
    }
  } catch {}
  return '';
}

async function expandListing(page) {
  // Some pages lazy-load on scroll. Do a short scroll loop
  let prev = -1;
  for (let i = 0; i < 8; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === prev) break;
    prev = h;
    await page.mouse.wheel(0, h);
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
    await sleep(SCROLL_PAUSE);
  }
}

// Collect cards from current page
async function extractCardsFromPage(page) {
  const base = page.url();
  return await page.evaluate((baseUrl) => {
    const getText = (el) => (el ? (el.innerText || el.textContent || '') : '').trim();

    const cards = Array.from(document.querySelectorAll('.card-event, article, .card'))
      .filter(n => n.querySelector('h3, .title, h2'));

    const items = [];
    for (const n of cards) {
      const titleEl = n.querySelector('h3 a, h3, .title a, .title, h2 a, h2');
      const title = getText(titleEl);

      const timeEl = n.querySelector('time[datetime]') || n.querySelector('time');
      const datetime = timeEl?.getAttribute?.('datetime') || '';
      const dateText = datetime || getText(timeEl) || getText(n.querySelector('.date'));

      const cta =
        n.querySelector('a.cta.cta--primary, a[class*="cta"][class*="primary"], a[href*="ticketsolve"]') ||
        n.querySelector('button, [role="button"]');

      const status = getText(cta);

      let href = '';
      if (cta && 'href' in cta && cta.href) href = cta.getAttribute('href') || '';
      if (!href) {
        const anyA = n.querySelector('a[href]');
        href = anyA?.getAttribute('href') || '';
      }

      const isTS = /ticketsolve\.com/i.test(href);
      items.push({
        title,
        dateText,
        datetime,
        status,
        ticketsLink: isTS ? href : '',
        eventPage: isTS ? '' : href
      });
    }

    // Normalise URLs
    for (const it of items) {
      if (it.ticketsLink && it.ticketsLink.startsWith('/')) {
        it.ticketsLink = new URL(it.ticketsLink, baseUrl).href;
      }
      if (it.eventPage && it.eventPage.startsWith('/')) {
        it.eventPage = new URL(it.eventPage, baseUrl).href;
      }
    }
    return items.filter(it => it.title);
  }, base);
}

// Paginate through numeric pager (1 2 3 4 ... at bottom)
async function collectAllListingCards(context) {
  const page = await context.newPage();
  const results = [];

  try {
    await page.goto(LIST_URL, { waitUntil: NAV_WAIT, timeout: PAGE_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE }).catch(() => {});
    await expandListing(page);

    // Discover total pages from pager
    const totalPages = await page.evaluate(() => {
      const nums = Array.from(document.querySelectorAll('a, button'))
        .map(el => (el.textContent || '').trim())
        .map(t => Number(t))
        .filter(n => Number.isFinite(n));
      const max = nums.length ? Math.max(...nums) : 1;
      return Math.max(1, max);
    });

    for (let p = 1; p <= totalPages; p++) {
      if (p > 1) {
        // Click the specific page number
        const sel = `a:has-text("${p}")`;
        const existed = await page.locator(sel).first().isVisible().catch(() => false);
        if (existed) {
          await page.locator(sel).first().click({ timeout: 4000 }).catch(() => {});
        } else {
          // fallback: querystring ?_page=…
          const u = new URL(page.url());
          u.searchParams.set('pg', String(p));
          await page.goto(u.href, { waitUntil: NAV_WAIT, timeout: PAGE_TIMEOUT });
        }
        await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE }).catch(() => {});
        await expandListing(page);
      }

      const cards = await extractCardsFromPage(page);
      results.push(...cards);
    }
  } finally {
    await page.close().catch(() => {});
  }

  // Dedup by title+date
  return dedupeBy(results, it => `${it.title}|${it.dateText}|${it.datetime}`);
}

// simple pool mapper
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const running = new Set();
  const kick = async (idx) => {
    running.add(idx);
    try { out[idx] = await fn(items[idx], idx); }
    finally { running.delete(idx); }
  };
  while (i < items.length) {
    while (running.size < limit && i < items.length) {
      void kick(i++);
    }
    if (running.size) await Promise.race([...running].map(() => sleep(25)));
  }
  while (running.size) await sleep(25);
  return out;
}

// -------- Main --------
async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: `Mozilla/5.0 (${os.platform()}; ${os.arch()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36`
  });

  try {
    // 1) Collect all listing cards across pages
    const cards = await collectAllListingCards(context);

    // Pre-create Ticketsolve pages for concurrency
    const tsPages = [];
    for (let i = 0; i < TS_CONCURRENCY; i++) tsPages.push(await context.newPage());

    // 2) Enrich with Ticketsolve % sold
    const enriched = await mapLimit(cards, TS_CONCURRENCY, async (card, idx) => {
      let ticketsUrl = card.ticketsLink;
      const listPage = tsPages[idx % TS_CONCURRENCY];

      // Resolve a Ticketsolve URL from the event page when missing
      if (!ticketsUrl && card.eventPage) {
        ticketsUrl = await findTicketsolveOnEventPage(listPage, card.eventPage);
      }
      if (ticketsUrl && !/\/seats\b/.test(ticketsUrl)) ticketsUrl = ticketsUrl.replace(/\/$/, '') + '/seats';

      // Parse start datetime
      const start =
        (card.datetime && iso(card.datetime)) ||
        (card.dateText && iso(card.dateText)) ||
        null;

      // Probe Ticketsolve
      let pct = null;
      if (ticketsUrl && /ticketsolve\.com/.test(ticketsUrl)) {
        try {
          const res = await probeTicketsolve(listPage, ticketsUrl);
          if (res?.pct != null) pct = res.pct;
        } catch {}
      }
      if (pct == null) pct = statusToPct(card.status);

      return {
        title: card.title,
        start,
        status: card.status || '',
        override_pct: pct
      };
    });

    // 3) Dedup and write
    const final = dedupeBy(
      enriched.filter(Boolean),
      ev => `${ev.title}|${ev.start || ''}|${ev.status}`
    );

    await fs.mkdir(path.dirname(OUTFILE), { recursive: true });
    await fs.writeFile(OUTFILE, JSON.stringify(final, null, 2), 'utf8');
    console.log(`Wrote ${final.length} events → ${OUTFILE}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(err => {
  console.error(err?.stack || err);
  process.exit(1);
});
