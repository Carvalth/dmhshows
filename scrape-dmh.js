// scrape-dmh.js — robust Playwright scraper for De Montfort Hall
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import dayjs from 'dayjs';

const WHATSON_URL = 'https://demontforthall.co.uk/whats-on/';
const OUT_DIR = 'public';
const OUT_JSON = path.join(OUT_DIR, 'dmh-events.json');
const DEBUG_DIR = path.join(OUT_DIR, 'debug');

function statusToPct(status) {
  const s = (status || '').toUpperCase();
  if (s.includes('SOLD OUT')) return 100;
  if (s.includes('BOOK NOW')) return 48;
  return 30;
}

function parseDateToISO(txt) {
  const t = (txt || '').replace(/\s+/g, ' ').trim();
  const d = dayjs(t);
  return d.isValid() ? new Date(d.year(), d.month(), d.date()).toISOString() : null;
}

async function acceptCookies(page) {
  const selectors = [
    '#ccc-notify-accept',
    '.ccc-notify-accept',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button[aria-label*="Accept"][aria-label*="cookie" i]'
  ];
  for (const sel of selectors) {
    const el = page.locator(sel);
    if (await el.count().catch(() => 0)) {
      try {
        await el.first().click({ timeout: 2000 }).catch(() => {});
        break;
      } catch {}
    }
  }
}

async function loadAll(page) {
  // Click a "Load more" style button until it disappears or repeats
  for (let i = 0; i < 30; i++) {
    const more = page.locator('button:has-text("Load more"), a:has-text("Load more")');
    const visible = await more.isVisible().catch(() => false);
    if (!visible) break;
    await more.click({ timeout: 3000 }).catch(() => {});
    // wait for new cards to be added or network to settle
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    // small guard to let DOM update
    await page.waitForTimeout(300);
  }
}

async function extractCard(card) {
  let title = await card.locator('h3 a, h3 .title, h3').first().innerText().catch(() => '');
  title = title.replace(/\s+/g, ' ').trim();

  const dateText = await card.locator('.date').first().innerText().catch(() => '');
  const start = parseDateToISO(dateText);

  // CTA or badge for status
  let status = await card.locator('a.cta.cta--primary').first().innerText().catch(() => '');
  if (!status) {
    status = await card
      .locator('[class*="badge"], .status, .soldout, .sold-out, .label:has-text("SOLD")')
      .first()
      .innerText()
      .catch(() => '');
  }
  status = (status || '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (status.includes('SOLD OUT')) status = 'SOLD OUT';
  else if (status.includes('BOOK NOW')) status = 'BOOK NOW';
  else status = '';

  return { title, start, status, override_pct: statusToPct(status) };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const e of items) {
    const key = `${e.title}__${e.start || ''}`;
    if (e.title && !seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

async function ensureDirs() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(DEBUG_DIR, { recursive: true });
}

async function writeDebug(page, label) {
  try {
    const png = path.join(DEBUG_DIR, `${label}.png`);
    const html = path.join(DEBUG_DIR, `${label}.html`);
    await page.screenshot({ path: png, fullPage: true }).catch(() => {});
    const content = await page.content().catch(() => '<no content>');
    await fs.writeFile(html, content, 'utf8').catch(() => {});
    console.log(`Wrote debug to ${png} and ${html}`);
  } catch {}
}

async function main() {
  await ensureDirs();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await page.goto(WHATSON_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // handle cookies (don’t fail if not present)
    await acceptCookies(page);

    // wait for any card container to appear; don’t hang forever
    const cards = page.locator('.card-event');
    await cards.first().waitFor({ state: 'visible', timeout: 30000 });

    // some sites lazy-load the rest:
    await loadAll(page);

    const count = await cards.count();
    if (count === 0) {
      console.warn('No cards found after wait — writing debug');
      await writeDebug(page, 'no-cards');
    }

    const results = [];
    for (let i = 0; i < count; i++) {
      const item = await extractCard(cards.nth(i));
      if (item.title) results.push(item);
    }

    const final = dedupe(results);
    await fs.writeFile(OUT_JSON, JSON.stringify(final, null, 2), 'utf8');
    console.log(`Scraped ${final.length} events`);
    console.log(final.slice(0, 3));
  } catch (err) {
    console.error('Scrape error:', err?.message || err);
    await writeDebug(page, 'error');
    // still emit a JSON file so later steps don’t fail
    await fs.writeFile(OUT_JSON, '[]', 'utf8');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
