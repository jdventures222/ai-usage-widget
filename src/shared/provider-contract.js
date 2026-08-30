'use strict';

const PROVIDER_STATUSES = Object.freeze([
  'ready',
  'disabled',
  'loading',
  'unauthenticated',
  'cli_missing',
  'unsupported_version',
  'stale',
  'offline',
  'error'
]);

const STATUS_SET = new Set(PROVIDER_STATUSES);

function safeText(value, fallback = '', maxLength = 160) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePercent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, number));
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  let milliseconds;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
  } else {
    milliseconds = Date.parse(String(value));
  }
  if (!Number.isFinite(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function normalizeWindowMinutes(value) {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  return Math.round(number);
}

function formatWindowLabel(minutes, fallback = 'Usage window') {
  const normalized = normalizeWindowMinutes(minutes);
  if (!normalized) return fallback;
  if (normalized % 10080 === 0) {
    const weeks = normalized / 10080;
    return weeks === 1 ? '7 days' : `${weeks} weeks`;
  }
  if (normalized % 1440 === 0) {
    const days = normalized / 1440;
    return days === 1 ? '24 hours' : `${days} days`;
  }
  if (normalized % 60 === 0) {
    const hours = normalized / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return `${normalized} minutes`;
}

function createBucket(input) {
  if (!input || typeof input !== 'object') return null;
  const id = safeText(input.id, '', 220);
  const label = safeText(input.label, '', 120);
  const usedPercent = normalizePercent(input.usedPercent);
  if (!id || !label || usedPercent === null) return null;
  const windowMinutes = normalizeWindowMinutes(input.windowMinutes);
  return {
    id,
    limitId: safeText(input.limitId, '', 160) || null,
    label,
    windowLabel: safeText(
      input.windowLabel,
      formatWindowLabel(windowMinutes),
      100
    ),
    usedPercent,
    windowMinutes,
    resetsAt: normalizeTimestamp(input.resetsAt),
    category: safeText(input.category, 'quota', 40),
    role: safeText(input.role, '', 40) || null
  };
}

function normalizeCredit(input, index) {
  if (!input || typeof input !== 'object') return null;
  const id = safeText(input.id, `credit-${index}`, 160);
  const label = safeText(input.label, 'Credits', 100);
  const balance = input.balance === null || input.balance === undefined
    ? null
    : safeText(String(input.balance), '', 80) || null;
  return {
    id,
    label,
    balance,
    currency: safeText(input.currency, '', 12) || null,
    unlimited: input.unlimited === true,
    hasCredits: input.hasCredits === true || input.unlimited === true || balance !== null,
    expiresAt: normalizeTimestamp(input.expiresAt)
  };
}

function createSnapshot(providerId, input = {}) {
  const id = safeText(providerId, '', 60);
  if (!id) throw new TypeError('providerId is required');
  const status = STATUS_SET.has(input.status) ? input.status : 'error';
  const buckets = Array.isArray(input.buckets)
    ? input.buckets.map(createBucket).filter(Boolean)
    : [];
  const credits = Array.isArray(input.credits)
    ? input.credits.map(normalizeCredit).filter(Boolean)
    : [];
  const account = input.account && typeof input.account === 'object'
    ? {
        displayName: safeText(input.account.displayName, '', 100) || null,
        planType: safeText(input.account.planType, '', 80) || null
      }
    : { displayName: null, planType: null };
  const meta = input.meta && typeof input.meta === 'object'
    ? {
        sourceVersion: safeText(input.meta.sourceVersion, '', 80) || null,
        resetCreditsAvailable: finiteNumber(input.meta.resetCreditsAvailable),
        noUsage: input.meta.noUsage === true
      }
    : { sourceVersion: null, resetCreditsAvailable: null, noUsage: false };

  return {
    providerId: id,
    providerName: safeText(input.providerName, id, 80),
    status,
    fetchedAt: normalizeTimestamp(input.fetchedAt) || new Date().toISOString(),
    stale: input.stale === true || status === 'stale',
    buckets,
    credits,
    account,
    error: input.error && typeof input.error === 'object'
      ? {
          code: safeText(input.error.code, 'unknown_error', 80),
          recoverable: input.error.recoverable !== false
        }
      : null,
    meta
  };
}

function createUnavailableSnapshot(providerId, providerName, status, errorCode, previous) {
  const canUsePrevious = !['disabled', 'unauthenticated'].includes(status) &&
    previous && Array.isArray(previous.buckets) && previous.buckets.length > 0;
  return createSnapshot(providerId, {
    providerName,
    status: canUsePrevious ? 'stale' : status,
    stale: canUsePrevious,
    fetchedAt: previous?.fetchedAt || Date.now(),
    buckets: canUsePrevious ? previous.buckets : [],
    credits: canUsePrevious ? previous.credits : [],
    account: previous?.account,
    meta: previous?.meta,
    error: { code: errorCode, recoverable: true }
  });
}

function isProviderSnapshot(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.providerId === 'string' &&
    STATUS_SET.has(value.status) &&
    Array.isArray(value.buckets) &&
    Array.isArray(value.credits)
  );
}

module.exports = {
  PROVIDER_STATUSES,
  createBucket,
  createSnapshot,
  createUnavailableSnapshot,
  finiteNumber,
  formatWindowLabel,
  isProviderSnapshot,
  normalizePercent,
  normalizeTimestamp,
  normalizeWindowMinutes,
  safeText
};
