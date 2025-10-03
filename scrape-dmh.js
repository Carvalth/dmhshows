#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const OUT = path.resolve("./public/dmh-events.json");

// --- helper to parse the DMH date string into ISO
function parseDateToISO(text) {
  if (!text) return null;
  // DMH seems like "Mon 6 Oct 2025"
  const cleaned = text.replace(/\s+/g, " ").trim();
  const parts = cleaned.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!parts) return null;
  const day = parts[1];
  const month = parts[2];
  const year = parts[3];
  const date = new Date(`${day} ${month} ${year}`);
  return isNaN(date) ? null : date.toISOString();
}

function statusFromText(raw) {
  const t = (raw || "").toUpperCase().replace(/\s+/g, " ").trim();
  if (/\bSOLD[-\s]*OUT\b/.test(t)) return "SOLD OUT";
  if (/\bBOOK\s*NOW\b/.test(t)) return "BOOK NOW";
  if (/\bON\s*SALE\s*SOON\b/.test(t)) return "ON SALE SOON";
  if (/\bLIMITED\b/.test(t)) return "LIMITED";
  return "";
}

// --- open Ticketsolve and check its availability
async function getTicketsolveStatus(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const txt = await page.evaluate(() => document.body.innerText || "");
    const s = statusFromText(txt);
    if (s) return s;

    // fallback: disabled purchase button
    const disabledBtn = await page.$('button[disabled], .button[disabled], .btn[disabled]');
    if (disabledBtn) return "SOLD OUT";

    const badges = await page.$$eval(
      '*, [class*="status"], [class*="availability"], [class*="ticket"]',
      els => els.slice(0, 200).map(e => (e.innerText || e.textContent || ""))
    );
    for (const b of badges) {
      const s2 = (b || "").toUpperCase();
      if (s2.includes("SOLD OUT")) return "SOLD OUT";
      if (s2.includes("ON SALE SOON")) return "ON SALE SOON";
      if (s2.includes("LIMITED")) return "LIMITED";
    }
    return "BOOK NOW";
  } catch {
    return "";
  } finally {
    await page.close();
  }
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const events = [];
  for (let pageNum = 1; pageNum <= 8; pageNum++) {
    const url = pageNum === 1
      ? "https://www.demontforthall.co.uk/whats-on/"
      : `https://www.demontforthall.co.uk/whats-on/page/${pageNum}/`;

    console.log("[info]", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    const cards = await page.$$(".card-event");
    console.log(`[info] found ${cards.length} cards on page ${pageNum}`);

    for (const el of cards) {
      const title = (await el.$eval(".title", n => n.innerText)).trim();

      const dateText = await el.$eval(".date", n => n.innerText).catch(() => "");
      const startISO = parseDateToISO(dateText);

      const ctaHref = await el.$eval("a.cta.cta--primary", a => a.href).catch(() => "");

      const cardText = await el.evaluate(n => n.innerText || n.textContent || "");
      let status = statusFromText(cardText);

      if (!status && ctaHref) {
        status = await getTicketsolveStatus(context, ctaHref);
      }
      if (!status && ctaHref) status = "BOOK NOW";

      const override_pct =
        status === "SOLD OUT" ? 100 :
        status === "BOOK NOW" ? 48 :
        30;

      events.push({ title, start: startISO, status, override_pct });
    }
  }

  await browser.close();

  console.log(`Wrote ${events.length} events -> ${OUT}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(events, null, 2));
}

scrape().catch(e => {
  console.error(e);
  process.exit(1);
});

