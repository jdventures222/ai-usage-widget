'use strict';

/**
 * safari-cookies.js
 *
 * Reads a single named cookie out of Safari's Cookies.binarycookies store so
 * the widget can adopt a session the user already established in their own
 * browser instead of opening a second login window.
 *
 * Reading the store needs Full Disk Access; without it macOS fails the open
 * with EPERM and the caller is expected to send the user to System Settings.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAGIC = 'cook';
const MAC_EPOCH_OFFSET_SECONDS = 978307200;
const COOKIE_HEADER_BYTES = 56;
const MAX_PAGES = 4096;
const MAX_COOKIES_PER_PAGE = 4096;
const MAX_STRING_BYTES = 8192;
// Safari's jar is a few MB; anything far larger is not one, and reading it
// would stall the main process.
const MAX_STORE_BYTES = 32 * 1024 * 1024;

// Cookie values are transmitted in a header, so they cannot contain control
// characters, spaces or separators. Anything else is a parse artefact.
const SESSION_KEY_PATTERN = /^[!-~]{20,4096}$/;

function safariCookiePath(homedir = os.homedir()) {
  return path.join(
    homedir,
    'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'
  );
}

function readCString(view, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= view.length) return null;
  const limit = Math.min(view.length, offset + MAX_STRING_BYTES);
  for (let end = offset; end < limit; end += 1) {
    if (view[end] === 0) return view.toString('utf8', offset, end);
  }
  return null;
}

function readCookieRecord(record, wantedName) {
  if (record.length < COOKIE_HEADER_BYTES) return null;
  const size = record.readUInt32LE(0);
  if (size < COOKIE_HEADER_BYTES || size > record.length) return null;
  const view = record.subarray(0, size);
  const name = readCString(view, view.readUInt32LE(20));
  // Other sites' cookies are skipped before their values become strings.
  if (name === null || (wantedName && name !== wantedName)) return null;
  const domain = readCString(view, view.readUInt32LE(16));
  const value = readCString(view, view.readUInt32LE(28));
  if (domain === null || value === null) return null;
  const expirySeconds = view.readDoubleLE(40);
  return {
    domain,
    name,
    value,
    expiresAt: Number.isFinite(expirySeconds)
      ? (expirySeconds + MAC_EPOCH_OFFSET_SECONDS) * 1000
      : null
  };
}

function parsePage(page, collected, wantedName) {
  if (page.length < 12) return;
  const count = page.readUInt32LE(4);
  if (count > MAX_COOKIES_PER_PAGE) return;
  const tableEnd = 8 + count * 4;
  if (page.length < tableEnd) return;
  for (let index = 0; index < count; index += 1) {
    const start = page.readUInt32LE(8 + index * 4);
    if (start >= page.length) continue;
    const cookie = readCookieRecord(page.subarray(start), wantedName);
    if (cookie) collected.push(cookie);
  }
}

function parseBinaryCookies(buffer, { name } = {}) {
  const collected = [];
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return collected;
  if (buffer.toString('latin1', 0, 4) !== MAGIC) return collected;
  const pageCount = buffer.readUInt32BE(4);
  if (pageCount > MAX_PAGES) return collected;
  const tableEnd = 8 + pageCount * 4;
  if (buffer.length < tableEnd) return collected;

  let offset = tableEnd;
  for (let index = 0; index < pageCount; index += 1) {
    const size = buffer.readUInt32BE(8 + index * 4);
    if (size < 12 || offset + size > buffer.length) break;
    parsePage(buffer.subarray(offset, offset + size), collected, name);
    offset += size;
  }
  return collected;
}

function domainMatches(cookieDomain, domain) {
  const host = String(cookieDomain || '').toLowerCase();
  const target = String(domain || '').toLowerCase();
  if (!host || !target) return false;
  return host === target || host === `.${target}` || host.endsWith(`.${target}`);
}

function selectCookie(cookies, { name, domain, now = Date.now() }) {
  let best = null;
  for (const cookie of cookies) {
    if (cookie.name !== name || !cookie.value) continue;
    if (!domainMatches(cookie.domain, domain)) continue;
    if (cookie.expiresAt !== null && cookie.expiresAt <= now) continue;
    if (!best || (cookie.expiresAt || 0) > (best.expiresAt || 0)) best = cookie;
  }
  return best;
}

function isPlausibleSessionKey(value) {
  return typeof value === 'string' && SESSION_KEY_PATTERN.test(value);
}

/**
 * @returns {{ok: true, value: string, expiresAt: number|null}
 *          |{ok: false, reason: 'permission_denied'|'cookie_store_missing'|'cookie_absent'}}
 */
function readSafariCookieValue({
  name,
  domain,
  cookiePath = safariCookiePath(),
  now = Date.now(),
  fsImpl = fs
} = {}) {
  let buffer;
  try {
    const stat = fsImpl.statSync(cookiePath);
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return { ok: false, reason: 'cookie_store_missing' };
    buffer = fsImpl.readFileSync(cookiePath);
  } catch (error) {
    const code = error && error.code;
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, reason: 'permission_denied' };
    return { ok: false, reason: 'cookie_store_missing' };
  }

  try {
    const cookie = selectCookie(parseBinaryCookies(buffer, { name }), { name, domain, now });
    if (!cookie) return { ok: false, reason: 'cookie_absent' };
    return { ok: true, value: cookie.value, expiresAt: cookie.expiresAt };
  } finally {
    // The jar holds every site's cookies, not just ours; do not leave it resident.
    if (Buffer.isBuffer(buffer)) buffer.fill(0);
  }
}

module.exports = {
  COOKIE_HEADER_BYTES,
  MAC_EPOCH_OFFSET_SECONDS,
  domainMatches,
  isPlausibleSessionKey,
  parseBinaryCookies,
  readSafariCookieValue,
  safariCookiePath,
  selectCookie
};
