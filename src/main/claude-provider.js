'use strict';

const {
  createSnapshot,
  createUnavailableSnapshot,
  safeText
} = require('../shared/provider-contract');
const { normalizeClaudeUsage } = require('./claude-normalizer');

const CLAUDE_ORIGIN = 'https://claude.ai';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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
    this.mainWindow = options.mainWindow;
    this.loginWindow = null;
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

  async fetchSnapshot({ previous } = {}) {
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
      return normalizeClaudeUsage(
        results[0].value,
        {},
        { organizationName: this.store.get('claude.organizationName') }
      );
    } catch (error) {
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
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus();
      return { success: false, error: 'login_already_open' };
    }

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

      this.loginWindow = new this.BrowserWindow({
        width: 1000,
        height: 720,
        title: 'Claude sign in — claude.ai',
        parent: this.mainWindow?.() || undefined,
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
        else this.loginWindow?.setTitle(`Claude sign in — ${new URL(url).hostname}`);
      });
      this.loginWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowed(url)) {
          this.loginWindow?.loadURL(url);
        }
        return { action: 'deny' };
      });

      const cookieListener = async (_event, cookie, _cause, removed) => {
        if (captured || removed || cookie.name !== 'sessionKey' || !cookie.domain.includes('claude.ai') || !cookie.value) return;
        captured = true;
        try {
          this.saveCredential(cookie.value);
          await this.setSessionCookie(cookie.value);
          await this.discoverOrganization();
          finish({ success: true });
        } catch {
          this.store.delete('claude.sessionKeyEncrypted');
          finish({ success: false, error: 'claude_login_validation_failed' });
        }
      };

      this.browserSession.cookies.on('changed', cookieListener);
      this.loginWindow.on('closed', () => {
        if (!settled) finish({ success: false, error: 'login_window_closed' });
      });
      this.loginWindow.webContents.on('did-fail-load', () => {
        if (!settled) finish({ success: false, error: 'login_page_failed' });
      });

      const timeout = setTimeout(() => finish({ success: false, error: 'login_timeout' }), LOGIN_TIMEOUT_MS);
      timeout.unref?.();
      this.loginWindow.loadURL(`${CLAUDE_ORIGIN}/login`);
    });
  }

  async disconnect() {
    this.store.delete('claude.sessionKeyEncrypted');
    this.store.delete('claude.sessionKey');
    this.store.delete('claude.organizationId');
    this.store.delete('claude.organizationName');
    const cookies = await this.browserSession.cookies.get({ domain: 'claude.ai' });
    for (const cookie of cookies) {
      try { await this.browserSession.cookies.remove(CLAUDE_ORIGIN, cookie.name); } catch {}
    }
    await this.browserSession.clearStorageData({ origin: CLAUDE_ORIGIN });
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
