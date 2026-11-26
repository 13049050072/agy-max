import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {startNativeIntegration,declaredNativeNames,ensureLoopbackNoProxyEnv,isSwarmTarget,nativeSource,swarmI18nSource} from '../lib/native-host.mjs';

test('same window reattaches after an updater changes the origin or debug endpoint',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'agy-recovery-')),portFile=join(directory,'port');
  writeFileSync(portFile,'12345\n');
  const originalFetch=globalThis.fetch,clients=[],origins=[];
  let target={id:'same-window',type:'page',title:'Conversation - Antigravity',url:'https://127.0.0.1:5000/c/a',webSocketDebuggerUrl:'ws://127.0.0.1:12345/devtools/page/a'};
  globalThis.fetch=async()=>({json:async()=>[target]});
  let stop;
  try{
    stop=startNativeIntegration({portFile,parseSessionData:()=>({}),onStatus:()=>{},discover:async origin=>{origins.push(origin);return ['sampleNativeName'];},connect:async endpoint=>{
      const client={endpoint,closed:false,calls:[],onEvent(){},socket:{addEventListener(){},close(){client.closed=true;}},async send(method,params){this.calls.push({method,params});if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame'}}};if(method==='Page.addScriptToEvaluateOnNewDocument')return{identifier:'script'};return{result:{value:false}};}};
      clients.push(client);return client;
    }});
    await stop.ready;
    assert.equal(clients.length,1);
    target={...target,url:'https://127.0.0.1:6000/c/a'};
    await stop.check();
    assert.equal(clients.length,2);assert.equal(clients[0].closed,true);
    assert.deepEqual(origins,['https://127.0.0.1:5000','https://127.0.0.1:6000']);
    target={...target,webSocketDebuggerUrl:'ws://127.0.0.1:12345/devtools/page/b'};
    await stop.check();
    assert.equal(clients.length,3);assert.equal(clients[1].closed,true);
    for(const client of clients)assert.ok(client.calls.some(c=>c.method==='Page.addScriptToEvaluateOnNewDocument'));
  }finally{await stop?.();globalThis.fetch=originalFetch;rmSync(directory,{recursive:true,force:true});}
});

test('component discovery includes lexical declarations without executing bundle text',()=>{
  const source='var Alpha=1;const Beta=2,Gamma=3;let Delta=4;globalThis.sideEffect();';
  assert.deepEqual(declaredNativeNames(source),['Alpha','Beta','Gamma','Delta']);
});

test('onMissingDebugPort triggers on missing/refused port before connection, ignores transient timeouts, and stops after debug port is ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-port-guard-'));
  const missingFile = join(dir, 'missing-port');
  const activeFile = join(dir, 'active-port');
  writeFileSync(activeFile, '12345\n');
  const originalFetch = globalThis.fetch;

  let stopMissing, stopTimeout, stopReady;
  try {
    let missingCalls = 0;
    stopMissing = startNativeIntegration({
      portFile: missingFile,
      parseSessionData: () => ({}),
      onStatus: () => {},
      onMissingDebugPort: () => { missingCalls++; }
    });
    await stopMissing.ready;
    assert.equal(missingCalls, 1, 'missing DevToolsActivePort file should notify onMissingDebugPort');

    globalThis.fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    };
    let refusedCalls = 0;
    const stopRefused = startNativeIntegration({
      portFile: activeFile,
      parseSessionData: () => ({}),
      onStatus: () => {},
      onMissingDebugPort: () => { refusedCalls++; }
    });
    try {
      await stopRefused.ready;
      assert.equal(refusedCalls, 1, 'ECONNREFUSED before first connection should notify onMissingDebugPort');
    } finally {
      await stopRefused();
    }

    let fetchMode = 'timeout';
    globalThis.fetch = async () => {
      if (fetchMode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (fetchMode === 'abort') throw Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
      if (fetchMode === 'refused') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return { json: async () => [] };
    };
    let timeoutMissingCalls = 0;
    stopTimeout = startNativeIntegration({
      portFile: activeFile,
      parseSessionData: () => ({}),
      onStatus: () => {},
      onMissingDebugPort: () => { timeoutMissingCalls++; }
    });
    await stopTimeout.ready;
    fetchMode = 'abort';
    await stopTimeout.check();
    assert.equal(timeoutMissingCalls, 0, 'transient timeouts before connection must not trigger onMissingDebugPort');

    let readyCalls = 0, postReadyMissingCalls = 0;
    fetchMode = 'ok';
    stopReady = startNativeIntegration({
      portFile: activeFile,
      parseSessionData: () => ({}),
      onStatus: () => {},
      onDebugPortReady: () => { readyCalls++; },
      onMissingDebugPort: () => { postReadyMissingCalls++; }
    });
    await stopReady.ready;
    assert.equal(readyCalls, 1, 'successful /json/list poll should invoke onDebugPortReady');

    fetchMode = 'timeout';
    await stopReady.check();
    fetchMode = 'refused';
    await stopReady.check();
    assert.equal(postReadyMissingCalls, 0, 'subsequent timeout or ECONNREFUSED after debug port reached must not trigger onMissingDebugPort');
  } finally {
    await stopMissing?.();
    await stopTimeout?.();
    await stopReady?.();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSwarmTarget and startNativeIntegration localize Swarm plugin iframes and dispose cleanly', async () => {
  assert.equal(isSwarmTarget({ type: 'iframe', url: 'plugin://swarm--swarm_board-123/index.html' }), true);
  assert.equal(isSwarmTarget({ type: 'page', url: 'plugin://swarm--swarm_board-123/index.html' }), false);
  assert.equal(isSwarmTarget({ type: 'iframe', url: 'https://127.0.0.1:5000/c/a' }), false);
  const src = swarmI18nSource({ enabled: true, language: 'zh-TW' });
  assert.doesNotThrow(() => new Function(src));
  assert.ok(src.includes('"language":"zh-TW"'));

  const dir = mkdtempSync(join(tmpdir(), 'agy-swarm-i18n-'));
  const portFile = join(dir, 'port');
  writeFileSync(portFile, '12345\n');
  const originalFetch = globalThis.fetch;
  const swarmClientCalls = [];
  let swarmClosed = false;
  globalThis.fetch = async () => ({
    json: async () => [
      { id: 'swarm-1', type: 'iframe', title: 'Swarm', url: 'plugin://swarm--swarm_board-abc/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/page/swarm-1' }
    ]
  });
  let stop;
  try {
    stop = startNativeIntegration({
      portFile,
      parseSessionData: () => ({}),
      onStatus: () => {},
      connect: async () => ({
        onEvent() {},
        socket: { addEventListener() {}, close() { swarmClosed = true; } },
        async send(method, params) {
          swarmClientCalls.push({ method, params });
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'swarm-script-1' };
          return { result: { value: { ready: true, lang: 'zh-CN' } } };
        }
      })
    });
    await stop.ready;
    assert.ok(swarmClientCalls.some(c => c.method === 'Runtime.evaluate' && String(c.params?.expression || '').includes('__agyLocalization')));
    await stop();
    assert.equal(swarmClosed, true);
    assert.ok(swarmClientCalls.some(c => c.method === 'Runtime.evaluate' && c.params?.expression === 'globalThis.__agyLocalization?.dispose()'));
    assert.ok(swarmClientCalls.some(c => c.method === 'Page.removeScriptToEvaluateOnNewDocument' && c.params?.identifier === 'swarm-script-1'));
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native-host unpacks isolated RPC envelopes without id/method collision and replies to integer rpcId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-rpc-envelope-'));
  const portFile = join(dir, 'port');
  writeFileSync(portFile, '12345\n');
  const originalFetch = globalThis.fetch;
  const listeners = new Set();
  const replies = [];
  const parseCalls = [];
  globalThis.fetch = async () => ({
    json: async () => [
      { id: 'win-1', type: 'page', title: 'Local - Antigravity', url: 'https://127.0.0.1:5005/c/a', webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/page/win-1' }
    ]
  });
  let stop;
  try {
    stop = startNativeIntegration({
      portFile,
      parseSessionData: id => { parseCalls.push(id); return { conversationId: id, requests: [], turns: [] }; },
      onStatus: () => {},
      discover: async () => [],
      connect: async () => ({
        onEvent: fn => listeners.add(fn),
        socket: { addEventListener() {}, close() {} },
        async send(method, params) {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
          if (method === 'Runtime.evaluate') {
            const expr = String(params?.expression || '');
            if (expr.includes('navigator.userAgent')) {
              return { result: { value: { ua: 'Mozilla/5.0 Antigravity/2.35.0', isHub: true, sshKind: '', sshHost: '', title: 'Local - Antigravity' } } };
            }
            const match = expr.match(/globalThis\.__agyPowertoolsReceive\?\.\((\d+),([\s\S]+)\)$/);
            if (match) replies.push({ rpcId: Number(match[1]), reply: JSON.parse(match[2]) });
            return { result: { value: true } };
          }
          return {};
        }
      })
    });
    await stop.ready;
    const emit = async evt => { for (const fn of listeners) await fn(evt); };
    await emit({
      method: 'Runtime.executionContextCreated',
      params: { context: { id: 7, origin: 'https://127.0.0.1:5005', auxData: { isDefault: true, frameId: 'main-frame' } } }
    });

    // Isolated envelope with payload.id and payload.method must NOT overwrite integer rpcId or rpcMethod
    await emit({
      method: 'Runtime.bindingCalled',
      params: {
        name: '__agyPowertoolsHost',
        executionContextId: 7,
        payload: JSON.stringify({
          id: 41,
          method: 'state',
          payload: { id: 'prof_collision', method: 'FAKE', conversationId: 'conv-isolated' }
        })
      }
    });
    assert.deepEqual(parseCalls, ['conv-isolated']);
    const r41 = replies.find(r => r.rpcId === 41);
    assert.ok(r41);
    assert.equal(r41.reply.conversationId, 'conv-isolated');

    // Domain id like thought.profiles.delete({ id: 'prof_abc' }) must still receive a response on integer rpcId (not silently dropped)
    await emit({
      method: 'Runtime.bindingCalled',
      params: {
        name: '__agyPowertoolsHost',
        executionContextId: 7,
        payload: JSON.stringify({
          id: 42,
          method: 'thought.profiles.delete',
          payload: { id: 'prof_abc' }
        })
      }
    });
    const r42 = replies.find(r => r.rpcId === 42);
    assert.ok(r42);
    assert.equal(typeof r42.reply.error, 'string');

    // Backwards compatibility: flat envelope still works
    await emit({
      method: 'Runtime.bindingCalled',
      params: {
        name: '__agyPowertoolsHost',
        executionContextId: 7,
        payload: JSON.stringify({ id: 43, method: 'settings.get' })
      }
    });
    const r43 = replies.find(r => r.rpcId === 43);
    assert.ok(r43);
    assert.equal(typeof r43.reply.enabled, 'boolean');
  } finally {
    await stop?.();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NO_PROXY retains existing bypasses and adds both IPv6 spellings', () => {
  const env = { no_proxy: 'example.test, LOCALHOST, [::1]' };
  ensureLoopbackNoProxyEnv(env);
  assert.equal(env.NO_PROXY, 'example.test,LOCALHOST,[::1],127.0.0.1,::1');
  ensureLoopbackNoProxyEnv(env);
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(env.no_proxy.split(',').length, 5);
});

test('native boot gives up after 150 retries and exposes missing bindings for another attempt', () => {
  const origin = 'https://127.0.0.1:5000';
  const callbacks = [], errors = [];
  const window = {};
  window.top = window;
  const context = vm.createContext({
    window, location: { origin }, document: { head: {}, body: {}, getElementById: () => null },
    setTimeout(fn, ms) { assert.equal(ms, 100); callbacks.push(fn); },
    console: { error: value => errors.push(value) }
  });
  const script = new vm.Script(nativeSource(origin));
  script.runInContext(context);
  assert.equal(context.__agyNativeBootPending, true);
  for (let i = 0; i < 150; i++) callbacks.shift()();
  assert.equal(callbacks.length, 0);
  assert.equal(context.__agyNativeBootPending, undefined);
  assert.match(context.__agyCompatibilityError, /ReactDOM\.createRoot, createFileRoute, DOM #root/);
  assert.deepEqual(errors, [context.__agyCompatibilityError]);
  script.runInContext(context);
  assert.equal(context.__agyNativeBootPending, true);
  assert.equal(callbacks.length, 1);
});

test('native build hash includes helpers and bindings while ignoring window data', () => {
  const origin = 'https://127.0.0.1:5000';
  const hash = (...args) => nativeSource(...args).match(/__agyNativeBuildHash="([0-9a-f]+)"/)[1];
  const initial = hash(origin);
  const originalRead = fs.readFileSync;
  let changedFile;
  try {
    fs.readFileSync = (file, ...args) => {
      const data = originalRead(file, ...args);
      return String(file).endsWith(changedFile) ? data + '\n// changed fixture' : data;
    };
    syncBuiltinESMExports();
    for (changedFile of ['native-bindings.js', 'zh-tw.mjs', 'prism-workbench.js']) {
      assert.notEqual(hash(origin), initial, changedFile);
    }
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  assert.equal(hash('https://localhost:6000', ['NewNativeName'], { priorityState: { open: true } }), initial);
});

test('mounts a healthy window while another initializes, closes failed sockets, and retains partial diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cdp-windows-'));
  const portFile = join(dir, 'port');
  writeFileSync(portFile, '12345\n');
  const originalFetch = globalThis.fetch;
  let targets = ['slow', 'fast'].map(id => ({
    id, type: 'page', title: 'Antigravity', url: 'https://127.0.0.1:5000/c/a',
    webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/page/' + id
  }));
  globalThis.fetch = async () => ({ json: async () => targets });
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const slow = Promise.withResolvers();
  const fast = Promise.withResolvers();
  let fastMounted = false, closed = 0, stop, timeout;
  try {
    stop = startNativeIntegration({
      portFile, onStatus() {}, discover: async () => [], wsl: false,
      connect: async endpoint => ({
        onEvent() {},
        socket: { addEventListener() {}, close() { if (endpoint.endsWith('/slow')) closed++; } },
        async send(method, params) {
          if (endpoint.endsWith('/slow')) {
            assert.equal(method, 'Page.getFrameTree');
            await slow.promise;
            throw new Error('Page.getFrameTree failed');
          }
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'new-document' };
          if (params?.expression?.startsWith('if(location.origin')) {
            fastMounted = true;
            fast.resolve();
          }
          return { result: { value: { version, healthy: true, mounted: 1 } } };
        }
      })
    });
    await Promise.race([fast.promise, new Promise(resolve => { timeout = setTimeout(resolve, 1000); })]);
    assert.ok(fastMounted, 'fast window must finish while the first window is blocked');
    slow.resolve();
    await stop.ready;
    assert.equal(closed, 1);
    const status = await stop.health();
    assert.equal(status.healthy, true);
    assert.equal(status.portReachable, true);
    assert.equal(status.matchedTargets, 2);
    assert.equal(status.mountedCount, 1);
    assert.equal(status.failedCount, 1);
    assert.equal(status.firstError, 'Page.getFrameTree failed');

    targets = [];
    await stop.check();
    const waiting = await stop.health();
    assert.equal(waiting.portReachable, true);
    assert.equal(waiting.matchedTargets, 0);
    assert.equal(waiting.failedCount, 0);
    assert.equal(waiting.firstError, '');
  } finally {
    clearTimeout(timeout);
    slow.resolve();
    await stop?.ready;
    await stop?.();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CDP discovery and real WebSocket upgrades bypass NODE_USE_ENV_PROXY and HTTP_PROXY', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cdp-proxy-'));
  const portFile = join(dir, 'DevToolsActivePort');
  let cdpHits = 0, upgradeHits = 0, trapProxyHits = 0;
  const upgradedSockets = new Set();
  const cdpServer = createServer((req, res) => {
    if (req.url === '/json/list') {
      cdpHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  cdpServer.on('upgrade', (req, socket) => {
    upgradeHits++;
    assert.equal(req.url, '/devtools/page/test');
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.once('data', () => socket.end(Buffer.from([0x88, 0])));
  });
  const proxyServer = createServer();
  proxyServer.on('connection', socket => {
    trapProxyHits++;
    socket.destroy();
  });
  try {
    await new Promise(r => cdpServer.listen(0, '127.0.0.1', r));
    await new Promise(r => proxyServer.listen(0, '127.0.0.1', r));
    writeFileSync(portFile, `${cdpServer.address().port}\n/devtools/browser/test\n`, 'utf8');
    const modUrl = pathToFileURL(resolve('lib/native-host.mjs')).href;
    const script = `import { connectCdp, startNativeIntegration } from ${JSON.stringify(modUrl)};
      let ready = false;
      const stop = startNativeIntegration({
        portFile: ${JSON.stringify(portFile)},
        parseSessionData: () => ({}),
        onStatus: () => {},
        onDebugPortReady: () => { ready = true; }
      });
      await stop.ready;
      await stop();
      if (!ready) throw new Error('debug port not reached');
      process.env.NO_PROXY = process.env.no_proxy = '';
      const cdp = await connectCdp('ws://127.0.0.1:${cdpServer.address().port}/devtools/page/test');
      cdp.socket.close();
      await new Promise(resolve => cdp.socket.addEventListener('close', resolve, { once: true }));`;
    await new Promise((resolveDone, reject) => {
      const env = {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: `http://127.0.0.1:${proxyServer.address().port}`,
        http_proxy: `http://127.0.0.1:${proxyServer.address().port}`,
        NO_PROXY: '',
        no_proxy: ''
      };
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', c => { stderr += c; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolveDone() : reject(new Error(stderr || `exit ${code}`)));
    });
    assert.equal(trapProxyHits, 0, 'local CDP discovery and upgrade must never traverse HTTP_PROXY');
    assert.equal(cdpHits, 1);
    assert.equal(upgradeHits, 1);
  } finally {
    for (const socket of upgradedSockets) socket.destroy();
    await new Promise(r => cdpServer.close(r));
    await new Promise(r => proxyServer.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
