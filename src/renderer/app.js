'use strict';

const api = window.usageWidget;
const state = {
  snapshots: {},
  settings: null,
  history: [],
  version: '',
  compact: true,
  refreshing: false,
  chart: null,
  toastTimer: null
};

const elements = {};
const ERROR_MESSAGES = Object.freeze({
  claude_login_required: 'Connect your Claude account to load subscription usage.',
  claude_session_expired: 'Your Claude session expired. Reconnect to continue.',
  claude_fetch_failed: 'Claude usage is temporarily unavailable.',
  codex_cli_not_found: 'Codex CLI was not found. Install it or choose its executable.',
  unsupported_version: 'This Codex version does not expose the expected usage method.',
  timeout: 'Codex did not respond before the safety timeout.',
  process_failed: 'The local Codex service exited unexpectedly.',
  rpc_failed: 'Codex rejected the local usage request.',
  invalid_response: 'The provider returned an unsupported data shape.',
  codex_unknown_error: 'Codex usage is temporarily unavailable.'
});

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  cacheElements();
  bindEvents();
  api.onSnapshotsUpdated(({ snapshots, history }) => {
    state.snapshots = snapshots || {};
    state.history = Array.isArray(history) ? history : [];
    state.refreshing = false;
    render();
  });
  api.onMigrationComplete((result) => {
    const auth = result.credentialMigrated ? 'Claude login migrated.' : 'Claude may require a new login.';
    showMigration(`${auth} Imported ${result.historySamples || 0} history samples.`);
  });

  try {
    const dashboard = await api.getDashboard();
    state.snapshots = dashboard.snapshots || {};
    state.settings = dashboard.settings;
    state.history = dashboard.history || [];
    state.version = dashboard.version || '';
    state.compact = dashboard.compactMode !== false;
    applyTheme(state.settings.theme);
    populateSettings();
    render();
  } catch {
    elements.providerList.replaceChildren(createStateMessage('The application could not load its local dashboard.'));
  }

  setInterval(updateRelativeTimes, 1000);
}

function cacheElements() {
  for (const id of [
    'windowShell', 'summaryText', 'compactToggleButton', 'settingsButton', 'refreshButton', 'minimizeButton', 'closeButton',
    'migrationBanner', 'compactPanel', 'compactList', 'mainScroll', 'providerList', 'historyPanel', 'historyProvider', 'usageChart',
    'emptyChart', 'lastUpdated', 'settingsModal', 'saveSettingsButton', 'claudeEnabled', 'codexEnabled',
    'codexPath', 'chooseCodexButton', 'refreshInterval', 'theme', 'warnThreshold', 'dangerThreshold',
    'usageAlerts', 'showHistory', 'alwaysOnTop', 'allSpaces', 'widgetCorner', 'hudOpacity', 'hudOpacityValue',
    'autoStart', 'minimizeToTray', 'copyDiagnosticsButton',
    'codexDocsButton', 'sourceButton', 'versionLabel', 'toast'
  ]) elements[id] = document.getElementById(id);
}

function bindEvents() {
  elements.settingsButton.addEventListener('click', openSettings);
  elements.compactToggleButton.addEventListener('click', () => setCompactMode(!state.compact));
  elements.saveSettingsButton.addEventListener('click', saveAndCloseSettings);
  elements.settingsModal.addEventListener('click', (event) => {
    if (event.target === elements.settingsModal) saveAndCloseSettings();
  });
  elements.refreshButton.addEventListener('click', () => refresh());
  elements.minimizeButton.addEventListener('click', api.minimizeWindow);
  elements.closeButton.addEventListener('click', api.closeWindow);
  elements.chooseCodexButton.addEventListener('click', chooseCodex);
  elements.copyDiagnosticsButton.addEventListener('click', copyDiagnostics);
  elements.codexDocsButton.addEventListener('click', () => api.openLink('codexDocs'));
  elements.sourceButton.addEventListener('click', () => api.openLink('source'));
  elements.historyProvider.addEventListener('change', renderHistory);
  elements.theme.addEventListener('change', () => applyTheme(elements.theme.value));
  elements.hudOpacity.addEventListener('input', () => {
    elements.hudOpacityValue.textContent = `${Math.round(Number(elements.hudOpacity.value) * 100)}%`;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.settingsModal.hidden) saveAndCloseSettings();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      refresh();
    }
  });
}

function render() {
  renderMode();
  renderSummary();
  renderCompact();
  renderProviders();
  renderHistory();
  updateLastUpdated();
}

function renderMode() {
  document.documentElement.dataset.compact = String(state.compact);
  elements.compactToggleButton.setAttribute('aria-label', state.compact ? 'Expand widget' : 'Collapse widget');
  elements.compactToggleButton.title = state.compact ? 'Expand widget' : 'Collapse widget';
}

function enabledSnapshots() {
  const order = ['claude', 'codex'];
  return order.map((id) => state.snapshots[id]).filter((snapshot) => snapshot && snapshot.status !== 'disabled');
}

function renderCompact() {
  if (!state.compact) return;
  const codex = state.snapshots.codex;
  const claude = state.snapshots.claude;
  const codexBucket = (codex?.buckets || []).reduce((highest, bucket) =>
    !highest || bucket.usedPercent > highest.usedPercent ? bucket : highest
  , null);
  const definitions = [
    { label: 'Codex', snapshot: codex, bucket: codexBucket },
    { label: 'Claude 5h', snapshot: claude, bucket: findBucket(claude, 'claude:all-models:primary:300') },
    { label: 'Claude week', snapshot: claude, bucket: findBucket(claude, 'claude:all-models:secondary:10080') },
    { label: 'Fable', snapshot: claude, bucket: findBucket(claude, 'claude:fable:secondary:10080') }
  ];
  const fragment = document.createDocumentFragment();
  for (const definition of definitions) fragment.append(createCompactRow(definition));
  elements.compactList.replaceChildren(fragment);
}

function findBucket(snapshot, id) {
  return (snapshot?.buckets || []).find((bucket) => bucket.id === id) || null;
}

function createCompactRow({ label, snapshot, bucket }) {
  const row = document.createElement('div');
  row.className = `compact-row ${snapshot?.stale ? 'is-stale' : ''}`;

  const copy = document.createElement('div');
  copy.className = 'compact-copy';
  const name = document.createElement('strong');
  name.textContent = label;
  const detail = document.createElement('small');
  if (bucket) {
    const reset = bucket.resetsAt ? formatRelative(bucket.resetsAt) : 'reset unknown';
    detail.textContent = `${bucket.windowLabel} · ${reset}`;
    detail.title = bucket.resetsAt ? `Resets ${new Date(bucket.resetsAt).toLocaleString()}` : 'Reset time unavailable';
  } else {
    detail.textContent = compactStatus(snapshot);
  }
  copy.append(name, detail);

  const progress = document.createElement('div');
  progress.className = 'compact-progress';
  const fill = document.createElement('span');
  fill.className = bucket ? usageClass(bucket.usedPercent) : 'unavailable';
  fill.style.width = `${bucket ? Math.min(100, Math.max(0, bucket.usedPercent)) : 0}%`;
  progress.append(fill);

  const value = document.createElement('span');
  value.className = `compact-value ${bucket ? usageClass(bucket.usedPercent) : 'unavailable'}`;
  value.textContent = bucket ? `${Math.round(bucket.usedPercent)}%` : '—';
  row.append(copy, progress, value);
  return row;
}

function compactStatus(snapshot) {
  if (!snapshot) return 'checking…';
  if (snapshot.stale) return 'last value unavailable';
  return {
    loading: 'checking…', unauthenticated: 'sign in required', cli_missing: 'Codex CLI missing',
    unsupported_version: 'update Codex CLI', disabled: 'disabled', error: 'temporarily unavailable'
  }[snapshot.status] || 'not reported';
}

function renderSummary() {
  const snapshots = enabledSnapshots();
  const current = snapshots.flatMap((snapshot) => snapshot.stale ? [] : snapshot.buckets.map((bucket) => bucket.usedPercent));
  if (state.refreshing) {
    elements.summaryText.textContent = 'Refreshing both accounts…';
  } else if (current.length > 0) {
    elements.summaryText.textContent = `Highest current usage ${Math.round(Math.max(...current))}%`;
  } else if (snapshots.some((snapshot) => snapshot.status === 'loading')) {
    elements.summaryText.textContent = 'Checking providers…';
  } else {
    elements.summaryText.textContent = 'Connect or configure a provider';
  }
}

function renderProviders() {
  const fragment = document.createDocumentFragment();
  const snapshots = enabledSnapshots();
  if (snapshots.length === 0) {
    fragment.append(createStateMessage('Both providers are disabled. Re-enable one in Settings.'));
  } else {
    for (const snapshot of snapshots) fragment.append(createProviderCard(snapshot));
  }
  elements.providerList.replaceChildren(fragment);
}

function createProviderCard(snapshot) {
  const card = document.createElement('article');
  card.className = `provider-card provider-${snapshot.providerId}`;
  card.dataset.provider = snapshot.providerId;

  const header = document.createElement('header');
  header.className = 'provider-header';
  const identity = document.createElement('div');
  identity.className = 'provider-identity';
  const mark = document.createElement('span');
  mark.className = 'provider-mark';
  mark.textContent = snapshot.providerId === 'claude' ? 'C' : 'X';
  const titleWrap = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = snapshot.providerName;
  const account = document.createElement('p');
  account.textContent = snapshot.account?.displayName || snapshot.account?.planType || providerSubtitle(snapshot.providerId);
  titleWrap.append(title, account);
  identity.append(mark, titleWrap);

  const controls = document.createElement('div');
  controls.className = 'provider-controls';
  const pill = document.createElement('span');
  pill.className = `status-pill status-${snapshot.status}`;
  pill.textContent = statusLabel(snapshot);
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'mini-button';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => refreshProvider(snapshot.providerId));
  controls.append(pill, refresh);
  header.append(identity, controls);
  card.append(header);

  if (snapshot.stale) {
    const stale = document.createElement('div');
    stale.className = 'provider-warning';
    stale.textContent = `Showing last-known data — ${errorMessage(snapshot)}`;
    card.append(stale);
  }

  if (snapshot.buckets.length > 0) {
    const list = document.createElement('div');
    list.className = 'bucket-list';
    for (const bucket of snapshot.buckets) list.append(createBucketRow(snapshot, bucket));
    card.append(list);
  } else {
    card.append(createProviderEmpty(snapshot));
  }

  const footer = document.createElement('footer');
  footer.className = 'provider-footer';
  const fetched = document.createElement('span');
  fetched.className = 'relative-time';
  fetched.dataset.timestamp = snapshot.fetchedAt;
  fetched.textContent = formatRelative(snapshot.fetchedAt);
  footer.append(fetched);
  if (snapshot.providerId === 'claude' && snapshot.status === 'ready') {
    const disconnect = document.createElement('button');
    disconnect.type = 'button';
    disconnect.className = 'link-button';
    disconnect.textContent = 'Disconnect';
    disconnect.addEventListener('click', disconnectClaude);
    footer.append(disconnect);
  }
  card.append(footer);
  return card;
}

function createBucketRow(snapshot, bucket) {
  const row = document.createElement('div');
  row.className = 'bucket-row';
  const heading = document.createElement('div');
  heading.className = 'bucket-heading';
  const labels = document.createElement('div');
  const label = document.createElement('strong');
  label.textContent = bucket.label;
  const windowLabel = document.createElement('span');
  windowLabel.textContent = bucket.windowLabel;
  labels.append(label, windowLabel);
  const percent = document.createElement('span');
  percent.className = `bucket-percent ${usageClass(bucket.usedPercent)}`;
  percent.textContent = `${Math.round(bucket.usedPercent)}%`;
  heading.append(labels, percent);

  const progress = document.createElement('div');
  progress.className = 'progress-track';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', `${snapshot.providerName} ${bucket.label} ${bucket.windowLabel}`);
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-valuenow', String(Math.round(bucket.usedPercent)));
  const fill = document.createElement('div');
  fill.className = `progress-fill ${usageClass(bucket.usedPercent)}`;
  fill.style.width = `${Math.min(100, Math.max(0, bucket.usedPercent))}%`;
  progress.append(fill);

  const reset = document.createElement('div');
  reset.className = 'bucket-reset';
  if (bucket.resetsAt) {
    reset.classList.add('relative-time');
    reset.dataset.timestamp = bucket.resetsAt;
    reset.dataset.prefix = 'Resets ';
    reset.textContent = `Resets ${formatRelative(bucket.resetsAt)}`;
    reset.title = new Date(bucket.resetsAt).toLocaleString();
  } else {
    reset.textContent = bucket.category === 'spend' ? 'No reset time reported' : 'Reset time unavailable';
  }

  row.append(heading, progress, reset);
  return row;
}

function createProviderEmpty(snapshot) {
  const empty = document.createElement('div');
  empty.className = 'provider-empty';
  const text = document.createElement('p');
  text.textContent = snapshot.meta?.noUsage ? 'No usage windows were returned yet.' : errorMessage(snapshot);
  empty.append(text);

  if (snapshot.providerId === 'claude' && ['unauthenticated', 'stale'].includes(snapshot.status)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-button claude-action';
    button.textContent = 'Connect Claude';
    button.addEventListener('click', connectClaude);
    empty.append(button);
  }
  if (snapshot.providerId === 'codex' && ['cli_missing', 'stale'].includes(snapshot.status)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-button codex-action';
    button.textContent = 'Locate Codex';
    button.addEventListener('click', chooseCodex);
    empty.append(button);
  }
  return empty;
}

function createStateMessage(text) {
  const element = document.createElement('div');
  element.className = 'global-empty';
  element.textContent = text;
  return element;
}

function providerSubtitle(providerId) {
  return providerId === 'claude' ? 'Claude.ai subscription' : 'Local ChatGPT subscription';
}

function statusLabel(snapshot) {
  if (snapshot.stale) return 'Stale';
  return {
    ready: 'Live', loading: 'Loading', disabled: 'Disabled', unauthenticated: 'Sign in',
    cli_missing: 'CLI missing', unsupported_version: 'Unsupported', offline: 'Offline', error: 'Error'
  }[snapshot.status] || 'Unknown';
}

function errorMessage(snapshot) {
  return ERROR_MESSAGES[snapshot.error?.code] || 'This provider is currently unavailable.';
}

function usageClass(percent) {
  const settings = state.settings || { warnThreshold: 75, dangerThreshold: 90 };
  if (percent >= settings.dangerThreshold) return 'danger';
  if (percent >= settings.warnThreshold) return 'warning';
  return 'normal';
}

function formatRelative(timestamp) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return 'time unavailable';
  const delta = value - Date.now();
  const absolute = Math.abs(delta);
  if (absolute < 60_000) return delta > 0 ? 'in under a minute' : 'just now';
  const units = [
    ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]
  ];
  for (const [unit, size] of units) {
    if (absolute >= size) {
      const amount = Math.round(delta / size);
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit);
    }
  }
  return 'just now';
}

function updateRelativeTimes() {
  document.querySelectorAll('.relative-time[data-timestamp]').forEach((element) => {
    const prefix = element.dataset.prefix || 'Updated ';
    element.textContent = `${prefix}${formatRelative(element.dataset.timestamp)}`;
  });
  updateLastUpdated();
}

function updateLastUpdated() {
  const times = Object.values(state.snapshots).map((snapshot) => Date.parse(snapshot.fetchedAt)).filter(Number.isFinite);
  elements.lastUpdated.textContent = times.length ? `Last refresh ${formatRelative(new Date(Math.max(...times)).toISOString())}` : 'Not refreshed yet';
}

async function refresh(providerId) {
  if (state.refreshing) return;
  state.refreshing = true;
  elements.refreshButton.classList.add('spinning');
  renderSummary();
  try {
    const snapshots = await api.refreshProviders(providerId);
    state.snapshots = snapshots || state.snapshots;
  } catch {
    showToast('Refresh failed. Last-known data was preserved.', true);
  } finally {
    state.refreshing = false;
    elements.refreshButton.classList.remove('spinning');
    render();
  }
}

function refreshProvider(providerId) {
  return refresh(providerId);
}

async function connectClaude() {
  showToast('Complete sign-in in the Claude window.');
  const result = await api.connectClaude();
  if (result.success) showToast('Claude connected.');
  else showToast(ERROR_MESSAGES[result.error] || 'Claude sign-in did not complete.', true);
}

async function disconnectClaude() {
  if (!window.confirm('Disconnect Claude from this widget? Your Claude account itself is unchanged.')) return;
  await api.disconnectClaude();
  showToast('Claude disconnected.');
}

async function setCompactMode(compact) {
  state.compact = await api.setCompactMode(compact);
  render();
}

async function openSettings() {
  if (state.compact) await setCompactMode(false);
  populateSettings();
  elements.settingsModal.hidden = false;
  elements.saveSettingsButton.focus();
}

function populateSettings() {
  const settings = state.settings;
  if (!settings) return;
  elements.claudeEnabled.checked = settings.enabledProviders?.claude !== false;
  elements.codexEnabled.checked = settings.enabledProviders?.codex !== false;
  elements.codexPath.textContent = settings.codexExecutable || 'Auto-detect';
  elements.refreshInterval.value = String(settings.refreshInterval);
  elements.theme.value = settings.theme;
  elements.warnThreshold.value = String(settings.warnThreshold);
  elements.dangerThreshold.value = String(settings.dangerThreshold);
  elements.usageAlerts.checked = settings.usageAlerts;
  elements.showHistory.checked = settings.showHistory;
  elements.alwaysOnTop.checked = settings.alwaysOnTop;
  elements.allSpaces.checked = settings.allSpaces;
  elements.widgetCorner.value = settings.widgetCorner;
  elements.hudOpacity.value = String(settings.hudOpacity);
  elements.hudOpacityValue.textContent = `${Math.round(settings.hudOpacity * 100)}%`;
  elements.autoStart.checked = settings.autoStart;
  elements.minimizeToTray.checked = settings.minimizeToTray;
  elements.versionLabel.textContent = `AI Usage Widget ${state.version ? `v${state.version}` : ''}`;
}

async function saveAndCloseSettings() {
  if (elements.settingsModal.hidden || !state.settings) return;
  const settings = {
    ...state.settings,
    enabledProviders: { claude: elements.claudeEnabled.checked, codex: elements.codexEnabled.checked },
    refreshInterval: Number(elements.refreshInterval.value),
    theme: elements.theme.value,
    warnThreshold: Number(elements.warnThreshold.value),
    dangerThreshold: Number(elements.dangerThreshold.value),
    usageAlerts: elements.usageAlerts.checked,
    showHistory: elements.showHistory.checked,
    alwaysOnTop: elements.alwaysOnTop.checked,
    allSpaces: elements.allSpaces.checked,
    widgetCorner: elements.widgetCorner.value,
    hudOpacity: Number(elements.hudOpacity.value),
    autoStart: elements.autoStart.checked,
    minimizeToTray: elements.minimizeToTray.checked
  };
  try {
    state.settings = await api.saveSettings(settings);
    applyTheme(state.settings.theme);
    elements.settingsModal.hidden = true;
    showToast('Settings saved.');
    render();
  } catch {
    showToast('Settings could not be saved.', true);
  }
}

async function chooseCodex() {
  const result = await api.chooseCodexExecutable();
  if (result.success) {
    state.settings = await api.getSettings();
    elements.codexPath.textContent = result.path;
    showToast('Codex executable selected.');
  } else if (!result.canceled) {
    showToast('That file is not an executable Codex CLI.', true);
  }
}

async function copyDiagnostics() {
  await api.copyDiagnostics();
  showToast('Safe diagnostics copied.');
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || 'dark';
}

function renderHistory() {
  if (!state.settings) return;
  elements.historyPanel.hidden = state.compact || !state.settings.showHistory;
  if (state.compact || !state.settings.showHistory) {
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    return;
  }
  const providerId = elements.historyProvider.value;
  const rows = state.history.filter((row) => row.providerId === providerId);
  const snapshot = state.snapshots[providerId];
  const labels = new Map((snapshot?.buckets || []).map((bucket) => [bucket.id, `${bucket.label} · ${bucket.windowLabel}`]));
  const ids = (snapshot?.buckets || [])
    .map((bucket) => bucket.id)
    .filter((id) => rows.some((row) => Number.isFinite(row.buckets?.[id])));
  elements.emptyChart.hidden = rows.length > 0 && ids.length > 0;
  elements.usageChart.hidden = !elements.emptyChart.hidden;
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  if (!rows.length || !ids.length || typeof Chart === 'undefined') return;

  state.chart = new Chart(elements.usageChart.getContext('2d'), {
    type: 'line',
    data: {
      datasets: ids.map((id, index) => ({
        label: labels.get(id) || id.split(':').slice(1, -1).join(' '),
        data: rows.filter((row) => Number.isFinite(row.buckets?.[id])).map((row) => ({ x: row.timestamp, y: row.buckets[id] })),
        borderColor: chartColor(id, index),
        backgroundColor: chartColor(id, index),
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.2
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      plugins: { legend: { display: ids.length <= 6, labels: { color: cssValue('--text-muted'), boxWidth: 10 } } },
      scales: {
        x: { type: 'linear', ticks: { color: cssValue('--text-faint'), callback: (value) => new Date(value).toLocaleDateString(undefined, { weekday: 'short' }) }, grid: { color: cssValue('--line') } },
        y: { min: 0, max: 100, ticks: { color: cssValue('--text-faint'), callback: (value) => `${value}%` }, grid: { color: cssValue('--line') } }
      }
    }
  });
}

function chartColor(id, index) {
  const palette = ['#8b5cf6', '#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#f97316'];
  let hash = index;
  for (const character of id) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function cssValue(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function showMigration(message) {
  elements.migrationBanner.textContent = message;
  elements.migrationBanner.hidden = false;
  setTimeout(() => { elements.migrationBanner.hidden = true; }, 9000);
}

function showToast(message, error = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('toast-error', error);
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3200);
}
