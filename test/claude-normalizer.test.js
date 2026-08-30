'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeClaudeUsage } = require('../src/main/claude-normalizer');

test('Claude normalization emits exactly 5-hour, weekly, and Fable limits', () => {
  const snapshot = normalizeClaudeUsage({
    five_hour: { utilization: 12, resets_at: '2026-08-30T18:00:00Z' },
    seven_day: { utilization: 34, resets_at: '2026-09-01T18:00:00Z' },
    seven_day_sonnet: { utilization: 88, resets_at: '2026-09-02T18:00:00Z' },
    seven_day_opus: { utilization: 89, resets_at: '2026-09-02T18:00:00Z' },
    limits: [
      {
        kind: 'weekly_scoped',
        percent: 56,
        resets_at: '2026-09-03T18:00:00Z',
        scope: { model: { display_name: 'Fable' } }
      },
      {
        kind: 'weekly_scoped',
        percent: 99,
        resets_at: '2026-09-03T18:00:00Z',
        scope: { model: { display_name: 'Cowork' } }
      }
    ]
  }, {
    overage: { monthly_credit_limit: 100, used_credits: 50 },
    prepaid: { amount: 500, currency: 'USD' }
  });

  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.id), [
    'claude:all-models:primary:300',
    'claude:all-models:secondary:10080',
    'claude:fable:secondary:10080'
  ]);
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.usedPercent), [12, 34, 56]);
  assert.deepEqual(snapshot.credits, []);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['sonnet', 'opus', 'cowork', 'extra-usage', 'prepaid']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
});

test('Claude normalization tolerates an unavailable Fable bucket', () => {
  const snapshot = normalizeClaudeUsage({
    five_hour: { utilization: 3 },
    seven_day: { utilization: 4 },
    seven_day_fable: null
  });
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.id), [
    'claude:all-models:primary:300',
    'claude:all-models:secondary:10080'
  ]);
});
