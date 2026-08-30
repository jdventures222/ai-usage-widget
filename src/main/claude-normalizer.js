'use strict';

const {
  createSnapshot,
  normalizePercent
} = require('../shared/provider-contract');
const { normalizeUsageLimits } = require('../normalize-usage-limits');

function appendBucket(buckets, seen, input) {
  const percent = normalizePercent(input.value?.utilization);
  if (percent === null) return;
  if (seen.has(input.id)) return;
  seen.add(input.id);
  buckets.push({
    id: input.id,
    limitId: input.limitId,
    label: input.label,
    windowLabel: input.windowLabel,
    windowMinutes: input.windowMinutes,
    usedPercent: percent,
    resetsAt: input.value?.resets_at,
    category: input.category || 'quota',
    role: input.role
  });
}

function normalizeClaudeUsage(usagePayload, _optional = {}, options = {}) {
  if (!usagePayload || typeof usagePayload !== 'object' || Array.isArray(usagePayload)) {
    throw new TypeError('invalid_claude_usage');
  }
  const data = { ...usagePayload };
  normalizeUsageLimits(data);
  const buckets = [];
  const seen = new Set();

  appendBucket(buckets, seen, {
    id: 'claude:all-models:primary:300',
    limitId: 'all-models',
    label: 'All models',
    windowLabel: '5 hours',
    windowMinutes: 300,
    role: 'primary',
    value: data.five_hour
  });
  appendBucket(buckets, seen, {
    id: 'claude:all-models:secondary:10080',
    limitId: 'all-models',
    label: 'All models',
    windowLabel: '7 days',
    windowMinutes: 10080,
    role: 'secondary',
    value: data.seven_day
  });

  appendBucket(buckets, seen, {
    id: 'claude:fable:secondary:10080',
    limitId: 'fable',
    label: 'Fable',
    windowLabel: '7 days',
    windowMinutes: 10080,
    role: 'secondary',
    value: data.seven_day_fable
  });

  return createSnapshot('claude', {
    providerName: 'Claude',
    status: 'ready',
    fetchedAt: options.fetchedAt || Date.now(),
    buckets,
    credits: [],
    account: { displayName: options.organizationName || null },
    meta: { noUsage: buckets.length === 0 }
  });
}

module.exports = { normalizeClaudeUsage };
