// scrape-dmh.js  — Playwright (ESM) scraper for De Montfort Hall
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import dayjs from 'dayjs';

const WHATSON_URL = 'https://demontforthall.co.uk/whats-on/';

function statusToPct(status) {
  const s = (status || '').trim().toUpperCase();
  if (s.includes('SOLD OUT')) return 100;
  if (s.includes('BOOK NOW')) return 48;
  return 30;
}

function parseDateToISO(dateText) {
  // Site examples look like: "Mon 6 Oct 2025"
  // dayjs can parse this in most locales; if it fails, return null.
  const cleaned = (dateText || '').replace(/\s+/g, ' ').trim();
  const d = dayjs(cleaned);
  return d.isValid() ? new Date(d.year(), d.month(), d.date()).toISOString() : null;
}

async function extractCard(card) {
  // title
  let title = await card.locator('h3 .title, h3 a, h3').first().innerText().catch(() => '');
  title = title.replace(/\s+/g, ' ').trim();

  // date
  const dateText = await card.locator('.date').first().innerText().catch(() => '');
  const start = parseDateToISO(dateText);

  // status
  // Primary CTA shows "BOOK NOW"; some items show "SOLD OUT" on a badge
  let status = await card.locator('a.cta.cta--primary').first().innerText().catch(() => '');
  if (!status) {
    // try badges or alt labels
    status = await card.locator('[class*="badge"], .status, .soldout, .sold-out').first().innerText().catch(() => '');
  }
  status = (status || '').replace(/\s+/g, ' ').trim().toUpperCase();

  // Sometimes the link text is uppercase by CSS; keep consistent phrasing
  if (status.includes('SOLD OUT')) status = 'SOLD OUT';
  else if (status.includes('BOOK NOW')) status = 'BOOK NOW';
  else status = '';

  return {
    title,
    start,
    status,
    override_pct: statusToPct(status)
  };
}

function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const key = `${e.title}__${e.start || ''}`;
    if (e.title && !seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(WHATSON_URL, { waitUntil: 'networkidle' });

    // Wait for at least one card to render
    const cardsRoot = page.locator('.card-event');
    await cardsRoot.first().waitFor({ state: 'visible', timeout: 30000 });

    const count = await cardsRoot.count();
    const results = [];

    for (let i = 0; i < count; i++) {
      const card = cardsRoot.nth(i);
      const item = await extractCard(card);

      // Ignore empty shells
      if (item.title) results.push(item);
    }

    const cleaned = dedupe(results);

    // Ensure output folder exists
    const outDir = path.join('public');
    await fs.mkdir(outDir, { recursive: true });

    const outFile = path.join(outDir, 'dmh-events.json');
    await fs.writeFile(outFile, JSON.stringify(cleaned, null, 2), 'utf8');

    console.log(`Scraped ${cleaned.length} events`);
    // Print a tiny preview for CI logs
    console.log(cleaned.slice(0, 3));
  } catch (err) {
    console.error('Scrape error:', err);
    // Write empty array so downstream steps don't explode
    const outDir = path.join('public');
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'dmh-events.json'), '[]', 'utf8');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();

