#!/usr/bin/env node
// Walk the browser demo in headless Chrome and save what a person would see,
// into docs/screenshots/. Needs `pnpm demo:app` running on a fresh start, and
// a Chrome install (CHROME=/path/to/chrome to override).
//
//   pnpm demo:app                  # in one terminal, freshly started
//   node scripts/screenshots.mjs   # in another
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://127.0.0.1:2704";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 880, height: 1000, deviceScaleFactor: 2 });
page.setDefaultTimeout(20_000);
const shot = async (name) => { await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true }); console.log(`  ${name}.png`); };
const clickText = async (re) => {
  const ok = await page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const b = [...document.querySelectorAll("button")].find((b) => re.test(b.innerText));
    if (b) b.click();
    return !!b;
  }, re.source);
  if (!ok) throw new Error(`no button matching ${re}: ${await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.innerText).join(" | "))}`);
};
const backAtApp = () => page.waitForFunction((app) => location.href.startsWith(app), {}, APP);
const settled = () => new Promise((r) => setTimeout(r, 800));

/** From an app page, press a sign-in button, sign in on the PDS, screenshot the consent, accept. */
async function signIn(formAction, password, consentShot) {
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click(`form[action='${formAction}'] button`)]);
  await page.waitForSelector("input[type=password]");
  await page.type("input[type=password]", password);
  await clickText(/^sign in$/);
  // The consent screen is rendered by the same page after sign-in.
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /^authorize$/i.test(b.innerText)));
  await settled();
  await shot(consentShot);
  await clickText(/^authorize$/);
  await backAtApp();
  await page.waitForNetworkIdle({ idleTime: 300 }).catch(() => {});
}

console.log("Screenshots:");
await page.goto(`${APP}/`, { waitUntil: "load" });
await shot("00-index");

// The club's tool.
await page.goto(`${APP}/club`, { waitUntil: "load" });
await signIn("/oauth/club/start", "club-pass", "01-consent-club");
await page.waitForSelector("form[action='/club/delegates/put']");
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/club/delegates/put'] button")]);
await shot("02-club-delegates");

// alice's app, with the permission set.
await page.goto(`${APP}/alice`, { waitUntil: "load" });
await signIn("/oauth/set/start", "alice-pass", "03-consent-permission-set");
await page.waitForSelector("form[action='/alice/write']");
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/alice/write'] button[value=accept]")]);
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/alice/write'] button[value=post]")]);
await shot("04-alice-acting-as");

// The club sees who wrote what.
await page.goto(`${APP}/club`, { waitUntil: "load" });
await shot("05-club-log");

// alice again, with the raw scope: same grant, generic consent screen.
await page.goto(`${APP}/alice`, { waitUntil: "load" });
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/alice/sign-out'] button")]);
await page.waitForSelector("form[action='/oauth/raw/start']");
await signIn("/oauth/raw/start", "alice-pass", "06-consent-raw-scope");

await browser.close();
console.log("done");
process.exit(0);
