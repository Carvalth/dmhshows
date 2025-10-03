// scrape-dmh.js — De Montfort Hall -> Ticketsolve with accurate % sold when available
// Requires Node 18+ and playwright

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

// --------- Config ----------
const DMH_WHATS_ON = 'https://demontforthall.co.uk/whats-on/';
const OUTFILE = path.join('public', 'dmh-events.json');

const NAV_WAIT = 'domcontentloaded';
const PAGE_TIMEOUT_MS = 30_000;

// --------- Utils ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const round = (n) => Math.round(n);

function statusFallbackPct(statusText = '') {
  const s = statusText.toLowerCase();
  if (s.includes('sold')) return 100;
  if (s.includes('limited')) return 85;
  if (s.includes('last') || s.includes('low') || s.includes('few')) return 75;
  if (s.includes('book')) return 48;
  return 30;
}

// DMH dates are typically day+month+year in text. We keep time at 19:30 local by default.
function parseDateLoose(text) {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // If a <time datetime="..."> exists, prefer it (we’ll pass through as-is).
  // Otherwise try to feed Date; add a time so UTC conversion won’t jump a day.
  try {
    const d = new Date(`${cleaned} 19:30`);
    return isNaN(d) ? null : d.toISOString();
  } catch {
    return null;
  }
}

// Walk arbitrary JSON to find {capacity, remaining}-like pairs
function extractCapacityFromJSON(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const stack = [obj];
  const seen = new Set();
  const found = [];

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    const keys = Object.keys(node);
    const lc = (k) => k.toLowerCase();

    const capKey = keys.find(k => /capacity|totalcapacity|total|max|quota|seats(total)?/i.test(lc(k)));
    const remKey = keys.find(k => /remaining|available|left|free|seatsAvailable|ticketsRemaining/i.test(lc(k)));
    if (capKey && remKey) {
      const capacity = Number(node[capKey]);
      const remaining = Number(node[remKey]);
      if (Number.isFinite(capacity) && Number.isFinite(remaining) && capacity > 0 && remaining >= 0) {
        found.push({ capacity, remaining });
      }
    }

    for (const k of keys) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(x => (x && typeof x === 'object') && stack.push(x));
      else if (v && typeof v === 'object') stack.push(v);
    }
  }

  if (!found.length) return null;
  // Prefer the largest capacity — usually the main performance, not an add-on
  found.sort((a, b) => b.capacity - a.capacity);
  return found[0];
}

// Open a Ticketsolve page and listen for JSON/XHR to compute availability
async function probeTicketsolveAvailability(tsPage, url) {
  let best = null;

  const handler = async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      const u = resp.url();
      if (!/json|javascript/.test(ct)) return;
      if (!/(avail|inventory|seat|ticket|capacity|performance|event)/i.test(u)) return;
      const body = await resp.text();
      if (!body) return;
      let data;
      try { data = JSON.parse(body); } catch { return; }
      const ex = extractCapacityFromJSON(data);
      if (ex && (!best || ex.capacity > best.capacity)) best = ex;
    } catch {}
  };

  tsPage.on('response', handler);
  try {
    await tsPage.goto(url, { waitUntil: NAV_WAIT, timeout: PAGE_TIMEOUT_MS });
    // Let network settle
    await tsPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await sleep(400);
  } catch {} finally {
    tsPage.off('response', handler);
  }

  // Fallback: look for bootstrapped JSON in the DOM
  if (!best) {
    try {
      const boot = await tsPage.evaluate(() => {
        const out = {};
        if (window.__PRELOADED_STATE__) out.preloaded = window.__PRELOADED_STATE__;
        if (window.__INITIAL_STATE__) out.initial = window.__INITIAL_STATE__;
        if (window.__TS_INITIAL_STATE__) out.ts = window.__TS_INITIAL_STATE__;
        const blocks = Array.from(document.querySelectorAll('script[type="application/json"]'))
          .map(s => { try { return JSON.parse(s.textContent || ''); } catch { return null; } })
          .filter(Boolean);
        if (blocks.length) out.blocks = blocks;
        return out;
      });
      best = extractCapacityFromJSON(boot) || extractCapacityFromJSON(boot?.blocks?.[0]);
    } catch {}
  }

  if (best && best.capacity > 0) {
    const remaining = clamp(best.remaining, 0, best.capacity);
    const sold = best.capacity - remaining;
    const pct = clamp(round((sold / best.capacity) * 100), 0, 100);
    return { capacity: best.capacity, remaining, sold, pct };
  }
  return null;
}

// Click "Load more" repeatedly if present
async function exhaustLoadMore(page) {
  for (let i = 0; i < 15; i++) {
    // Buttons we might encounter
    const btn = page.locator('button:has-text("Load more"), a:has-text("Load more")').first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) break;
    try {
      await btn.click({ timeout: 3000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(400);
    } catch {
      break;
    }
  }
}

// Collect all cards into plain objects BEFORE leaving the page
async function collectCards(page) {
  const results = await page.evaluate(() => {
    // Be generous with selectors — the site might tweak classes.
    const cardSel = [
      '.card-event',
      '[class*="card"][class*="event"]',
      'article:has(a)'
    ].join(',');

    const nodes = Array.from(document.querySelectorAll(cardSel));
    const items = [];

    for (const el of nodes) {
      // Title
      const titleEl = el.querySelector('h3 a, h3, .title a, .title');
      const title = titleEl?.textContent?.trim() || '';

      // Date: prefer <time datetime="">
      const timeEl = el.querySelector('time[datetime]') || el.querySelector('time');
      const datetime = timeEl?.getAttribute?.('datetime') || '';
      const dateText = datetime || (timeEl?.textContent?.trim() || el.querySelector('.date')?.textContent?.trim() || '');

      // CTA
      const ctaEl =
        el.querySelector('a.cta.cta--primary') ||
        el.querySelector('a[class*="cta"][class*="primary"]') ||
        el.querySelector('a[href*="ticketsolve"]') ||
        el.querySelector('a');

      const status = (ctaEl?.textContent || '').trim();
      let href = ctaEl?.getAttribute('href') || '';

      // Resolve relative URLs
      try {
        if (href && href.startsWith('/')) href = new URL(href, location.origin).href;
      } catch {}

      // Try to detect direct ticketsolve link on the card, otherwise look for a "More info" that goes to event page
      const ticketsLink =
        href && /ticketsolve\.com/i.test(href)
          ? href
          : '';

      const eventPage =
        href && !/ticketsolve\.com/i.test(href)
          ? href
          : '';

      items.push({ title, dateText, datetime, status, ticketsLink, eventPage });
    }

    // Deduplicate by title+dateText
    const seen = new Set();
    return items.filter(it => {
      const k = `${it.title}|${it.dateText}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return it.title;
    });
  });

  return results;
}

async function maybeFindTicketsolveFromEventPage(page, eventUrl) {
  if (!eventUrl) return '';
  try {
    await page.goto(eventUrl, { waitUntil: NAV_WAIT, timeout: PAGE_TIMEOUT_MS });
    // Look for a buy/cta button that points to ticketsolve
    const link = await page.$('a[href*="ticketsolve"]');
    if (link) {
      const href = await link.getAttribute('href');
      if (href) {
        try {
          return href.startsWith('/') ? new URL(href, new URL(eventUrl).origin).href : href;
        } catch { return href; }
      }
    }
  } catch {}
  return '';
}

// --------- Main scrape ----------
async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const listing = await ctx.newPage();
  const tsPage = await ctx.newPage(); // dedicated Ticketsolve page (DON'T reuse listing page)

  const out = [];

  try {
    await listing.goto(DMH_WHATS_ON, { waitUntil: NAV_WAIT, timeout: PAGE_TIMEOUT_MS });
    await exhaustLoadMore(listing);
    // Scroll to ensure any lazy content mounts
    await listing.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(500);

    const cards = await collectCards(listing);

    // Resolve ticketsolve links for those that only have a DMH event page
    for (const card of cards) {
      let ticketsHref = card.ticketsLink;
      if (!ticketsHref && card.eventPage) {
        ticketsHref = await maybeFindTicketsolveFromEventPage(listing, card.eventPage);
      }

      // Compute start
      // If datetime looks ISO-like, use it; else parse the visible text
      const startISO = card.datetime
        ? (new Date(card.datetime).toString() !== 'Invalid Date'
            ? new Date(card.datetime).toISOString()
            : parseDateLoose(card.dateText))
        : parseDateLoose(card.dateText);

      let override_pct = null;

      // Try hard availability only if we have a ticketsolve URL
      if (ticketsHref && /ticketsolve\.com/i.test(ticketsHref)) {
        const seatUrl = /\/seats\b/.test(ticketsHref) ? ticketsHref : ticketsHref.replace(/\/$/, '') + '/seats';
        const avail = await probeTicketsolveAvailability(tsPage, seatUrl);
        if (avail?.pct != null) override_pct = avail.pct;
      }

      if (override_pct == null) {
        override_pct = statusFallbackPct(card.status);
      }

      out.push({
        title: card.title,
        start: startISO,
        status: card.status || '',
        override_pct
      });
    }
  } finally {
    await browser.close();
  }

  // Dedup and tidy
  const seen = new Set();
  const final = out.filter(ev => {
    const key = `${ev.title}|${ev.start || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return ev.title;
  });

  await fs.mkdir(path.dirname(OUTFILE), { recursive: true });
  await fs.writeFile(OUTFILE, JSON.stringify(final, null, 2), 'utf8');
  console.log(`Wrote ${final.length} events to ${OUTFILE}`);
}

scrape().catch(err => {
  console.error('Scrape error:', err?.stack || err);
  process.exit(1);
});
