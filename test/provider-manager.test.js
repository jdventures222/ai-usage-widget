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
    id: 'example',
    name: 'Example',
    cacheTtlMs: 1000,
    fetchSnapshot: async () => createSnapshot('example', {
      providerName: 'Example',
      status: 'ready',
      buckets: [{ id: 'claude:all-models:secondary:10080', label: 'All models', usedPercent: 7 }]
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
    getSettings: () => ({ enabledProviders: { example: true, claude: true } })
  });

  const snapshots = await manager.refresh({ force: true });
  assert.equal(snapshots.example.status, 'ready');
  assert.equal(snapshots.claude.status, 'error');
  assert.equal(snapshots.claude.error.code, 'claude_provider_failed');
  assert.equal(JSON.stringify(snapshots).includes('private failure detail'), false);
  const history = store.get('usageHistoryV2');
  assert.equal(history.length, 1);
  assert.equal(history[0].providerId, 'example');
  assert.deepEqual(history[0].buckets, { 'claude:all-models:secondary:10080': 7 });
});

test('disabled providers do not execute', async () => {
  let calls = 0;
  const provider = {
    id: 'example',
    name: 'Example',
    fetchSnapshot: async () => { calls += 1; },
    dispose() {}
  };
  const manager = new ProviderManager({
    providers: [provider],
    store: new MemoryStore(),
    getSettings: () => ({ enabledProviders: { example: false } })
  });
  const snapshots = await manager.refresh({ force: true });
  assert.equal(calls, 0);
  assert.equal(snapshots.example.status, 'disabled');
});
