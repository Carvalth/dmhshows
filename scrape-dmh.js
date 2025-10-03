// scrape-dmh.js — DMH listing-only scraper with pagination + safe selectors (no :has-text)
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
  // DMH has an "I Accept" button on the bottom-left cookie panel
  const candidates = [
    'button:has-text("I Accept")',           // Playwright locator (outside evaluate)
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    '#onetrust-accept-btn-handler'
  ];
  for (const sel of candidates) {
    const btn = await page.locator(sel).first();
    if (await btn.count()) { await btn.click({ timeout: 1000 }).catch(()=>{}); break; }
  }
}

async function getPaginationHrefs(page) {
  // Collect explicit paginated URLs like /whats-on/page/2/
  const hrefs = await page.$$eval('a', as =>
    Array.from(new Set(as.map(a => a.href).filter(Boolean)))
      .filter(h => /\/whats-on\/page\/\d+\/?$/i.test(h))
  );
  return [START_URL, ...hrefs].filter((v,i,arr)=>arr.indexOf(v)===i);
}

async function extractCardsOnPage(page) {
  // Scroll to render lazy content
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
  }

  // Likely wrappers
  const wrappers = ['.event-card','article','li[class*="event" i]','.card'];
  let nodes = [];
  for (const sel of wrappers) {
    const list = await page.$$(sel);
    if (list.length) { nodes = list; break; }
  }
  if (!nodes.length) {
    // fallback: any element that contains a link to /event/
    nodes = await page.$$('a[href*="/event/"], a[href*="/events/"]');
  }

  const items = [];
  for (const node of nodes) {
    const info = await node.evaluate(n => {
      const pick = sel => (n.querySelector(sel)?.textContent || '').replace(/\s+/g,' ').trim();

      // Title candidates
      const title =
        pick('h2') || pick('h3') || pick('h4') ||
        pick('.event-title, .card-title, a[title]') ||
        (n.querySelector('a[href*="/event/"], a[href*="/events/"]')?.textContent || '').replace(/\s+/g,' ').trim();

      // Date (badge/label near the image)
      const dateText = pick('time, .date, .event-date, .when, [class*="date"]');

      // Status: read badges first; if empty, scan all buttons/links text
      let status =
        pick('.availability, .status, .badge, [class*="availability"], .label, .pill');

      if (!status) {
        const texts = Array.from(n.querySelectorAll('a,button'))
          .map(el => (el.textContent || '').replace(/\s+/g,' ').trim())
          .filter(Boolean);
        status = texts.find(t => /sold\s*out|book\s*now|limited|last\s*remaining|selling\s*fast/i.test(t)) || '';
      }

      return { title, dateText, status };
    });

    const title = clean(info.title);
    if (!title || /cookie|policy|terms/i.test(title)) continue;

    const start = normalizeStart(info.dateText);
    const status = clean(info.status);
    const override_pct = statusToPct(status);

    items.push({ title, start, status, override_pct });
  }

  // Dedupe by title+date
  const seen = new Set();
  return items.filter(it => {
    const key = `${it.title}|${it.start || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-GB',
    viewport: { width: 1366, height: 1024 }
  });
  // reduce bot fingerprint
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  const pagesToVisit = new Set([START_URL]);

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await acceptCookies(page);

  // discover pagination
  try {
    const hrefs = await getPaginationHrefs(page);
    hrefs.forEach(h => pagesToVisit.add(h));
  } catch {}

  const results = [];

  let idx = 0;
  for (const url of pagesToVisit) {
    idx++;
    try {
      if (idx > 1) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await acceptCookies(page);
      }

      // Debug dump per page
      const dir = path.join(DEBUG_DIR, `page-${idx}`);
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'listing.png'), fullPage: true }).catch(()=>{});
      const html = await page.content().catch(()=> '');
      fs.writeFileSync(path.join(dir, 'listing.html'), html);

      const items = await extractCardsOnPage(page);
      results.push(...items);
      console.log(`[info] ${url} -> ${items.length} cards`);
    } catch (e) {
      console.warn('[warn] failed on', url, e.message);
    }
  }

  // Sort by date (unknown last)
  results.sort((a,b) => {
    const da = a.start ? Date.parse(a.start) : Infinity;
    const db = b.start ? Date.parse(b.start) : Infinity;
    return da - db;
  });

  // Safe write
  if (results.length === 0 && fs.existsSync(OUT)) {
    console.warn('[warn] zero results; preserving previous JSON');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  console.log(`Wrote ${results.length} events -> ${OUT}`);

  await browser.close();
})();

