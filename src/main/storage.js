'use strict';

const fs = require('node:fs');

const SCHEMA_VERSION = 2;
const HISTORY_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_SAMPLES = 10000;
const HUD_POLICY_VERSION = 1;

const DEFAULT_SETTINGS = Object.freeze({
  enabledProviders: { claude: true, codex: true },
  autoStart: true,
  minimizeToTray: true,
  alwaysOnTop: true,
  allSpaces: true,
  widgetCorner: 'top-right',
  hudOpacity: 0.92,
  theme: 'dark',
  warnThreshold: 75,
  dangerThreshold: 90,
  usageAlerts: true,
  refreshInterval: 300,
  showHistory: false,
  codexExecutable: ''
});

function integerInRange(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function sanitizeSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const warnThreshold = integerInRange(source.warnThreshold, DEFAULT_SETTINGS.warnThreshold, 1, 99);
  let dangerThreshold = integerInRange(source.dangerThreshold, DEFAULT_SETTINGS.dangerThreshold, 2, 100);
  if (dangerThreshold <= warnThreshold) dangerThreshold = Math.min(100, warnThreshold + 1);
  const refreshAllowed = [60, 120, 300, 600, 900];
  const refreshCandidate = integerInRange(source.refreshInterval, DEFAULT_SETTINGS.refreshInterval, 60, 900);
  const refreshInterval = refreshAllowed.includes(refreshCandidate) ? refreshCandidate : DEFAULT_SETTINGS.refreshInterval;
  const theme = ['dark', 'light', 'system'].includes(source.theme) ? source.theme : DEFAULT_SETTINGS.theme;
  const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const widgetCorner = corners.includes(source.widgetCorner) ? source.widgetCorner : DEFAULT_SETTINGS.widgetCorner;
  const enabled = source.enabledProviders && typeof source.enabledProviders === 'object'
    ? source.enabledProviders
    : {};
  return {
    enabledProviders: {
      claude: enabled.claude !== false,
      codex: enabled.codex !== false
    },
    autoStart: source.autoStart !== false,
    minimizeToTray: source.minimizeToTray !== false,
    alwaysOnTop: source.alwaysOnTop !== false,
    allSpaces: source.allSpaces !== false,
    widgetCorner,
    hudOpacity: numberInRange(source.hudOpacity, DEFAULT_SETTINGS.hudOpacity, 0.7, 1),
    theme,
    warnThreshold,
    dangerThreshold,
    usageAlerts: source.usageAlerts !== false,
    refreshInterval,
    showHistory: source.showHistory === true || source.graphVisible === true,
    codexExecutable: typeof source.codexExecutable === 'string' && source.codexExecutable.length < 4096
      ? source.codexExecutable
      : ''
  };
}

function convertLegacyHistory(config) {
  const candidateKeys = Object.keys(config || {}).filter((key) => key === 'usageHistory' || key.startsWith('usageHistory_'));
  const byTimestamp = new Map();
  for (const key of candidateKeys) {
    const rows = Array.isArray(config[key]) ? config[key] : [];
    for (const row of rows) {
      const timestamp = Number(row?.timestamp);
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
      const buckets = {};
      const mappings = [
        ['claude:all-models:primary:300', row.session],
        ['claude:all-models:secondary:10080', row.weekly],
        ['claude:fable:secondary:10080', row.fable]
      ];
      for (const [id, value] of mappings) {
        const percent = Number(value);
        if (Number.isFinite(percent)) buckets[id] = Math.min(100, Math.max(0, percent));
      }
      if (Object.keys(buckets).length > 0) {
        byTimestamp.set(timestamp, { timestamp, providerId: 'claude', buckets });
      }
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_HISTORY_SAMPLES);
}

function readJsonFile(filePath, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function migrateLegacyConfig({ store, legacyPath, safeStorage, fsImpl = fs }) {
  if (store.get('migration.v2.completed') === true) return { migrated: false, reason: 'already_complete' };
  const legacy = readJsonFile(legacyPath, fsImpl);
  if (!legacy) {
    store.set('schemaVersion', SCHEMA_VERSION);
    store.set('settings', sanitizeSettings(store.get('settings')));
    store.set('migration.v2', { completed: true, sourceFound: false, completedAt: new Date().toISOString() });
    hardenStorePermissions(store, fsImpl);
    return { migrated: false, reason: 'source_missing' };
  }

  const currentSettings = store.get('settings');
  const legacySettings = legacy.settings && typeof legacy.settings === 'object' ? legacy.settings : {};
  store.set('settings', sanitizeSettings(currentSettings || legacySettings));
  const history = convertLegacyHistory(legacy);
  if (history.length > 0 && !store.has('usageHistoryV2')) store.set('usageHistoryV2', history);

  let credentialMigrated = false;
  const encrypted = legacy.sessionKey_encrypted;
  if (typeof encrypted === 'string' && encrypted && safeStorage.isEncryptionAvailable()) {
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      if (decrypted) {
        store.set('claude.sessionKeyEncrypted', encrypted);
        credentialMigrated = true;
      }
    } catch {
      credentialMigrated = false;
    }
  }
  if (credentialMigrated && legacy.organizationId) {
    store.set('claude.organizationId', String(legacy.organizationId));
  }

  store.set('schemaVersion', SCHEMA_VERSION);
  store.set('migration.v2', {
    completed: true,
    sourceFound: true,
    credentialMigrated,
    historySamples: history.length,
    completedAt: new Date().toISOString()
  });
  hardenStorePermissions(store, fsImpl);
  return { migrated: true, credentialMigrated, historySamples: history.length };
}

function applyPersistentHudDefaults(store, fsImpl = fs) {
  if (store.get('migration.hudPolicyVersion', 0) >= HUD_POLICY_VERSION) return false;
  store.set('settings', sanitizeSettings({
    ...store.get('settings', {}),
    autoStart: true,
    minimizeToTray: true,
    alwaysOnTop: true,
    allSpaces: true,
    widgetCorner: 'top-right',
    hudOpacity: 0.92
  }));
  store.set('migration.hudPolicyVersion', HUD_POLICY_VERSION);
  hardenStorePermissions(store, fsImpl);
  return true;
}

function hardenStorePermissions(store, fsImpl = fs) {
  if (process.platform === 'win32' || !store?.path) return;
  try { fsImpl.chmodSync(store.path, 0o600); } catch {}
}

function pruneHistory(history, now = Date.now()) {
  const cutoff = now - HISTORY_RETENTION_MS;
  return (Array.isArray(history) ? history : [])
    .filter((row) => Number(row?.timestamp) >= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_HISTORY_SAMPLES);
}

module.exports = {
  DEFAULT_SETTINGS,
  HISTORY_RETENTION_MS,
  HUD_POLICY_VERSION,
  MAX_HISTORY_SAMPLES,
  SCHEMA_VERSION,
  applyPersistentHudDefaults,
  convertLegacyHistory,
  hardenStorePermissions,
  migrateLegacyConfig,
  pruneHistory,
  readJsonFile,
  sanitizeSettings
};
