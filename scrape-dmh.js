// scrape-dmh.js — list-page only (avoids 403 on event pages)
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const START_URL = 'https://www.demontforthall.co.uk/whats-on/';
const OUT = path.join('public', 'dmh-events.json');

function statusToPct(label = '') {
  const s = label.toLowerCase();
  if (/sold\s*out/.test(s)) return 100;
  if (/(very\s*limited|limited|last\s*(few|remaining)|almost\s*sold|low\s*availability)/.test(s)) return 92;
  if (/(selling\s*fast|best\s*availability)/.test(s)) return 70;
  if (/(book\s*now|on\s*sale|available)/.test(s)) return 48;
  return 30;
}
const clean = x => (x || '').replace(/\s+/g, ' ').trim();

async function acceptCookies(page) {
  const choices = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button[aria-label*="accept"]',
  ];
  for (const sel of choices) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click().catch(()=>{}); break; }
  }
}

// Try to click “Load more” until there’s no more
async function loadAll(page) {
  for (;;) {
    const more = await page.$('button:has-text("Load more"), button:has-text("Show more"), a:has-text("Load more")');
    if (!more) break;
    await more.click().catch(()=>{});
    await page.waitForTimeout(1200);
  }
}

// Pull data from a card element
async function extractFromCard(card) {
  return await card.evaluate(node => {
    const t = (sel) => (node.querySelector(sel)?.textContent || '').replace(/\s+/g,' ').trim();
    const a = (node.querySelector('a[href]')?.getAttribute('href')) || '';
    const title = t('h3, .card-title, .event-title, h2, h4');
    const dateText = t('time, .date, .event-date, .when');
    const status = t('.availability, .status, .badge, [class*="availability"]');
    return { href: a, title, dateText, status };
  });
}

function normalizeStart(dateText) {
  if (!dateText) return null;
  // If it’s already ISO-like, pass through
  if (/^\d{4}-\d{2}-\d{2}/.test(dateText)) return dateText;
  const parsed = Date.parse(dateText);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await acceptCookies(page);

  // In case items are infinite-scrolled
  await loadAll(page);
  await page.waitForTimeout(800);

  // Try a few common card wrappers (adjust if needed)
  const cardSelectors = [
    '.event-card',
    'article',
    'li[class*="event"]',
    '.card',
    '[data-component*="event"]'
  ];

  // Collect cards by trying selectors until we get a decent count
  let cards = [];
  for (const sel of cardSelectors) {
    cards = await page.$$(sel);
    if (cards.length >= 5) break; // good enough
  }
  if (cards.length === 0) {
    // fallback to links; still better than nothing
    cards = await page.$$('a[href*="/event/"], a[href*="/events/"]');
  }

  const seen = new Set();
  const results = [];

  for (const card of cards) {
    const info = await extractFromCard(card);
    const title = clean(info.title);
    // ignore cookie/policy junk
    if (!title || /cookie|policy|terms/i.test(title)) continue;

    const start = normalizeStart(clean(info.dateText));
    const status = clean(info.status);
    const override_pct = statusToPct(status);

    const key = `${title}|${start || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ title, start, status, override_pct });
  }

  results.sort((a, b) => {
    const da = a.start ? Date.parse(a.start) : Infinity;
    const db = b.start ? Date.parse(b.start) : Infinity;
    return da - db;
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`Wrote ${results.length} events -> ${OUT}`);
  await browser.close();
})();
