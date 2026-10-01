'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatMenuBarTitle, popoverBounds } = require('../src/main/menu-bar');
const { createSnapshot, createUnavailableSnapshot } = require('../src/shared/provider-contract');

function ready(percents) {
  return createSnapshot('claude', {
    providerName: 'Claude',
    status: 'ready',
    buckets: percents.map((usedPercent, index) => ({ id: `b${index}`, label: 'Limit', usedPercent }))
  });
}

test('menu bar title shows the tightest limit', () => {
  assert.equal(formatMenuBarTitle(ready([12, 41.6, 30])), '42%');
});

test('menu bar title marks a last-known value and an account without data', () => {
  const stale = createUnavailableSnapshot('claude', 'Claude', 'error', 'claude_fetch_failed', ready([55]));
  const signedOut = createUnavailableSnapshot('claude', 'Claude', 'unauthenticated', 'claude_login_required');
  assert.equal(formatMenuBarTitle(stale), '~55%');
  assert.equal(formatMenuBarTitle(signedOut), '–');
  assert.equal(formatMenuBarTitle(undefined), '');
});

test('panel opens centred under a menu bar icon and stays on screen', () => {
  const workArea = { x: 0, y: 25, width: 1512, height: 957 };
  const size = { width: 400, height: 600 };
  assert.deepEqual(
    popoverBounds({ x: 700, y: 0, width: 40, height: 24 }, workArea, size),
    { x: 520, y: 31, width: 400, height: 600 }
  );
  const nearEdge = popoverBounds({ x: 1480, y: 0, width: 30, height: 24 }, workArea, size);
  assert.equal(nearEdge.x, 1512 - 400 - 6);
});

test('panel opens above a bottom taskbar and falls back to the top-right corner', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 400, height: 600 };
  const bottom = popoverBounds({ x: 1800, y: 1040, width: 24, height: 40 }, workArea, size);
  assert.equal(bottom.y, 1040 - 600 - 6);
  assert.deepEqual(
    popoverBounds({ x: 0, y: 0, width: 0, height: 0 }, workArea, size),
    { x: 1920 - 400 - 6, y: 6, width: 400, height: 600 }
  );
});

test('panel shrinks to fit a short display', () => {
  const bounds = popoverBounds({ x: 600, y: 0, width: 30, height: 24 }, { x: 0, y: 25, width: 1280, height: 500 }, { width: 400, height: 600 });
  assert.equal(bounds.height, 488);
  assert.ok(bounds.y + bounds.height <= 25 + 500);
});
