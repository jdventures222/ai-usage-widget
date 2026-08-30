/**
 * fetch-via-window.js
 *
 * Fetches JSON from a URL using a hidden BrowserWindow.
 *
 * Why this exists:
 * Claude.ai uses Cloudflare protection and detects Electron's default
 * request headers, blocking standard Node.js fetch/http requests.
 * By loading the URL in a hidden BrowserWindow with a spoofed Chrome
 * User-Agent, we ride on the browser session cookies and bypass
 * Cloudflare's bot detection. This is the simplest reliable approach
 * after the previous cookie-database-reading strategy proved too
 * fragile and OS-specific.
 */
const { BrowserWindow } = require('electron');

/**
 * Known error signatures returned when Claude.ai blocks or changes behaviour.
 * If the extracted body matches one of these patterns we throw a specific error
 * so callers can react (e.g. prompt re-login).
 */
const BLOCKED_SIGNATURES = [
  { pattern: 'Just a moment', error: 'CloudflareBlocked' },
  { pattern: 'Enable JavaScript and cookies to continue', error: 'CloudflareChallenge' },
  { pattern: '<html', error: 'UnexpectedHTML' },
];

/**
 * Parse and validate response body text
 * @param {string} bodyText - Raw body text from the page * @returns {Object} Parsed JSON data
 * @throws {Error} If blocked signatures detected or JSON parsing fails
 */
function parseResponseBody(bodyText) {
  // Detect known block/failure signatures before attempting JSON parse.
  // This provides explicit errors when Claude.ai modifies their API or CSP.
  for (const sig of BLOCKED_SIGNATURES) {
    if (bodyText.includes(sig.pattern)) {
      throw new Error(sig.error);
    }
  }

  try {
    return JSON.parse(bodyText);
  } catch (parseErr) {
    throw new Error('InvalidJSON');
  }
}

function validateClaudeApiUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || !url.pathname.startsWith('/api/')) {
    throw new Error('BlockedURL');
  }
  return url.toString();
}

/**
 * Fetch a single URL using a dedicated BrowserWindow (legacy single-call approach)
 * @param {string} url - URL to fetch
 * @param {Object} options - Options object
 * @param {number} options.timeoutMs - Request timeout in milliseconds (default: 30000)
 * @returns {Promise<Object>} Parsed JSON response
 */
function fetchViaWindow(url, { timeoutMs = 30000, browserSession } = {}) {
  return new Promise((resolve, reject) => {
    let safeUrl;
    try { safeUrl = validateClaudeApiUrl(url); }
    catch (error) { reject(error); return; }
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        ...(browserSession ? { session: browserSession } : {})
      }
    });

    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!win.isDestroyed()) win.destroy();
      if (error) reject(error); else resolve(value);
    };

    const timeout = setTimeout(() => {
      finish(new Error('RequestTimeout'));
    }, timeoutMs);

    win.webContents.on('did-finish-load', async () => {
      try {
        const bodyText = await win.webContents.executeJavaScript(
          'document.body.innerText || document.body.textContent'
        );
        const data = parseResponseBody(bodyText);
        finish(null, data);
      } catch (err) {
        finish(err);
      }
    });

    win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      finish(new Error(`LoadFailed:${errorCode}`));
    });

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, nextUrl) => {
      try { validateClaudeApiUrl(nextUrl); }
      catch { event.preventDefault(); finish(new Error('BlockedNavigation')); }
    });
    win.loadURL(safeUrl);
  });
}

/**
 * Fetch multiple URLs sequentially using a single reused BrowserWindow
 * This reduces memory overhead by avoiding repeated window creation/destruction
 * 
 * @param {string[]} urls - Array of URLs to fetch
 * @param {Object} options - Options object
 * @param {number} options.timeoutMs - Per-request timeout in milliseconds (default: 10000)
 * @returns {Promise<Object[]>} Array of parsed JSON responses (or errors)
 */
async function fetchMultipleViaWindow(urls, options = {}) {
  const results = [];
  for (const url of urls) {
    try {
      const value = await fetchViaWindow(url, options);
      results.push({ ok: true, value });
    } catch (error) {
      if (!options.continueOnError) throw error;
      results.push({ ok: false, error });
    }
  }
  return results;
}

module.exports = { fetchViaWindow, fetchMultipleViaWindow, parseResponseBody, validateClaudeApiUrl };
