// scrape-dmh.js — robust list-page scraper with self-debug + safe fallback
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

function statusToPct(label = '') {
  const s = label.toLowerCase();
  if (/sold\s*out/.test(s)) return 100;
  if (/(very\s*limited|limited|last\s*(few|remaining)|almost\s*sold|low\s*availability)/.test(s)) return 92;
  if (/(selling\s*fast|best\s*availability)/.test(s)) return 70;
  if (/(book\s*now|on\s*sale|available)/.test(s)) return 48;
  return 30;
}

async function acceptCookies(page) {
  // OneTrust can be inline or inside its own iframe
  try {
    const inline = await page.$('#onetrust-accept-btn-handler, button:has-text("Accept All")');
    if (inline) { await inline.click(); return; }
    const frames = page.frames();
    for (const f of frames) {
      const btn = await f.$('#onetrust-accept-btn-handler, button:has-text("Accept All")');
      if (btn) { await btn.click(); return; }
    }
  } catch {}
}

async function scrollAndLoadAll(page) {
  // Try explicit "Load more" buttons repeatedly
  for (let i = 0; i < 15; i++) {
    const more = await page.$('button:has-text("Load more"), button:has-text("Show more"), a:has-text("Load more")');
    if (!more) break;
    await more.click().catch(()=>{});
    await page.waitForTimeout(1200);
  }
  // Also force a few bottom scrolls
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
  }
}

function normalizeStart(dateText) {
  const t = clean(dateText);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t;
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-GB',
    viewport: { width: 1366, height: 900 }
  });

  // Hide webdriver flag (some sites use this)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await acceptCookies(page);
  await page.waitForLoadState('networkidle').catch(()=>{});

  // See what links are visible before loading more
  const firstLinks = await page.$$eval('a', as => as.map(a => a.href).filter(Boolean));
  console.log(`[diagnostic] initial link count: ${firstLinks.length}`);

  await scrollAndLoadAll(page);
  await page.waitForTimeout(800);

  // DEBUG dump (what the bot actually saw)
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  await page.screenshot({ path: path.join(DEBUG_DIR, 'listing.png'), fullPage: true }).catch(()=>{});
  const html = await page.content().catch(()=>'');
  fs.writeFileSync(path.join(DEBUG_DIR, 'listing.html'), html);

  // Pick card nodes
  const selectors = [
    '.event-card',
    'article[class*="event" i]',
    'li[class*="event" i]',
    '.card:has(a[href*="/event/"])',
    '[data-component*="event" i]'
  ];
  let cards = [];
  for (const sel of selectors) {
    cards = await page.$$(sel);
    console.log(`[diagnostic] selector "${sel}" -> ${cards.length} nodes`);
    if (cards.length >= 3) break;
  }
  if (cards.length === 0) {
    // fallback: just grab event-like links
    cards = await page.$$('a[href*="/event/"], a[href*="/events/"]');
    console.log(`[diagnostic] fallback link nodes -> ${cards.length}`);
  }

  const results = [];
  const seen = new Set();

  for (const card of cards) {
    const info = await card.evaluate(node => {
      const pick = sel => (node.querySelector(sel)?.textContent || '').replace(/\s+/g,' ').trim();
      const href = node.querySelector('a[href*="/event/"], a[href*="/events/"]')?.getAttribute('href') || '';
      const title = pick('h3, h2, h4, .card-title, .event-title, a[title], a');
      const dateText = pick('time, .date, .event-date, .when, [class*="date"]');
      const status = pick('.availability, .status, .badge, [class*="availability"], .label, .pill');
      return { href, title, dateText, status };
    });
    const title = clean(info.title);
    if (!title || /cookie|policy|terms/i.test(title)) continue;

    const start = normalizeStart(info.dateText);
    const status = clean(info.status);
    const override_pct = statusToPct(status);
    const key = `${title}|${start || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ title, start, status, override_pct });
  }

  // Sort by date when possible
  results.sort((a, b) => {
    const da = a.start ? Date.parse(a.start) : Infinity;
    const db = b.start ? Date.parse(b.start) : Infinity;
    return da - db;
  });

  // SAFETY: if we found nothing, keep the previous JSON instead of nuking it
  if (results.length === 0) {
    console.warn('[warning] scraper found 0 events; preserving previous JSON if it exists');
    if (!fs.existsSync(OUT)) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, '[]');
    }
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  console.log(`Wrote ${results.length} events -> ${OUT}`);
  await browser.close();
})();

