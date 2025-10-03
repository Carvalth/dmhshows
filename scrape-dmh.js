// scrape-dmh.js — DMH (robust) list scraper: pagination, clean anchors, full-card status scan
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const START_URL = 'https://www.demontforthall.co.uk/whats-on/';
const OUT = path.join('public', 'dmh-events.json');
const DEBUG_DIR = 'public/debug';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const clean = s => (s || '').replace(/\s+/g, ' ').trim();

function statusFromText(txt = '') {
  const s = txt.toLowerCase();
  if (s.includes('sold out')) return 'SOLD OUT';
  if (/very\s*limited|limited|last\s*(few|remaining)|almost\s*sold|low\s*availability/.test(s)) return 'LIMITED';
  if (s.includes('selling fast') || s.includes('best availability')) return 'SELLING FAST';
  if (s.includes('book now') || s.includes('on sale') || s.includes('available')) return 'BOOK NOW';
  return '';
}
function statusToPct(label = '') {
  const s = label.toLowerCase();
  if (s === 'sold out') return 100;
  if (s === 'limited') return 92;
  if (s === 'selling fast') return 70;
  if (s === 'book now') return 48;
  return 30;
}
function normalizeStart(dateText) {
  const t = clean(dateText);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t;
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function acceptCookies(page) {
  const choices = [
    'button:has-text("I Accept")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    '#onetrust-accept-btn-handler',
  ];
  for (const sel of choices) {
    const loc = page.locator(sel).first();
    if (await loc.count()) { await loc.click({ timeout: 1000 }).catch(()=>{}); break; }
  }
}

async function paginatedUrls(page) {
  const hrefs = await page.$$eval('a', as =>
    Array.from(new Set(as.map(a => a.href).filter(Boolean)))
      .filter(h => /\/whats-on\/page\/\d+\/?$/i.test(h))
  );
  return [START_URL, ...hrefs].filter((v,i,a)=>a.indexOf(v)===i);
}

async function extractFromListing(page) {
  // render lazy items
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(250);
  }

  // Grab event anchors but drop "More info about ..." and pure "BOOK NOW" CTAs.
  const rows = await page.$$eval('a[href*="/event/"], a[href*="/events/"]', (as) => {
    const junkAnchor = (a) => {
      const t = (a.textContent || '').trim();
      const titleAttr = (a.getAttribute('title') || '').trim();
      if (/^more info$/i.test(t)) return true;
      if (/^more info about /i.test(titleAttr)) return true;
      return false;
    };

    // Build a unique set of card nodes we want to parse
    const cards = new Set();
    for (const a of as) {
      if (junkAnchor(a)) continue;
      const card = a.closest('article, li, .card, .event, .grid-item, .content, .col') || a.parentElement;
      if (card) cards.add(card);
    }

    const results = [];
    cards.forEach(card => {
      const pick = sel => (card.querySelector(sel)?.textContent || '').replace(/\s+/g,' ').trim();

      // Title: headings first, then prominent link text
      let title =
        pick('h2, h3, h4, .event-title, .card-title') ||
        (card.querySelector('a[href*="/event/"], a[href*="/events/"]')?.textContent || '');

      title = title.replace(/\s+/g,' ').trim();
      if (!title || /^more info$/i.test(title)) return;

      // Date (badge/label)
      const dateText = pick('time, .date, .event-date, .when, [class*="date"]');

      // STATUS: use full card text so we catch plain <span>SOLD OUT</span>
      const full = card.innerText.replace(/\s+/g,' ').trim();
      let status = statusFromText(full);

      // If still empty, try badges/buttons quickly
      if (!status) {
        const badge = pick('.availability, .status, .badge, [class*="availability"], .label, .pill');
        status = statusFromText(badge);
      }

      results.push({ title, dateText, status });
    });

    // de-dupe by title+date
    const seen = new Set();
    return results.filter(r => {
      const key = `${r.title}|${r.dateText}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  return rows.map(r => ({
    title: clean(r.title),
    start: normalizeStart(r.dateText),
    status: r.status,                         // already normalized words
    override_pct: statusToPct(r.status)
  }));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-GB',
    viewport: { width: 1366, height: 1024 }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await acceptCookies(page);

  const urls = new Set([START_URL]);
  try { (await paginatedUrls(page)).forEach(u => urls.add(u)); } catch {}

  const all = [];
  let idx = 0;

  for (const url of urls) {
    idx++;
    if (idx > 1) { await page.goto(url, { waitUntil: 'domcontentloaded' }); await acceptCookies(page); }

    // Debug dump
    const dir = path.join(DEBUG_DIR, `page-${idx}`);
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'listing.png'), fullPage: true }).catch(()=>{});
    const html = await page.content().catch(()=> '');
    fs.writeFileSync(path.join(dir, 'listing.html'), html);

    const items = await extractFromListing(page);
    all.push(...items);
    console.log(`[info] ${url} -> ${items.length} items`);
  }

  all.sort((a,b) => {
    const da = a.start ? Date.parse(a.start) : Infinity;
    const db = b.start ? Date.parse(b.start) : Infinity;
    return da - db;
  });

  if (all.length === 0 && fs.existsSync(OUT)) {
    console.warn('[warn] zero results; preserving previous dmh-events.json');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(all, null, 2));
  }
  console.log(`Wrote ${all.length} events -> ${OUT}`);

  await browser.close();
})();
