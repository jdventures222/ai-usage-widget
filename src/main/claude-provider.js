'use strict';

const {
  createSnapshot,
  createUnavailableSnapshot,
  safeText
} = require('../shared/provider-contract');
const { normalizeClaudeUsage } = require('./claude-normalizer');
const { isPlausibleSessionKey, readSafariCookieValue } = require('./safari-cookies');

const CLAUDE_ORIGIN = 'https://claude.ai';
const CLAUDE_LOGIN_URL = `${CLAUDE_ORIGIN}/login`;
const FULL_DISK_ACCESS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const NAVIGATION_ABORTED = -3;

class ClaudeProvider {
  constructor(options) {
    this.id = 'claude';
    this.name = 'Claude';
    this.cacheTtlMs = 60 * 1000;
    this.store = options.store;
    this.safeStorage = options.safeStorage;
    this.BrowserWindow = options.BrowserWindow;
    this.browserSession = options.browserSession;
    this.fetchMultipleViaWindow = options.fetchMultipleViaWindow;
    this.platform = options.platform || process.platform;
    // An unpackaged run is the stock Electron binary, which must never be the
    // app the user grants Full Disk Access to.
    this.safariImportAvailable = options.safariImportAvailable !== false;
    this.openExternal = options.openExternal || (() => {});
    this.openInSafari = options.openInSafari || this.openExternal;
    this.readSafariCookie = options.readSafariCookie || readSafariCookieValue;
    this.loginWindow = null;
    this.connecting = false;
  }

  getCredential() {
    const encrypted = this.store.get('claude.sessionKeyEncrypted');
    if (!encrypted || !this.safeStorage.isEncryptionAvailable()) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return null;
    }
  }

  saveCredential(sessionKey) {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('secure_storage_unavailable');
    }
    const encrypted = this.safeStorage.encryptString(sessionKey);
    this.store.set('claude.sessionKeyEncrypted', encrypted.toString('base64'));
    this.store.delete('claude.sessionKey');
  }

  async forgetSession() {
    this.store.delete('claude.sessionKeyEncrypted');
    this.store.delete('claude.organizationId');
    this.store.delete('claude.organizationName');
    await this.clearPartition();
  }

  // The partition exists only for this widget, so wiping all of it also
  // removes identity-provider sessions left by a Google or Apple sign-in.
  async clearPartition() {
    try { await this.browserSession.clearStorageData(); } catch {}
    try { await this.browserSession.clearAuthCache(); } catch {}
  }

  async setSessionCookie(sessionKey) {
    await this.browserSession.cookies.set({
      url: CLAUDE_ORIGIN,
      name: 'sessionKey',
      value: sessionKey,
      domain: '.claude.ai',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction'
    });
  }

  async discoverOrganization() {
    const results = await this.fetchMultipleViaWindow(
      [`${CLAUDE_ORIGIN}/api/organizations`],
      { browserSession: this.browserSession, timeoutMs: 15000 }
    );
    if (!results[0]?.ok || !Array.isArray(results[0].value)) {
      throw results[0]?.error || new Error('organization_lookup_failed');
    }
    const organizations = results[0].value.filter((organization) =>
      Array.isArray(organization?.capabilities) && organization.capabilities.includes('chat')
    );
    if (organizations.length === 0) throw new Error('no_chat_organization');
    const selected = organizations.find((organization) => organization.raven_type === 'team') || organizations[0];
    const organizationId = selected.uuid || selected.id;
    if (!organizationId) throw new Error('organization_lookup_failed');
    this.store.set('claude.organizationId', String(organizationId));
    this.store.set('claude.organizationName', safeText(selected.name, 'Claude account', 100));
    return String(organizationId);
  }

  async ensureOrganization(sessionKey) {
    let organizationId = this.store.get('claude.organizationId');
    await this.setSessionCookie(sessionKey);
    if (!organizationId) organizationId = await this.discoverOrganization();
    return organizationId;
  }

  connectingSnapshot(previous) {
    return createUnavailableSnapshot(this.id, this.name, 'loading', 'claude_connecting', previous);
  }

  // A refresh that overlaps a connect started with a credential that is no
  // longer the stored one, so neither its result nor its failure may apply.
  credentialChangedSince(encrypted) {
    return this.connecting || this.store.get('claude.sessionKeyEncrypted') !== encrypted;
  }

  async fetchSnapshot({ previous } = {}) {
    // A refresh during sign-in would rewrite the sessionKey cookie the login
    // window is waiting for.
    if (this.connecting) return this.connectingSnapshot(previous);
    const encrypted = this.store.get('claude.sessionKeyEncrypted');
    const sessionKey = this.getCredential();
    if (!sessionKey) {
      return createUnavailableSnapshot(this.id, this.name, 'unauthenticated', 'claude_login_required', previous);
    }

    try {
      const organizationId = await this.ensureOrganization(sessionKey);
      const base = `${CLAUDE_ORIGIN}/api/organizations/${encodeURIComponent(organizationId)}`;
      const results = await this.fetchMultipleViaWindow(
        [`${base}/usage`],
        {
          browserSession: this.browserSession,
          timeoutMs: 15000
        }
      );
      if (!results[0]?.ok) throw results[0]?.error || new Error('usage_fetch_failed');
      if (this.credentialChangedSince(encrypted)) return this.connectingSnapshot(previous);
      return normalizeClaudeUsage(
        results[0].value,
        {},
        { organizationName: this.store.get('claude.organizationName') }
      );
    } catch (error) {
      if (this.credentialChangedSince(encrypted)) return this.connectingSnapshot(previous);
      const message = String(error?.message || 'claude_unknown_error');
      const sessionFailure = /Cloudflare|UnexpectedHTML|401|403|session/i.test(message);
      if (sessionFailure) {
        this.store.delete('claude.sessionKeyEncrypted');
        this.store.delete('claude.organizationId');
      }
      return createUnavailableSnapshot(
        this.id,
        this.name,
        sessionFailure ? 'unauthenticated' : 'error',
        sessionFailure ? 'claude_session_expired' : 'claude_fetch_failed',
        previous
      );
    }
  }

  async connect() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'secure_storage_unavailable' };
    }
    if (this.connecting) {
      if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.focus();
      return { success: false, error: 'login_already_open' };
    }
    this.connecting = true;
    try {
      // Safari is the only browser whose cookie jar we can read, so every
      // other platform, and a development run, signs in through a window.
      if (this.platform === 'darwin' && this.safariImportAvailable) return await this.connectViaSafari();
      return await this.connectViaLoginWindow();
    } finally {
      this.connecting = false;
    }
  }

  async connectViaSafari() {
    const cookie = this.readSafariCookie({ name: 'sessionKey', domain: 'claude.ai' });
    if (!cookie.ok) {
      if (cookie.reason === 'permission_denied') {
        this.openExternal(FULL_DISK_ACCESS_URL);
        return { success: false, error: 'safari_access_denied' };
      }
      this.openInSafari(CLAUDE_LOGIN_URL);
      return { success: false, error: 'safari_login_required' };
    }
    if (!isPlausibleSessionKey(cookie.value)) {
      this.openInSafari(CLAUDE_LOGIN_URL);
      return { success: false, error: 'safari_login_required' };
    }

    try {
      await this.adoptSessionKey(cookie.value);
      return {
        success: true,
        organizationName: this.store.get('claude.organizationName') || null
      };
    } catch {
      await this.forgetSession();
      return { success: false, error: 'claude_login_validation_failed' };
    }
  }

  /**
   * Adopts a session that belongs to a possibly different account, so the
   * previous account's cookies and cached organization must go first — a stale
   * organizationId would otherwise be queried with the new credential.
   */
  async adoptSessionKey(sessionKey) {
    await this.clearBrowserCookies();
    this.store.delete('claude.organizationId');
    this.store.delete('claude.organizationName');
    this.saveCredential(sessionKey);
    await this.setSessionCookie(sessionKey);
    await this.discoverOrganization();
  }

  async clearBrowserCookies() {
    const cookies = await this.browserSession.cookies.get({ domain: 'claude.ai' });
    for (const cookie of cookies) {
      try { await this.browserSession.cookies.remove(CLAUDE_ORIGIN, cookie.name); } catch {}
    }
  }

  async connectViaLoginWindow() {
    try { await this.browserSession.cookies.remove(CLAUDE_ORIGIN, 'sessionKey'); } catch {}

    return new Promise((resolve) => {
      const allowedDomains = [
        'claude.ai',
        'accounts.google.com',
        'appleid.apple.com',
        'login.microsoftonline.com'
      ];
      let settled = false;
      let captured = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.browserSession.cookies.removeListener('changed', cookieListener);
        if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close();
        this.loginWindow = null;
        resolve(result);
      };

      // No parent window: the menu bar panel hides when it loses focus, and an
      // attached child would be hidden along with it.
      this.loginWindow = new this.BrowserWindow({
        width: 1000,
        height: 720,
        title: 'Claude sign in · claude.ai',
        modal: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          session: this.browserSession
        }
      });

      const isAllowed = (url) => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === 'https:' && allowedDomains.some((domain) =>
            parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
          );
        } catch {
          return false;
        }
      };

      this.loginWindow.webContents.on('will-navigate', (event, url) => {
        if (!isAllowed(url)) event.preventDefault();
        else this.loginWindow?.setTitle(`Claude sign in · ${new URL(url).hostname}`);
      });
      this.loginWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowed(url)) {
          this.loginWindow?.loadURL(url).catch(() => {});
        }
        return { action: 'deny' };
      });

      const cookieListener = async (_event, cookie, _cause, removed) => {
        const claudeDomain = cookie.domain === 'claude.ai' || cookie.domain === '.claude.ai';
        if (captured || removed || cookie.name !== 'sessionKey' || !claudeDomain || !cookie.value) return;
        captured = true;
        try {
          this.saveCredential(cookie.value);
          await this.setSessionCookie(cookie.value);
          await this.discoverOrganization();
          finish({
            success: true,
            organizationName: this.store.get('claude.organizationName') || null
          });
        } catch {
          await this.forgetSession();
          finish({ success: false, error: 'claude_login_validation_failed' });
        }
      };

      this.browserSession.cookies.on('changed', cookieListener);
      this.loginWindow.on('closed', () => {
        if (!settled) finish({ success: false, error: 'login_window_closed' });
      });
      this.loginWindow.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
        if (!settled && isMainFrame && errorCode !== NAVIGATION_ABORTED) {
          finish({ success: false, error: 'login_page_failed' });
        }
      });

      const timeout = setTimeout(() => finish({ success: false, error: 'login_timeout' }), LOGIN_TIMEOUT_MS);
      timeout.unref?.();
      this.loginWindow.loadURL(`${CLAUDE_ORIGIN}/login`).catch(() => {});
    });
  }

  async disconnect() {
    this.store.delete('claude.sessionKeyEncrypted');
    this.store.delete('claude.sessionKey');
    this.store.delete('claude.organizationId');
    this.store.delete('claude.organizationName');
    await this.clearPartition();
    return true;
  }

  async getDiagnostics() {
    return {
      provider: this.id,
      encryptedCredentialPresent: Boolean(this.store.get('claude.sessionKeyEncrypted')),
      organizationSelected: Boolean(this.store.get('claude.organizationId')),
      secureStorageAvailable: this.safeStorage.isEncryptionAvailable(),
      transport: 'isolated-browser-session'
    };
  }

  dispose() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close();
    this.loginWindow = null;
  }
}

module.exports = { ClaudeProvider };
