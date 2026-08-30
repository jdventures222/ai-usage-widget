'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderManager } = require('../src/main/provider-manager');
const { createSnapshot } = require('../src/shared/provider-contract');

class MemoryStore {
  constructor() { this.values = {}; }
  get(key, fallback) { return this.values[key] === undefined ? fallback : this.values[key]; }
  set(key, value) { this.values[key] = structuredClone(value); }
}

test('provider failures are isolated and successful history still records', async () => {
  const store = new MemoryStore();
  const ready = {
    id: 'codex',
    name: 'Codex',
    cacheTtlMs: 1000,
    fetchSnapshot: async () => createSnapshot('codex', {
      providerName: 'Codex',
      status: 'ready',
      buckets: [{ id: 'codex:primary:10080', label: 'Codex', usedPercent: 7 }]
    }),
    dispose() {}
  };
  const failed = {
    id: 'claude',
    name: 'Claude',
    cacheTtlMs: 1000,
    fetchSnapshot: async () => { throw new Error('private failure detail'); },
    dispose() {}
  };
  const manager = new ProviderManager({
    providers: [ready, failed],
    store,
    getSettings: () => ({ enabledProviders: { codex: true, claude: true } })
  });

  const snapshots = await manager.refresh({ force: true });
  assert.equal(snapshots.codex.status, 'ready');
  assert.equal(snapshots.claude.status, 'error');
  assert.equal(snapshots.claude.error.code, 'claude_provider_failed');
  assert.equal(JSON.stringify(snapshots).includes('private failure detail'), false);
  assert.deepEqual(store.get('usageHistoryV2')[0].buckets, { 'codex:primary:10080': 7 });
});

test('disabled providers do not execute', async () => {
  let calls = 0;
  const provider = {
    id: 'codex',
    name: 'Codex',
    fetchSnapshot: async () => { calls += 1; },
    dispose() {}
  };
  const manager = new ProviderManager({
    providers: [provider],
    store: new MemoryStore(),
    getSettings: () => ({ enabledProviders: { codex: false } })
  });
  const snapshots = await manager.refresh({ force: true });
  assert.equal(calls, 0);
  assert.equal(snapshots.codex.status, 'disabled');
});
