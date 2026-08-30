'use strict';

const os = require('node:os');
const {
  createSnapshot,
  createUnavailableSnapshot,
  finiteNumber,
  formatWindowLabel,
  normalizePercent,
  safeText
} = require('../shared/provider-contract');
const {
  CodexClientError,
  discoverCodexExecutable,
  readCodexRateLimits,
  readCodexVersion
} = require('./codex-client');

function normalizeCodexRateLimits(payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new CodexClientError('invalid_response');
  }

  const multi = payload.rateLimitsByLimitId;
  const multiEntries = multi && typeof multi === 'object' && !Array.isArray(multi)
    ? Object.entries(multi).filter(([, value]) => value && typeof value === 'object')
    : [];
  const canonicalEntries = multiEntries.filter(([entryId, value]) =>
    safeText(value.limitId || entryId, '', 160).toLowerCase() === 'codex'
  );
  const groups = canonicalEntries.length > 0
    ? canonicalEntries
    : (multiEntries.length === 0 && payload.rateLimits && typeof payload.rateLimits === 'object'
        ? [['codex', payload.rateLimits]]
        : []);

  const buckets = [];
  const planTypes = new Set();

  for (const [entryId, group] of groups) {
    const limitId = safeText(group.limitId || entryId, 'codex', 160);
    const limitName = safeText(group.limitName, '', 120) ||
      (limitId === 'legacy' || limitId === 'codex' ? 'Codex' : limitId.replace(/[_-]+/g, ' '));
    if (group.planType) planTypes.add(safeText(String(group.planType), '', 80));

    for (const role of ['primary', 'secondary']) {
      const window = group[role];
      if (!window || typeof window !== 'object') continue;
      const usedPercent = normalizePercent(window.usedPercent);
      if (usedPercent === null) continue;
      const minutes = finiteNumber(window.windowDurationMins);
      const durationId = minutes && minutes > 0 ? Math.round(minutes) : 'unknown';
      buckets.push({
        id: `${limitId}:${role}:${durationId}`,
        limitId,
        label: limitName,
        windowLabel: formatWindowLabel(minutes, role === 'primary' ? 'Primary window' : 'Secondary window'),
        usedPercent,
        windowMinutes: minutes,
        resetsAt: window.resetsAt,
        category: 'quota',
        role
      });
    }

  }

  if (groups.length === 0 || buckets.length === 0) {
    throw new CodexClientError('invalid_response');
  }

  return createSnapshot('codex', {
    providerName: 'Codex',
    status: 'ready',
    fetchedAt: options.fetchedAt || Date.now(),
    buckets,
    credits: [],
    account: {
      planType: [...planTypes].filter(Boolean).join(', ') || null
    },
    meta: {
      sourceVersion: options.sourceVersion || null,
      resetCreditsAvailable: null,
      noUsage: buckets.length === 0
    }
  });
}

class CodexProvider {
  constructor(options) {
    this.id = 'codex';
    this.name = 'Codex';
    this.cacheTtlMs = 5 * 60 * 1000;
    this.getSettings = options.getSettings;
    this.clientVersion = options.clientVersion || '2.0.0';
    this.executable = null;
    this.version = null;
  }

  async fetchSnapshot({ previous } = {}) {
    const settings = this.getSettings();
    this.executable = discoverCodexExecutable({
      configuredPath: settings.codexExecutable,
      homeDirectory: os.homedir()
    });
    if (!this.executable) {
      return createUnavailableSnapshot(this.id, this.name, 'cli_missing', 'codex_cli_not_found', previous);
    }

    try {
      const [payload, version] = await Promise.all([
        readCodexRateLimits({
          executable: this.executable,
          timeoutMs: 12000,
          clientVersion: this.clientVersion
        }),
        this.version ? Promise.resolve(this.version) : readCodexVersion(this.executable)
      ]);
      this.version = version;
      return normalizeCodexRateLimits(payload, { sourceVersion: version });
    } catch (error) {
      const code = error instanceof CodexClientError ? error.code : 'codex_unknown_error';
      const status = code === 'unsupported_version'
        ? 'unsupported_version'
        : (code === 'cli_missing' ? 'cli_missing' : 'error');
      return createUnavailableSnapshot(this.id, this.name, status, code, previous);
    }
  }

  async getDiagnostics() {
    return {
      provider: this.id,
      executableFound: Boolean(this.executable),
      executable: this.executable ? this.executable.replace(os.homedir(), '~') : null,
      version: this.version,
      protocol: 'account/rateLimits/read',
      cacheSeconds: this.cacheTtlMs / 1000
    };
  }

  dispose() {}
}

module.exports = { CodexProvider, normalizeCodexRateLimits };
