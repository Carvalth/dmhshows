// ESM + Playwright
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const LIST_URL = 'https://demontforthall.co.uk/whats-on/';
const OUT_FILE = path.join('public', 'dmh-events.json');

const HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';
const TIMEOUT = 40000;         // general nav timeout
const NET_IDLE = 3500;         // wait after interactions
const TS_CONCURRENCY = 3;      // ticketsolve pages in parallel

/* ---------- small helpers ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const round = (n) => Math.round(n);
const uniqBy = (arr, keyFn) => {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = keyFn(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
};
const statusToPct = (s='') => {
  const t = s.toLowerCase();
  if (t.includes('sold')) return 100;
  if (t.includes('limited')) return 85;
  if (t.includes('last') || t.includes('few') || t.includes('low')) return 75;
  if (t.includes('book')) return 48;
  return 30;
};
const toISO = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/* ---------- Ticketsolve availability extraction ---------- */

/** recursively search for fields that look like capacity / remaining */
function pickCapRem(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const q = [obj]; const seen = new Set(); let best = null;

  const hit = (k, re) => re.test(String(k).toLowerCase());

  while (q.length) {
    const n = q.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);

    const keys = Object.keys(n);
    const capK = keys.find(k => hit(k, /(^|_)(capacity|totalcapacity|max|seats(total)?|quota)(_|$)/));
    const remK = keys.find(k => hit(k, /(^|_)(remaining|available|left|free|seatsavailable|ticketsremaining)(_|$)/));

    if (capK && remK) {
      const cap = Number(n[capK]);
      const rem = Number(n[remK]);
      if (Number.isFinite(cap) && Number.isFinite(rem) && cap > 0 && rem >= 0) {
        if (!best || cap > best.capacity) best = { capacity: cap, remaining: rem };
      }
    }
    for (const k of keys) {
      const v = n[k];
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) v.forEach(x => x && typeof x === 'object' && q.push(x));
        else q.push(v);
      }
    }
  }
  return best;
}

/** Network probe: listen for Ticketsolve JSON calls */
async function probeTicketsolveViaNetwork(page, url) {
  let best = null;
  const handler = async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!/json|javascript/.test(ct)) return;
      const u = resp.url();
      if (!/(seat|availability|avail|inventory|capacity|performance|event)/i.test(u)) return;
      const txt = await resp.text();
      let data; try { data = JSON.parse(txt); } catch { return; }
      const found = pickCapRem(data);
      if (found && (!best || found.capacity > best.capacity)) best = found;
    } catch {}
  };
  page.on('response', handler);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    // click a benign element to encourage lazy calls
    await page.locator('button, [role="button"]').first().click({ timeout: 800 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
  } catch {}
  page.off('response', handler);
  return best;
}

/** DOM probe: iterate zones, count seats in SVG/DOM */
async function probeTicketsolveViaDOM(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  } catch { return null; }

  // Normalise to /seats if not already
  if (!/\/seats\b/.test(page.url())) {
    try {
      await page.goto(url.replace(/\/$/, '') + '/seats', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    } catch {}
  }
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});

  // Try to read bootstrapped JSON first
  try {
    const boot = await page.evaluate(() => {
      const out = {};
      for (const k of [
        '__PRELOADED_STATE__','__INITIAL_STATE__','TS_BOOTSTRAP','__TS_INITIAL_STATE__'
      ]) if (window[k]) out[k] = window[k];
      const jsonScripts = Array.from(document.querySelectorAll('script[type="application/json"]'))
        .map(s => { try { return JSON.parse(s.textContent || '') } catch { return null } })
        .filter(Boolean);
      if (jsonScripts.length) out.scripts = jsonScripts;
      return out;
    });
    const found = pickCapRem(boot) || pickCapRem(boot?.scripts?.[0]);
    if (found) return found;
  } catch {}

  // If still no data, use zone iteration and seat counting
  const zones = await page.evaluate(() => {
    const sel = document.querySelector('select, [role="listbox"]');
    if (!sel) return [];
    // Standard <select>
    if (sel.tagName === 'SELECT') {
      return Array.from(sel.options)
        .map(o => ({ value: o.value, text: (o.textContent || '').trim() }))
        .filter(z => z.value && !/select/i.test(z.text));
    }
    // Custom dropdown (Ticketsolve sometimes uses it)
    const opts = Array.from(document.querySelectorAll('[role="option"]')).map(el => ({
      value: el.getAttribute('data-value') || (el.textContent || '').trim(),
      text: (el.textContent || '').trim()
    }));
    return opts.filter(o => o.value);
  });

  if (!zones.length) {
    // Some seat maps render all zones at once — just count globally
    const { cap, avail } = await page.evaluate(() => {
      const seats = Array.from(document.querySelectorAll(
        // try a bunch of seat selectors/classes used by Ticketsolve skins
        '.seat, [class*="seat"], svg [data-seat], svg [data-status], svg [class*="seat"]'
      ));
      const isAvail = (el) => {
        const cls = (el.getAttribute('class') || '').toLowerCase();
        const ds = (el.getAttribute('data-status') || '').toLowerCase();
        const fill = (getComputedStyle(el).fill || '').toLowerCase();
        // heuristics: available/selected vs taken/sold/reserved
        if (/unavailable|taken|sold|reserved|blocked|held/.test(cls) || /unavailable|taken|sold|reserved/.test(ds)) return false;
        if (/available|free/.test(cls) || /available|free/.test(ds)) return true;
        if (fill && /#?ccc|#?bbb|gray|grey/.test(fill)) return false;
        return !/selected/.test(cls); // default to available unless clearly not
      };
      let cap = seats.length;
      let avail = seats.filter(isAvail).length;
      return { cap, avail };
    });
    if (cap > 0) return { capacity: cap, remaining: avail };
    return null;
  }

  // Iterate each zone: select it, wait, count seats
  let totCap = 0, totAvail = 0;
  for (const z of zones) {
    try {
      // open dropdown + select option (handle both native and custom)
      const sel = page.locator('select');
      if (await sel.count()) {
        await sel.selectOption(z.value);
      } else {
        // custom: click box, click option
        const box = page.locator('[role="listbox"]');
        if (await box.count()) {
          await box.click();
          const opt = page.locator(`[role="option"]`, { hasText: z.text }).first();
          if (await opt.count()) await opt.click();
        }
      }
      await page.waitForLoadState('networkidle', { timeout: NET_IDLE }).catch(() => {});
      await sleep(250);

      const { cap, avail } = await page.evaluate(() => {
        const seats = Array.from(document.querySelectorAll(
          '.seat, [class*="seat"], svg [data-seat], svg [data-status], svg [class*="seat"]'
        ));
        const isAvail = (el) => {
          const cls = (el.getAttribute('class') || '').toLowerCase();
          const ds = (el.getAttribute('data-status') || '').toLowerCase();
          const fill = (getComputedStyle(el).fill || '').toLowerCase();
          if (/unavailable|taken|sold|reserved|blocked|held/.test(cls) || /unavailable|taken|sold|reserved/.test(ds)) return false;
          if (/available|free/.test(cls) || /available|free/.test(ds)) return true;
          if (fill && /#?ccc|#?bbb|gray|grey/.test(fill)) return false;
          return !/selected/.test(cls);
        };
        const cap = seats.length;
        const avail = seats.filter(isAvail).length;
        return { cap, avail };
      });

      if (cap > 0) { totCap += cap; totAvail += avail; }
    } catch {
      // keep going — some zones may not render / be hidden
    }
  }

  if (totCap > 0) return { capacity: totCap, remaining: totAvail };
  return null;
}

/** Compute final pct_sold using Ticketsolve (network -> DOM -> fallback) */
async function computeTicketsolvePct(page, url) {
  // normalise URL to /seats
  let seatsUrl = url;
  if (!/\/seats\b/.test(seatsUrl)) seatsUrl = seatsUrl.replace(/\/$/, '') + '/seats';

  // 1) network sniff
  let res = await probeTicketsolveViaNetwork(page, seatsUrl);
  if (!res) {
    // 2) DOM walk
    res = await probeTicketsolveViaDOM(page, seatsUrl);
  }

  if (!res) return null;
  const cap = res.capacity;
  const remaining = clamp(res.remaining, 0, cap);
  const sold = cap - remaining;
  const pct = clamp(round((sold / cap) * 100), 0, 100);
  return { capacity: cap, remaining, sold, pct };
}

/* ---------- List page scraping ---------- */

async function expand(page) {
  let prev = -1;
  for (let i = 0; i < 8; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === prev) break;
    prev = h;
    await page.mouse.wheel(0, h);
    await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => {});
    await sleep(200);
  }
}

async function collectPaginationUrls(page) {
  const urls = new Set([LIST_URL]);
  const add = (u) => { try { urls.add(new URL(u, LIST_URL).href); } catch {} };

  const anchors = await page.$$eval('a.page-numbers, nav a, .pagination a', as =>
    as.map(a => a.getAttribute('href') || '').filter(Boolean)
  );
  anchors.forEach(add);

  const nextRel = await page.getAttribute('link[rel="next"]', 'href').catch(() => null);
  if (nextRel) add(nextRel);

  const maxNum = await page.evaluate(() => {
    const nums = Array.from(document.querySelectorAll('a.page-numbers, nav a'))
      .map(el => (el.textContent || '').trim())
      .map(t => Number(t))
      .filter(n => Number.isFinite(n));
    return nums.length ? Math.max(...nums) : 1;
  });
  if (maxNum > 1) {
    for (let p = 2; p <= maxNum; p++) {
      add(`/whats-on/page/${p}/`);
      add(`?pg=${p}`);
      add(`?sf_paged=${p}`);
    }
  }
  return Array.from(urls);
}

async function extractCardsFromPage(page) {
  return await page.evaluate(() => {
    const T = (el) => (el?.innerText || el?.textContent || '').trim();
    const isCTAish = (el) => {
      const cls = (el?.className || '').toString().toLowerCase();
      return /\bcta\b|\bbtn\b|button/.test(cls);
    };
    const goodStatus = (s) => /sold\s*out|limited|book\s*now/i.test(s) && !/more\s*info/i.test(s);

    const cards = Array.from(document.querySelectorAll('.card-event, article, .card'))
      .filter(n => n.querySelector('h2, h3, .title'));

    const items = [];
    for (const n of cards) {
      const titleEl = n.querySelector('h3 a, h3, .title a, .title, h2 a, h2');
      const title = T(titleEl);

      const timeEl = n.querySelector('time[datetime]') || n.querySelector('time');
      const datetime = timeEl?.getAttribute?.('datetime') || '';
      const dateText = datetime || T(timeEl) || T(n.querySelector('.date'));

      const ctas = Array.from(n.querySelectorAll('a,button,span')).filter(isCTAish);
      let status = '';
      let ticketsHref = '';

      const pref = ctas.find(el => goodStatus(T(el))) || ctas.find(el => /book|sold|limited/i.test(T(el)));
      if (pref) {
        status = T(pref);
        if (pref.tagName === 'A' && pref.getAttribute('href')) {
          ticketsHref = pref.getAttribute('href');
        }
      }
      if (!/ticketsolve/i.test(ticketsHref)) {
        const ts = n.querySelector('a[href*="ticketsolve"]');
        if (ts) ticketsHref = ts.getAttribute('href') || '';
      }

      let eventHref = '';
      const anyA = n.querySelector('a[href]');
      if (anyA) eventHref = anyA.getAttribute('href') || '';

      // normalise to absolute
      const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
      items.push({
        title,
        datetime,
        dateText,
        status,
        ticketsHref: ticketsHref ? abs(ticketsHref) : '',
        eventHref: eventHref ? abs(eventHref) : ''
      });
    }
    return items.filter(i => i.title);
  });
}

async function findTicketsolveOnEventPage(page, eventUrl) {
  try {
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    const a = page.locator('a[href*="ticketsolve"]');
    if (await a.count()) {
      const href = await a.first().getAttribute('href');
      if (href) return new URL(href, eventUrl).href;
    }
    const btn = page.locator('[data-href*="ticketsolve"]');
    if (await btn.count()) {
      const href = await btn.first().getAttribute('data-href');
      if (href) return new URL(href, eventUrl).href;
    }
  } catch {}
  return '';
}

/* ---------- run ---------- */

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: `Mozilla/5.0 (${os.platform()}; ${os.arch()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36`
  });

  try {
    // collect all list pages
    const p0 = await context.newPage();
    await p0.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await p0.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await expand(p0);
    const pageUrls = await collectPaginationUrls(p0);
    await p0.close();

    // extract cards from each page
    const rawCards = [];
    for (const url of pageUrls) {
      const p = await context.newPage();
      try {
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await p.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        await expand(p);
        rawCards.push(...await extractCardsFromPage(p));
      } catch (e) {
        console.warn('[list] failed', url, e.message);
      } finally {
        await p.close().catch(() => {});
      }
    }

    const cards = uniqBy(rawCards, c => `${c.title}|${c.datetime || c.dateText}`);
    if (!cards.length) throw new Error('No events found');

    // create a small pool of pages for Ticketsolve
    const tsPages = [];
    for (let i = 0; i < TS_CONCURRENCY; i++) tsPages.push(await context.newPage());

    // enrich with real percentages
    const out = [];
    for (let i = 0; i < cards.length; i++) {
      const it = cards[i];
      const idx = i % TS_CONCURRENCY;
      let ticketsUrl = it.ticketsHref;

      // find ticketsolve inside event page if missing
      if (!/ticketsolve/i.test(ticketsUrl) && it.eventHref) {
        ticketsUrl = await findTicketsolveOnEventPage(tsPages[idx], it.eventHref);
      }

      // ISO date
      const start =
        (it.datetime && toISO(it.datetime)) ||
        (it.dateText && toISO(it.dateText)) ||
        null;

      let pct = null;
      if (ticketsUrl) {
        try {
          const res = await computeTicketsolvePct(tsPages[idx], ticketsUrl);
          if (res?.pct != null) pct = res.pct;
        } catch (e) {
          // swallow and fallback
        }
      }
      if (pct == null) pct = statusToPct(it.status);

      out.push({
        title: it.title,
        start,
        status: (it.status || '').toUpperCase(),
        override_pct: pct
      });
    }

    const final = uniqBy(out, e => `${e.title}|${e.start}|${e.status}|${e.override_pct}`);
    await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
    await fs.writeFile(OUT_FILE, JSON.stringify(final, null, 2), 'utf8');
    console.log(`Wrote ${final.length} events → ${OUT_FILE}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch(err => {
  console.error(err?.stack || err);
  process.exit(1);
});
