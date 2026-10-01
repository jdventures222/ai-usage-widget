'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeProvider } = require('../src/main/claude-provider');

const SESSION_KEY = 'sk-ant-sid01-' + 'n'.repeat(96);
const OLD_ORGANIZATION = 'a28fe09f-aed3-43be-a738-b2efc4b85c10';
const NEW_ORGANIZATION = '11111111-2222-3333-4444-555555555555';

class MemoryStore {
  constructor(values = {}) { this.values = { ...values }; }
  get(key, fallback) { return this.values[key] === undefined ? fallback : this.values[key]; }
  set(key, value) { this.values[key] = value; }
  delete(key) { delete this.values[key]; }
  has(key) { return this.values[key] !== undefined; }
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (buffer) => buffer.toString().replace(/^enc:/, '')
};

function encrypted(sessionKey) {
  return safeStorage.encryptString(sessionKey).toString('base64');
}

function createProvider({
  platform = 'darwin',
  safariImportAvailable,
  safariResult,
  storeValues = {},
  organizations = [{ uuid: NEW_ORGANIZATION, name: 'New Account', capabilities: ['chat'] }],
  organizationsOk = true,
  fetchMultipleViaWindow
} = {}) {
  const store = new MemoryStore(storeValues);
  const opened = [];
  const openedInSafari = [];
  const removedCookies = [];
  const setCookies = [];
  const clearedStorage = [];
  const browserSession = {
    cookies: {
      get: async () => [{ name: 'sessionKeyV3' }, { name: 'sessionKey' }, { name: '__cf_bm' }],
      set: async (cookie) => { setCookies.push(cookie); },
      remove: async (_url, name) => { removedCookies.push(name); }
    },
    clearStorageData: async (...args) => { clearedStorage.push(args); },
    clearAuthCache: async () => {}
  };
  const provider = new ClaudeProvider({
    store,
    safeStorage: { ...safeStorage },
    BrowserWindow: class {},
    browserSession,
    fetchMultipleViaWindow: fetchMultipleViaWindow || (async () => [
      organizationsOk
        ? { ok: true, value: organizations }
        : { ok: false, error: new Error('organization_lookup_failed') }
    ]),
    platform,
    safariImportAvailable,
    openExternal: (url) => opened.push(url),
    openInSafari: (url) => openedInSafari.push(url),
    readSafariCookie: () => safariResult
  });
  return { provider, store, opened, openedInSafari, removedCookies, setCookies, clearedStorage };
}

test('adopts the Safari session and reports the account it landed on', async () => {
  const { provider, store, setCookies } = createProvider({
    safariResult: { ok: true, value: SESSION_KEY, expiresAt: Date.now() + 10000 }
  });

  const result = await provider.connect();

  assert.deepEqual(result, { success: true, organizationName: 'New Account' });
  assert.equal(store.get('claude.organizationId'), NEW_ORGANIZATION);
  assert.equal(setCookies.at(-1).value, SESSION_KEY);
  assert.equal(
    Buffer.from(store.get('claude.sessionKeyEncrypted'), 'base64').toString(),
    `enc:${SESSION_KEY}`
  );
});

test('switching accounts drops the previous account cookies and cached organization', async () => {
  const { provider, store, removedCookies } = createProvider({
    safariResult: { ok: true, value: SESSION_KEY, expiresAt: Date.now() + 10000 },
    storeValues: {
      'claude.organizationId': OLD_ORGANIZATION,
      'claude.organizationName': 'Old Account'
    }
  });

  await provider.connect();

  // A surviving sessionKeyV3 from the previous account would authenticate the
  // fetch as the wrong user even with the new sessionKey injected.
  assert.deepEqual(removedCookies, ['sessionKeyV3', 'sessionKey', '__cf_bm']);
  assert.equal(store.get('claude.organizationId'), NEW_ORGANIZATION);
  assert.equal(store.get('claude.organizationName'), 'New Account');
});

test('a rejected session leaves no half-connected credential or browser state behind', async () => {
  const { provider, store, clearedStorage } = createProvider({
    safariResult: { ok: true, value: SESSION_KEY, expiresAt: Date.now() + 10000 },
    storeValues: { 'claude.organizationId': OLD_ORGANIZATION },
    organizationsOk: false
  });

  const result = await provider.connect();

  assert.equal(result.success, false);
  assert.equal(result.error, 'claude_login_validation_failed');
  assert.equal(store.get('claude.sessionKeyEncrypted'), undefined);
  assert.equal(store.get('claude.organizationId'), undefined);
  // No origin filter: the whole partition, identity-provider cookies included.
  assert.deepEqual(clearedStorage, [[]]);
});

test('disconnect wipes the whole sign-in partition', async () => {
  const { provider, store, clearedStorage } = createProvider({
    storeValues: { 'claude.sessionKeyEncrypted': encrypted(SESSION_KEY), 'claude.organizationId': OLD_ORGANIZATION }
  });

  await provider.disconnect();

  assert.equal(store.get('claude.sessionKeyEncrypted'), undefined);
  assert.deepEqual(clearedStorage, [[]]);
});

test('a missing Safari session opens claude.ai in Safari, not the default browser', async () => {
  const { provider, store, opened, openedInSafari } = createProvider({
    safariResult: { ok: false, reason: 'cookie_absent' }
  });

  const result = await provider.connect();

  assert.equal(result.error, 'safari_login_required');
  assert.deepEqual(openedInSafari, ['https://claude.ai/login']);
  assert.deepEqual(opened, []);
  assert.equal(store.get('claude.sessionKeyEncrypted'), undefined);
});

test('a blocked cookie store sends the user to Full Disk Access', async () => {
  const { provider, opened } = createProvider({
    safariResult: { ok: false, reason: 'permission_denied' }
  });

  const result = await provider.connect();

  assert.equal(result.error, 'safari_access_denied');
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^x-apple\.systempreferences:/);
});

test('a malformed cookie value is never adopted', async () => {
  const { provider, store, openedInSafari } = createProvider({
    safariResult: { ok: true, value: 'short', expiresAt: Date.now() + 10000 }
  });

  const result = await provider.connect();

  assert.equal(result.error, 'safari_login_required');
  assert.equal(store.get('claude.sessionKeyEncrypted'), undefined);
  assert.deepEqual(openedInSafari, ['https://claude.ai/login']);
});

test('non-macOS still signs in through the embedded window', async () => {
  let safariReads = 0;
  const { provider } = createProvider({ platform: 'win32', safariResult: { ok: false } });
  provider.readSafariCookie = () => { safariReads += 1; return { ok: false }; };
  provider.connectViaLoginWindow = async () => ({ success: false, error: 'login_window_used' });

  const result = await provider.connect();

  assert.equal(result.error, 'login_window_used');
  assert.equal(safariReads, 0);
});

test('a development run never reads Safari, so it never asks for Full Disk Access', async () => {
  let safariReads = 0;
  const { provider, opened } = createProvider({ safariImportAvailable: false, safariResult: { ok: false, reason: 'permission_denied' } });
  provider.readSafariCookie = () => { safariReads += 1; return { ok: false, reason: 'permission_denied' }; };
  provider.connectViaLoginWindow = async () => ({ success: false, error: 'login_window_used' });

  const result = await provider.connect();

  assert.equal(result.error, 'login_window_used');
  assert.equal(safariReads, 0);
  assert.deepEqual(opened, []);
});

test('secure storage being unavailable blocks the import outright', async () => {
  const { provider } = createProvider({
    safariResult: { ok: true, value: SESSION_KEY, expiresAt: Date.now() + 10000 }
  });
  provider.safeStorage.isEncryptionAvailable = () => false;

  const result = await provider.connect();

  assert.deepEqual(result, { success: false, error: 'secure_storage_unavailable' });
});

test('a second connect while one is in progress is refused', async () => {
  const { provider } = createProvider();
  let release;
  provider.connectViaSafari = () => new Promise((resolve) => { release = resolve; });

  const first = provider.connect();
  const second = await provider.connect();
  release({ success: true });

  assert.deepEqual(second, { success: false, error: 'login_already_open' });
  assert.deepEqual(await first, { success: true });
  assert.equal(provider.connecting, false);
});

test('a refresh during sign-in does not touch the session', async () => {
  let fetches = 0;
  const { provider, setCookies } = createProvider({
    storeValues: { 'claude.sessionKeyEncrypted': encrypted(SESSION_KEY), 'claude.organizationId': OLD_ORGANIZATION },
    fetchMultipleViaWindow: async () => { fetches += 1; return [{ ok: true, value: { five_hour: { utilization: 5 } } }]; }
  });
  provider.connecting = true;

  const snapshot = await provider.fetchSnapshot();

  assert.notEqual(snapshot.status, 'ready');
  assert.equal(snapshot.error.code, 'claude_connecting');
  assert.equal(fetches, 0);
  assert.deepEqual(setCookies, []);
});

test('usage fetched with a credential that was replaced mid-flight is discarded', async () => {
  const { provider, store } = createProvider({
    storeValues: { 'claude.sessionKeyEncrypted': encrypted('old-session'), 'claude.organizationId': OLD_ORGANIZATION },
    fetchMultipleViaWindow: async () => {
      store.set('claude.sessionKeyEncrypted', encrypted(SESSION_KEY));
      return [{ ok: true, value: { five_hour: { utilization: 40 } } }];
    }
  });

  const snapshot = await provider.fetchSnapshot();

  assert.notEqual(snapshot.status, 'ready');
  assert.deepEqual(snapshot.buckets, []);
});

test('an expired old session does not delete a credential saved during the refresh', async () => {
  const fresh = encrypted(SESSION_KEY);
  const { provider, store } = createProvider({
    storeValues: { 'claude.sessionKeyEncrypted': encrypted('old-session'), 'claude.organizationId': OLD_ORGANIZATION },
    fetchMultipleViaWindow: async () => {
      store.set('claude.sessionKeyEncrypted', fresh);
      return [{ ok: false, error: new Error('HTTP 401') }];
    }
  });

  const snapshot = await provider.fetchSnapshot();

  assert.equal(store.get('claude.sessionKeyEncrypted'), fresh);
  assert.notEqual(snapshot.status, 'unauthenticated');
});

test('an expired session with no concurrent change still signs out', async () => {
  const { provider, store } = createProvider({
    storeValues: { 'claude.sessionKeyEncrypted': encrypted('old-session'), 'claude.organizationId': OLD_ORGANIZATION },
    fetchMultipleViaWindow: async () => [{ ok: false, error: new Error('HTTP 401') }]
  });

  const snapshot = await provider.fetchSnapshot();

  assert.equal(snapshot.status, 'unauthenticated');
  assert.equal(snapshot.error.code, 'claude_session_expired');
  assert.equal(store.get('claude.sessionKeyEncrypted'), undefined);
});
