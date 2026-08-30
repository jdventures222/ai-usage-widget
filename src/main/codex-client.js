'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_STDOUT_BUFFER = 1024 * 1024;
const MAX_STDERR_BUFFER = 16 * 1024;

class CodexClientError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CodexClientError';
    this.code = code;
  }
}

function isExecutable(candidate, fsImpl = fs) {
  if (!candidate || !path.isAbsolute(candidate)) return false;
  try {
    const stat = fsImpl.statSync(candidate);
    if (!stat.isFile()) return false;
    fsImpl.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(platform) {
  return platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
}

function discoverCodexExecutable(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  const homeDirectory = options.homeDirectory || os.homedir();
  const environment = options.environment || process.env;
  const candidates = [];

  if (options.configuredPath) candidates.push(options.configuredPath);

  const pathEntries = String(environment.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of executableNames(platform)) candidates.push(path.join(entry, name));
  }

  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA;
    const appData = environment.APPDATA;
    if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'codex', 'codex.exe'));
    if (appData) candidates.push(path.join(appData, 'npm', 'codex.cmd'));
  } else {
    candidates.push(
      path.join(homeDirectory, '.local', 'bin', 'codex'),
      path.join(homeDirectory, '.local', 'share', 'mise', 'shims', 'codex'),
      path.join(homeDirectory, 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      '/usr/bin/codex'
    );
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (!isExecutable(candidate, fsImpl)) continue;
    try {
      return fsImpl.realpathSync(candidate);
    } catch {
      return candidate;
    }
  }
  return null;
}

function boundedAppend(current, chunk, limit) {
  if (current.length >= limit) return current;
  return (current + chunk).slice(0, limit);
}

function readCodexRateLimits(options) {
  const executable = options?.executable;
  if (!isExecutable(executable, options?.fsImpl || fs)) {
    return Promise.reject(new CodexClientError('cli_missing'));
  }
  const spawnImpl = options.spawnImpl || childProcess.spawn;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const clientInfo = {
    name: 'ai-usage-widget',
    title: 'AI Usage Widget',
    version: String(options.clientVersion || '2.0.0')
  };

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, ['app-server', '--stdio'], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' }
      });
    } catch {
      reject(new CodexClientError('spawn_failed'));
      return;
    }

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let outcome = null;
    let finalized = false;
    let handshakeTimer = null;
    let forceKillTimer = null;
    let finalizeTimer = null;

    const finalize = () => {
      if (finalized || !outcome) return;
      finalized = true;
      clearTimeout(deadlineTimer);
      clearTimeout(handshakeTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(finalizeTimer);
      if (outcome.error) reject(outcome.error);
      else resolve(outcome.result);
    };

    const stopChild = () => {
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 250);
      forceKillTimer.unref?.();
      finalizeTimer = setTimeout(finalize, 700);
    };

    const conclude = (error, result) => {
      if (outcome) return;
      outcome = { error, result };
      stopChild();
    };

    const send = (message) => {
      if (!child.stdin || child.stdin.destroyed) {
        conclude(new CodexClientError('process_closed'));
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        conclude(new CodexClientError('write_failed'));
      }
    };

    const handleMessage = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.id === 1) {
        if (message.error) {
          conclude(new CodexClientError('initialize_failed'));
          return;
        }
        send({ jsonrpc: '2.0', method: 'initialized' });
        handshakeTimer = setTimeout(() => {
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'account/rateLimits/read',
            params: {}
          });
        }, 250);
        return;
      }
      if (message.id !== 2) return;
      if (message.error) {
        const code = message.error.code === -32601 ? 'unsupported_version' : 'rpc_failed';
        conclude(new CodexClientError(code));
        return;
      }
      if (!message.result || typeof message.result !== 'object') {
        conclude(new CodexClientError('invalid_response'));
        return;
      }
      conclude(null, message.result);
    };

    const consumeLines = () => {
      while (stdoutBuffer.includes('\n')) {
        const newline = stdoutBuffer.indexOf('\n');
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          // App-server may write non-protocol diagnostics. Ignore individual lines,
          // while the global buffer limit and deadline still bound the call.
        }
      }
    };

    const deadlineTimer = setTimeout(() => {
      conclude(new CodexClientError('timeout'));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_STDOUT_BUFFER) {
        conclude(new CodexClientError('response_too_large'));
        return;
      }
      consumeLines();
    });
    child.stderr.on('data', (chunk) => {
      stderrBuffer = boundedAppend(stderrBuffer, chunk, MAX_STDERR_BUFFER);
    });
    child.on('error', () => conclude(new CodexClientError('spawn_failed')));
    child.on('close', (code) => {
      if (!outcome) {
        const errorCode = code === 0 ? 'empty_response' : 'process_failed';
        conclude(new CodexClientError(errorCode));
      }
      finalize();
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo, capabilities: null }
    });
  });
}

function readCodexVersion(executable, options = {}) {
  if (!isExecutable(executable, options.fsImpl || fs)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const execFileImpl = options.execFileImpl || childProcess.execFile;
    execFileImpl(
      executable,
      ['--version'],
      { timeout: options.timeoutMs || 3000, maxBuffer: 4096, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const value = String(stdout || '').replace(/[\r\n]+/g, ' ').trim();
        resolve(value.slice(0, 80) || null);
      }
    );
  });
}

module.exports = {
  CodexClientError,
  DEFAULT_TIMEOUT_MS,
  discoverCodexExecutable,
  isExecutable,
  readCodexRateLimits,
  readCodexVersion
};
