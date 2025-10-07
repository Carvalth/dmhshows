import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const LIST_URL = 'https://demontforthall.co.uk/whats-on/';
const OUT_FILE = path.join('public', 'dmh-events.json');
const DIAG_DIR = 'diagnostics';

// allow override via --headless=false
let HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';
const TIMEOUT = 60000;
const NET_IDLE = 4500;
const CONCURRENCY = 3;

/* ---------------- CLI knobs ----------------
   --limit=20          only process first N events
   --from=2025-10-01   only events on/after this (ISO date)
   --to=2025-12-31     only events on/before this (ISO date)
   --perEventMs=25000  watchdog per event
   --headless=false    show the browser
*/
const argv = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const LIMIT        = Number.isFinite(+argv.limit) ? +argv.limit : Infinity;
const FROM_DATE    = argv.from ? new Date(argv.from) : null;
const TO_DATE      = argv.to ? new Date(argv.to) : null;
const PER_EVENT_MS = Number.isFinite(+argv.perEventMs) ? +argv.perEventMs : 45000;
if (typeof argv.headless === 'string') HEADLESS = argv.headless !== 'false';

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

async function withDeadline(promise, ms, label='task'){
  return Promise.race([
    promise,
    (async()=>{ await sleep(ms); throw new Error(`timeout: ${label} after ${ms}ms`); })()
  ]);
}

// ---- timezone helpers (store both UTC + local wall-clock) ----
const TZ = 'Europe/London';

function localWallclockFromUTC(iso, tz = TZ) {
  if (!iso) return { local: null, tz };
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (t) => parts.find(p => p.type === t)?.value;
  const y  = get('year');
  const mo = get('month');
  const da = get('day');
  const hh = get('hour');
  const mi = get('minute');

  return { local: `${y}-${mo}-${da}T${hh}:${mi}:00`, tz };
}


/* ----------------------- TIME FINDER ----------------------- */
async function extractStartFromTicketsolveRow(page, y, m, d){
  const two = n => String(n).padStart(2,'0');

  // Wait for the header row that contains the a11y "Dates:" label,
  // or for any visible HH:MM near the top of the page.
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await page.waitForSelector('main, header, [role="main"]', { timeout: 6000 }).catch(()=>{});
  await page.waitForSelector('.sr-only:text-matches("^\\s*Dates:\\s*$", "i"), text=/\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b/', { timeout: 6000 }).catch(()=>{});
  await page.waitForTimeout(800); // give React a beat

  // Prefer: same row as "Dates:" label
  const hasLabel = page.locator('.sr-only').filter({ hasText: /(^|\s)Dates:\s*$/i });
  if (await hasLabel.count()){
    const row = hasLabel.first().locator('..'); // parent wrapper
    const hhmm = await row.getByText(/\b([01]?\d|2[0-3]):([0-5]\d)\b/).first().textContent().catch(()=>null);
    if (hhmm){
      const m24 = hhmm.match(/([01]?\d|2[0-3]):([0-5]\d)/);
      if (m24){
        const hh = parseInt(m24[1],10), mi = parseInt(m24[2],10);
        const local = new Date(`${y}-${two(m)}-${two(d)}T${two(hh)}:${two(mi)}:00`);
        return isNaN(local.getTime()) ? null : local.toISOString();
      }
    }
  }

  // Fallback: first HH:MM anywhere near the top of the main content
  const topScope = page.locator('main, header, [role="main"]').first();
  const hhmmAny = await topScope.getByText(/\b([01]?\d|2[0-3]):([0-5]\d)\b/).first().textContent().catch(()=>null);
  if (hhmmAny){
    const m24 = hhmmAny.match(/([01]?\d|2[0-3]):([0-5]\d)/);
    if (m24){
      const hh = parseInt(m24[1],10), mi = parseInt(m24[2],10);
      const local = new Date(`${y}-${two(m)}-${two(d)}T${two(hh)}:${two(mi)}:00`);
      return isNaN(local.getTime()) ? null : local.toISOString();
    }
  }
  return null;
}

function ymdFromUTCDate(d){
  return { y: d.getUTCFullYear(), m: d.getUTCMonth()+1, d: d.getUTCDate() };
}
const two = (n)=>String(n).padStart(2,'0');

function findStartInISOish(text, y, m, d){
  const datePat = `${y}-${two(m)}-${two(d)}`;
  const mIso = text.match(new RegExp(`${datePat}[T\\s]([01]?\\d|2[0-3]):([0-5]\\d)`));
  if (mIso){
    const hh = parseInt(mIso[1],10), mi = parseInt(mIso[2],10);
    const iso = new Date(`${datePat}T${two(hh)}:${two(mi)}:00`).toISOString();
    return iso;
  }
  return null;
}
function findStartInTextOnly(text, y, m, d){
  const m24 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m24){
    const hh = parseInt(m24[1],10), mi = parseInt(m24[2],10);
    return new Date(`${y}-${two(m)}-${two(d)}T${two(hh)}:${two(mi)}:00`).toISOString();
  }
  const m12 = text.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
  if (m12){
    let hh = parseInt(m12[1],10);
    const mi = m12[2] ? parseInt(m12[2],10) : 0;
    const ap = m12[3].toLowerCase();
    if (ap==='pm' && hh<12) hh+=12;
    if (ap==='am' && hh===12) hh=0;
    return new Date(`${y}-${two(m)}-${two(d)}T${two(hh)}:${two(mi)}:00`).toISOString();
  }
  return null;
}

/** Grab HH:MM from Ticketsolve Seats page header.
 *  Structure is:  <div class="sr-only">Dates:</div><span>Tuesday 7 October 2025</span><span>, 19:30</span>
 */
async function extractStartFromTicketsolveHeader(page, baseY, baseM, baseD){
  // wait briefly for the date/time row to render
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await page.waitForSelector('main, header, [role="main"]', { timeout: 6000 }).catch(()=>{});
await page.waitForTimeout(1200);

  return await page.evaluate(({y,m,d})=>{
    const two=n=>String(n).padStart(2,'0');

    // 1) prefer an explicit “Dates:” a11y label if present
    const sr = Array.from(document.querySelectorAll('.sr-only'))
      .find(n => /(^|\s)dates?:\s*$/i.test((n.textContent||'').trim()));

    const scope = sr?.parentElement || document.querySelector('main, header, [role="main"]') || document.body;

    // collect nearby text (spans/time next to the label or in first “row” under the H1)
    const buckets = [];
    if (scope) {
      const rowWithLabel = sr?.parentElement || scope;
      buckets.push(
        Array.from(rowWithLabel.querySelectorAll('span,time')).map(n => (n.textContent||'').trim()).join(' ')
      );
      // also scan first few rows under the title
      const h1 = scope.querySelector('h1');
      if (h1) {
        let p = h1.parentElement;
        for (let i=0;i<5 && p;i++, p=p.nextElementSibling) {
          buckets.push(Array.from(p.querySelectorAll('span,time')).map(n => (n.textContent||'').trim()).join(' '));
        }
      }
    }
    buckets.push(document.body.innerText||'');

    const join = buckets.filter(Boolean).join(' • ');

    // 24h first
    let m24 = join.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (m24){
      const hh = parseInt(m24[1],10), mi = parseInt(m24[2],10);
      const local = new Date(`${y}-${two(m)}-${two(d)}T${two(hh)}:${two(mi)}:00`);
      return isNaN(local.getTime()) ? null : local.toISOString();
    }
    // 12h fallback
    let m12 = join.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
    if (m12){
      let hh = parseInt(m12[1],10);
      const mi = m12[2] ? parseInt(m12[2],10) : 0;
      const ap = m12[3].toLowerCase();
      if (ap==='pm' && hh<12) hh+=12;
      if (ap==='am' && hh===12) hh=0;
      const local = new Date(`${y}-${two(m)}-${two(d)}T${two(hh)}:${two(mi)}:00`);
      return isNaN(local.getTime()) ? null : local.toISOString();
    }
    return null;
  }, {y:baseY,m:baseM,d:baseD});
}

/** Sniff network payloads for a date+time signature. */
async function sniffStartFromNetwork(page, baseY, baseM, baseD){
  let found = null;
  const onResp = async (resp) => {
    try{
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!/json|text|javascript/.test(ct)) return;
      const text = await resp.text();
      if (!text) return;
      found = found || findStartInISOish(text, baseY, baseM, baseD);
      if (!found && text.includes(`${baseY}-${two(baseM)}-${two(baseD)}`)) {
        found = findStartInTextOnly(text, baseY, baseM, baseD);
      }
    }catch{}
  };
  page.on('response', onResp);
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(()=>{});
await sleep(1500);
  page.off('response', onResp);
  return found;
}

/** Generic page extractor: <time datetime>, Ticketsolve header, JSON-LD, then body text. */
async function extractStartISOFromPage(page, baseY, baseM, baseD){
  try{
    const t = await page.locator('time[datetime]').first().getAttribute('datetime');
    if (t && /\dT\d/.test(t)) return new Date(t).toISOString();
  }catch{}

  try{
    const headerISO = await extractStartFromTicketsolveHeader(page, baseY, baseM, baseD);
    if (headerISO) return headerISO;
  }catch{}

  try{
    const blocks = await page.$$eval('script[type="application/ld+json"]', ss => ss.map(s => s.textContent || ''));
    for (const b of blocks){
      try{
        const obj = JSON.parse(b);
        const arr = Array.isArray(obj) ? obj : [obj];
        for (const o of arr){
          const sd = o?.startDate || o?.start || o?.start_time || o?.event?.startDate;
          if (sd) return new Date(sd).toISOString();
        }
      }catch{}
    }
  }catch{}

  try{
    const txt = await page.evaluate(() => document.body.innerText || '');
    let mm = txt.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (mm){
      const hh = parseInt(mm[1],10), mi = parseInt(mm[2],10);
      const local = new Date(`${baseY}-${two(baseM)}-${two(baseD)}T${two(hh)}:${two(mi)}:00`);
      if (!isNaN(local.getTime())) return local.toISOString();
    }
    mm = txt.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
    if (mm){
      let hh = parseInt(mm[1],10);
      const mi = mm[2] ? parseInt(mm[2],10) : 0;
      const ap = mm[3].toLowerCase();
      if (ap==='pm' && hh<12) hh+=12;
      if (ap==='am' && hh===12) hh=0;
      const local = new Date(`${baseY}-${two(baseM)}-${two(baseD)}T${two(hh)}:${two(mi)}:00`);
      if (!isNaN(local.getTime())) return local.toISOString();
    }
  }catch{}

  return null;
}

/** Refine a midnight-only ISO by visiting Ticketsolve Seats first, then DMH page. */
async function discoverStartISO(page, currentStartISO, eventUrl, ticketsUrl){
  if (!currentStartISO) return null;

  const dt = new Date(currentStartISO);
  const { y, m, d } = ymdFromUTCDate(dt);

  // If it already has a time, keep it.
  if (dt.getUTCHours() !== 0 || dt.getUTCMinutes() !== 0) return currentStartISO;

  // --- 1) Ticketsolve seats (preferred: clearly shows ", 19:30") ---
  if (ticketsUrl){
    let seatsUrl = ticketsUrl;
    if (!/\/seats\b/.test(seatsUrl)) seatsUrl = seatsUrl.replace(/\/$/, '') + '/seats';

    try{
      await page.goto(seatsUrl, { waitUntil:'domcontentloaded', timeout: 20000 });
      await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(()=>{});

      // NEW: try the explicit "Dates:" row first
      const explicit = await extractStartFromTicketsolveRow(page, y, m, d);
      if (explicit) return explicit;

      // Then run the generic DOM extractor + network sniffer in parallel on the seats page
      const winner = await Promise.race([
        (async()=> await extractStartISOFromPage(page, y, m, d))(),
        (async()=> await sniffStartFromNetwork(page, y, m, d))()
      ].map(p => p.then(v => v || null)));

      if (winner) return winner;
    } catch {}
  }

  // --- 2) DMH event page fallback ---
  if (eventUrl){
    try{
      await page.goto(eventUrl, { waitUntil:'domcontentloaded', timeout: 20000 });
      await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(()=>{});
      const iso = await extractStartISOFromPage(page, y, m, d);
      if (iso) return iso;
    } catch {}
  }

  // Fallback: give up and keep the midnight date.
  return currentStartISO;
}

/* --------------------- END TIME FINDER --------------------- */


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

      let status = '', ticketsHref = '', eventHref = '';

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

      const more = n.querySelector('a[href*="/event/"], a[href*="/events/"], a[href*="/event-"]');
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

/* ---------- seat payload parsing ---------- */
function summariseSeatPayload(data) {
  let cap = 0, avail = 0;
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return; seen.add(node);
    if (Array.isArray(node)) { node.forEach(visit); return; }

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
    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(data);
  return { cap, avail };
}

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

      diag.responses.push({ url, ct, type, size: text.length });

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
      return hits.reduce((a,b) => (b.cap > a.cap ? b : a), { cap:0, avail:0 });
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

  let best = tap.best();
  if (best && best.cap > 0) {
    await tap.flush();
    const sold = best.cap - best.avail;
    const pct = clamp(round((sold / best.cap) * 100), 0, 100);
    return { capacity: best.cap, remaining: best.avail, sold, pct };
  }

  let zones = await readZones(page);
  if (!zones.length) zones = [{ text: 'All', value: null }];

  let totalCap = 0, totalAvail = 0;
  for (const z of zones) {
    await selectZone(page, z.text, z.value).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: NET_IDLE }).catch(() => {});
    await sleep(600);

    best = tap.best();
    if (best && best.cap > 0) { totalCap = best.cap; totalAvail = best.avail; break; }

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
    let cards = uniqBy(raw, x => `${x.title}|${x.datetime || x.dateText}`);

    // date window + limit
    const getDateISO = (c) => (c.datetime && toISO(c.datetime)) || (c.dateText && toISO(c.dateText)) || null;
    if (FROM_DATE || TO_DATE) {
      cards = cards.filter(c => {
        const iso = getDateISO(c);
        if (!iso) return true;
        const d = new Date(iso);
        if (FROM_DATE && d < FROM_DATE) return false;
        if (TO_DATE && d > TO_DATE) return false;
        return true;
      });
    }
    if (isFinite(LIMIT)) cards = cards.slice(0, LIMIT);

    console.log(`Discovered ${cards.length} events across ${pageUrls.length} pages`);

    const tsPages = [];
    for (let i = 0; i < CONCURRENCY; i++) tsPages.push(await context.newPage());

    const out = [];
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const p = tsPages[i % CONCURRENCY];

      console.log(`[${i+1}/${cards.length}] ${c.title}`);

      let tickets = c.ticketsHref;
      if ((!tickets || !/ticketsolve/i.test(tickets)) && c.eventHref) {
        try {
          tickets = await withDeadline(findTicketsolveOnEventPage(p, c.eventHref), PER_EVENT_MS, 'findTicketsolveOnEventPage');
        } catch (e) {
          console.warn('  ⚠︎ ticketsolve discovery:', e.message);
        }
      }

      let start = getDateISO(c);

      // refine start time
      try {
        if (start) {
          const refined = await withDeadline(discoverStartISO(p, start, c.eventHref, tickets), PER_EVENT_MS, 'discoverStartISO');
          if (refined) start = refined;
        }
      } catch (e) {
        console.warn('  ⚠︎ time refine:', e.message);
      }

      let pct = null;
      if (tickets) {
        try {
          const r = await withDeadline(
            computeTicketsolvePct(p, tickets, `${(c.title||'event').slice(0,60).replace(/[^\w\-]+/g,'_')}-${start||'no-date'}`),
            PER_EVENT_MS,
            'computeTicketsolvePct'
          );
          if (r?.pct != null) pct = r.pct;
        } catch (e) {
          console.warn('  ⚠︎ seat count:', e.message);
        }
      }
      if (pct == null) pct = statusToPct(c.status);

      console.log(`  ↳ ${pct}% sold${start ? ' • ' + start : ''}`);

      const start_utc = start || null;
const { local: start_local, tz } = localWallclockFromUTC(start_utc);

out.push({
  title: c.title,
  // keep existing field for backward compatibility (UTC):
  start: start_utc,
  // ALSO include local wall-clock + timezone:
  start_local,         // e.g. "2025-10-07T19:30:00" (no Z)
  tz,                  // "Europe/London"
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
