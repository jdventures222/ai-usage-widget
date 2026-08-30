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
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(preload, /sessionKey|credential|auth\.json|cookie/i);
  assert.doesNotMatch(preload, /ipcRenderer\.send\([^)]*settings/);
});

test('Codex authentication files are never read by application source', () => {
  const sourceFiles = [
    'main.js',
    'preload.js',
    'src/main/codex-client.js',
    'src/main/codex-provider.js',
    'src/main/provider-manager.js'
  ];
  const source = sourceFiles.map(read).join('\n');
  assert.doesNotMatch(source, /auth\.json|\.codex[\\/]auth|OPENAI_API_KEY/);
  assert.match(read('src/main/codex-client.js'), /shell:\s*false/);
});

test('product policy excludes disallowed usage labels from the renderer', () => {
  const renderer = read('src/renderer/app.js').toLowerCase();
  for (const forbidden of ['gpt reserve', 'codex spark', 'prepaid balance', 'extra usage']) {
    assert.equal(renderer.includes(forbidden), false);
  }
});

test('HUD uses supported native movement and resizing with separate saved bounds', () => {
  const main = read('main.js');
  const styles = read('src/renderer/styles.css');
  assert.match(main, /resizable:\s*true/);
  assert.match(main, /movable:\s*true/);
  assert.match(main, /transparent:\s*false/);
  assert.match(main, /windowBoundsV2\.\$\{mode\}/);
  assert.match(main, /visibleHeight = Math\.min\(32, height\)/);
  assert.match(main, /showInactive\(\);\s*mainWindow\.setBounds\(initial, false\)/);
  assert.doesNotMatch(main, /ipcMain\.on\('window:resize'/);
  assert.match(styles, /-webkit-app-region:\s*drag/);
});
