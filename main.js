'use strict';

const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
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
const { pathToFileURL } = require('node:url');
const Store = require('electron-store');
const { ClaudeProvider } = require('./src/main/claude-provider');
const { CodexProvider } = require('./src/main/codex-provider');
const { discoverCodexExecutable } = require('./src/main/codex-client');
const { ProviderManager } = require('./src/main/provider-manager');
const {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  applyPersistentHudDefaults,
  hardenStorePermissions,
  migrateLegacyConfig,
  sanitizeSettings
} = require('./src/main/storage');
const { fetchMultipleViaWindow } = require('./src/fetch-via-window');

const APP_NAME = 'AI Usage Widget';
const APP_ID = 'com.jameshan.aiusagewidget';
const WINDOW_MODES = Object.freeze({
  compact: Object.freeze({ width: 304, height: 226, minWidth: 260, minHeight: 200, maxWidth: 520, maxHeight: 420 }),
  expanded: Object.freeze({ width: 620, height: 560, minWidth: 480, minHeight: 360, maxWidth: 960, maxHeight: 900 })
});
const SCREEN_MARGIN = 10;
const CHROME_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ALLOWED_LINKS = Object.freeze({
  claude: 'https://claude.ai',
  codexDocs: 'https://developers.openai.com/codex',
  source: 'https://github.com/jdventures222/ai-usage-widget'
});

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
let compactMode = store.get('windowCompact', true) !== false;
let persistBoundsTimer = null;
let changingWindowMode = false;

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

function currentModeKey() {
  return compactMode ? 'compact' : 'expanded';
}

function modeLimits(mode = currentModeKey()) {
  return WINDOW_MODES[mode] || WINDOW_MODES.compact;
}

function displayForWidget(bounds, mode = currentModeKey()) {
  if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    return screen.getDisplayMatching(bounds);
  }
  const savedId = store.get(`windowDisplayIdsV2.${mode}`);
  return screen.getAllDisplays().find((display) => String(display.id) === String(savedId)) ||
    screen.getPrimaryDisplay();
}

function cornerBounds(width, height, display = displayForWidget()) {
  const area = display.workArea;
  const corner = getSettings().widgetCorner;
  const left = corner.endsWith('left');
  const top = corner.startsWith('top');
  return {
    x: Math.round(left ? area.x + SCREEN_MARGIN : area.x + area.width - width - SCREEN_MARGIN),
    y: Math.round(top ? area.y + SCREEN_MARGIN : area.y + area.height - height - SCREEN_MARGIN),
    width,
    height
  };
}

function constrainBounds(input, mode = currentModeKey()) {
  const limits = modeLimits(mode);
  const candidate = input && typeof input === 'object' ? input : {};
  const display = displayForWidget(candidate, mode);
  const area = display.workArea;
  const width = Math.min(
    Math.max(limits.minWidth, Math.round(Number(candidate.width) || limits.width)),
    Math.min(limits.maxWidth, area.width)
  );
  const height = Math.min(
    Math.max(limits.minHeight, Math.round(Number(candidate.height) || limits.height)),
    Math.min(limits.maxHeight, area.height)
  );
  const proposedX = Math.round(Number(candidate.x));
  const proposedY = Math.round(Number(candidate.y));
  const visibleWidth = Math.min(96, width);
  const visibleHeight = Math.min(48, height);
  const x = Number.isFinite(proposedX)
    ? Math.min(area.x + area.width - visibleWidth, Math.max(area.x - width + visibleWidth, proposedX))
    : cornerBounds(width, height, display).x;
  const y = Number.isFinite(proposedY)
    ? Math.min(area.y + area.height - visibleHeight, Math.max(area.y, proposedY))
    : cornerBounds(width, height, display).y;
  return { x, y, width, height };
}

function storedBounds(mode = currentModeKey()) {
  const saved = store.get(`windowBoundsV2.${mode}`);
  if (!saved || typeof saved !== 'object') return null;
  return constrainBounds(saved, mode);
}

function initialBounds(mode = currentModeKey()) {
  const saved = storedBounds(mode);
  if (saved) return saved;
  const limits = modeLimits(mode);
  return cornerBounds(limits.width, limits.height, displayForWidget(null, mode));
}

function persistCurrentBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(persistBoundsTimer);
  const mode = currentModeKey();
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  store.set(`windowBoundsV2.${mode}`, bounds);
  store.set(`windowDisplayIdsV2.${mode}`, String(display.id));
  hardenStorePermissions(store);
}

function schedulePersistBounds() {
  if (changingWindowMode) return;
  clearTimeout(persistBoundsTimer);
  persistBoundsTimer = setTimeout(persistCurrentBounds, 250);
  persistBoundsTimer.unref?.();
}

function applyModeBounds({ snap = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const mode = currentModeKey();
  const limits = modeLimits(mode);
  changingWindowMode = true;
  mainWindow.setMinimumSize(limits.minWidth, limits.minHeight);
  mainWindow.setMaximumSize(limits.maxWidth, limits.maxHeight);
  const current = mainWindow.getBounds();
  const target = snap
    ? cornerBounds(current.width, current.height, displayForWidget(current, mode))
    : (storedBounds(mode) || initialBounds(mode));
  mainWindow.setBounds(constrainBounds(target, mode), false);
  setTimeout(() => { changingWindowMode = false; }, 300).unref?.();
}

function ensureMainWindowVisible() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.getBounds();
  const safe = constrainBounds(current);
  if (['x', 'y', 'width', 'height'].some((key) => current[key] !== safe[key])) {
    changingWindowMode = true;
    mainWindow.setBounds(safe, false);
    setTimeout(() => { changingWindowMode = false; persistCurrentBounds(); }, 300).unref?.();
  }
}

function showMainWindow({ focus = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  ensureMainWindowVisible();
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (focus) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    mainWindow.showInactive();
  }
}

function createMainWindow() {
  const limits = modeLimits();
  const initial = initialBounds();

  mainWindow = new BrowserWindow({
    ...initial,
    minWidth: limits.minWidth,
    maxWidth: limits.maxWidth,
    minHeight: limits.minHeight,
    maxHeight: limits.maxHeight,
    frame: false,
    transparent: false,
    backgroundColor: '#00000000',
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    show: false,
    alwaysOnTop: getSettings().alwaysOnTop,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    movable: true,
    minimizable: false,
    fullscreenable: false,
    vibrancy: process.platform === 'darwin' ? 'hud' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
    title: APP_NAME,
    icon: path.join(__dirname, process.platform === 'darwin' ? 'assets/icon.icns' : 'assets/logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => showMainWindow({ focus: false }));
  mainWindow.on('move', schedulePersistBounds);
  mainWindow.on('resize', schedulePersistBounds);
  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, process.platform === 'darwin' ? 'assets/tray-icon-mac.png' : 'assets/tray-icon.png');
  const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide(); else showMainWindow();
  });
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show AI Usage Widget', click: showMainWindow },
    { label: 'Refresh now', click: () => refreshProviders({ force: true }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function updateTray(snapshots) {
  if (!tray) return;
  const lines = [];
  let highest = null;
  for (const snapshot of Object.values(snapshots || {})) {
    if (!snapshot || snapshot.status === 'disabled') continue;
    const values = snapshot.buckets.map((bucket) => bucket.usedPercent).filter(Number.isFinite);
    const providerHigh = values.length ? Math.max(...values) : null;
    if (providerHigh !== null && !snapshot.stale) highest = highest === null ? providerHigh : Math.max(highest, providerHigh);
    const suffix = snapshot.stale ? ' (stale)' : '';
    lines.push(`${snapshot.providerName}: ${providerHigh === null ? snapshot.status : `${Math.round(providerHigh)}%`}${suffix}`);
  }
  tray.setToolTip([APP_NAME, ...lines].join('\n'));
  if (process.platform === 'darwin') tray.setTitle(highest === null ? '' : ` ${Math.round(highest)}%`);
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

function applySettings(settings, options = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isAlwaysOnTop() !== settings.alwaysOnTop) {
      mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
    }
    if (mainWindow.isVisibleOnAllWorkspaces() !== settings.allSpaces) {
      mainWindow.setVisibleOnAllWorkspaces(settings.allSpaces, { visibleOnFullScreen: true });
    }
    if (Math.abs(mainWindow.getOpacity() - settings.hudOpacity) > 0.001) {
      mainWindow.setOpacity(settings.hudOpacity);
    }
    if (options.snapToCorner) applyModeBounds({ snap: true });
  }
  if (process.platform === 'darwin' && app.dock) {
    if (settings.minimizeToTray) app.dock.hide(); else app.dock.show();
  }
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
  const dashboardUrl = pathToFileURL(path.join(__dirname, 'src', 'renderer', 'index.html')).toString();
  const assertDashboardSender = (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame?.url !== dashboardUrl) {
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
    version: app.getVersion(),
    compactMode
  }));
  handle('providers:refresh', (providerId) => refreshProviders({
    force: true,
    providerId: typeof providerId === 'string' ? providerId : undefined
  }));
  handle('claude:connect', async () => {
    const result = await claudeProvider.connect();
    if (result.success) await refreshProviders({ force: true, providerId: 'claude' });
    hardenStorePermissions(store);
    return result;
  });
  handle('claude:disconnect', async () => {
    await claudeProvider.disconnect();
    await refreshProviders({ force: true, providerId: 'claude' });
    hardenStorePermissions(store);
    return true;
  });
  handle('settings:get', () => getSettings());
  handle('settings:save', async (input) => {
    const current = getSettings();
    const requested = input && typeof input === 'object' ? input : {};
    requested.codexExecutable = current.codexExecutable;
    const settings = saveSettings(requested);
    applySettings(settings, { snapToCorner: settings.widgetCorner !== current.widgetCorner });
    await refreshProviders({ force: true });
    return settings;
  });
  handle('codex:choose-executable', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select the Codex executable',
      properties: ['openFile', 'dontAddToRecent']
    });
    if (result.canceled || result.filePaths.length !== 1) return { success: false, canceled: true };
    const resolved = discoverCodexExecutable({ configuredPath: result.filePaths[0], environment: { PATH: '' } });
    if (!resolved) return { success: false, error: 'not_executable' };
    const settings = saveSettings({ ...getSettings(), codexExecutable: resolved });
    await refreshProviders({ force: true, providerId: 'codex' });
    return { success: true, path: settings.codexExecutable };
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
  on('window:minimize', () => mainWindow?.minimize());
  on('window:close', () => mainWindow?.close());
  handle('window:set-mode', (requestedCompact) => {
    persistCurrentBounds();
    compactMode = requestedCompact !== false;
    store.set('windowCompact', compactMode);
    hardenStorePermissions(store);
    applyModeBounds();
    return compactMode;
  });
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
  const migration = migrateLegacyConfig({
    store,
    legacyPath: profileName
      ? path.join(app.getPath('userData'), 'no-legacy-config.json')
      : legacyConfigPath(),
    safeStorage
  });
  if (await migrateLegacyCredentialIfNeeded(migration)) migration.credentialMigrated = true;
  if (!store.has('settings')) saveSettings(DEFAULT_SETTINGS);
  applyPersistentHudDefaults(store);
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
    mainWindow: () => mainWindow
  });
  const codexProvider = new CodexProvider({
    getSettings,
    clientVersion: app.getVersion()
  });
  providerManager = new ProviderManager({
    providers: [claudeProvider, codexProvider],
    store,
    getSettings
  });

  registerIpc();
  if (process.platform === 'darwin' && app.dock && getSettings().minimizeToTray) app.dock.hide();
  createMainWindow();
  createTray();
  applySettings(getSettings());
  screen.on('display-metrics-changed', ensureMainWindowVisible);
  screen.on('display-removed', ensureMainWindowVisible);
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
  clearTimeout(persistBoundsTimer);
  persistCurrentBounds();
  providerManager?.dispose();
});
app.on('window-all-closed', () => {
  // The tray is the recovery surface. Explicit Quit exits on every platform.
});

}
