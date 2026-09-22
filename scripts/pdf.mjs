#!/usr/bin/env node
// Print docs/acting-for-an-account.html to a landscape PDF, one slide per
// page, with headless Chrome (CHROME=/path/to/chrome to override).
import puppeteer from "puppeteer-core";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const html = new URL("../docs/acting-for-an-account.html", import.meta.url);
const pdf = new URL("../docs/acting-for-an-account.pdf", import.meta.url).pathname;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.goto(html.href, { waitUntil: "load" });
await page.emulateMediaType("print");
await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
await browser.close();
console.log(pdf);
