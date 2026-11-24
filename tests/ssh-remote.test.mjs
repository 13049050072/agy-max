import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  validateSshDestination,
  parseSshTarget,
  parseSshWindowTitle,
  resolveSshWindowConfig,
  resolveRemotePosixPath,
  buildRemoteWorkerCode,
  buildShellBootstrap,
  createRemoteTelemetryBridge
} from '../lib/ssh-remote.mjs';
import { parseSessionData } from '../lib/session-parser.mjs';
import { startNativeIntegration, isHubTarget } from '../lib/native-host.mjs';

const varint = value => {
  const bytes = [];
  let n = BigInt(value);
  do {
    let b = Number(n & 127n);
    n >>= 7n;
    if (n) b |= 128;
    bytes.push(b);
  } while (n);
  return Buffer.from(bytes);
};
const integer = (n, value) => Buffer.concat([varint(n * 8), varint(value)]);
const bytesField = (n, value) => {
  const buf = Buffer.from(value);
  return Buffer.concat([varint(n * 8 + 2), varint(buf.length), buf]);
};
const concat = (...parts) => Buffer.concat(parts);
const duration = seconds => concat(integer(1, seconds));
const timestamp = seconds => concat(integer(1, seconds));

function seedConversationFixture(appDataDir, id, promptText) {
  const logsDir = join(appDataDir, 'brain', id, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(join(appDataDir, 'conversations'), { recursive: true });

  const steps = [
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-22T01:00:00Z', content: `<USER_REQUEST>${promptText}</USER_REQUEST>` },
    { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T01:00:01Z', input_tokens: 400, cache_read_tokens: 1600, output_tokens: 120, content: 'Done inspecting.' }
  ];
  writeFileSync(join(logsDir, 'transcript.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  writeFileSync(join(appDataDir, 'brain', id, 'task.md'), '- [x] Inspect remote telemetry\n- [ ] Verify panel\n', 'utf8');

  const db = new DatabaseSync(join(appDataDir, 'conversations', `${id}.db`));
  try {
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);');
    const context = concat(integer(1, 2000), integer(4, 200000), bytesField(3, bytesField(1, concat(bytesField(1, 'Chat Messages'), integer(4, 2000)))));
    const generation = bytesField(1, concat(
      bytesField(4, concat(integer(2, 400), integer(3, 120), integer(5, 1600))),
      bytesField(9, bytesField(10, context)),
      bytesField(11, duration(1)),
      bytesField(12, duration(3)),
      bytesField(19, 'gemini-4-hydrogen')
    ));
    const genWithSteps = concat(generation, integer(2, 1), bytesField(4, id));
    db.prepare('INSERT INTO gen_metadata(idx, data) VALUES (?, ?)').run(0, genWithSteps);
    const t0 = concat(bytesField(1, timestamp(1795309200)), bytesField(8, timestamp(1795309200)));
    const t1 = concat(bytesField(1, timestamp(1795309201)), bytesField(6, timestamp(1795309202)), bytesField(7, timestamp(1795309205)), bytesField(8, timestamp(1795309205)));
    db.prepare('INSERT INTO steps(idx, step_type, metadata) VALUES (?, ?, ?)').run(0, 1, t0);
    db.prepare('INSERT INTO steps(idx, step_type, metadata) VALUES (?, ?, ?)').run(1, 2, t1);
  } finally {
    db.close();
  }
}

test('validateSshDestination and parseSshWindowTitle accept safe hosts and reject unsafe inputs', () => {
  assert.equal(validateSshDestination('  homelab  '), 'homelab');
  assert.equal(validateSshDestination('alice@203.0.113.10'), 'alice@203.0.113.10');
  assert.equal(validateSshDestination('alice@[::1]:2222'), 'alice@[::1]:2222');
  assert.equal(validateSshDestination('ssh://bob@devbox:2222'), 'ssh://bob@devbox:2222');

  for (const bad of ['', '   ', '-oProxyCommand=calc', 'host name', 'host\nwhoami', 'host;id', 'host`id`', null, undefined]) {
    assert.throws(() => validateSshDestination(bad), /SSH/);
  }

  assert.equal(parseSshWindowTitle('grave-arsenal - Antigravity (SSH: homelab)'), 'homelab');
  assert.equal(parseSshWindowTitle('(2) Title - Antigravity (SSH: homelab)'), 'homelab');
  assert.equal(parseSshWindowTitle('proj - Antigravity [SSH: alice@devbox:2222]'), 'alice@devbox:2222');
  assert.equal(parseSshWindowTitle('Local - Antigravity'), '');
  assert.equal(parseSshWindowTitle('Evil - Antigravity (SSH: -oProxyCommand=calc)'), '');

  assert.equal(isHubTarget({ type: 'page', title: 'Grave Arsenal Development... (SSH: homelab)', url: 'https://127.0.0.1:37743/c/abc' }), true);
  assert.equal(isHubTarget({ type: 'page', title: '(1) Grave Arsenal Develop... (SSH: homelab)', url: 'https://127.0.0.1:37743/c/abc' }), true);
  assert.equal(isHubTarget({ type: 'page', title: 'Long Conversation Title... (WSL: Ubuntu)', url: 'https://127.0.0.1:37743/c/abc' }), true);
  assert.equal(isHubTarget({ type: 'page', title: '先阅读项目根目录的 `README.md`', url: 'https://127.0.0.1:37743/c/3f88b06e-1234-5678-9abc-def012345678' }), true);
  assert.equal(isHubTarget({ type: 'page', title: '(1) 重构远程会话统计模块', url: 'https://127.0.0.1:37743/c/7a4c798f-1234-5678-9abc-def012345678' }), true);
  assert.equal(isHubTarget({ type: 'page', title: 'Antigravity Docs', url: 'https://127.0.0.1:1234/' }), false);
  assert.equal(isHubTarget({ type: 'page', title: 'Local Dev App', url: 'https://127.0.0.1:3000/' }), false);
});

test('resolveSshWindowConfig and resolveRemotePosixPath resolve metadata and POSIX file URIs safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ssh-cfg-'));
  try {
    const customCfgA = join(dir, 'ssh_a.conf');
    const customCfgB = join(dir, 'ssh_b.conf');
    writeFileSync(customCfgA, 'Host homelab\n');
    writeFileSync(customCfgB, 'Host backup\n');
    writeFileSync(join(dir, 'ssh_windows.json'), JSON.stringify({
      version: 1,
      windows: [
        { host: 'homelab', configFile: customCfgA },
        { host: 'missing-cfg', configFile: join(dir, 'does-not-exist.conf') }
      ]
    }));
    writeFileSync(join(dir, 'app_storage.json'), JSON.stringify({
      'ssh.recentConnections': JSON.stringify([
        { host: 'backup', configFile: customCfgB },
        { host: 'evil', configFile: '-oBad' }
      ])
    }));

    assert.deepEqual(resolveSshWindowConfig('homelab', { userDataDir: dir }), { host: 'homelab', configFile: customCfgA });
    assert.deepEqual(resolveSshWindowConfig('backup', { userDataDir: dir }), { host: 'backup', configFile: customCfgB });
    assert.deepEqual(resolveSshWindowConfig('missing-cfg', { userDataDir: dir }), { host: 'missing-cfg', configFile: '' });
    assert.deepEqual(resolveSshWindowConfig('evil', { userDataDir: dir }), { host: 'evil', configFile: '' });

    assert.equal(resolveRemotePosixPath('file:///data/projects/a%20b.gd#L10'), '/data/projects/a b.gd');
    assert.equal(resolveRemotePosixPath('file:///data/project-C#/src/app.cs#L10-L20'), '/data/project-C#/src/app.cs');
    assert.equal(resolveRemotePosixPath('file:///data/project-C#%2Fsrc%2Fapp.cs%23L10-L20'), '/data/project-C#/src/app.cs');
    assert.equal(resolveRemotePosixPath('file:///data/project-C#/README.md#overview'), '/data/project-C#/README.md');
    assert.equal(resolveRemotePosixPath('file://localhost/home/user/test.txt?foo=bar'), '/home/user/test.txt');
    assert.throws(() => resolveRemotePosixPath('file://remote-host/etc/passwd'));
    assert.throws(() => resolveRemotePosixPath('https://example.com/a'));
    assert.throws(() => resolveRemotePosixPath('file:///a%00b'));
    assert.throws(() => resolveRemotePosixPath(''));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createRemoteTelemetryBridge runs in-memory worker over child stdio, tolerates MOTD noise, multiplexes requests, and backs off on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ssh-worker-'));
  const userDataDir = join(dir, 'userdata');
  const appDataDir = join(dir, 'remote-appdata');
  mkdirSync(userDataDir, { recursive: true });
  seedConversationFixture(appDataDir, 'conv-main', 'Analyze homelab performance');
  seedConversationFixture(appDataDir, 'sub-1', 'Subagent inspect');

  const cfgPath = join(userDataDir, 'custom.ssh');
  writeFileSync(cfgPath, 'Host homelab\n');
  writeFileSync(join(userDataDir, 'ssh_windows.json'), JSON.stringify({
    version: 1,
    windows: [{ host: 'homelab', configFile: cfgPath }]
  }));

  const spawnCalls = [];
  const childRefs = [];
  const harnessScript = `
    process.stdout.write("Welcome to Ubuntu 24.04 MOTD\\n");
    let buf = "";
    process.stdin.setEncoding("utf8");
    const onBoot = chunk => {
      buf += chunk;
      const idx = buf.indexOf("\\n");
      if (idx < 0) return;
      process.stdin.removeListener("data", onBoot);
      process.stdin.pause();
      const line = buf.slice(0, idx);
      const m = line.match(/exec "\\$NODE" --no-warnings -e '([^']+)'/);
      if (!m) { console.error("bad bootstrap:", line); process.exit(2); }
      new Function("require", m[1])(require);
    };
    process.stdin.on("data", onBoot);
    process.stdin.resume();
  `;

  const bridge = createRemoteTelemetryBridge({
    userDataDir,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    backoffMs: 60000,
    spawnProcess: (command, args, opts) => {
      spawnCalls.push({ command, args });
      const child = spawn(process.execPath, ['--no-warnings', '-e', harnessScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...opts.env, ANTIGRAVITY_APP_DATA_DIR: appDataDir }
      });
      childRefs.push(child);
      return child;
    }
  });

  try {
    const [remoteState, remoteSubagents, remoteDash, remoteSearch, remoteMd] = await Promise.all([
      bridge.state('homelab', { conversationId: 'conv-main' }),
      bridge.subagents('homelab', { conversationIds: ['sub-1', 'missing-sub'] }),
      bridge.dashboard('homelab', { force: true }),
      bridge.search('homelab', { query: 'homelab', excludeIds: ['sub-1'] }),
      bridge.markdown('homelab', { conversationId: 'conv-main', title: 'Homelab Perf' })
    ]);

    assert.equal(spawnCalls.length, 1);
    const args = spawnCalls[0].args;
    assert.ok(args.includes('-T'));
    assert.ok(args.includes('BatchMode=yes'));
    assert.ok(args.includes('-F'));
    assert.ok(args.includes(cfgPath));
    assert.deepEqual(args.slice(-3), ['homelab', 'sh', '-s']);

    const expected = parseSessionData('conv-main', { includeSessions: false, strict: true, appDataDir });
    assert.deepEqual(remoteState.contextWindow, expected.contextWindow);
    assert.deepEqual(remoteState.telemetry, expected.telemetry);
    assert.deepEqual(remoteState.turns, expected.turns);
    assert.deepEqual(remoteState.requests, expected.requests);
    assert.deepEqual(remoteState.progress, expected.progress);

    assert.equal(remoteSubagents.sessions['sub-1'].conversationId, 'sub-1');
    assert.equal(remoteSubagents.sessions['missing-sub'].conversationId, '');
    assert.equal(remoteDash.totalRequests, 2);
    assert.equal(remoteSearch.results.length, 1);
    assert.equal(remoteSearch.results[0].conversationId, 'conv-main');
    assert.match(remoteMd.markdown, /^# Homelab Perf\n/);
    assert.ok(remoteMd.markdown.includes('Analyze homelab performance'));
  } finally {
    await bridge.close();
  }

  for (const child of childRefs) {
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'worker child should exit cleanly on close()');
  }

  let failSpawns = 0;
  const failingBridge = createRemoteTelemetryBridge({
    userDataDir,
    backoffMs: 60000,
    spawnProcess: () => {
      failSpawns++;
      return spawn(process.execPath, ['-e', 'process.stderr.write("Permission denied\\n"); process.exit(255);'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    }
  });
  try {
    await assert.rejects(() => failingBridge.state('homelab', { conversationId: 'conv-main' }), /Permission denied|exit 255/);
    assert.equal(failSpawns, 1);
    await assert.rejects(() => failingBridge.state('homelab', { conversationId: 'conv-main' }), /Permission denied|exit 255/);
    assert.equal(failSpawns, 1, 'non-forced call within backoff must not spawn another ssh');
    await assert.rejects(() => failingBridge.dashboard('homelab', { force: true }), /Permission denied|exit 255/);
    assert.equal(failSpawns, 2, 'forced call should bypass backoff');
  } finally {
    await failingBridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startNativeIntegration routes SSH windows to remoteTelemetry, isolates discovery cache, and reports per-window health', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-native-ssh-'));
  const portFile = join(dir, 'port');
  writeFileSync(portFile, '12345\n');

  const originalFetch = globalThis.fetch;
  const targets = [
    { id: 'local-1', type: 'page', title: 'Local - Antigravity', url: 'https://127.0.0.1:5001/c/c-local', webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/page/local' },
    { id: 'ssh-1', type: 'page', title: 'Proj - Antigravity (SSH: homelab)', url: 'https://127.0.0.1:5002/c/c-remote', webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/page/ssh' }
  ];
  globalThis.fetch = async () => ({ json: async () => targets });

  const localCalls = [];
  const remoteCalls = [];
  const discoverCalls = [];
  const clientsByEndpoint = new Map();

  let stop;
  try {
    stop = startNativeIntegration({
      portFile,
      onStatus: () => {},
      parseSessionData: (id, opts) => {
        localCalls.push({ id, opts });
        return {
          conversationId: id,
          modelName: 'local-model',
          contextWindow: { usedTokens: 100, maxTokens: 1000, models: [] },
          telemetry: { stepCount: 1, requestCount: 1, totalTokens: 100, inputTokens: 100, cacheReadTokens: 0, outputTokens: 10 },
          turns: [],
          requests: [],
          errors: [],
          progress: { status: 'complete', tasks: [] }
        };
      },
      remoteTelemetry: {
        async state(host, params) {
          remoteCalls.push({ method: 'state', host, params });
          return {
            conversationId: params.conversationId,
            modelName: 'remote-model',
            contextWindow: { usedTokens: 2000, maxTokens: 100000, models: [] },
            telemetry: { stepCount: 3, requestCount: 2, totalTokens: 2000, inputTokens: 500, cacheReadTokens: 1500, outputTokens: 200 },
            turns: [],
            requests: [],
            errors: [],
            progress: { status: 'running', tasks: [] }
          };
        },
        async subagents(host, params) {
          remoteCalls.push({ method: 'subagents', host, params });
          return {
            sessions: {
              'sub-r1': {
                conversationId: 'sub-r1',
                modelName: 'gemini-4-hydrogen',
                contextWindow: { usedTokens: 500, maxTokens: 100000, models: [] },
                telemetry: { stepCount: 2, requestCount: 1, totalTokens: 500, inputTokens: 100, cacheReadTokens: 400, outputTokens: 50 },
                requests: []
              }
            }
          };
        },
        async dashboard(host, params) {
          remoteCalls.push({ method: 'dashboard', host, params });
          return { requests: [{ id: 'r1', model: 'gemini-4-hydrogen', inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, timestampMs: 1 }], totalRequests: 1, errors: [], totalErrors: 0, days: [], updatedAtMs: 1 };
        },
        async close() {
          remoteCalls.push({ method: 'close' });
        }
      },
      discover: async (origin, opts) => {
        discoverCalls.push({ origin, cacheScope: opts.cacheScope, preferFallback: opts.preferFallback });
        return ['sampleNativeName'];
      },
      connect: async endpoint => {
        const isSsh = endpoint.endsWith('/ssh');
        const listeners = new Set();
        const replies = [];
        const client = {
          endpoint,
          listeners,
          replies,
          onEvent(fn) { listeners.add(fn); },
          emit(event) { return Promise.all([...listeners].map(fn => fn(event))); },
          socket: { addEventListener() {}, close() {} },
          async send(method, params = {}) {
            if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
            if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
            if (method === 'Runtime.evaluate') {
              const expr = String(params.expression || '');
              if (expr.includes('compatibilityError')) {
                return {
                  result: {
                    value: {
                      version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
                      healthy: true,
                      mounted: isSsh ? 2 : 1,
                      conversationId: isSsh ? 'c-remote' : 'c-local',
                      compatibilityError: '',
                      clientVersion: '2.34.0'
                    }
                  }
                };
              }
              if (expr.includes('navigator.userAgent')) {
                return {
                  result: {
                    value: {
                      ua: 'Mozilla/5.0 Antigravity/2.34.0',
                      sshKind: isSsh ? 'ssh' : '',
                      sshHost: isSsh ? 'homelab' : '',
                      title: isSsh ? 'Proj - Antigravity (SSH: homelab)' : 'Local - Antigravity'
                    }
                  }
                };
              }
              if (expr.includes('globalThis.__agyPowertoolsReceive')) {
                const match = expr.match(/globalThis\.__agyPowertoolsReceive\?\.\((\d+),([\s\S]+)\)$/);
                if (match) replies.push({ id: Number(match[1]), payload: JSON.parse(match[2]) });
                return { result: { value: true } };
              }
              return { result: { value: false } };
            }
            return {};
          }
        };
        clientsByEndpoint.set(endpoint, client);
        return client;
      }
    });

    await stop.ready;
    assert.equal(discoverCalls.length, 2);
    const localDiscover = discoverCalls.find(d => d.origin === 'https://127.0.0.1:5001');
    const sshDiscover = discoverCalls.find(d => d.origin === 'https://127.0.0.1:5002');
    assert.equal(localDiscover.preferFallback, undefined);
    assert.equal(sshDiscover.cacheScope, 'ssh');
    assert.equal(sshDiscover.preferFallback, true);

    const localClient = clientsByEndpoint.get('ws://127.0.0.1:12345/devtools/page/local');
    const sshClient = clientsByEndpoint.get('ws://127.0.0.1:12345/devtools/page/ssh');
    for (const [c, orig] of [[localClient, 'https://127.0.0.1:5001'], [sshClient, 'https://127.0.0.1:5002']]) {
      await c.emit({ method: 'Runtime.executionContextCreated', params: { context: { id: 10, origin: orig, auxData: { isDefault: true, frameId: 'main-frame' } } } });
    }

    const sendRpc = (client, id, body) => client.emit({
      method: 'Runtime.bindingCalled',
      params: { name: '__agyPowertoolsHost', executionContextId: 10, payload: JSON.stringify({ id, ...body }) }
    });

    await sendRpc(localClient, 1, { method: 'state', conversationId: 'c-local' });
    await sendRpc(sshClient, 2, { method: 'state', conversationId: 'c-remote' });
    await sendRpc(sshClient, 3, { method: 'subagents.stats', conversationIds: ['sub-r1'] });
    await sendRpc(sshClient, 4, { method: 'dashboard', force: true });
    await sendRpc(sshClient, 5, { method: 'file.path', uri: 'file:///data/projects/foo%20bar.gd' });
    await sendRpc(sshClient, 6, { method: 'file.open', uri: 'file:///data/projects/foo.gd' });

    assert.equal(localCalls.length, 1);
    assert.equal(localCalls[0].id, 'c-local');
    assert.equal(localClient.replies.find(r => r.id === 1).payload.modelName, 'local-model');

    assert.equal(sshClient.replies.find(r => r.id === 2).payload.modelName, 'remote-model');
    assert.equal(sshClient.replies.find(r => r.id === 3).payload.items['sub-r1'].shortModel, 'Hydrogen');
    assert.equal(sshClient.replies.find(r => r.id === 4).payload.totalRequests, 1);
    assert.equal(sshClient.replies.find(r => r.id === 5).payload.path, '/data/projects/foo bar.gd');
    assert.match(sshClient.replies.find(r => r.id === 6).payload.error, /SSH/);

    assert.deepEqual(remoteCalls.map(c => c.method), ['state', 'subagents', 'dashboard']);

    const health = await stop.health();
    assert.equal(health.healthy, true);
    assert.equal(health.connected, true);
    assert.deepEqual(health.windows, [
      { sshHost: null, healthy: true, mounted: 1, conversationId: 'c-local' },
      { sshHost: 'homelab', healthy: true, mounted: 2, conversationId: 'c-remote' }
    ]);

    targets[1].title = 'Bare Title On Settings';
    targets[1].url = 'https://127.0.0.1:5002/settings';
    await stop.check();
    const persistedHealth = await stop.health();
    assert.equal(persistedHealth.connected, true);
    assert.deepEqual(persistedHealth.windows, health.windows);
  } finally {
    await stop?.();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSshTarget splits direct host:port and [ipv6]:port targets while preserving aliases and ssh:// URIs', async () => {
  assert.deepEqual(parseSshTarget('root@example.com:11430'), { host: 'root@example.com', port: '11430' });
  assert.deepEqual(parseSshTarget('example.com:11430'), { host: 'example.com', port: '11430' });
  assert.deepEqual(parseSshTarget('alice@203.0.113.10:2222'), { host: 'alice@203.0.113.10', port: '2222' });
  assert.deepEqual(parseSshTarget('alice@[::1]:2222'), { host: 'alice@::1', port: '2222' });
  assert.deepEqual(parseSshTarget('[::1]:2222'), { host: '::1', port: '2222' });
  assert.deepEqual(parseSshTarget('[2001:db8::1%eth0]:2222'), { host: '2001:db8::1%eth0', port: '2222' });
  assert.deepEqual(parseSshTarget('alice@[::1]'), { host: 'alice@::1', port: '' });
  assert.deepEqual(parseSshTarget('my-server'), { host: 'my-server', port: '' });
  assert.deepEqual(parseSshTarget('alice@203.0.113.10'), { host: 'alice@203.0.113.10', port: '' });
  assert.deepEqual(parseSshTarget('ssh://bob@devbox:2222'), { host: 'ssh://bob@devbox:2222', port: '' });
  assert.deepEqual(parseSshTarget('ssh://[::1]:2222'), { host: 'ssh://[::1]:2222', port: '' });
  assert.deepEqual(parseSshTarget('::1'), { host: '::1', port: '' });
  assert.throws(() => parseSshTarget('-oProxyCommand=calc'), /SSH/);

  const dir = mkdtempSync(join(tmpdir(), 'agy-ssh-port-'));
  const spawnCalls = [];
  const bridge = createRemoteTelemetryBridge({
    userDataDir: dir,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    spawnProcess: (command, args) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      child.stdin = new EventEmitter();
      child.stdin.write = chunk => {
        const text = String(chunk);
        if (text.includes('exec "$NODE"')) {
          queueMicrotask(() => child.stdout.emit('data', '__AGY_PT__:{"type":"ready","node":"22.0.0","pid":1}\n'));
        } else {
          for (const line of text.split('\n').filter(Boolean)) {
            const req = JSON.parse(line);
            queueMicrotask(() => child.stdout.emit('data', `__AGY_PT__:${JSON.stringify({ type: 'res', id: req.id, result: { ok: true } })}\n`));
          }
        }
      };
      child.stdin.end = () => {
        child.exitCode = 0;
        child.emit('exit', 0);
        child.emit('close', 0);
      };
      child.kill = () => {
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
        child.emit('close', null, 'SIGTERM');
      };
      return child;
    }
  });

  try {
    await bridge.state('root@example.com:11430', { conversationId: 'c1' });
    await bridge.state('alice@[::1]:2222', { conversationId: 'c1' });
    await bridge.state('ssh://bob@devbox:2222', { conversationId: 'c1' });
    await bridge.state('my-server', { conversationId: 'c1' });

    assert.equal(spawnCalls.length, 4);
    assert.deepEqual(spawnCalls[0].args.slice(-6), ['-p', '11430', '--', 'root@example.com', 'sh', '-s']);
    assert.deepEqual(spawnCalls[1].args.slice(-6), ['-p', '2222', '--', 'alice@::1', 'sh', '-s']);
    assert.equal(spawnCalls[2].args.includes('-p'), false);
    assert.deepEqual(spawnCalls[2].args.slice(-4), ['--', 'ssh://bob@devbox:2222', 'sh', '-s']);
    assert.equal(spawnCalls[3].args.includes('-p'), false);
    assert.deepEqual(spawnCalls[3].args.slice(-4), ['--', 'my-server', 'sh', '-s']);
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildShellBootstrap prefers agy-node and selects highest node:zlib-capable semver instead of lexicographical glob order', async () => {
  const bootstrap = buildShellBootstrap();
  assert.equal(bootstrap.endsWith('\n'), true);
  assert.equal(bootstrap.trimEnd().includes('\n'), false, 'bootstrap must remain single-line for sh -s');
  assert.match(bootstrap, /agy-node/);
  assert.match(bootstrap, /require\("node:zlib"\)/);
  assert.match(bootstrap, /exec "\$NODE" --no-warnings -e '/);

  if (process.platform === 'win32' || !existsSync('/bin/sh')) return;

  const makeFakeNode = (filePath, { version, supportsZlib = true, tag }) => {
    mkdirSync(join(filePath, '..'), { recursive: true });
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "-e" ]; then',
      supportsZlib
        ? `  printf '%s' "$(( ${version[0]} * 1000000 + ${version[1]} * 1000 + ${version[2]} ))"; exit 0`
        : '  exit 1',
      'fi',
      `printf 'SELECTED:%s\\n' '${tag}'`,
      'exit 0'
    ].join('\n') + '\n';
    writeFileSync(filePath, script, 'utf8');
    chmodSync(filePath, 0o755);
  };

  const runBootstrap = homeDir => new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: homeDir, PATH: '/usr/bin:/bin' }
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(bootstrap);
  });

  const dir = mkdtempSync(join(tmpdir(), 'agy-ssh-boot-'));
  try {
    // 1. Lexicographically 'v9.11.2' > 'v8.17.0' > 'v22...' and 'v99.2.0' > 'v99.14.0';
    //    must reject broken v8 (no node:zlib) and pick highest numeric semver v99.14.0.
    const home1 = join(dir, 'home-nvm');
    makeFakeNode(join(home1, '.nvm/versions/node/v8.17.0/bin/node'), { version: [8, 17, 0], supportsZlib: false, tag: 'v8' });
    makeFakeNode(join(home1, '.nvm/versions/node/v9.11.2/bin/node'), { version: [9, 11, 2], supportsZlib: true, tag: 'v9' });
    makeFakeNode(join(home1, '.nvm/versions/node/v99.2.0/bin/node'), { version: [99, 2, 0], supportsZlib: true, tag: 'v99.2' });
    makeFakeNode(join(home1, '.nvm/versions/node/v99.14.0/bin/node'), { version: [99, 14, 0], supportsZlib: true, tag: 'v99.14' });
    const res1 = await runBootstrap(home1);
    assert.equal(res1.code, 0, res1.err);
    assert.equal(res1.out.trim(), 'SELECTED:v99.14');

    // 2. Working agy-node must be preferred over nvm candidates.
    const home2 = join(dir, 'home-agy');
    makeFakeNode(join(home2, '.gemini/antigravity/bin/agy-node'), { version: [22, 0, 0], supportsZlib: true, tag: 'agy-node' });
    makeFakeNode(join(home2, '.nvm/versions/node/v99.14.0/bin/node'), { version: [99, 14, 0], supportsZlib: true, tag: 'v99.14' });
    const res2 = await runBootstrap(home2);
    assert.equal(res2.code, 0, res2.err);
    assert.equal(res2.out.trim(), 'SELECTED:agy-node');

    // 3. Broken agy-node (no node:zlib) must fall back to highest working nvm candidate.
    const home3 = join(dir, 'home-agy-broken');
    makeFakeNode(join(home3, '.gemini/antigravity/bin/agy-node'), { version: [12, 0, 0], supportsZlib: false, tag: 'agy-broken' });
    makeFakeNode(join(home3, '.nvm/versions/node/v99.14.0/bin/node'), { version: [99, 14, 0], supportsZlib: true, tag: 'v99.14' });
    const res3 = await runBootstrap(home3);
    assert.equal(res3.code, 0, res3.err);
    assert.equal(res3.out.trim(), 'SELECTED:v99.14');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
