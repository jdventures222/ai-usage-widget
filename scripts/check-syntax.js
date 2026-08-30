'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const roots = ['main.js', 'preload.js', 'src', 'scripts', 'test'];
const files = [];

function collect(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath).sort()) {
      collect(path.join(relativePath, entry));
    }
    return;
  }
  if (relativePath.endsWith('.js') && relativePath !== 'scripts/check-syntax.js') {
    files.push(relativePath);
  }
}

for (const target of roots) collect(target);

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], {
    cwd: root,
    stdio: 'inherit'
  });
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
