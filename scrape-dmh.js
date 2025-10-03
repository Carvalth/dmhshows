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

  // Try a few common wrappers; if none, we’ll fall back
