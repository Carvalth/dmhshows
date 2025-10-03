// scrape-dmh.js
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const START_URL = 'https://www.demontforthall.co.uk/whats-on/';
const OUT = path.join('public', 'dmh-events.json');

function statusToPct(label = '') {
  const s = label.toLowerCase();
  if (/(sold\s*out)/.test(s)) return 100;
  if (/(very\s*limited|limited|last\s*(few|remaining)|almost\s*sold|low\s*availability)/.test(s)) return 92;
  if (/(selling\s*fast|best\s*availability)/.test(s)) return 70;
  if (/(book\s*now|on\s*sale|available)/.test(s)) return 48;
  return 30;
}

function safeTrim(x) { return (x || '').replace(/\s+/g,' ').trim(); }

async function acceptCookies(page) {
  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    '#onetrust-accept-btn-handler',
    'button[aria-label*="accept"]',
    'button#ccc-recommended-settings'
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click().catch(()=>{}); break; }
  }
}

async function extractJsonLdEvents(page) {
  const blocks = await page.$$eval('script[type="application/ld+json"]', els =>
    els.map(el => {
      try { return JSON.parse(el.textContent); } catch { return null; }
    }).filter(Boolean)
  );
  const events = [];
  const dig = obj => {
    if (!obj) return;
    if (Array.isArray(obj)) return obj.forEach(dig);
    const type = (obj['@type'] || '').toString().toLowerCase();
    if (type === 'event') events.push(obj);
    for (const v of Object.values(obj)) if (v && typeof v === 'object') dig(v);
  };
  blocks.forEach(dig);
  return events;
}

async function getStatusText(page) {
  // Likely places for availability labels
  const parts = await page.$$eval([
    '.availability', '.status', '.badge', '.event-status', '[class*="availability"]',
    '.cta a', '.cta button', 'a.button', 'button', 'a[role="button"]'
  ].join(','), els => els.map(el => el.textContent).filter(Boolean)).catch(() => []);
  const aria = await page.$$eval('[aria-label]', els =>
    els.map(el => el.getAttribute('aria-label')).filter(Boolean)
  ).catch(() => []);
  const body = await page.evaluate(() => document.body.innerText).catch(() => '');

  const candidates = [ ...parts, ...aria, body ].map(safeTrim);
  const hit = candidates.find(t =>
    /(sold\s*out|very\s*limited|limited|last\s*(few|remaining)|almost\s*sold|low\s*availability|selling\s*fast|best\s*availability|book\s*now|on\s*sale)/i.test(t)
  );
  return hit || '';
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  // 1) Open listing and dismiss cookies
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await acceptCookies(page);

  // 2) Collect event links (filter out policy/cookie links)
  const eventLinks = await page.$$eval(
    'a[href*="/event/"], a[href*="/events/"], .event-card a',
    as => Array.from(new Set(
      as.map(a => a.href)
        .filter(Boolean)
        .filter(href =>
          !/cookie|privacy|policy|terms/i.test(href) &&
          /\/event|\/events\//i.test(href)
        )
    ))
  );

  const results = [];

  for (const url of eventLinks) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await acceptCookies(page);

      // Prefer JSON-LD Event blocks
      const ldEvents = await extractJsonLdEvents(page);
      const ld = ldEvents.find(e => safeTrim(e.name) && !/cookie/i.test(e.name));

      // Title from main content first, fallback to JSON-LD
      const title =
        safeTrim(await page.$eval('main h1, h1.event-title, h1.title, h1', el => el.textContent).catch(() => '')) ||
        safeTrim(ld?.name) ||
        'Untitled';

      // Start date/time: prefer <time datetime>, else JSON-LD startDate
      const start =
        safeTrim(await page.$eval('time[datetime]', el => el.getAttribute('datetime')).catch(() => '')) ||
        safeTrim(ld?.startDate) ||
        null;

      // Status / availability
      const status = await getStatusText(page);
      const override_pct = statusToPct(status);

      // Heuristic: drop junk titles like cookie notices
      if (/cookie/i.test(title)) continue;

      results.push({ title, start, status, override_pct });
      console.log(`[ok] ${title} | ${start} | ${status} -> ${override_pct}%`);
    } catch (e) {
      console.error('[skip]', url, e.message);
    }
  }

  // Sort by date where possible
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
