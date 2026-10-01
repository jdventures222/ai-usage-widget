'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('renderer remains sandboxed with no network or credential IPC', () => {
  const main = read('main.js');
  const preload = read('preload.js');
  const html = read('src/renderer/index.html');
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /untrusted_ipc_sender/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setPermissionCheckHandler/);
  assert.match(main, /registerDashboardScheme\(protocol\)/);
  assert.match(main, /registerDashboardHandler\(protocol, __dirname\)/);
  assert.match(main, /mainWindow\.loadURL\(DASHBOARD_URL\)/);
  assert.doesNotMatch(main, /mainWindow\.loadFile\(/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(preload, /sessionKey|credential|auth\.json|cookie/i);
  assert.doesNotMatch(preload, /ipcRenderer\.send\([^)]*settings/);
});

test('Claude Code credentials are never read by application source', () => {
  const sourceFiles = [
    'main.js',
    'preload.js',
    'src/main/claude-provider.js',
    'src/main/provider-manager.js',
    'src/main/safari-cookies.js'
  ];
  const source = sourceFiles.map(read).join('\n');
  assert.doesNotMatch(source, /\.credentials\.json|Claude Code-credentials|ANTHROPIC_API_KEY/);
});

test('product policy excludes disallowed usage labels from the renderer', () => {
  const renderer = read('src/renderer/app.js').toLowerCase();
  for (const forbidden of ['gpt reserve', 'codex spark', 'prepaid balance', 'extra usage']) {
    assert.equal(renderer.includes(forbidden), false);
  }
});

test('usage lives in the menu bar with a panel that hides when it loses focus', () => {
  const main = read('main.js');
  assert.match(main, /resizable:\s*false/);
  assert.match(main, /movable:\s*false/);
  assert.match(main, /show:\s*false/);
  assert.match(main, /mainWindow\.on\('blur'/);
  assert.match(main, /tray\.setTitle\(/);
  assert.match(main, /tray\.on\('click', togglePopover\)/);
  assert.doesNotMatch(main, /windowBoundsV2|window:set-mode|setOpacity/);
  assert.doesNotMatch(read('src/renderer/styles.css'), /-webkit-app-region:\s*drag/);
});
