'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSnapshot,
  createUnavailableSnapshot,
  formatWindowLabel,
  normalizeTimestamp,
  safeText
} = require('../src/shared/provider-contract');

test('provider contract clamps values and strips control characters', () => {
  const snapshot = createSnapshot('codex', {
    providerName: 'Co\u0000dex',
    status: 'ready',
    buckets: [{ id: 'codex:primary:300', label: 'Codex', usedPercent: 120, windowMinutes: 300 }]
  });
  assert.equal(snapshot.providerName, 'Co dex');
  assert.equal(snapshot.buckets[0].usedPercent, 100);
  assert.equal(snapshot.buckets[0].windowLabel, '5 hours');
  assert.equal(formatWindowLabel(10080), '7 days');
  assert.equal(safeText('  a\n b  '), 'a b');
  assert.equal(normalizeTimestamp(1_800_000_000), '2027-01-15T08:00:00.000Z');
});

test('logout and disable states never expose stale usage', () => {
  const previous = createSnapshot('claude', {
    providerName: 'Claude',
    status: 'ready',
    buckets: [{ id: 'x', label: 'X', usedPercent: 44 }]
  });
  const loggedOut = createUnavailableSnapshot('claude', 'Claude', 'unauthenticated', 'login', previous);
  const failed = createUnavailableSnapshot('claude', 'Claude', 'error', 'failure', previous);
  assert.equal(loggedOut.status, 'unauthenticated');
  assert.deepEqual(loggedOut.buckets, []);
  assert.equal(failed.status, 'stale');
  assert.equal(failed.buckets[0].usedPercent, 44);
});
