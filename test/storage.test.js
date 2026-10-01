'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  convertLegacyHistory,
  pruneHistory,
  sanitizeSettings
} = require('../src/main/storage');

test('legacy history imports only the approved Claude buckets', () => {
  const history = convertLegacyHistory({
    usageHistory: [{
      timestamp: 1_800_000_000_000,
      session: 10,
      weekly: 20,
      fable: 30,
      sonnet: 91,
      opus: 92,
      cowork: 93,
      design: 94,
      oauthApps: 95,
      extraUsage: 96
    }]
  });
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].buckets, {
    'claude:all-models:primary:300': 10,
    'claude:all-models:secondary:10080': 20,
    'claude:fable:secondary:10080': 30
  });
});

test('settings are bounded', () => {
  assert.equal(DEFAULT_SETTINGS.refreshInterval, 300);
  const sanitized = sanitizeSettings({
    refreshInterval: 61,
    warnThreshold: 90,
    dangerThreshold: 50
  });
  assert.equal(sanitized.refreshInterval, 300);
  assert.equal(sanitized.dangerThreshold, 91);
});

test('settings saved by 2.0 drop Codex and floating-window fields', () => {
  const sanitized = sanitizeSettings({
    enabledProviders: { claude: false, codex: true },
    codexExecutable: '/usr/local/bin/codex',
    alwaysOnTop: true,
    widgetCorner: 'top-right',
    hudOpacity: 0.92,
    theme: 'light'
  });
  assert.equal(sanitized.theme, 'light');
  for (const removed of ['enabledProviders', 'codexExecutable', 'alwaysOnTop', 'allSpaces', 'widgetCorner', 'hudOpacity', 'minimizeToTray']) {
    assert.equal(Object.hasOwn(sanitized, removed), false, removed);
  }
});

test('history pruning rejects old samples and enforces ordering', () => {
  const now = 1_800_000_000_000;
  const recent = { timestamp: now - 1000, providerId: 'claude', buckets: { x: 1 } };
  const older = { timestamp: now - 2000, providerId: 'claude', buckets: { x: 2 } };
  const expired = { timestamp: now - (9 * 24 * 60 * 60 * 1000), providerId: 'claude', buckets: { x: 3 } };
  assert.deepEqual(pruneHistory([recent, expired, older], now), [older, recent]);
});
