// scrape-dmh.js — DMH listing-only scraper with pagination + robust selectors + debug
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
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t;          // already ISO-ish
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function acceptCookies(page) {
  // DMH shows a custom banner with "I Accept"
  const candidates = [
    'button:has-text("I Accept")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    '#onetrust-accept-btn-handler',
  ];
  for (const sel of candidates) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click().catch(()=>{}); break; }
  }
}

async function extractCardsOnPage(page) {
  // Scroll a bit to ensure lazy content appears
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
  }

  // Try a few common wrappers; if none, we’ll fall back to finding buttons and walking up
  const wrappers = [
    '.event-card',                          // guess
    'article',                              // often used
    'li[class*="event" i]',
    '.card:has(a[href*="/event/"])'
  ];
  let nodes = [];
  for (const sel of wrappers) {
    nodes = await page.$$(sel);
    if (nodes.length >= 4) break;          // good enough
  }
  if (nodes.length === 0) {
    // Fallback: any element containing booking buttons/labels, then climb to a card-like ancestor
    const btnNodes = await page.$$(
      'a:has-text("BOOK NOW"), a:has-text("SOLD OUT"), button:has-text("BOOK NOW"), button:has-text("SOLD OUT")'
    );
    nodes = [];
    for (const b of btnNodes) {
      const card = await b.evaluateHandle(el =>
        el.closest('article, li, .card, .event, .grid-item, .content, .col') || el.parentElement
      );
      nodes.push(card);
    }
  }

  const items = [];
  for (const node of nodes) {
    const info = await node.evaluate((n) => {
      const txt = (sel) => (n.querySelector(sel)?.textContent || '').replace(/\s+/g,' ').trim();
      // title candidates
      const title =
        txt('h2') || txt('h3') || txt('h4') ||
        txt('.event-title, .card-title, a[title]') ||
        // sometimes link text itself is the title:
        (n.querySelector('a[href*="/event/"], a[href*="/events/"]')?.textContent || '').replace(/\s+/g,' ').trim();

      // date text (badge/label)
      const dateText = txt('time, .date, .event-date, .when, [class*="date"]');

      // status from badges/buttons inside the card
      const status =
        txt('.availability, .status, .badge, [class*="availability"], .label, .pill') ||
        txt('a:has-text("SOLD OUT"), button:has-text("SOLD OUT")') ||
        txt('a:has-text("BOOK NOW"),  button:has-text("BOOK NOW")');

      return { title, dateText, status };
    });

    const title = clean(info.title);
    if (!title || /cookie|policy|terms/i.test(title)) continue;

    const start = normalizeStart(info.dateText);
    const status = clean(info.status);
    const override_pct = statusToPct(status);

    items.push({ title, start, status, override_pct });
  }

  // dedupe
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    const key = `${it.title}|${it.start || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }
  return deduped;
}

async function getPaginationHrefs(page) {
  // collect all page links (1..8 etc)
  const hrefs = await page.$$eval('a', as =>
    Array.from(new Set(
      as.map(a => a.href).filter(Boolean).filter(u => /whats-on/i.test(u))
    ))
  );
  // Prefer explicit page numbers from a pager if present
  const pager = await page.$$eval(
    'nav, .pagination, .pager, .wp-pagenavi, .page-numbers',
    els => els.map(el => el.innerText)
  ).catch(() => []);
  // If we can’t detect pager, just return START_URL only (page 1)
  return [START_URL, ...hrefs.filter(h => /\b[?&]paged=\d+|\/page\/\d+\b/i.test(h))].filter((v,i,arr)=>arr.indexOf(v)===i);
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
  // discover additional paginated pages (if any)
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

      // screenshot + html per page for debugging
      const pageSlug = `page-${idx}`;
      const dir = path.join(DEBUG_DIR, pageSlug);
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

  // sort by date (unknowns last)
  results.sort((a,b) => {
    const da = a.start ? Date.parse(a.start) : Infinity;
    const db = b.start ? Date.parse(b.start) : Infinity;
    return da - db;
  });

  // safe write (don’t wipe existing file if we found nothing)
  if (results.length === 0 && fs.existsSync(OUT)) {
    console.warn('[warn] zero results; preserving previous dmh-events.json');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  console.log(`Wrote ${results.length} events -> ${OUT}`);

  await browser.close();
})();

