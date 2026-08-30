'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  applyPersistentHudDefaults,
  convertLegacyHistory,
  pruneHistory,
  sanitizeSettings
} = require('../src/main/storage');

class MemoryStore {
  constructor(values = {}) { this.values = structuredClone(values); }
  get(key, fallback) {
    const parts = key.split('.');
    let value = this.values;
    for (const part of parts) value = value?.[part];
    return value === undefined ? fallback : value;
  }
  set(key, value) {
    const parts = key.split('.');
    let target = this.values;
    for (const part of parts.slice(0, -1)) target = target[part] ||= {};
    target[parts.at(-1)] = value;
  }
}

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

test('HUD settings are bounded and default to a subtle persistent corner', () => {
  assert.equal(DEFAULT_SETTINGS.widgetCorner, 'top-right');
  assert.equal(DEFAULT_SETTINGS.alwaysOnTop, true);
  assert.equal(DEFAULT_SETTINGS.allSpaces, true);
  assert.equal(DEFAULT_SETTINGS.minimizeToTray, true);
  const sanitized = sanitizeSettings({
    widgetCorner: 'center',
    hudOpacity: 0.1,
    refreshInterval: 61,
    warnThreshold: 90,
    dangerThreshold: 50
  });
  assert.equal(sanitized.widgetCorner, 'top-right');
  assert.equal(sanitized.hudOpacity, 0.92);
  assert.equal(sanitized.refreshInterval, 300);
  assert.equal(sanitized.dangerThreshold, 91);
});

test('persistent HUD defaults apply once and preserve later choices', () => {
  const store = new MemoryStore({ settings: { theme: 'light', minimizeToTray: false } });
  assert.equal(applyPersistentHudDefaults(store), true);
  assert.equal(store.get('settings.theme'), 'light');
  assert.equal(store.get('settings.minimizeToTray'), true);
  assert.equal(store.get('settings.autoStart'), true);
  store.set('settings.widgetCorner', 'bottom-left');
  assert.equal(applyPersistentHudDefaults(store), false);
  assert.equal(store.get('settings.widgetCorner'), 'bottom-left');
});

test('history pruning rejects old samples and enforces ordering', () => {
  const now = 1_800_000_000_000;
  const recent = { timestamp: now - 1000, providerId: 'codex', buckets: { x: 1 } };
  const older = { timestamp: now - 2000, providerId: 'codex', buckets: { x: 2 } };
  const expired = { timestamp: now - (9 * 24 * 60 * 60 * 1000), providerId: 'codex', buckets: { x: 3 } };
  assert.deepEqual(pruneHistory([recent, expired, older], now), [older, recent]);
});
