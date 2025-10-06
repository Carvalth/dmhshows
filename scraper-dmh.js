// scraper-dmh.js
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const LIST_URL = 'https://demontforthall.co.uk/whats-on/';
const OUT_FILE = path.join('public', 'dmh-events.json');

const HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';
const TIMEOUT = 45000;
const NET_IDLE = 3500;
const CONCURRENCY = 3;

/* ---------- helpers ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round = (x) => Math.round(x);
const uniqBy = (arr, keyFn) => {
  const seen = new Set(); const out = [];
  for (const v of arr) { const k = keyFn(v); if (!seen.has(k)) { seen.add(k); out.push(v); } }
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
const toISO = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const isHttp = (u) => /^https?:\/\//i.test(u);
const isWhatsOn = (u) => /^https?:\/\/[^/]*demontforthall\.co\.uk\/whats-on\//i.test(u);

/* ---------- list crawling ---------- */

async function expand(page) {
  let prev = -1;
  for (let i = 0; i < 8; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === prev) break;
    prev = h;
    await page.mouse.wheel(0, h);
    await page.waitForLoadState('networkidle', { timeout: 1200 }).catch(() => {});
    await sleep(200);
  }
}

// NEW: only return real "What's On" pagination URLs
async function collectPaginationUrls(page) {
  const urls = new Set([LIST_URL]);

  // numbers in pagination
  const nums = await page.$$eval('a.page-numbers, nav a', as =>
    as.map(a => parseInt((a.textContent || '').trim(), 10)).filter(Number.isFinite)
  );
  const maxNum = nums.length ? Math.max(...nums) : 1;
  for (let p = 2; p <= maxNum; p++) urls.add(new URL(`/whats-on/page/${p}/`, LIST_URL).href);

  // also capture explicit links that look like paging
  const anchors = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')));
  for (const href of anchors) {
    if (!href) continue;
    const abs = new URL(href, LIST_URL).href;
    if (isWhatsOn(abs)) urls.add(abs);
  }
  return Array.from(urls);
}

async function extractCardsFromPage(page) {
  return await page.evaluate(() => {
    const T = (el) => (el?.innerText || el?.textContent || '').trim();
    const isCTA = (el) => /\b(btn|button|cta|primary)\b/i.test(el?.className || '');
    const goodStatus = (s) => /sold\s*out|limited|book\s*now/i.test(s) && !/more\s*info/i.test(s);

    const cards = Array.from(document.querySelectorAll('.card-event, article, .card'))
      .filter(n => n.querySelector('h2, h3, .title'));

    const items = [];
    for (const n of cards) {
      const title = T(n.querySelector('h3 a, h3, .title a, .title, h2 a, h2'));
      if (!title) continue;

      const timeEl = n.querySelector('time[datetime]') || n.querySelector('time') || n.querySelector('.date');
      const datetime = timeEl?.getAttribute?.('datetime') || '';
      const dateText = datetime || T(timeEl);

      let status = ''; let ticketsHref = '';
      const ctas = Array.from(n.querySelectorAll('a,button,span')).filter(isCTA);
      const pref = ctas.find(el => goodStatus(T(el))) || ctas.find(el => /book|sold|limited/i.test(T(el)));
      if (pref) {
        status = T(pref);
        if (pref.tagName === 'A' && pref.getAttribute('href')) ticketsHref = pref.getAttribute('href');
      }
      if (!/ticketsolve/i.test(ticketsHref)) {
        const ts = n.querySelector('a[href*="ticketsolve"]');
        if (ts) ticketsHref = ts.getAttribute('href') || '';
      }

      let eventHref = '';
      const more = n.querySelector('a[href*="/event/"], a[href*="/events/"], a[href*="/event-"]');
      if (more) eventHref = more.getAttribute('href') || '';

      const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
      items.push({ title, datetime, dateText, status, ticketsHref: ticketsHref ? abs(ticketsHref) : '', eventHref: eventHref ? abs(eventHref) : '' });
    }
    return items;
  });
}

async function findTicketsolveOnEventPage(page, eventUrl) {
  try {
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
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

/* ---------- Ticketsolve seat extraction ---------- */

// Robust JSON scanner – counts any object that looks like a seat with availability info
function summariseSeatPayload(data) {
  let cap = 0, avail = 0;
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return; seen.add(node);

    if (Array.isArray(node)) { node.forEach(visit); return; }

    const keys = Object.keys(node);
    const looksLikeSeat = (
      ('seat' in node || 'seatId' in node || 'id' in node || 'x' in node || 'row' in node) &&
      ('available' in node || 'isAvailable' in node || 'status' in node || 'state' in node)
    );
    if (looksLikeSeat) {
      cap += 1;
      const s = String(node.status ?? node.state ?? '').toLowerCase();
      const a = node.available ?? node.isAvailable;
      if (a === true || /available|free|open/.test(s)) avail += 1;
    }
    for (const k of keys) visit(node[k]);
  };
  visit(data);
  return { cap, avail };
}

async function extractAvailabilityFromNetwork(page) {
  const payloads = [];
  const handler = async (resp) => {
    try {
      const url = resp.url();
      // only JSON/XHR relevant to seats
      if (!/events?\/\d+\/(seats|availability|seatmap)|seat|avail|inventory|map/i.test(url)) return;
      const ct = resp.headers()['content-type'] || '';
      if (!/json|javascript/i.test(ct)) return;
      const data = await resp.json();
      const sum = summariseSeatPayload(data);
      if (sum.cap > 0) payloads.push(sum);
    } catch {}
  };
  page.on('response', handler);
  return {
    stop: () => page.off('response', handler),
    read: () => {
      if (!payloads.length) return null;
      // merge all
      const total = payloads.reduce((a,b)=>({cap:a.cap+b.cap, avail:a.avail+b.avail}), {cap:0, avail:0});
      return total.cap > 0 ? total : null;
    }
  };
}

async function selectZone(page, zoneText, zoneValue) {
  // native <select>
  const sel = page.locator('select');
  if (await sel.count()) {
    try {
      if (zoneValue) {
        await sel.selectOption(zoneValue);
      } else {
        const value = await sel.evaluate((s, txt) => {
          const t = (txt || '').toLowerCase();
          const opt = Array.from(s.options).find(o => (o.textContent || '').toLowerCase().includes(t));
          return opt ? opt.value : null;
        }, zoneText);
        if (value) await sel.selectOption(value);
      }
      return true;
    } catch {}
  }
  // custom listbox
  const listBox = page.locator('[role="listbox"]');
  if (await listBox.count()) {
    try {
      await listBox.click();
      const opt = page.locator('[role="option"]', { hasText: zoneText }).first();
      if (await opt.count()) { await opt.click(); return true; }
    } catch {}
  }
  return false;
}

async function readZones(page) {
  if (await page.locator('select').count()) {
    return await page.evaluate(() => {
      const s = document.querySelector('select');
      return s ? Array.from(s.options)
        .map(o => ({ value: o.value, text: (o.textContent || '').trim() }))
        .filter(o => o.value && !/select/i.test(o.text)) : [];
    });
  }
  if (await page.locator('[role="listbox"]').count()) {
    await page.locator('[role="listbox"]').click().catch(() => {});
    const zones = await page.$$eval('[role="option"]', os =>
      os.map(el => ({
        value: el.getAttribute('data-value') || (el.textContent || '').trim(),
        text: (el.textContent || '').trim()
      })).filter(o => o.value)
    );
    await page.keyboard.press('Escape').catch(() => {});
    return zones;
  }
  return [];
}

// last-ditch DOM heuristic (may be 0 if canvas only)
async function countSeatsNow(page) {
  return await page.evaluate(() => {
    const seats = Array.from(document.querySelectorAll(
      'svg [data-seat], svg [data-status], [role="button"][aria-label*="seat" i], [class*="seat"]'
    ));
    if (!seats.length) return { cap: 0, avail: 0 };
    const isAvailable = (el) => {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const ds = (el.getAttribute('data-status') || '').toLowerCase();
      const cls = (el.getAttribute('class') || '').toLowerCase();
      if (/unavailable|not available|sold|taken|reserved|occupied|held/.test(label)) return false;
      if (/available|free/.test(label)) return true;
      if (/unavailable|sold|taken|reserved|occupied|held/.test(ds)) return false;
      if (/available|free/.test(ds)) return true;
      if (/\b(unavailable|sold|taken|reserved|blocked|held)\b/.test(cls)) return false;
      if (/\b(available|free)\b/.test(cls)) return true;
      const pe = getComputedStyle(el).pointerEvents;
      const op = parseFloat(getComputedStyle(el).opacity);
      const tab = el.getAttribute('tabindex');
      return (pe !== 'none') && (op > 0.2) && (tab !== '-1');
    };
    const cap = seats.length;
    const avail = seats.filter(isAvailable).length;
    return { cap, avail };
  });
}

async function computeTicketsolvePct(page, url) {
  let seatsUrl = url;
  if (!/\/seats\b/.test(seatsUrl)) seatsUrl = seatsUrl.replace(/\/$/, '') + '/seats';

  // capture network JSON the seatmap fetches
  const tap = await extractAvailabilityFromNetwork(page);

  try {
    await page.goto(seatsUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  } catch { tap.stop(); return null; }

  // if we saw API payloads already, use them
  let net = tap.read();
  if (net && net.cap > 0) {
    tap.stop();
    const sold = net.cap - net.avail;
    const pct = clamp(round((sold / net.cap) * 100), 0, 100);
    return { capacity: net.cap, remaining: net.avail, sold, pct };
  }

  // else: iterate zones and keep listening (some endpoints load per-zone)
  let zones = await readZones(page);
  if (!zones.length) zones = [{ text: 'All', value: null }];
  let totalCap = 0, totalAvail = 0;

  for (const z of zones) {
    await selectZone(page, z.text, z.value).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: NET_IDLE }).catch(() => {});
    await sleep(350);

    // prefer network payload if it appeared
    net = tap.read();
    if (net && net.cap > 0) { totalCap = net.cap; totalAvail = net.avail; break; }

    // fallback DOM probe
    const { cap, avail } = await countSeatsNow(page);
    if (cap > 0) { totalCap += cap; totalAvail += avail; }
  }
  tap.stop();

  if (totalCap > 0) {
    const sold = totalCap - totalAvail;
    const pct = clamp(round((sold / totalCap) * 100), 0, 100);
    return { capacity: totalCap, remaining: totalAvail, sold, pct };
  }
  return null;
}

/* ---------- main ---------- */

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: `Mozilla/5.0 (${os.platform()}; ${os.arch()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36`
  });

  try {
    const p0 = await context.newPage();
    await p0.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await p0.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await expand(p0);
    const pageUrls = (await collectPaginationUrls(p0))
      .filter(u => isHttp(u) && isWhatsOn(u)); // <-- prevent tel:, mailto:, javascript:
    await p0.close();

    const raw = [];
    for (const url of pageUrls) {
      const p = await context.newPage();
      try {
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await p.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        await expand(p);
        raw.push(...await extractCardsFromPage(p));
      } catch (e) {
        console.warn('List page failed', url, e.message);
      } finally { await p.close().catch(() => {}); }
    }
    const cards = uniqBy(raw, x => `${x.title}|${x.datetime || x.dateText}`);

    // pool of pages for concurrent Ticketsolve work
    const tsPages = [];
    for (let i = 0; i < CONCURRENCY; i++) tsPages.push(await context.newPage());

    const out = [];
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const p = tsPages[i % CONCURRENCY];

      let tickets = c.ticketsHref;
      if ((!tickets || !/ticketsolve/i.test(tickets)) && c.eventHref) {
        tickets = await findTicketsolveOnEventPage(p, c.eventHref);
      }

      const start = (c.datetime && toISO(c.datetime)) || (c.dateText && toISO(c.dateText)) || null;

      let pct = null;
      if (tickets) {
        try {
          const r = await computeTicketsolvePct(p, tickets);
          if (r?.pct != null) pct = r.pct;
        } catch {}
      }
      if (pct == null) pct = statusToPct(c.status);

      out.push({
        title: c.title,
        start,
        status: (c.status || '').toUpperCase(),
        override_pct: pct
      });
    }

    const final = uniqBy(out, x => `${x.title}|${x.start}|${x.override_pct}`);
    await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
    await fs.writeFile(OUT_FILE, JSON.stringify(final, null, 2), 'utf8');
    console.log(`Wrote ${final.length} events → ${OUT_FILE}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
