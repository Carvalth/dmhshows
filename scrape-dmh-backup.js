import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const LIST_URL = 'https://demontforthall.co.uk/whats-on/';
const OUT_FILE = path.join('public', 'dmh-events.json');

const HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';
const TIMEOUT = 45000;
const NET_IDLE = 3500;
const TS_CONCURRENCY = 3;

/* utils */
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

async function collectPaginationUrls(page) {
  const urls = new Set([LIST_URL]);
  const add = (u) => { try { urls.add(new URL(u, LIST_URL).href); } catch {} };

  const anchors = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')));
  anchors.forEach(add);

  const nums = await page.$$eval('a.page-numbers, nav a', as =>
    as.map(a => parseInt((a.textContent || '').trim(), 10)).filter(n => Number.isFinite(n))
  );
  const maxNum = nums.length ? Math.max(...nums) : 1;
  for (let p = 2; p <= maxNum; p++) add(`/whats-on/page/${p}/`);

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

      let status = '';
      let ticketsHref = '';
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
      const more = n.querySelector('a[href*="/event/"], a[href*="/events/"], a[href*="/event-"], a[href]');
      if (more) eventHref = more.getAttribute('href') || '';

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

/* ---------- Ticketsolve seat counting ---------- */

async function selectZone(page, zoneText, zoneValue) {
  // native <select>
  const sel = page.locator('select');
  if (await sel.count()) {
    try {
      if (zoneValue) {
        await sel.selectOption(zoneValue);
      } else {
        const target = await sel.evaluateHandle((s, txt) => {
          const t = (txt || '').toLowerCase();
          const opt = Array.from(s.options).find(o => (o.textContent || '').toLowerCase().includes(t));
          return opt || null;
        }, zoneText);
        if (target) {
          const value = await target.evaluate(opt => opt.value);
          await sel.selectOption(value);
        }
      }
      return true;
    } catch {}
  }
  // custom dropdown
  const listBox = page.locator('[role="listbox"]');
  if (await listBox.count()) {
    try {
      await listBox.click();
      const opt = page.locator('[role="option"]', { hasText: zoneText }).first();
      if (await opt.count()) {
        await opt.click();
        return true;
      }
    } catch {}
  }
  return false;
}

async function readZones(page) {
  // native
  if (await page.locator('select').count()) {
    return await page.evaluate(() => {
      const s = document.querySelector('select');
      return s ? Array.from(s.options)
        .map(o => ({ value: o.value, text: (o.textContent || '').trim() }))
        .filter(o => o.value && !/select/i.test(o.text)) : [];
    });
  }
  // custom
  if (await page.locator('[role="listbox"]').count()) {
    await page.locator('[role="listbox"]').click().catch(() => {});
    const zones = await page.$$eval('[role="option"]', os =>
      os.map(el => ({
        value: el.getAttribute('data-value') || (el.textContent || '').trim(),
        text: (el.textContent || '').trim()
      })).filter(o => o.value)
    );
    // close again
    await page.keyboard.press('Escape').catch(() => {});
    return zones;
  }
  return [];
}

async function countSeatsNow(page) {
  return await page.evaluate(() => {
    // gather plausible seat nodes
    const seats = Array.from(document.querySelectorAll(
      'svg [data-seat], svg [data-status], [role="button"][aria-label*="seat" i], [class*="seat"]'
    ));
    if (!seats.length) return { cap: 0, avail: 0 };

    const isAvailable = (el) => {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const ds = (el.getAttribute('data-status') || '').toLowerCase();
      const cls = (el.getAttribute('class') || '').toLowerCase();

      // aria/data first (most reliable)
      if (/unavailable|not available|sold|taken|reserved|occupied|held/.test(label)) return false;
      if (/available|free/.test(label)) return true;
      if (/unavailable|sold|taken|reserved|occupied|held/.test(ds)) return false;
      if (/available|free/.test(ds)) return true;

      // class hints
      if (/\b(unavailable|sold|taken|reserved|blocked|held)\b/.test(cls)) return false;
      if (/\b(available|free)\b/.test(cls)) return true;

      // interactivity: focusable/clickable seats are typically available
      const pe = getComputedStyle(el).pointerEvents;
      const op = parseFloat(getComputedStyle(el).opacity);
      const tab = el.getAttribute('tabindex');
      const clickable = (pe !== 'none') && (op > 0.2) && (tab !== '-1');
      if (clickable) return true;

      return false;
    };

    const cap = seats.length;
    const avail = seats.filter(isAvailable).length;
    return { cap, avail };
  });
}

async function computeTicketsolvePct(page, url) {
  // normalise to /seats
  let seatsUrl = url;
  if (!/\/seats\b/.test(seatsUrl)) seatsUrl = seatsUrl.replace(/\/$/, '') + '/seats';

  try {
    await page.goto(seatsUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  } catch { return null; }

  // read zones; if none, just count once
  let zones = await readZones(page);
  if (!zones.length) {
    const single = await countSeatsNow(page);
    if (single.cap > 0) {
      const sold = single.cap - single.avail;
      const pct = clamp(round((sold / single.cap) * 100), 0, 100);
      return { capacity: single.cap, remaining: single.avail, sold, pct };
    }
    return null;
  }

  // iterate all zones
  let totalCap = 0, totalAvail = 0;
  for (const z of zones) {
    const ok = await selectZone(page, z.text, z.value);
    if (!ok) continue;
    await page.waitForLoadState('networkidle', { timeout: NET_IDLE }).catch(() => {});
    await sleep(350);
    const { cap, avail } = await countSeatsNow(page);
    if (cap > 0) { totalCap += cap; totalAvail += avail; }
  }

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
    const pageUrls = await collectPaginationUrls(p0);
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
        console.warn('List fail', url, e.message);
      } finally { await p.close().catch(() => {}); }
    }
    const cards = uniqBy(raw, x => `${x.title}|${x.datetime || x.dateText}`);

    const tsPages = [];
    for (let i = 0; i < TS_CONCURRENCY; i++) tsPages.push(await context.newPage());

    const out = [];
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const p = tsPages[i % TS_CONCURRENCY];

      let tickets = c.ticketsHref;
      if (!/ticketsolve/i.test(tickets) && c.eventHref) {
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

    const final = uniqBy(out, x => `${x.title}|${x.start}|${x.status}|${x.override_pct}`);
    await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
    await fs.writeFile(OUT_FILE, JSON.stringify(final, null, 2), 'utf8');
    console.log(`Wrote ${final.length} events → ${OUT_FILE}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch(e => { console.error(e); process.exit(1); });
