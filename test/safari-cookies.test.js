'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fileStat = () => ({ isFile: () => true, size: 1024 });

const {
  COOKIE_HEADER_BYTES,
  MAC_EPOCH_OFFSET_SECONDS,
  domainMatches,
  isPlausibleSessionKey,
  parseBinaryCookies,
  readSafariCookieValue,
  selectCookie
} = require('../src/main/safari-cookies');

const NOW = Date.UTC(2026, 8, 4, 3, 0, 0);

function encodeCookie({ domain, name, value, cookiePath = '/', expiresAt }) {
  const terminated = (text) => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
  const domainBuf = terminated(domain);
  const nameBuf = terminated(name);
  const pathBuf = terminated(cookiePath);
  const valueBuf = terminated(value);

  const domainOffset = COOKIE_HEADER_BYTES;
  const nameOffset = domainOffset + domainBuf.length;
  const pathOffset = nameOffset + nameBuf.length;
  const valueOffset = pathOffset + pathBuf.length;
  const size = valueOffset + valueBuf.length;

  const record = Buffer.alloc(size);
  record.writeUInt32LE(size, 0);
  record.writeUInt32LE(domainOffset, 16);
  record.writeUInt32LE(nameOffset, 20);
  record.writeUInt32LE(pathOffset, 24);
  record.writeUInt32LE(valueOffset, 28);
  record.writeDoubleLE(expiresAt / 1000 - MAC_EPOCH_OFFSET_SECONDS, 40);
  record.writeDoubleLE(NOW / 1000 - MAC_EPOCH_OFFSET_SECONDS, 48);
  domainBuf.copy(record, domainOffset);
  nameBuf.copy(record, nameOffset);
  pathBuf.copy(record, pathOffset);
  valueBuf.copy(record, valueOffset);
  return record;
}

function encodePage(cookies) {
  const records = cookies.map(encodeCookie);
  const tableBytes = 8 + records.length * 4 + 4;
  const offsets = [];
  let cursor = tableBytes;
  for (const record of records) {
    offsets.push(cursor);
    cursor += record.length;
  }
  const page = Buffer.alloc(cursor);
  page.writeUInt32BE(0x00000100, 0);
  page.writeUInt32LE(records.length, 4);
  offsets.forEach((offset, index) => page.writeUInt32LE(offset, 8 + index * 4));
  records.forEach((record, index) => record.copy(page, offsets[index]));
  return page;
}

function encodeStore(pages) {
  const header = Buffer.alloc(8 + pages.length * 4);
  header.write(MAGIC_OK, 0, 'latin1');
  header.writeUInt32BE(pages.length, 4);
  pages.forEach((page, index) => header.writeUInt32BE(page.length, 8 + index * 4));
  return Buffer.concat([header, ...pages]);
}

const MAGIC_OK = 'cook';
const LIVE_KEY = 'sk-ant-sid01-' + 'a'.repeat(96);
const STALE_KEY = 'sk-ant-sid01-' + 'b'.repeat(96);

const YEAR = 365 * 24 * 60 * 60 * 1000;

function storeFixture() {
  return encodeStore([
    encodePage([
      { domain: '.claude.ai', name: 'cf_clearance', value: 'x'.repeat(40), expiresAt: NOW + YEAR },
      { domain: '.claude.ai', name: 'sessionKey', value: LIVE_KEY, expiresAt: NOW + YEAR }
    ]),
    encodePage([
      { domain: 'claude.ai', name: 'activitySessionId', value: 'abc123', expiresAt: NOW + YEAR },
      { domain: '.other.example', name: 'sessionKey', value: 'not-ours-at-all-really', expiresAt: NOW + YEAR }
    ])
  ]);
}

test('parses every cookie in a multi-page store', () => {
  const cookies = parseBinaryCookies(storeFixture());
  assert.equal(cookies.length, 4);
  const names = cookies.map((cookie) => cookie.name).sort();
  assert.deepEqual(names, ['activitySessionId', 'cf_clearance', 'sessionKey', 'sessionKey']);
});

test('selects the claude.ai session key and not a same-named cookie on another site', () => {
  const cookie = selectCookie(parseBinaryCookies(storeFixture()), {
    name: 'sessionKey',
    domain: 'claude.ai',
    now: NOW
  });
  assert.equal(cookie.value, LIVE_KEY);
  assert.equal(cookie.domain, '.claude.ai');
});

test('ignores an expired session key', () => {
  const store = encodeStore([
    encodePage([{ domain: '.claude.ai', name: 'sessionKey', value: STALE_KEY, expiresAt: NOW - 1000 }])
  ]);
  const cookie = selectCookie(parseBinaryCookies(store), {
    name: 'sessionKey',
    domain: 'claude.ai',
    now: NOW
  });
  assert.equal(cookie, null);
});

test('prefers the longest-lived session key when several are present', () => {
  const store = encodeStore([
    encodePage([
      { domain: '.claude.ai', name: 'sessionKey', value: STALE_KEY, expiresAt: NOW + 1000 },
      { domain: '.claude.ai', name: 'sessionKey', value: LIVE_KEY, expiresAt: NOW + YEAR }
    ])
  ]);
  const cookie = selectCookie(parseBinaryCookies(store), {
    name: 'sessionKey',
    domain: 'claude.ai',
    now: NOW
  });
  assert.equal(cookie.value, LIVE_KEY);
});

test('rejects look-alike domains', () => {
  assert.equal(domainMatches('.claude.ai', 'claude.ai'), true);
  assert.equal(domainMatches('claude.ai', 'claude.ai'), true);
  assert.equal(domainMatches('.api.claude.ai', 'claude.ai'), true);
  assert.equal(domainMatches('notclaude.ai', 'claude.ai'), false);
  assert.equal(domainMatches('claude.ai.attacker.test', 'claude.ai'), false);
  assert.equal(domainMatches('', 'claude.ai'), false);
});

test('returns an empty list for malformed input instead of throwing', () => {
  assert.deepEqual(parseBinaryCookies(Buffer.alloc(0)), []);
  assert.deepEqual(parseBinaryCookies(Buffer.from('nope')), []);
  assert.deepEqual(parseBinaryCookies(Buffer.from('cook')), []);
  assert.deepEqual(parseBinaryCookies(null), []);
  const truncated = storeFixture().subarray(0, 40);
  assert.deepEqual(parseBinaryCookies(truncated), []);
});

test('reports a Full Disk Access failure distinctly from a missing cookie', () => {
  const denied = readSafariCookieValue({
    name: 'sessionKey',
    domain: 'claude.ai',
    cookiePath: '/nope',
    fsImpl: { statSync: fileStat, readFileSync() { const error = new Error('denied'); error.code = 'EPERM'; throw error; } }
  });
  assert.deepEqual(denied, { ok: false, reason: 'permission_denied' });

  const missing = readSafariCookieValue({
    name: 'sessionKey',
    domain: 'claude.ai',
    cookiePath: '/nope',
    fsImpl: { statSync: fileStat, readFileSync() { const error = new Error('gone'); error.code = 'ENOENT'; throw error; } }
  });
  assert.deepEqual(missing, { ok: false, reason: 'cookie_store_missing' });
});

test('reads the session key through the file layer', () => {
  const result = readSafariCookieValue({
    name: 'sessionKey',
    domain: 'claude.ai',
    cookiePath: '/fixture',
    now: NOW,
    fsImpl: { statSync: fileStat, readFileSync: () => storeFixture() }
  });
  assert.equal(result.ok, true);
  assert.equal(result.value, LIVE_KEY);
});

test('reports an absent cookie when the user is signed out in Safari', () => {
  const store = encodeStore([
    encodePage([{ domain: '.claude.ai', name: 'cf_clearance', value: 'x'.repeat(40), expiresAt: NOW + YEAR }])
  ]);
  const result = readSafariCookieValue({
    name: 'sessionKey',
    domain: 'claude.ai',
    cookiePath: '/fixture',
    now: NOW,
    fsImpl: { statSync: fileStat, readFileSync: () => store }
  });
  assert.deepEqual(result, { ok: false, reason: 'cookie_absent' });
});

test('rejects implausible session key values', () => {
  assert.equal(isPlausibleSessionKey(LIVE_KEY), true);
  assert.equal(isPlausibleSessionKey('short'), false);
  assert.equal(isPlausibleSessionKey('has spaces in the value here'), false);
  assert.equal(isPlausibleSessionKey(''), false);
  assert.equal(isPlausibleSessionKey(null), false);
});

test('a cookie store that is not a plausible file is never read', () => {
  let reads = 0;
  const readFileSync = () => { reads += 1; return storeFixture(); };
  const oversized = readSafariCookieValue({
    name: 'sessionKey',
    domain: 'claude.ai',
    fsImpl: { statSync: () => ({ isFile: () => true, size: 64 * 1024 * 1024 }), readFileSync }
  });
  const fifo = readSafariCookieValue({
    name: 'sessionKey',
    domain: 'claude.ai',
    fsImpl: { statSync: () => ({ isFile: () => false, size: 0 }), readFileSync }
  });
  assert.deepEqual(oversized, { ok: false, reason: 'cookie_store_missing' });
  assert.deepEqual(fifo, { ok: false, reason: 'cookie_store_missing' });
  assert.equal(reads, 0);
});

test('a name filter skips every other cookie', () => {
  const all = parseBinaryCookies(storeFixture());
  const filtered = parseBinaryCookies(storeFixture(), { name: 'sessionKey' });
  assert.ok(all.some((cookie) => cookie.name !== 'sessionKey'));
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((cookie) => cookie.name === 'sessionKey'));
});
