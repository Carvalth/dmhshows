// scrape-dmh.js  — Playwright-based scraper that estimates % tickets sold
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

// ---------- Config ----------
const DMH_WHATS_ON = 'https://demontforthall.co.uk/whats-on/';
const OUTFILE = path.join('public', 'dmh-events.json');

// Timeouts / throttling
const PAGE_TIMEOUT_MS = 30_000;
const NAV_WAIT = 'domcontentloaded';

// ---------- Helpers ----------
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

function parseDateUK(text) {
  // e.g. "Mon 6 Oct 2025" or "Thu 23 Jan 2026"
  // Let Date parse in the browser locale once we add a time so it's unambiguous.
  // If parse fails, return null.
  try {
    // Add 19:30 local time as a safe default so we preserve the day
    const d = new Date(text + ' 19:30');
    return isNaN(d) ? null : d.toISOString();
  } catch {
    return null;
  }
}

// Try to extract capacity/remaining pairs from arbitrary JSON
function extractCapacityFromJSON(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // common Ticketsolve-ish keys we’ve seen
  const candidates = [];

  // Walk the object shallowly & add nodes that look like availability
  const stack = [obj];
  const visited = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);

    // Heuristic keys
    const keys = Object.keys(node);
    const lc = (k) => k.toLowerCase();

    const hasCapacity = keys.some(k => /capacity|total|max|quota/.test(lc(k)));
    const hasAvail   = keys.some(k => /remaining|available|left|free/.test(lc(k)));

    if (hasCapacity && hasAvail) {
      const capacity = Number(
        node.capacity ?? node.total ?? node.max ?? node.quota ?? node.totalCapacity
      );
      const remaining = Number(
        node.remaining ?? node.available ?? node.left ?? node.free ?? node.ticketsRemaining ?? node.seatsAvailable
      );
      if (Number.isFinite(capacity) && Number.isFinite(remaining) && capacity > 0) {
        candidates.push({ capacity, remaining });
      }
    }

    // push children
    for (const k of keys) {
      const v = node[k];
      if (v && typeof v === 'object') stack.push(v);
      if (Array.isArray(v)) for (const item of v) if (item && typeof item === 'object') stack.push(item);
    }
  }

  if (candidates.length) {
    // prefer the largest capacity (usually the main performance, not an upsell)
    candidates.sort((a, b) => b.capacity - a.capacity);
    return candidates[0];
  }
  return null;
}

// Listen for JSON/XHR while loading a Ticketsolve page and try to read capacity
async function probeTicketsolveAvailability(page, url) {
  let best = null;

  const handler = async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      const u = resp.url();
      // Heuristic: endpoints that look like availability/inventory/etc
      if (!/json|javascript/.test(ct)) return;
      if (!/(avail|inventory|seat|ticket|capacity|performance|event)/i.test(u)) return;
      const bodyText = await resp.text();
      if (!bodyText) return;

      // Most responses will be JSON
      let data;
      try { data = JSON.parse(bodyText); }
      catch { /* some are JS; ignore */ return; }

      const extracted = extractCapacityFromJSON(data);
      if (extracted) {
        // Keep the one with the largest capacity
        if (!best || extracted.capacity > best.capacity) {
          best = extracted;
        }
      }
    } catch { /* ignore single response errors */ }
  };

  page.on('response', handler);

  try {
    await page.goto(url, { waitUntil: NAV_WAIT, timeout: PAGE_TIMEOUT_MS });
    // Let XHRs fire
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await sleep(500); // small settle
  } catch {
    // ignore navigation errors; we’ll fall back later
  } finally {
    page.off('response', handler);
  }

  // As a secondary attempt, try to read any embedded JSON bootstrap state
  if (!best) {
    try {
      const boot = await page.evaluate(() => {
        // try a few common patterns
        const out = {};
        if (window.__PRELOADED_STATE__) out.preloaded = window.__PRELOADED_STATE__;
        if (window.__INITIAL_STATE__) out.initial = window.__INITIAL_STATE__;
        if (window.__TS_INITIAL_STATE__) out.ts = window.__TS_INITIAL_STATE__;
        // pick up any lone <script type="application/json"> blocks
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'))
          .map(s => {
            try { return JSON.parse(s.textContent || ''); } catch { return null; }
          })
          .filter(Boolean);
        if (scripts.length) out.embedded = scripts;
        return out;
      });
      best = extractCapacityFromJSON(boot) || extractCapacityFromJSON(boot?.embedded?.[0]);
    } catch { /* ignore */ }
  }

  if (best && best.capacity > 0) {
    const remaining = clamp(best.remaining, 0, best.capacity);
    const sold = best.capacity - remaining;
    const pct = clamp(round((sold / best.capacity) * 100), 0, 100);
    return { capacity: best.capacity, remaining, sold, pct };
  }
  return null;
}

// ---------- Scrape flow ----------
async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const all = [];

  try {
    await page.goto(DMH_WHATS_ON, { waitUntil: NAV_WAIT, timeout: PAGE_TIMEOUT_MS });
    // Some sites lazy-load cards; scroll to bottom to trigger
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(800);

    const cards = await page.$$('[class*="card-event"], .card-event');
    for (const card of cards) {
      const title = (await card.$eval('h3 a, h3, .title a, .title', el => el.textContent?.trim()).catch(() => '')) || '';
      if (!title) continue;

      const dateText = await card.$eval('.date, time', el => el.textContent?.trim()).catch(() => '');
      const startISO = parseDateUK(dateText);

      // Status and link
      const ctaHandle = await card.$('a.cta.cta--primary, a[class*="cta-primary"], a[href*="ticketsolve"]');
      let status = '';
      let ctaHref = '';
      if (ctaHandle) {
        status = (await ctaHandle.textContent())?.trim() || '';
        ctaHref = (await ctaHandle.getAttribute('href')) || '';
        // Normalise relative links
        if (ctaHref && ctaHref.startsWith('/')) {
          const { origin } = new URL(DMH_WHATS_ON);
          ctaHref = origin + ctaHref;
        }
      }

      // Try to compute % sold from Ticketsolve if we have a usable link
      let override_pct = null;
      if (ctaHref && /ticketsolve\.com/.test(ctaHref)) {
        const avail = await probeTicketsolveAvailability(page, ctaHref);
        if (avail?.pct != null) {
          override_pct = avail.pct;
        }
      }

      // Fallback mapping if no hard numbers
      if (override_pct == null) {
        override_pct = statusFallbackPct(status);
      }

      all.push({
        title,
        start: startISO,
        status,
        override_pct
      });
    }
  } finally {
    await browser.close();
  }

  // Filter obvious empties / duplicates
  const dedup = [];
  const seen = new Set();
  for (const ev of all) {
    const key = `${ev.title}|${ev.start||''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(ev);
  }

  await fs.mkdir(path.dirname(OUTFILE), { recursive: true });
  await fs.writeFile(OUTFILE, JSON.stringify(dedup, null, 2), 'utf8');
  console.log(`Wrote ${dedup.length} events to ${OUTFILE}`);
}

scrape().catch(err => {
  console.error('Scrape error:', err?.message || err);
  process.exit(1);
});

