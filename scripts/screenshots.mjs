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

// alice again, as an app for one host: the audience-specific permission, generic consent screen.
await page.goto(`${APP}/alice`, { waitUntil: "load" });
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/alice/sign-out'] button")]);
await page.waitForSelector("form[action='/oauth/raw/start']");
await signIn("/oauth/raw/start", "alice-pass", "06-consent-raw-scope");

// --- Sign-in as the club, from a stock client ---------------------------------

const hasButton = (re) => page.evaluate((src) => [...document.querySelectorAll("button")].some((b) => new RegExp(src, "i").test(b.innerText)), re.source);
/** Wait for whichever of a password field, an account list, or the consent screen comes up. */
const waitForPdsStep = () => page.waitForFunction(() =>
  !!document.querySelector("input[type=password]") ||
  [...document.querySelectorAll("button")].some((b) => /^authorize$/i.test(b.innerText) || /club\.test/.test(b.innerText)));

// The stock client's sign-in page, then the club's PDS: the stock sign-in
// screen, with the link this prototype adds.
await page.goto(`${APP}/stock`, { waitUntil: "load" });
await shot("07-stock-client");
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/oauth/stock/start'] button:not([name])")]);
await page.waitForSelector("input[type=password]");
await settled();
await shot("08-club-sign-in-screen-with-link");
// Take the link: the PDS's own sign-in-as page.
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("a[href='#']")]);
await page.waitForSelector("input[name=handle]");
await shot("09-sign-in-as-page");
await page.type("input[name=handle]", "alice.test");
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/oauth/delegate'] button")]);
// alice's own PDS: she may already be signed in there from earlier (then only consent is asked).
await waitForPdsStep();
if (await page.$("input[type=password]")) {
  await page.type("input[type=password]", "alice-pass");
  await clickText(/^sign in$/);
}
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /^authorize$/i.test(b.innerText)));
await settled();
await shot("10-consent-nested-atproto-only");
await clickText(/^authorize$/);
// Callback → finish → back at the club's authorize page, which now lists club.test.
await page.waitForFunction(() => location.pathname === "/oauth/authorize" && [...document.querySelectorAll("button")].some((b) => /^authorize$/i.test(b.innerText) || /club\.test/.test(b.innerText)));
await settled();
if (!(await hasButton(/^authorize$/))) {
  await shot("11-club-consent-lists-club-session");
  await clickText(/club\.test/);
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /^authorize$/i.test(b.innerText)));
  await settled();
}
await shot("12-consent-as-club");
await clickText(/^authorize$/);
await backAtApp();
await page.waitForNetworkIdle({ idleTime: 300 }).catch(() => {});
await page.waitForSelector("form[action='/stock/write']");
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/stock/write'] button[value=accept]")]);
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/stock/write'] button[value=post]")]);
await shot("13-stock-acting-as-club");

// The club sees both paths in its log, and the delegated session.
await page.goto(`${APP}/club`, { waitUntil: "load" });
await shot("14-club-log-and-sessions");

// --- Creating a community from an app -------------------------------------------

// alice, still signed in to her app as an app for one host, creates riders.test.
await page.goto(`${APP}/alice`, { waitUntil: "load" });
await page.waitForSelector("form[action='/alice/create']");
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/alice/create'] button")]);
await shot("15-alice-created-a-community");

/** Drive whatever PDS screens come up (password, account list, consent) until the browser is back at the app. */
async function driveBackToApp(password) {
  for (let i = 0; i < 8 && !page.url().startsWith(APP); i++) {
    await page.waitForFunction((app) =>
      location.href.startsWith(app) ||
      !!document.querySelector("input[type=password]") ||
      [...document.querySelectorAll("button")].some((b) => /^authorize$/i.test(b.innerText) || /\.test$/.test(b.innerText.trim())), {}, APP);
    if (page.url().startsWith(APP)) break;
    if (await page.$("input[type=password]")) {
      await page.type("input[type=password]", password);
      await clickText(/^sign in$/);
    } else if (await hasButton(/^authorize$/)) {
      await settled();
      await clickText(/^authorize$/);
    } else {
      await clickText(/\.test$/);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  await backAtApp();
  await page.waitForNetworkIdle({ idleTime: 300 }).catch(() => {});
}

// The founder opens the tool as riders: she signs in as a controller, never a password for riders.
await page.goto(`${APP}/club`, { waitUntil: "load" });
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/club/sign-out'] button")]);
await page.waitForSelector("form[action='/oauth/club/start']");
await page.$eval("form[action='/oauth/club/start'] input[name=who]", (el) => { el.value = "riders.test"; });
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/oauth/club/start'] button[name=as_delegate]")]);
await page.waitForSelector("input[name=handle]");
await page.type("input[name=handle]", "alice.test");
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("form[action='/oauth/delegate'] button")]);
await driveBackToApp("alice-pass");
await page.waitForSelector("form[action='/club/controllers']");
await shot("16-tool-as-controller");

await browser.close();
console.log("done");
process.exit(0);
