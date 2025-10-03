// scrape-dmh.js — robust list-page scraper with debug output
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const START_URL = 'https://www.demontforthall.co.uk/whats-on/';
const OUT = path.join('public', 'dmh-events.json');
const DEBUG_DIR = 'public/debug';

const ua =
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
  const sels = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    '[aria-label*="accept" i]'
  ];
  for (const sel of sels) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click().catch(()=>{}); break; }
  }
}

async function scrollToBottom(page, passes = 10) {
  for (let i = 0; i < passes; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
  }
}

async function clickLoadMore(page) {
  for (;;) {
    const more = await page.$('button:has-text("Load more"), button:has-text("Show more"), a:has-text("Load more")');
    if (!more) break;
    await more.click().catch(()=>{});
    await page.waitForTimeout(1200);
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
    userAgent: ua,
    locale: 'en-GB',
    viewport: { width: 1366, height: 900 }
  });
  const page = await context.newPage();

  await page.route('**/*', route => {
    // skip heavy trackers
    const url = route.request().url();
    if (/\.(png|jpg|jpeg|gif|webp|svg|woff2?)$/i.test(url)) return route.continue();
    route.continue();
  });

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await acceptCookies(page);
  await page.waitForLoadState('networkidle').catch(()=>{});

  // Try to reveal all events
  await clickLoadMore(page);
  await scrollToBottom(page, 12);
  await page.waitForTimeout(1000);

  // DEBUG: dump what the bot actually sees
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  await page.screenshot({ path: path.join(DEBUG_DIR, 'listing.png'), fullPage: true }).catch(()=>{});
  const html = await page.content().catch(()=>'');
  fs.writeFileSync(path.join(DEBUG_DIR, 'listing.html'), html);

  // Collect cards
  const selectors = [
    '.event-card',
    'article[class*="event" i]',
    'li[class*="event" i]',
    '.card:has(a[href*="/event/"])',
    'a[href*="/event/"], a[href*="/events/"]' // fallback
  ];
  let cards = [];
  for (const sel of selectors) {
    cards = await page.$$(sel);
    if (cards.length >= 5) break;
  }

  const results = [];
  const seen = new Set();

  for (const card of cards) {
    const info = await card.evaluate(node => {
      const t = sel => (node.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
      const href = node.querySelector('a[href*="/event/"], a[href*="/events/"]')?.getAttribute('href') || '';
      const title = t('h3, h2, h4, .card-title, .event-title, a[title], a');
      const dateText = t('time, .date, .event-date, .when, [class*="date"]');
      const status = t('.availability, .status, .badge, [class*="availability"], .label');
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

  results.sort((a,b) => {
    const da = a.start ? Date.parse(a.start) : Infinity;
    const db = b.start ? Date.parse(b.start) : Infinity;
    return da - db;
  });

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`Wrote ${results.length} events -> ${OUT}`);

  await browser.close();
})();

