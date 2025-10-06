import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const LIST_URL = 'https://demontforthall.co.uk/whats-on/';
const OUT_FILE = path.join('public', 'dmh-events.json');
const DIAG_DIR = 'diagnostics';

const HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';
const TIMEOUT = 60000;
const NET_IDLE = 4500;
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

async function ensureDir(p){ await fs.mkdir(p, { recursive: true }).catch(()=>{}); }

/* ---------- time extraction helpers (NEW) ---------- */
function extractTimePartsFromText(txt=''){
  // 24h HH:MM
  let m = txt.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return { h: parseInt(m[1],10), m: parseInt(m[2],10) };
  // 12h h(:mm)? am/pm
  m = txt.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
  if (m){
    let h = parseInt(m[1],10);
    let mi = m[2] ? parseInt(m[2],10) : 0;
    const ap = m[3].toLowerCase();
    if (ap==='pm' && h<12) h+=12;
    if (ap==='am' && h===12) h=0;
    return { h, m: mi };
  }
  return null;
}
const pad = (n) => String(n).padStart(2,'0');
function makeISOFromLocalParts(y,m,d,h,mi){
  const local = new Date(`${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(mi)}:00`);
  return isNaN(local.getTime()) ? null : local.toISOString();
}

async function extractStartISOFromPage(page, baseY, baseM, baseD){
  // <time datetime="...">
  try{
    const t = await page.locator('time[datetime]').first().getAttribute('datetime');
    if (t && /\dT\d/.test(t)) {
      const iso = new Date(t).toISOString();
      if (!isNaN(new Date(iso))) return iso;
    }
  }catch{}

  // schema.org JSON-LD
  try{
    const blocks = await page.$$eval('script[type="application/ld+json"]', ss => ss.map(s => s.textContent || ''));
    for (const b of blocks){
      try{
        const obj = JSON.parse(b);
        const arr = Array.isArray(obj) ? obj : [obj];
        for (const o of arr){
          const sd = o && (o.startDate || o.start || o.start_time || (o.event && o.event.startDate));
          if (sd){
            const iso = new Date(sd).toISOString();
            if (!isNaN(new Date(iso))) return iso;
          }
        }
      }catch{}
    }
  }catch{}

  // free-text “19:00”, “7:30pm”, etc.
  try{
    const txt = await page.evaluate(() => document.body.innerText || '');
    const tm = extractTimePartsFromText(txt);
    if (tm) {
      const iso = makeISOFromLocalParts(baseY, baseM, baseD, tm.h, tm.m);
      if (iso) return iso;
    }
  }catch{}

  return null;
}

async function discoverStartISO(page, currentStartISO, eventUrl, ticketsUrl){
  if (!currentStartISO) return null;
  const d = new Date(currentStartISO);
  const y = d.getUTCFullYear(), m = d.getUTCMonth()+1, day = d.getUTCDate();

  // keep if not midnight already
  const hh = d.getUTCHours(), mm = d.getUTCMinutes();
  if (!(hh===0 && mm===0)) return currentStartISO;

  // try DMH event page
  if (eventUrl){
    try{
      await page.goto(eventUrl, { waitUntil:'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(()=>{});
      const iso = await extractStartISOFromPage(page, y, m, day);
      if (iso) return iso;
    }catch{}
  }
  // try Ticketsolve seats
  if (ticketsUrl){
    let seatsUrl = ticketsUrl;
    if (!/\/seats\b/.test(seatsUrl)) seatsUrl = seatsUrl.replace(/\/$/, '') + '/seats';
    try{
      await page.goto(seatsUrl, { waitUntil:'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(()=>{});
      const iso = await extractStartISOFromPage(page, y, m, day);
      if (iso) return iso;
    }catch{}
  }
  return currentStartISO; // fallback: leave midnight
}

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

  const nums = await page.$$eval('a.page-numbers, nav a', as =>
    as.map(a => parseInt((a.textContent || '').trim(), 10)).filter(Number.isFinite)
  );
  const maxNum = nums.length ? Math.max(...nums) : 1;
  for (let p = 2; p <= maxNum; p++) urls.add(new URL(`/whats-on/page/${p}/`, LIST_URL).href);

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

/* ---------- seat payload parsing ---------- */

// Heuristic seat summarizer: crawl any structure and count capacity/available.
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

/* capture network + websockets, write diagnostics, and expose the best summary seen */
async function tapAvailability(page, diagId) {
  const hits = [];
  const diag = { responses: [], ws: [] };

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const type = resp.request().resourceType();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!/json|javascript|text/.test(ct) && !/xhr|fetch/.test(type)) return;

      const text = await resp.text();
      if (!text) return;

      // Save for diagnostics
      diag.responses.push({ url, ct, type, size: text.length });

      // Try JSON parse; fall back to embedded JSON detection
      let data = null;
      try { data = JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (m) { try { data = JSON.parse(m[0]); } catch {} }
      }
      if (!data) return;

      const sum = summariseSeatPayload(data);
      if (sum.cap > 0) hits.push(sum);
    } catch {}
  });

  page.on('websocket', ws => {
    const rec = { url: ws.url(), frames: [] };
    diag.ws.push(rec);
    ws.on('framereceived', data => {
      rec.frames.push({ in: true, size: (data||'').length });
      try {
        const obj = JSON.parse(data);
        const sum = summariseSeatPayload(obj);
        if (sum.cap > 0) hits.push(sum);
      } catch {}
    });
    ws.on('framesent', data => { rec.frames.push({ out: true, size: (data||'').length }); });
  });

  return {
    best: () => {
      if (!hits.length) return null;
      const best = hits.reduce((a,b) => (b.cap > a.cap ? b : a), { cap:0, avail:0 });
      return best;
    },
    async flush() {
      await ensureDir(DIAG_DIR);
      await fs.writeFile(path.join(DIAG_DIR, `${diagId}.json`), JSON.stringify(diag, null, 2));
    }
  };
}

/* activate seat map reliably */
async function activateSeatMap(page) {
  const consent = page.locator('button:has-text("Accept") , button:has-text("I Agree"), button[aria-label*="accept" i]');
  if (await consent.count()) { await consent.first().click().catch(()=>{}); }

  const seatCanvas = page.locator('canvas, [id*="seat"], [class*="seatmap"], svg');
  if (await seatCanvas.count()) await seatCanvas.first().scrollIntoViewIfNeeded().catch(()=>{});

  const price = page.locator('label:has-text("Full") , [for*="Full"], [role="radio"]:has-text("Full")');
  if (await price.count()) await price.first().click().catch(()=>{});

  const listbox = page.locator('[role="listbox"], select');
  if (await listbox.count()) { await listbox.first().click().catch(()=>{}); await page.keyboard.press('Escape').catch(()=>{}); }

  await page.waitForLoadState('networkidle', { timeout: NET_IDLE }).catch(()=>{});
  await sleep(600);
}

async function selectZone(page, zoneText, zoneValue) {
  const sel = page.locator('select');
  if (await sel.count()) {
    try {
      if (zoneValue) await sel.selectOption(zoneValue);
      else {
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

async function computeTicketsolvePct(page, url, diagName) {
  let seatsUrl = url;
  if (!/\/seats\b/.test(seatsUrl)) seatsUrl = seatsUrl.replace(/\/$/, '') + '/seats';

  const tap = await tapAvailability(page, diagName);

  try {
    await page.goto(seatsUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  } catch { await tap.flush(); return null; }

  await activateSeatMap(page);

  // first try: any network payload already?
  let best = tap.best();
  if (best && best.cap > 0) {
    await tap.flush();
    const sold = best.cap - best.avail;
    const pct = clamp(round((sold / best.cap) * 100), 0, 100);
    return { capacity: best.cap, remaining: best.avail, sold, pct };
  }

  // else iterate zones; some APIs fire per-zone
  let zones = await readZones(page);
  if (!zones.length) zones = [{ text: 'All', value: null }];

  let totalCap = 0, totalAvail = 0;
  for (const z of zones) {
    await selectZone(page, z.text, z.value).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: NET_IDLE }).catch(() => {});
    await sleep(600);

    best = tap.best();
    if (best && best.cap > 0) { totalCap = best.cap; totalAvail = best.avail; break; }

    // last-ditch DOM probe
    const { cap, avail } = await countSeatsNow(page);
    if (cap > 0) { totalCap += cap; totalAvail += avail; }
  }

  await tap.flush();

  if (totalCap > 0) {
    const sold = totalCap - totalAvail;
    const pct = clamp(round((sold / totalCap) * 100), 0, 100);
    return { capacity: totalCap, remaining: totalAvail, sold, pct };
  }
  return null;
}

/* ---------- main ---------- */

async function main() {
  await ensureDir(path.dirname(OUT_FILE));
  await ensureDir(DIAG_DIR);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: `Mozilla/5.0 (${os.platform()}; ${os.arch()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36`
  });

  try {
    const p0 = await context.newPage();
    await p0.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await p0.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await expand(p0);
    const pageUrls = (await collectPaginationUrls(p0)).filter(u => isHttp(u) && isWhatsOn(u));
    await p0.close();

    const raw = [];
    for (const url of pageUrls) {
      const p = await context.newPage();
      try {
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await p.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await expand(p);
        raw.push(...await extractCardsFromPage(p));
      } catch (e) {
        console.warn('List page failed', url, e.message);
      } finally { await p.close().catch(() => {}); }
    }
    const cards = uniqBy(raw, x => `${x.title}|${x.datetime || x.dateText}`);

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

      let start = (c.datetime && toISO(c.datetime)) || (c.dateText && toISO(c.dateText)) || null;

      // NEW: refine start time (get real HH:MM)
      try {
        if (start) {
          const refined = await discoverStartISO(p, start, c.eventHref, tickets);
          if (refined) start = refined;
        }
      } catch {}

      let pct = null;
      if (tickets) {
        try {
          const r = await computeTicketsolvePct(p, tickets, `${(c.title||'event').slice(0,60).replace(/[^\w\-]+/g,'_')}-${start||'no-date'}`);
          if (r?.pct != null) pct = r.pct;
        } catch (e) {
          console.warn('Ticketsolve failed', c.title, e.message);
        }
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
    await fs.writeFile(OUT_FILE, JSON.stringify(final, null, 2), 'utf8');
    console.log(`Wrote ${final.length} events → ${OUT_FILE}`);
    console.log(`Diagnostics saved in: ./${DIAG_DIR}/ (one JSON per event)`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
