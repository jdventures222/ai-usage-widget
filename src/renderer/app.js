'use strict';

const api = window.usageWidget;
const state = {
  snapshots: {},
  settings: null,
  history: [],
  version: '',
  refreshing: false,
  // A connect result can arrive after the panel hid (Safari or System
  // Settings took focus), so it stays on the card instead of only in a toast.
  connectError: null,
  chart: null,
  toastTimer: null
};

const elements = {};
const ERROR_MESSAGES = Object.freeze({
  claude_login_required: 'Connect your Claude account to load subscription usage.',
  claude_session_expired: 'Your Claude session expired. Reconnect to continue.',
  claude_fetch_failed: 'Claude usage is temporarily unavailable.',
  claude_connecting: 'Signing in…',
  claude_login_validation_failed: 'That session was rejected by Claude. Sign in again, then retry.',
  safari_login_required: 'Sign in to Claude in the Safari tab that just opened, then click Connect again.',
  safari_access_denied: 'Give AI Usage Widget Full Disk Access in the System Settings pane that just opened, then click Connect again.',
  secure_storage_unavailable: 'macOS secure storage is unavailable, so the session cannot be saved.',
  login_already_open: 'A Claude sign-in is already in progress.',
  login_window_closed: 'The sign-in window closed before sign-in finished.',
  login_timeout: 'Sign-in timed out. Try again.',
  login_page_failed: 'The claude.ai sign-in page did not load. Check the connection and try again.',
  invalid_response: 'Claude returned an unsupported data shape.'
});

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  cacheElements();
  bindEvents();
  api.onSnapshotsUpdated(({ snapshots, history }) => {
    setSnapshots(snapshots);
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
    setSnapshots(dashboard.snapshots);
    state.settings = dashboard.settings;
    state.history = dashboard.history || [];
    state.version = dashboard.version || '';
    applyTheme(state.settings.theme);
    populateSettings();
    render();
  } catch {
    elements.providerList.replaceChildren(createStateMessage('The application could not load its local dashboard.'));
    fitWindow();
  }

  setInterval(updateRelativeTimes, 1000);
}

function cacheElements() {
  for (const id of [
    'windowShell', 'summaryText', 'settingsButton', 'refreshButton', 'closeButton',
    'migrationBanner', 'mainScroll', 'providerList', 'historyPanel', 'usageChart',
    'emptyChart', 'lastUpdated', 'settingsModal', 'saveSettingsButton',
    'refreshInterval', 'theme', 'warnThreshold', 'dangerThreshold',
    'usageAlerts', 'showHistory', 'autoStart', 'copyDiagnosticsButton',
    'sourceButton', 'versionLabel', 'toast'
  ]) elements[id] = document.getElementById(id);
}

function bindEvents() {
  elements.settingsButton.addEventListener('click', openSettings);
  elements.saveSettingsButton.addEventListener('click', saveAndCloseSettings);
  elements.settingsModal.addEventListener('click', (event) => {
    if (event.target === elements.settingsModal) saveAndCloseSettings();
  });
  elements.refreshButton.addEventListener('click', () => refresh());
  elements.closeButton.addEventListener('click', api.closeWindow);
  elements.copyDiagnosticsButton.addEventListener('click', copyDiagnostics);
  elements.sourceButton.addEventListener('click', () => api.openLink('source'));
  elements.theme.addEventListener('change', () => applyTheme(elements.theme.value));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!elements.settingsModal.hidden) saveAndCloseSettings();
      else api.closeWindow();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      refresh();
    }
  });
}

function setSnapshots(snapshots) {
  state.snapshots = snapshots || {};
  if (state.snapshots.claude?.status === 'ready') state.connectError = null;
}

function render() {
  renderSummary();
  renderProviders();
  renderHistory();
  updateLastUpdated();
  fitWindow();
}

// Measured synchronously after each change: a hidden window gets no frames,
// so a ResizeObserver would only resize the panel after it is already shown.
function fitWindow() {
  const shell = elements.windowShell;
  const border = shell.offsetHeight - shell.clientHeight;
  let height = border + elements.mainScroll.offsetTop + elements.mainScroll.scrollHeight;
  if (!elements.settingsModal.hidden) {
    const panel = elements.settingsModal.firstElementChild;
    let settingsHeight = border + elements.settingsModal.offsetHeight - panel.clientHeight;
    for (const child of panel.children) {
      settingsHeight += child.classList.contains('settings-scroll') ? child.scrollHeight : child.offsetHeight;
    }
    height = Math.max(height, settingsHeight);
  }
  api.fitContent(height);
}

function claudeSnapshot() {
  const snapshot = state.snapshots.claude;
  return snapshot && snapshot.status !== 'disabled' ? snapshot : null;
}

// Personal Claude organizations are named "<email>'s Organization".
function accountLabel(name) {
  return name ? name.replace(/'s Organization$/, '') : null;
}

function renderSummary() {
  const snapshot = claudeSnapshot();
  const current = snapshot && !snapshot.stale ? snapshot.buckets.map((bucket) => bucket.usedPercent) : [];
  if (state.refreshing) {
    elements.summaryText.textContent = 'Refreshing…';
  } else if (current.length > 0) {
    elements.summaryText.textContent = `Highest current usage ${Math.round(Math.max(...current))}%`;
  } else if (snapshot?.stale && snapshot.buckets.length > 0) {
    elements.summaryText.textContent = `Last known highest usage ${Math.round(Math.max(...snapshot.buckets.map((bucket) => bucket.usedPercent)))}%`;
  } else if (!snapshot || snapshot.status === 'loading') {
    elements.summaryText.textContent = 'Checking Claude…';
  } else if (snapshot.status === 'unauthenticated') {
    elements.summaryText.textContent = 'Connect your Claude account';
  } else {
    elements.summaryText.textContent = 'Claude usage unavailable';
  }
}

function renderProviders() {
  const snapshot = claudeSnapshot();
  elements.providerList.replaceChildren(snapshot
    ? createProviderCard(snapshot)
    : createStateMessage('Checking Claude…'));
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
  mark.textContent = 'C';
  const titleWrap = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = snapshot.providerName;
  const account = document.createElement('p');
  // An unauthenticated snapshot still carries the previous account's name.
  account.textContent = snapshot.status === 'unauthenticated'
    ? 'Not connected'
    : accountLabel(snapshot.account?.displayName) || 'Claude.ai subscription';
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
    stale.textContent = `Showing last-known data · ${errorMessage(snapshot)}`;
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
  if (snapshot.status === 'ready' || snapshot.stale) footer.append(createDisconnectButton());
  card.append(footer);
  return card;
}

// A confirm() sheet would take focus from the panel, which hides on blur, so
// disconnecting asks for a second click instead.
function createDisconnectButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-button';
  button.textContent = 'Disconnect';
  let armTimer = null;
  button.addEventListener('click', () => {
    if (armTimer) {
      clearTimeout(armTimer);
      disconnectClaude();
      return;
    }
    button.textContent = 'Click again to disconnect';
    armTimer = setTimeout(() => {
      armTimer = null;
      button.textContent = 'Disconnect';
    }, 4000);
  });
  return button;
}

function createBucketRow(snapshot, bucket) {
  const row = document.createElement('div');
  row.className = 'bucket-row';
  const labels = document.createElement('div');
  labels.className = 'bucket-label';
  const label = document.createElement('strong');
  label.textContent = bucket.label;
  const windowLabel = document.createElement('span');
  windowLabel.textContent = bucket.windowLabel;
  labels.append(label, windowLabel);

  const reset = document.createElement('div');
  reset.className = 'bucket-reset';
  if (bucket.resetsAt) {
    reset.classList.add('relative-time');
    reset.dataset.timestamp = bucket.resetsAt;
    reset.dataset.prefix = 'Resets ';
    reset.textContent = `Resets ${formatRelative(bucket.resetsAt)}`;
    reset.title = new Date(bucket.resetsAt).toLocaleString();
  } else {
    reset.textContent = 'Reset time unavailable';
  }

  const percent = document.createElement('span');
  percent.className = `bucket-percent ${usageClass(bucket.usedPercent)}`;
  percent.textContent = `${Math.round(bucket.usedPercent)}%`;

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

  row.append(labels, reset, percent, progress);
  return row;
}

function createProviderEmpty(snapshot) {
  const empty = document.createElement('div');
  empty.className = 'provider-empty';
  const text = document.createElement('p');
  if (state.connectError) text.textContent = state.connectError;
  else if (snapshot.status === 'loading' && !snapshot.error) text.textContent = 'Checking Claude…';
  else if (snapshot.meta?.noUsage) text.textContent = 'No usage windows were returned yet.';
  else text.textContent = errorMessage(snapshot);
  empty.append(text);

  if (snapshot.status === 'unauthenticated') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-button';
    button.textContent = api.platform === 'darwin' ? 'Connect from Safari' : 'Connect Claude';
    button.addEventListener('click', connectClaude);
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

function statusLabel(snapshot) {
  if (snapshot.stale) return 'Stale';
  return {
    ready: 'Live', loading: 'Loading', disabled: 'Disabled', unauthenticated: 'Sign in',
    offline: 'Offline', error: 'Error'
  }[snapshot.status] || 'Unknown';
}

function errorMessage(snapshot) {
  return ERROR_MESSAGES[snapshot.error?.code] || 'Claude usage is currently unavailable.';
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
    if (snapshots) setSnapshots(snapshots);
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
  showToast(api.platform === 'darwin' ? 'Reading your Safari session…' : 'Complete sign-in in the Claude window.');
  let result;
  try {
    result = await api.connectClaude();
  } catch {
    result = { success: false };
  }
  if (result.success) {
    state.connectError = null;
    const account = accountLabel(result.organizationName);
    showToast(account ? `Connected as ${account}.` : 'Claude connected.');
  } else {
    state.connectError = ERROR_MESSAGES[result.error] || 'Claude sign-in did not complete.';
    showToast(state.connectError, true);
  }
  render();
}

async function disconnectClaude() {
  await api.disconnectClaude();
  showToast('Claude disconnected.');
}

function openSettings() {
  populateSettings();
  elements.settingsModal.hidden = false;
  fitWindow();
  elements.saveSettingsButton.focus();
}

function populateSettings() {
  const settings = state.settings;
  if (!settings) return;
  elements.refreshInterval.value = String(settings.refreshInterval);
  elements.theme.value = settings.theme;
  elements.warnThreshold.value = String(settings.warnThreshold);
  elements.dangerThreshold.value = String(settings.dangerThreshold);
  elements.usageAlerts.checked = settings.usageAlerts;
  elements.showHistory.checked = settings.showHistory;
  elements.autoStart.checked = settings.autoStart;
  elements.versionLabel.textContent = `AI Usage Widget ${state.version ? `v${state.version}` : ''}`;
}

async function saveAndCloseSettings() {
  if (elements.settingsModal.hidden || !state.settings) return;
  const settings = {
    ...state.settings,
    refreshInterval: Number(elements.refreshInterval.value),
    theme: elements.theme.value,
    warnThreshold: Number(elements.warnThreshold.value),
    dangerThreshold: Number(elements.dangerThreshold.value),
    usageAlerts: elements.usageAlerts.checked,
    showHistory: elements.showHistory.checked,
    autoStart: elements.autoStart.checked
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

async function copyDiagnostics() {
  await api.copyDiagnostics();
  showToast('Safe diagnostics copied.');
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || 'dark';
}

function renderHistory() {
  if (!state.settings) return;
  elements.historyPanel.hidden = !state.settings.showHistory;
  if (!state.settings.showHistory) {
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    return;
  }
  const rows = state.history.filter((row) => row.providerId === 'claude');
  const snapshot = state.snapshots.claude;
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
  fitWindow();
  setTimeout(() => {
    elements.migrationBanner.hidden = true;
    fitWindow();
  }, 9000);
}

function showToast(message, error = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('toast-error', error);
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3200);
}
