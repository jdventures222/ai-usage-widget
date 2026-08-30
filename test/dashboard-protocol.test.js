'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  DASHBOARD_SCHEME,
  DASHBOARD_URL,
  handleDashboardRequest,
  registerDashboardScheme,
  resolveDashboardAsset
} = require('../src/main/dashboard-protocol');

const rootDir = path.resolve(__dirname, '..');

test('dashboard scheme is standard and secure without bypassing CSP', () => {
  let registrations;
  registerDashboardScheme({ registerSchemesAsPrivileged: (input) => { registrations = input; } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].scheme, DASHBOARD_SCHEME);
  assert.equal(registrations[0].privileges.standard, true);
  assert.equal(registrations[0].privileges.secure, true);
  assert.equal(registrations[0].privileges.bypassCSP, false);
  assert.equal(registrations[0].privileges.supportFetchAPI, false);
  assert.equal(registrations[0].privileges.allowServiceWorkers, false);
});

test('dashboard protocol serves only its fixed local asset allowlist', async () => {
  const response = await handleDashboardRequest({ method: 'GET', url: DASHBOARD_URL }, { rootDir });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(await response.text(), /<title>AI Usage Widget<\/title>/);

  for (const request of [
    { method: 'POST', url: DASHBOARD_URL },
    { method: 'GET', url: 'ai-widget://other/index.html' },
    { method: 'GET', url: 'ai-widget://dashboard/main.js' },
    { method: 'GET', url: 'ai-widget://dashboard/index.html?debug=true' },
    { method: 'GET', url: 'https://dashboard/index.html' }
  ]) {
    assert.equal(resolveDashboardAsset(request), null);
    assert.equal((await handleDashboardRequest(request, { rootDir })).status, 404);
  }
});
