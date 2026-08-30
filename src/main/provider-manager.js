'use strict';

const {
  createSnapshot,
  createUnavailableSnapshot,
  isProviderSnapshot
} = require('../shared/provider-contract');
const { hardenStorePermissions, pruneHistory } = require('./storage');

class ProviderManager {
  constructor(options) {
    this.providers = new Map(options.providers.map((provider) => [provider.id, provider]));
    this.store = options.store;
    this.getSettings = options.getSettings;
    this.snapshots = new Map();
    this.lastAttempt = new Map();

    const persisted = this.store.get('latestSnapshotsV2', {});
    for (const provider of this.providers.values()) {
      const previous = persisted[provider.id];
      if (isProviderSnapshot(previous)) {
        this.snapshots.set(provider.id, createSnapshot(provider.id, {
          ...previous,
          status: previous.buckets.length > 0 ? 'stale' : previous.status,
          stale: previous.buckets.length > 0
        }));
      } else {
        this.snapshots.set(provider.id, createSnapshot(provider.id, {
          providerName: provider.name,
          status: 'loading',
          buckets: []
        }));
      }
    }
  }

  getSnapshots() {
    return Object.fromEntries(this.snapshots.entries());
  }

  getHistory() {
    return pruneHistory(this.store.get('usageHistoryV2', []));
  }

  shouldUseCache(provider, force) {
    if (force) return false;
    const attemptedAt = this.lastAttempt.get(provider.id) || 0;
    return Date.now() - attemptedAt < (provider.cacheTtlMs || 0);
  }

  async refresh(options = {}) {
    const settings = this.getSettings();
    const only = options.providerId ? new Set([options.providerId]) : null;
    const tasks = [];

    for (const provider of this.providers.values()) {
      if (only && !only.has(provider.id)) continue;
      const enabled = settings.enabledProviders?.[provider.id] !== false;
      if (!enabled) {
        this.snapshots.set(provider.id, createSnapshot(provider.id, {
          providerName: provider.name,
          status: 'disabled',
          buckets: []
        }));
        continue;
      }
      if (this.shouldUseCache(provider, options.force === true)) continue;
      const previous = this.snapshots.get(provider.id);
      this.lastAttempt.set(provider.id, Date.now());
      tasks.push((async () => {
        try {
          const snapshot = await provider.fetchSnapshot({ previous });
          if (!isProviderSnapshot(snapshot)) throw new Error('invalid_provider_snapshot');
          this.snapshots.set(provider.id, snapshot);
          if (snapshot.status === 'ready') this.recordHistory(snapshot);
        } catch {
          this.snapshots.set(provider.id, createUnavailableSnapshot(
            provider.id,
            provider.name,
            'error',
            `${provider.id}_provider_failed`,
            previous
          ));
        }
      })());
    }

    await Promise.allSettled(tasks);
    this.persistSnapshots();
    return this.getSnapshots();
  }

  recordHistory(snapshot) {
    if (!snapshot.buckets.length) return;
    const buckets = Object.fromEntries(snapshot.buckets.map((bucket) => [bucket.id, bucket.usedPercent]));
    let history = pruneHistory(this.store.get('usageHistoryV2', []));
    history.push({ timestamp: Date.now(), providerId: snapshot.providerId, buckets });
    history = pruneHistory(history);
    this.store.set('usageHistoryV2', history);
  }

  persistSnapshots() {
    this.store.set('latestSnapshotsV2', this.getSnapshots());
    hardenStorePermissions(this.store);
  }

  async diagnostics() {
    const providers = [];
    for (const provider of this.providers.values()) {
      try { providers.push(await provider.getDiagnostics()); }
      catch { providers.push({ provider: provider.id, diagnostics: 'unavailable' }); }
    }
    return providers;
  }

  dispose() {
    for (const provider of this.providers.values()) provider.dispose?.();
  }
}

module.exports = { ProviderManager };
