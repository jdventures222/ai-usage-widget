'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexClientError } = require('../src/main/codex-client');
const { normalizeCodexRateLimits } = require('../src/main/codex-provider');

function window(usedPercent, windowDurationMins, resetsAt = 1_800_000_000) {
  return { usedPercent, windowDurationMins, resetsAt };
}

test('Codex normalization emits only canonical Codex windows', () => {
  const snapshot = normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        limitName: 'Codex',
        planType: 'plus',
        primary: window(17, 300),
        secondary: window(28, 10080),
        individualLimit: { remainingPercent: 20 },
        credits: { hasCredits: true, balance: '50' }
      },
      codex_bengalfox: {
        limitId: 'codex_bengalfox',
        limitName: 'Codex Spark',
        primary: window(91, 300),
        secondary: window(92, 10080)
      },
      base_model_inference: {
        limitId: 'base_model_inference',
        limitName: 'GPT Reserve',
        secondary: window(93, 10080)
      }
    },
    rateLimitResetCredits: { availableCount: 4 }
  });

  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.id), [
    'codex:primary:300',
    'codex:secondary:10080'
  ]);
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.usedPercent), [17, 28]);
  assert.deepEqual(snapshot.credits, []);
  assert.equal(snapshot.meta.resetCreditsAvailable, null);
  assert.equal(JSON.stringify(snapshot).includes('Spark'), false);
  assert.equal(JSON.stringify(snapshot).includes('Reserve'), false);
});

test('Codex normalization accepts the legacy single-limit shape', () => {
  const snapshot = normalizeCodexRateLimits({
    rateLimits: { secondary: window(8, 10080) }
  });
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.id), ['codex:secondary:10080']);
});

test('Codex normalization refuses a multi-limit response without canonical Codex', () => {
  assert.throws(
    () => normalizeCodexRateLimits({
      rateLimitsByLimitId: {
        codex_bengalfox: { primary: window(9, 300) },
        base_model_inference: { secondary: window(10, 10080) }
      },
      rateLimits: { primary: window(11, 300) }
    }),
    (error) => error instanceof CodexClientError && error.code === 'invalid_response'
  );
});
