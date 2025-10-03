import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';

const START_URL = 'https://www.demontforthall.co.uk/whats-on/'; // adjust if different
const OUT = path.join('public', 'dmh-events.json');

// Map labels -> % sold (tweak these)
function statusToPct(label = '') {
  const s = label.toLowerCase();
  if (s.includes('sold out')) return 100;
  if (s.includes('limited')) return 90;
  if (s.includes('last') || s.includes('low')) return 85;
  if (s.includes('best availability')) return 60;
  if (s.includes('book now') || s.includes('on sale')) return 45;
  return 30;
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  // Grab event links (selectors may need tweaking if DMH changes markup)
  const eventLinks = await page.$$eval(
    'a[href*="/event/"], a[href*="/events/"], .event-card a',
    as => Array.from(new Set(as.map(a => a.href).filter(Boolean)))
  );

  const events = [];

  for (const url of eventLinks) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      const title =
        (await page.$eval('h1, .event-title, .title', el => el.textContent.trim()).catch(() => null)) ||
        'Untitled';

      let when =
        (await page.$eval('time[datetime]', el => el.getAttribute('datetime')).catch(() => null)) ||
        (await page.$eval('time', el => el.textContent.trim()).catch(() => null)) ||
        (await page.$eval('.event-date, .date, .when', el => el.textContent.trim()).catch(() => null));
      let iso = null;
      if (when && /^[0-9]{4}-/.test(when)) {
        iso = when;
      } else if (when) {
        const parsed = dayjs(when);
        if (parsed.isValid()) iso = parsed.toISOString();
      }

      const status =
        (await page.$eval('.availability, .status, .badge, [class*="availability"]',
          el => el.textContent.trim()).catch(() => null)) ||
        (await page.$eval('button, a[role="button"]',
          el => el.textContent.trim()).catch(() => null)) ||
        '';

      events.push({
        title,
        start: iso,             // your front-end can handle ISO
        status,
        override_pct: statusToPct(status)
      });
    } catch (e) {
      console.error('Failed on', url, e.message);
    }
  }

  events.sort((a, b) => {
    const da = a.start ? Date.parse(a.start) : Infinity;
    const db = b.start ? Date.parse(b.start) : Infinity;
    return da - db;
  });

  fs.mkdirSync('public', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(events, null, 2));
  console.log(`Wrote ${events.length} events -> ${OUT}`);

  await browser.close();
}

run();
