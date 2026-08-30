'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { readCodexRateLimits } = require('../src/main/codex-client');

function fakeChild(onMessage) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedWith = [];
  let input = '';
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      while (input.includes('\n')) {
        const index = input.indexOf('\n');
        const line = input.slice(0, index);
        input = input.slice(index + 1);
        if (line) onMessage(JSON.parse(line), child);
      }
      callback();
    }
  });
  child.kill = (signal) => {
    child.killedWith.push(signal);
    queueMicrotask(() => child.emit('close', 0));
    return true;
  };
  return child;
}

test('Codex client completes fragmented JSON-RPC and reaps its child', async () => {
  let child;
  let spawnArguments;
  child = fakeChild((message, target) => {
    if (message.id === 1) {
      target.stdout.write('{"jsonrpc":"2.0",');
      target.stdout.write('"id":1,"result":{}}\n');
    }
    if (message.id === 2) {
      target.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { rateLimits: { secondary: { usedPercent: 6, windowDurationMins: 10080 } } }
      })}\n`);
    }
  });
  const result = await readCodexRateLimits({
    executable: process.execPath,
    timeoutMs: 1000,
    spawnImpl: (...args) => {
      spawnArguments = args;
      return child;
    }
  });
  assert.equal(result.rateLimits.secondary.usedPercent, 6);
  assert.deepEqual(spawnArguments[1], ['app-server', '--stdio']);
  assert.equal(spawnArguments[2].shell, false);
  assert.ok(child.killedWith.includes('SIGTERM'));
});

test('Codex client enforces a deadline and kills an unresponsive child', async () => {
  const child = fakeChild(() => {});
  await assert.rejects(
    readCodexRateLimits({
      executable: process.execPath,
      timeoutMs: 25,
      spawnImpl: () => child
    }),
    (error) => error.code === 'timeout'
  );
  assert.ok(child.killedWith.includes('SIGTERM'));
});
