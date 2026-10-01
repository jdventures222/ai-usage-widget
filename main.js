'use strict';

const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray
} = require('electron');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('electron-store');
const { ClaudeProvider } = require('./src/main/claude-provider');
const { formatMenuBarTitle, highestUsage, popoverBounds } = require('./src/main/menu-bar');
const { ProviderManager } = require('./src/main/provider-manager');
const {
  DASHBOARD_URL,
  registerDashboardHandler,
  registerDashboardScheme
} = require('./src/main/dashboard-protocol');
const {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  hardenStorePermissions,
  migrateLegacyConfig,
  sanitizeSettings
} = require('./src/main/storage');
const { fetchMultipleViaWindow } = require('./src/fetch-via-window');

const APP_NAME = 'AI Usage Widget';
const APP_ID = 'com.jameshan.aiusagewidget';
const POPOVER_SIZE = Object.freeze({ width: 400, height: 600 });
// A click on the tray icon blurs the open panel before the click arrives, so a
// hide this recent means the click was meant to close it.
const BLUR_CLICK_GRACE_MS = 300;
const CHROME_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ALLOWED_LINKS = Object.freeze({
  claude: 'https://claude.ai',
  source: 'https://github.com/jdventures222/ai-usage-widget'
});

registerDashboardScheme(protocol);

const CREDENTIAL_HELPER_MODE = process.argv.includes('--credential-migration-helper=legacy');

function readHelperInput(limit = 8192) {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
      if (input.length > limit) reject(new Error('helper_input_too_large'));
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function runCredentialMigrationHelper() {
  app.setName('claude-usage-widget');
  app.setPath('userData', path.join(os.tmpdir(), 'ai-usage-widget-legacy-credential-helper'));
  app.whenReady().then(async () => {
    app.dock?.hide();
    let response = { success: false };
    try {
      const input = JSON.parse(await readHelperInput());
      const key = Buffer.from(input.key || '', 'base64');
      const encrypted = Buffer.from(input.encrypted || '', 'base64');
      if (key.length !== 32 || encrypted.length < 19 || encrypted.subarray(0, 3).toString('ascii') !== 'v10') {
        throw new Error('invalid_helper_input');
      }
      const sessionKey = safeStorage.decryptString(encrypted);
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(sessionKey, 'utf8'), cipher.final()]);
      response = {
        success: true,
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64')
      };
      key.fill(0);
    } catch {}
    process.stdout.write(`${JSON.stringify(response)}\n`, () => app.quit());
  }).catch(() => {
    process.stdout.write(`${JSON.stringify({ success: false })}\n`, () => app.quit());
  });
}

if (CREDENTIAL_HELPER_MODE) {
  runCredentialMigrationHelper();
} else {

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const profileArgument = process.argv.find((argument) => argument.startsWith('--profile='));
const profileName = profileArgument
  ? profileArgument.slice('--profile='.length).replace(/[^a-zA-Z0-9_-]/g, '_')
  : null;
const userDataRoot = path.join(app.getPath('appData'), 'ai-usage-widget');
app.setPath('userData', profileName ? path.join(userDataRoot, 'profiles', profileName) : userDataRoot);

const hasInstanceLock = app.requestSingleInstanceLock({ profileName });
if (!hasInstanceLock) app.quit();

const store = new Store({ name: 'config' });
let mainWindow = null;
let tray = null;
let providerManager = null;
let claudeProvider = null;
let refreshTimer = null;
let isQuitting = false;
let refreshPromise = null;
let lastBlurHideAt = 0;

function legacyConfigPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'claude-usage-widget', 'config.json');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-usage-widget', 'config.json');
  }
  return path.join(os.homedir(), '.config', 'claude-usage-widget', 'config.json');
}

function getSettings() {
  return sanitizeSettings(store.get('settings', DEFAULT_SETTINGS));
}

function saveSettings(settings) {
  const sanitized = sanitizeSettings(settings);
  store.set('settings', sanitized);
  hardenStorePermissions(store);
  return sanitized;
}

function runLegacyCredentialHelper(encrypted, key) {
  return new Promise((resolve) => {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const args = app.isPackaged
      ? ['--credential-migration-helper=legacy']
      : [app.getAppPath(), '--credential-migration-helper=legacy'];
    const child = spawn(process.execPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: environment
    });
    let output = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(null);
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 65536) {
        try { child.kill('SIGKILL'); } catch {}
        finish(null);
      }
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      try {
        const lines = output.trim().split(/\r?\n/).filter(Boolean);
        const parsed = JSON.parse(lines.at(-1) || '{}');
        finish(parsed.success === true ? parsed : null);
      } catch { finish(null); }
    });
    child.stdin.end(JSON.stringify({
      key: key.toString('base64'),
      encrypted
    }));
  });
}

async function migrateLegacyCredentialIfNeeded(migration) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const existing = store.get('claude.sessionKeyEncrypted');
  if (existing) {
    try {
      if (safeStorage.decryptString(Buffer.from(existing, 'base64'))) return false;
    } catch {
      store.delete('claude.sessionKeyEncrypted');
    }
  }
  const migrationState = store.get('migration.v2', {});
  if (!migration?.migrated && migrationState.sourceFound !== true) return false;
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(legacyConfigPath(), 'utf8')); }
  catch { return false; }
  if (typeof legacy.sessionKey_encrypted !== 'string' || !legacy.sessionKey_encrypted) return false;

  const key = crypto.randomBytes(32);
  try {
    const result = await runLegacyCredentialHelper(legacy.sessionKey_encrypted, key);
    if (!result) return false;
    const nonce = Buffer.from(result.nonce || '', 'base64');
    const ciphertext = Buffer.from(result.ciphertext || '', 'base64');
    const tag = Buffer.from(result.tag || '', 'base64');
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return false;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const sessionKey = plaintext.toString('utf8');
    if (!sessionKey) return false;
    const reencrypted = safeStorage.encryptString(sessionKey).toString('base64');
    plaintext.fill(0);
    store.set('claude.sessionKeyEncrypted', reencrypted);
    if (legacy.organizationId) store.set('claude.organizationId', String(legacy.organizationId));
    store.set('migration.v2', {
      ...store.get('migration.v2', {}),
      credentialMigrated: true,
      credentialReencrypted: true
    });
    hardenStorePermissions(store);
    return true;
  } catch {
    return false;
  } finally {
    key.fill(0);
  }
}

function positionPopover() {
  const trayBounds = tray?.getBounds();
  const display = trayBounds && trayBounds.width > 0
    ? screen.getDisplayMatching(trayBounds)
    : screen.getPrimaryDisplay();
  mainWindow.setBounds(popoverBounds(trayBounds, display.workArea, POPOVER_SIZE), false);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  positionPopover();
  if (process.platform === 'darwin') app.focus({ steal: true });
  mainWindow.show();
  mainWindow.focus();
}

function togglePopover() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }
  if (Date.now() - lastBlurHideAt < BLUR_CLICK_GRACE_MS) return;
  showMainWindow();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: POPOVER_SIZE.width,
    height: POPOVER_SIZE.height,
    frame: false,
    transparent: false,
    backgroundColor: '#00000000',
    roundedCorners: true,
    hasShadow: true,
    resizable: false,
    movable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    vibrancy: process.platform === 'darwin' ? 'popover' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
    title: APP_NAME,
    // macOS takes the application icon from the signed bundle; nativeImage
    // cannot load the ICNS through an ASAR path for a BrowserWindow option.
    ...(process.platform === 'darwin' ? {} : { icon: path.join(__dirname, 'assets/logo.png') }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.on('blur', () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDevToolsOpened()) return;
    lastBlurHideAt = Date.now();
    mainWindow.hide();
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(DASHBOARD_URL);
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, process.platform === 'darwin' ? 'assets/tray-icon-mac.png' : 'assets/tray-icon.png');
  const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  const menu = Menu.buildFromTemplate([
    { label: 'Show usage', click: showMainWindow },
    { label: 'Refresh now', click: () => refreshProviders({ force: true }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  // Linux tray hosts often deliver no click events, only the context menu.
  if (process.platform === 'linux') {
    tray.setContextMenu(menu);
  } else {
    tray.on('click', togglePopover);
    tray.on('right-click', () => tray.popUpContextMenu(menu));
  }
}

function updateTray(snapshots) {
  if (!tray) return;
  const snapshot = snapshots?.claude;
  const highest = highestUsage(snapshot);
  const lines = [];
  if (snapshot) {
    const suffix = snapshot.stale ? ' (stale)' : '';
    lines.push(`${snapshot.providerName}: ${highest === null ? snapshot.status : `${Math.round(highest)}%`}${suffix}`);
  }
  tray.setToolTip([APP_NAME, ...lines].join('\n'));
  if (process.platform === 'darwin') {
    const title = formatMenuBarTitle(snapshot);
    tray.setTitle(title ? ` ${title}` : '', { fontType: 'monospacedDigit' });
  }
}

function maybeNotify(snapshots) {
  const settings = getSettings();
  if (!settings.usageAlerts || !Notification.isSupported()) return;
  const state = store.get('notificationStateV2', {});
  const initialized = store.get('notificationsInitializedV2', false);
  const activeKeys = new Set();

  for (const snapshot of Object.values(snapshots || {})) {
    if (snapshot.status !== 'ready' || snapshot.stale) continue;
    for (const bucket of snapshot.buckets) {
      const resetKey = bucket.resetsAt || 'no-reset';
      const key = `${snapshot.providerId}|${bucket.id}|${resetKey}`;
      activeKeys.add(key);
      let level = 'normal';
      if (bucket.usedPercent >= 100) level = 'blocked';
      else if (bucket.usedPercent >= settings.dangerThreshold) level = 'danger';
      else if (bucket.usedPercent >= settings.warnThreshold) level = 'warning';
      const oldLevel = state[key] || 'normal';
      const ranks = { normal: 0, warning: 1, danger: 2, blocked: 3 };
      if (initialized && ranks[level] > ranks[oldLevel]) {
        new Notification({
          title: `${snapshot.providerName} usage: ${Math.round(bucket.usedPercent)}%`,
          body: `${bucket.label} · ${bucket.windowLabel}`,
          silent: false
        }).show();
      }
      state[key] = level;
    }
  }

  for (const key of Object.keys(state)) if (!activeKeys.has(key)) delete state[key];
  store.set('notificationStateV2', state);
  store.set('notificationsInitializedV2', true);
  hardenStorePermissions(store);
}

async function refreshProviders(options = {}) {
  if (!providerManager) return {};
  if (refreshPromise) return refreshPromise;
  refreshPromise = providerManager.refresh(options)
    .then((snapshots) => {
      updateTray(snapshots);
      maybeNotify(snapshots);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('snapshots-updated', {
          snapshots,
          history: providerManager.getHistory()
        });
      }
      return snapshots;
    })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function restartRefreshTimer() {
  clearInterval(refreshTimer);
  const milliseconds = getSettings().refreshInterval * 1000;
  refreshTimer = setInterval(() => refreshProviders({ force: false }), milliseconds);
  refreshTimer.unref?.();
}

function applySettings(settings) {
  if (app.isPackaged && process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: settings.autoStart, openAsHidden: true });
  }
  restartRefreshTimer();
}

function safeDiagnostics() {
  return providerManager.diagnostics().then((providers) => ({
    app: APP_NAME,
    version: app.getVersion(),
    schemaVersion: store.get('schemaVersion', null),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electron: process.versions.electron,
    providers,
    snapshots: Object.fromEntries(Object.entries(providerManager.getSnapshots()).map(([id, snapshot]) => [id, {
      status: snapshot.status,
      stale: snapshot.stale,
      bucketCount: snapshot.buckets.length,
      fetchedAt: snapshot.fetchedAt,
      errorCode: snapshot.error?.code || null
    }]))
  }));
}

function registerIpc() {
  const assertDashboardSender = (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame?.url !== DASHBOARD_URL) {
      throw new Error('untrusted_ipc_sender');
    }
  };
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    assertDashboardSender(event);
    return callback(...args);
  });
  const on = (channel, callback) => ipcMain.on(channel, (event, ...args) => {
    assertDashboardSender(event);
    callback(...args);
  });

  handle('dashboard:get', () => ({
    settings: getSettings(),
    snapshots: providerManager.getSnapshots(),
    history: providerManager.getHistory(),
    version: app.getVersion()
  }));
  handle('providers:refresh', (providerId) => refreshProviders({
    force: true,
    providerId: typeof providerId === 'string' ? providerId : undefined
  }));
  // refreshProviders hands back an in-flight refresh, which started before the
  // account changed, so wait it out and fetch again.
  const refreshClaude = async () => {
    if (refreshPromise) await refreshPromise.catch(() => {});
    await refreshProviders({ force: true, providerId: 'claude' });
  };
  handle('claude:connect', async () => {
    const result = await claudeProvider.connect();
    // Also after a failure: a refresh that overlapped the attempt left a
    // "signing in" snapshot behind.
    await refreshClaude();
    hardenStorePermissions(store);
    return result;
  });
  handle('claude:disconnect', async () => {
    await claudeProvider.disconnect();
    await refreshClaude();
    hardenStorePermissions(store);
    return true;
  });
  handle('settings:get', () => getSettings());
  handle('settings:save', async (input) => {
    const settings = saveSettings(input && typeof input === 'object' ? input : {});
    applySettings(settings);
    await refreshProviders({ force: true });
    return settings;
  });
  handle('diagnostics:copy', async () => {
    clipboard.writeText(JSON.stringify(await safeDiagnostics(), null, 2));
    return true;
  });
  handle('link:open', (key) => {
    const url = ALLOWED_LINKS[key];
    if (!url) return false;
    shell.openExternal(url);
    return true;
  });
  on('window:close', () => mainWindow?.hide());
}

function denySessionPermissions(browserSession) {
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  browserSession.setDevicePermissionHandler(() => false);
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.whenReady().then(async () => {
  await registerDashboardHandler(protocol, __dirname);
  const migration = migrateLegacyConfig({
    store,
    legacyPath: profileName
      ? path.join(app.getPath('userData'), 'no-legacy-config.json')
      : legacyConfigPath(),
    safeStorage
  });
  if (await migrateLegacyCredentialIfNeeded(migration)) migration.credentialMigrated = true;
  if (!store.has('settings')) saveSettings(DEFAULT_SETTINGS);
  store.set('schemaVersion', SCHEMA_VERSION);
  hardenStorePermissions(store);

  denySessionPermissions(session.defaultSession);
  const claudeSession = session.fromPartition('persist:ai-usage-claude', { cache: true });
  denySessionPermissions(claudeSession);
  claudeSession.setUserAgent(CHROME_USER_AGENT);
  claudeProvider = new ClaudeProvider({
    store,
    safeStorage,
    BrowserWindow,
    browserSession: claudeSession,
    fetchMultipleViaWindow,
    safariImportAvailable: app.isPackaged,
    openExternal: (url) => { shell.openExternal(url); },
    // The cookie is read from Safari, so the sign-in must happen there even
    // when another browser is the default.
    openInSafari: (url) => {
      spawn('/usr/bin/open', ['-a', 'Safari', url], { shell: false, stdio: 'ignore' }).on('error', () => {});
    }
  });
  providerManager = new ProviderManager({
    providers: [claudeProvider],
    store,
    getSettings
  });

  registerIpc();
  app.dock?.hide();
  createMainWindow();
  createTray();
  applySettings(getSettings());
  powerMonitor.on('resume', () => refreshProviders({ force: true }));
  await refreshProviders({ force: true });

  if (migration.migrated && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('migration-complete', {
      credentialMigrated: migration.credentialMigrated,
      historySamples: migration.historySamples
    });
  }
});

app.on('second-instance', showMainWindow);
app.on('activate', showMainWindow);
app.on('before-quit', () => {
  isQuitting = true;
  clearInterval(refreshTimer);
  providerManager?.dispose();
});
app.on('window-all-closed', () => {
  // The tray is the recovery surface. Explicit Quit exits on every platform.
});

}
