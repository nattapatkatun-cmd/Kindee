'use strict';
// Chromium resolution + a page harness for driving the real index.html.
//
// The app is a single static file with no build step, so the tests load it over file://
// and talk to its globals directly. Firebase and the CDN are unreachable in CI; the app
// falls back to localStorage on its own, so those network failures are filtered out and
// everything else is treated as a test failure.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const APP_PATH = path.resolve(__dirname, '..', '..', 'index.html');

// Resolve a Chromium binary without assuming Playwright's own download layout:
//   1. CHROMIUM_PATH — explicit override
//   2. a browser already sitting in PLAYWRIGHT_BROWSERS_PATH (preinstalled images)
//   3. undefined — let playwright-core find its own download
function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && fs.existsSync(root)) {
    for (const dir of fs.readdirSync(root)) {
      if (!dir.startsWith('chromium')) continue;
      for (const bin of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const full = path.join(root, dir, bin);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return undefined;
}

async function launch() {
  const executablePath = chromiumExecutable();
  return chromium.launch(executablePath ? { executablePath } : {});
}

// Network errors are expected offline and are not what these tests are about.
const IGNORABLE = /net::|Failed to load resource|ERR_|firebase|firestore|gstatic|googleapis|jsdelivr|cdn/i;

/**
 * Open index.html with `seed` written to localStorage.
 *
 * The seed is applied ONCE per browser context, not on every navigation: a test that
 * changes a setting and then reloads must see its own change survive, and an unguarded
 * addInitScript would overwrite it on the way back in.
 */
async function openApp(browser, seed, { settleMs = 1800 } = {}) {
  const page = await browser.newPage();
  const errors = [];

  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORABLE.test(m.text())) errors.push('console.error: ' + m.text());
  });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  await page.addInitScript((data) => {
    if (localStorage.getItem('__seeded')) return;
    for (const [k, v] of Object.entries(data)) {
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    localStorage.setItem('__seeded', '1');
  }, seed);

  await page.goto('file://' + APP_PATH, { waitUntil: 'load' });
  await page.waitForTimeout(settleMs);

  // The app's own window.onerror toast is the symptom a user reports; surface it too so a
  // handled-but-visible error still fails the run.
  page.errorToast = () =>
    page.evaluate(() => {
      const t = [...document.querySelectorAll('.toast, [class*="toast"], [id*="toast"]')]
        .map((e) => e.textContent || '')
        .join(' ');
      return /JS error/.test(t) ? t.replace(/\s+/g, ' ').slice(0, 200) : null;
    });

  page.collectedErrors = errors;
  return page;
}

/** All errors seen so far, including the app's own visible error toast. Deduplicated. */
async function errorsFor(page) {
  const toast = await page.errorToast();
  const all = toast ? page.collectedErrors.concat('error toast: ' + toast) : page.collectedErrors;
  return [...new Set(all)];
}

/**
 * WT.log is hydrated when the weight tab initialises, not at page load, so any test that
 * reads the weight analysis has to go through the tab first — same as a real user.
 */
async function openWeightAnalysis(page) {
  return page.evaluate(() => {
    showPage('weight');
    if (typeof initWeightTab === 'function') initWeightTab();
    runWeightAnalysis();
    return (document.getElementById('wt-analysis-result').textContent || '').replace(/\s+/g, ' ');
  });
}

module.exports = { APP_PATH, launch, openApp, errorsFor, openWeightAnalysis };
