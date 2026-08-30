'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD_SCHEME = 'ai-widget';
const DASHBOARD_HOST = 'dashboard';
const DASHBOARD_URL = `${DASHBOARD_SCHEME}://${DASHBOARD_HOST}/index.html`;
const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ');

const DASHBOARD_ASSETS = Object.freeze({
  '/index.html': Object.freeze({ file: 'src/renderer/index.html', type: 'text/html; charset=utf-8' }),
  '/styles.css': Object.freeze({ file: 'src/renderer/styles.css', type: 'text/css; charset=utf-8' }),
  '/app.js': Object.freeze({ file: 'src/renderer/app.js', type: 'text/javascript; charset=utf-8' }),
  '/node_modules/chart.js/dist/chart.umd.js': Object.freeze({
    file: 'node_modules/chart.js/dist/chart.umd.js',
    type: 'text/javascript; charset=utf-8'
  }),
  '/assets/ai-usage-logo.svg': Object.freeze({ file: 'assets/ai-usage-logo.svg', type: 'image/svg+xml' }),
  '/assets/fonts/LibreBaskerville-Regular.ttf': Object.freeze({
    file: 'assets/fonts/LibreBaskerville-Regular.ttf',
    type: 'font/ttf'
  }),
  '/assets/fonts/LibreBaskerville-Bold.ttf': Object.freeze({
    file: 'assets/fonts/LibreBaskerville-Bold.ttf',
    type: 'font/ttf'
  })
});

function registerDashboardScheme(electronProtocol) {
  electronProtocol.registerSchemesAsPrivileged([{
    scheme: DASHBOARD_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: false,
      allowServiceWorkers: false,
      supportFetchAPI: false,
      corsEnabled: false,
      stream: false,
      codeCache: true
    }
  }]);
}

function resolveDashboardAsset(request) {
  if (!request || request.method !== 'GET' || typeof request.url !== 'string') return null;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${DASHBOARD_SCHEME}:` ||
    url.hostname !== DASHBOARD_HOST ||
    url.username ||
    url.password ||
    url.port ||
    url.search
  ) return null;
  return DASHBOARD_ASSETS[url.pathname === '/' ? '/index.html' : url.pathname] || null;
}

async function handleDashboardRequest(request, { rootDir, readFile = fs.promises.readFile } = {}) {
  const asset = resolveDashboardAsset(request);
  if (!asset || typeof rootDir !== 'string') {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  try {
    const body = await readFile(path.join(rootDir, asset.file));
    return new Response(body, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': DASHBOARD_CSP,
        'Content-Type': asset.type,
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function registerDashboardHandler(electronProtocol, rootDir) {
  await electronProtocol.handle(DASHBOARD_SCHEME, (request) => handleDashboardRequest(request, { rootDir }));
}

module.exports = {
  DASHBOARD_CSP,
  DASHBOARD_SCHEME,
  DASHBOARD_URL,
  handleDashboardRequest,
  registerDashboardHandler,
  registerDashboardScheme,
  resolveDashboardAsset
};
