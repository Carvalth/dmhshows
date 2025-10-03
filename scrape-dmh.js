// scrape-dmh.js — DMH listing scraper (pagination, safe selectors, robust debug)
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

function normalizeStart(dateText) {
  const t = clean(dateText);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t;
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function acceptCookies(page) {
  // Cookie banner shows an "I Accept" button
  const locators = [
    'button:has-text("I Accept")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    '#onetrust-accept-btn-handler',
  ];
  for (const sel of locators) {
    const btn = page.locator(sel).first();
    if (await btn.count()) { await btn.click({ timeout: 1000 }).catch(()=>{}); break; }
  }
}

async function paginatedUrls(page) {
  // collect explicit pager links like /whats-on/page/2/
  const hrefs = await page.$$eval('a', as =>
    Array.from(new Set(as.map(a => a.href).filter(Boolean)))
      .filter(h => /\/whats-on\/page\/\d+\/?$/i.test(h))
  );
  return [START_URL, ...hrefs].filter((v,i,a)=>a.indexOf(v)===i);
}

async function extractFromListing(page) {
  // scroll to render lazy stuff
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(250);
  }

  // Do all extraction in one $$eval to avoid fragile element-handle selectors
  const rows = await page.$$eval('a[href*="/event/"], a[href*="/events/"]', as => {
    const isJunk = t => /cookie|policy|terms/i.test(t);
    const results = [];

    for (const a of as) {
      // Walk up to a plausible "card"
      const card = a.closest('article, li, .card, .event, .grid-item, .content, .col') || a.parentElement;

      // Title: prefer heading inside the card; fall back to attributes; avoid "MORE INFO" text
      let title =
        (card?.querySelector('h2, h3, h4, .event-title, .card-title')?.textContent || '') ||
        a.getAttribute('title') || a.getAttribute('aria-label') || a.textContent || '';
      title = title.replace(/\s+/g, ' ').trim();
      if (!title || isJunk(title) || /^more info$/i.test(title)) continue;

      // Date badge/label near image/heading
      let dateText =
        (card?.querySelector('time, .date, .event-date, .when, [class*="date"]')?.textContent || '')
          .replace(/\s+/g, ' ').trim();

      // Status: badge/label OR scan all buttons/links text inside the card
      let status =
        (card?.querySelector('.availability, .status, .badge, [class*="availability"], .label, .pill')?.textContent || '')
          .replace(/\s+/g, ' ').trim();

      if (!status && card) {
        const texts = Array.from(card.querySelectorAll('a,button'))
          .map(el => (el.textContent || '').replace(/\s+/g,' ').trim())
          .filter(Boolean);
        status = texts.find(t => /sold\s*out|book\s*now|limited|last\s*remaining|selling\s*fast|best\s*availability/i.test(t)) || '';
      }

      results.push({ title, dateText, status });
    }

    // de-dupe by title+date
    const seen = new Set();
    return results.filter(r => {
      const key = `${r.title}|${r.dateText}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  // Map to final shape
  return rows.map(r => ({
    title: clean(r.title),
    start: normalizeStart(r.dateText),
    status: clean(r.status),
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
  try {
    (await paginatedUrls(page)).forEach(u => urls.add(u));
  } catch {}

  const all = [];
  let idx = 0;

  for (const url of urls) {
    idx++;
    if (idx > 1) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await acceptCookies(page);
    }

    // Save debug per page
    const dir = path.join(DEBUG_DIR, `page-${idx}`);
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'listing.png'), fullPage: true }).catch(()=>{});
    const html = await page.content().catch(()=> '');
    fs.writeFileSync(path.join(dir, 'listing.html'), html);

    const items = await extractFromListing(page);
    all.push(...items);
    console.log(`[info] ${url} -> ${items.length} items`);
  }

  // sort by date (unknown last)
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
