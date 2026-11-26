import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { startSidecarWebUi, renderAuxPaneHtml } from '../lib/sidecar-ui.mjs';
import { startNativeIntegration } from '../lib/native-host.mjs';

function allocatePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function rawHttpRequest({ port, method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('Sidecar Web UI handles malformed URLs and throwing getStatus without crashing', async () => {
  const port = await allocatePort();
  let shouldThrow = true;
  const close = await startSidecarWebUi({
    port,
    token: 'tok-123',
    version: '1.1.0',
    getStatus: async () => {
      if (shouldThrow) throw new Error('status boom');
      return { healthy: true, enabled: true, language: 'en' };
    }
  });
  try {
    const badUrl = await rawHttpRequest({ port, path: 'http://[::1' });
    assert.equal(badUrl.status, 400);
    assert.equal(JSON.parse(badUrl.body).error, 'invalid url');

    const rootErr = await rawHttpRequest({ port, path: '/' });
    assert.equal(rootErr.status, 500);
    assert.equal(JSON.parse(rootErr.body).error, 'status boom');

    const statusErr = await rawHttpRequest({ port, path: '/api/status?token=tok-123' });
    assert.equal(statusErr.status, 500);
    assert.equal(JSON.parse(statusErr.body).error, 'status boom');

    // Server must remain alive and serve subsequent valid requests
    shouldThrow = false;
    const ok = await rawHttpRequest({ port, path: '/api/status?token=tok-123' });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).healthy, true);
  } finally {
    await close();
  }
});

test('Sidecar Web UI enforces Host, Origin/Sec-Fetch-Site checks, and fails closed when token is empty', async () => {
  const port = await allocatePort();
  let relaunches = 0;
  const close = await startSidecarWebUi({
    port,
    token: 'secret-token',
    version: '1.1.0',
    getStatus: async () => ({ healthy: false, enabled: true, language: 'zh-CN' }),
    onRelaunch: async () => { relaunches++; return { scheduled: true }; }
  });
  try {
    const badHost = await rawHttpRequest({ port, path: '/', headers: { Host: `evil.example:${port}` } });
    assert.equal(badHost.status, 403);

    const subdomainHost = await rawHttpRequest({ port, path: '/', headers: { Host: `evil.localhost:${port}` } });
    assert.equal(subdomainHost.status, 403);

    const otherPortOriginMismatch = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/relaunch',
      headers: { Host: `127.0.0.1:${port}`, Origin: 'http://127.0.0.1:65000', 'x-sidecar-token': 'secret-token' }
    });
    assert.equal(otherPortOriginMismatch.status, 403);

    // Antigravity 2.35+ proxies sidecar views via plugin://agy-max--inspector-<gatewayPort>/
    const pluginPageOk = await rawHttpRequest({
      port,
      path: '/?token=secret-token',
      headers: { Host: 'agy-max--inspector-52150' }
    });
    assert.equal(pluginPageOk.status, 200);
    assert.match(pluginPageOk.body, /Antigravity Max 1\.1\.0/);

    const pluginPostOk = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/relaunch',
      headers: {
        Host: 'agy-max--inspector-52150',
        Origin: 'plugin://agy-max--inspector-52150',
        'Sec-Fetch-Site': 'same-origin',
        'x-sidecar-token': 'secret-token'
      }
    });
    assert.equal(pluginPostOk.status, 200);
    assert.equal(relaunches, 1);

    const crossOrigin = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/relaunch',
      headers: { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example', 'x-sidecar-token': 'secret-token' }
    });
    assert.equal(crossOrigin.status, 403);

    const nullOrigin = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/relaunch',
      headers: { Host: `127.0.0.1:${port}`, Origin: 'null', 'x-sidecar-token': 'secret-token' }
    });
    assert.equal(nullOrigin.status, 403);

    const crossSite = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/relaunch',
      headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site', 'x-sidecar-token': 'secret-token' }
    });
    assert.equal(crossSite.status, 403);

    const sameSiteOtherPort = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/relaunch',
      headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-site', 'x-sidecar-token': 'secret-token' }
    });
    assert.equal(sameSiteOtherPort.status, 403);
    assert.equal(relaunches, 1);

    const sameOriginOk = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api/relaunch',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'x-sidecar-token': 'secret-token'
      }
    });
    assert.equal(sameOriginOk.status, 200);
    assert.equal(relaunches, 2);
  } finally {
    await close();
  }

  // Empty token must fail closed on API and non-GET endpoints
  const port2 = await allocatePort();
  let emptyRelaunches = 0;
  const close2 = await startSidecarWebUi({
    port: port2,
    token: '',
    version: '1.1.0',
    getStatus: async () => ({ healthy: true, enabled: true, language: 'en' }),
    onRelaunch: async () => { emptyRelaunches++; return { scheduled: true }; }
  });
  try {
    assert.equal((await rawHttpRequest({ port: port2, path: '/api/status' })).status, 401);
    assert.equal((await rawHttpRequest({ port: port2, path: '/api/update/status' })).status, 401);
    assert.equal((await rawHttpRequest({ port: port2, method: 'POST', path: '/api/relaunch' })).status, 401);
    assert.equal((await rawHttpRequest({ port: port2, method: 'POST', path: '/api/update/check' })).status, 401);
    assert.equal((await rawHttpRequest({ port: port2, method: 'POST', path: '/api/update/install', body: '{}' })).status, 401);
    assert.equal(emptyRelaunches, 0);

    // Same-origin Aux Pane HTML receives ephemeral fallbackToken so UI works when host omits ANTIGRAVITY_SIDECAR_UI_TOKEN
    const pageRes = await rawHttpRequest({ port: port2, path: '/' });
    assert.equal(pageRes.status, 200);
    const embedded = pageRes.body.match(/params\.get\('token'\)\s*\|\|\s*"([a-f0-9]{48})"/)?.[1];
    assert.ok(embedded, 'ephemeral fallback token should be embedded when host token is empty');
    assert.equal((await rawHttpRequest({ port: port2, path: `/api/status?token=${embedded}` })).status, 200);
  } finally {
    await close2();
  }
});

test('renderAuxPaneHtml escapes version in HTML and inline script JSON safely', () => {
  const hostile = '1.0.0"><img src=x onerror=1></script><script>alert(1)</script>';
  const html = renderAuxPaneHtml({ version: hostile, language: 'en' });
  const spanMatch = html.match(/<span id="state-text">([\s\S]*?)<\/span>/);
  assert.ok(spanMatch);
  assert.equal(spanMatch[1].includes('<img'), false);
  assert.ok(spanMatch[1].includes('&lt;img'));
  assert.ok(spanMatch[1].includes('&quot;'));
  const scriptMatches = html.match(/<script>[\s\S]*?<\/script>/g);
  assert.equal(scriptMatches?.length, 1, 'hostile version must not break out of inline script tag');
  const inlineScript = scriptMatches[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
  assert.equal(inlineScript.includes('</script>'), false);
  assert.ok(inlineScript.includes('\\u003c/script\\u003e'));
  assert.doesNotThrow(() => new Function(inlineScript));
});

test('Sidecar API includes discovery diagnostics with the legacy inspector status callback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-sidecar-diagnostics-'));
  const portFile = join(dir, 'port');
  writeFileSync(portFile, '12345\n');
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => [] });
  let stop, close;
  try {
    stop = startNativeIntegration({ portFile, onStatus() {}, wsl: false });
    const port = await allocatePort();
    close = await startSidecarWebUi({
      port, token: 'test-token',
      getStatus: async () => {
        const { healthy, connected } = await stop.health();
        return { healthy, connected, enabled: true };
      }
    });
    const response = await rawHttpRequest({ port, path: '/api/status?token=test-token' });
    assert.equal(response.status, 200);
    const { portReachable, matchedTargets, mountedCount, failedCount, firstError } = JSON.parse(response.body);
    assert.deepEqual({ portReachable, matchedTargets, mountedCount, failedCount, firstError }, {
      portReachable: true, matchedTargets: 0, mountedCount: 0, failedCount: 0, firstError: ''
    });
  } finally {
    await close?.();
    await stop?.();
    globalThis.fetch = fetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Sidecar serializes slow status polls and reports waiting, partial mounts, and clipboard results', async () => {
  const html = renderAuxPaneHtml({ version: '1.1.0', language: 'en' });
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const elements = new Map(), timeouts = new Map();
  let request, selected = false, writtenText, rejectClipboard = true;
  let nextTimer = 0, statusRequests = 0;
  const getElement = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        dataset: {}, hidden: true, listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        click() { return this.listeners.click?.(); },
        setAttribute() {}, focus() {}, select() { selected = true; }
      });
    }
    return elements.get(id);
  };
  vm.runInNewContext(script, {
    document: { documentElement: {}, getElementById: getElement },
    location: { search: '' },
    URLSearchParams,
    navigator: { clipboard: { async writeText(value) {
      if (rejectClipboard) throw new Error('clipboard denied');
      writtenText = value;
    } } },
    setTimeout(fn, ms) {
      const id = ++nextTimer;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: id => timeouts.delete(id),
    setInterval() { assert.fail('status must use a one-shot timer'); },
    fetch(url) {
      if (url === '/api/relaunch') return Promise.resolve({ ok: false, json: async () => ({ scheduled: false }) });
      assert.equal(url, '/api/status');
      statusRequests++;
      request = Promise.withResolvers();
      return request.promise;
    }
  });
  const settleStatus = async data => {
    request.resolve({ ok: true, json: async () => ({ enabled: true, language: 'en', ...data }) });
    await new Promise(resolve => setImmediate(resolve));
  };
  const nextStatus = () => {
    const polls = [...timeouts].filter(([, timer]) => timer.ms === 3000);
    assert.equal(polls.length, 1);
    const [id, { fn }] = polls[0];
    timeouts.delete(id);
    return fn();
  };

  assert.equal(statusRequests, 1);
  assert.equal(timeouts.size, 0, 'wait for status to settle before scheduling the next request');
  await settleStatus({ portReachable: false, manualCommand: 'antigravity --remote-debugging-port=12345' });
  assert.match(getElement('title').textContent, /Restart/);
  assert.equal(getElement('relaunch-btn').hidden, false);
  await getElement('relaunch-btn').click();
  await getElement('copy-cmd-btn').click();
  assert.match(getElement('copy-feedback').textContent, /Copy failed/);
  assert.match(getElement('copy-fallback').value, /--remote-debugging-port/);
  assert.equal(selected, true);

  let poll = nextStatus();
  assert.equal(statusRequests, 2);
  assert.equal(timeouts.size, 0);
  await settleStatus({ portReachable: true, matchedTargets: 0 });
  await poll;
  assert.match(getElement('title').textContent, /Waiting for the main window/);
  assert.equal(getElement('relaunch-btn').hidden, true);
  assert.equal(getElement('copy-fallback').hidden, true);

  poll = nextStatus();
  await settleStatus({ healthy: true, portReachable: true, matchedTargets: 3, mountedCount: 2, failedCount: 1, firstError: 'Frame tree failed' });
  await poll;
  assert.match(getElement('title').textContent, /some windows/);
  assert.match(getElement('compat-box').textContent, /2\/3\nFrame tree failed/);
  await getElement('copy-diag-btn').click();
  assert.match(getElement('copy-feedback').textContent, /Copy failed/);
  assert.match(getElement('copy-fallback').value, /Frame tree failed/);
  rejectClipboard = false;
  await getElement('copy-diag-btn').click();
  assert.equal(getElement('copy-feedback').textContent, 'Diagnostic copied');
  assert.equal(getElement('copy-fallback').hidden, true);
  assert.match(writtenText, /Frame tree failed/);
});

test('Sidecar Aux Pane inline script unlocks update controls on idle status and avoids leaking poll timer on terminal install response', async () => {
  const html = renderAuxPaneHtml({ version: '1.1.0', language: 'en' });
  const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript);

  const elements = new Map();
  const makeEl = id => {
    const listeners = {};
    const el = {
      id,
      hidden: true,
      disabled: false,
      textContent: '',
      href: '',
      dataset: {},
      addEventListener(type, fn) { listeners[type] = fn; },
      click() { return listeners.click?.(); }
    };
    elements.set(id, el);
    return el;
  };
  for (const id of [
    'dot', 'title', 'desc', 'mac-dock-hint', 'compat-box', 'primary-actions',
    'relaunch-btn', 'copy-cmd-btn', 'copy-diag-btn', 'cmd-box', 'feedback',
    'update-box', 'check-update-btn', 'install-update-btn', 'download-link',
    'update-feedback', 'update-notes'
  ]) makeEl(id);

  let nextTimerId = 1;
  const activeIntervals = new Map();
  let installResponse = { status: 'preparing', version: '1.2.0' };
  let updateStatusResponse = { status: 'idle' };

  const sandbox = {
    location: { search: '?token=t1' },
    URLSearchParams,
    document: {
      documentElement: { lang: 'en' },
      getElementById: id => elements.get(id)
    },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval(fn, ms) {
      const id = nextTimerId++;
      activeIntervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) { activeIntervals.delete(id); },
    setTimeout() { return 0; },
    clearTimeout() {},
    fetch: async url => {
      if (url.startsWith('/api/status')) return { ok: true, json: async () => ({ healthy: true, enabled: true, language: 'en' }) };
      if (url.startsWith('/api/update/check')) {
        return { ok: true, json: async () => ({ status: 'available', version: '1.2.0', canInstall: true }) };
      }
      if (url.startsWith('/api/update/install')) return { ok: true, json: async () => installResponse };
      if (url.startsWith('/api/update/status')) return { ok: true, json: async () => updateStatusResponse };
      return { ok: false, json: async () => ({}) };
    }
  };

  vm.runInNewContext(inlineScript, sandbox);
  const flush = () => new Promise(r => setImmediate(r));
  await flush();

  // Trigger update check so install button becomes available
  elements.get('check-update-btn').click();
  await flush();
  assert.equal(elements.get('install-update-btn').hidden, false);
  assert.equal(elements.get('install-update-btn').disabled, false);

  // Case 1: install returns preparing -> starts 900ms poll timer -> idle status unlocks UI and clears timer
  elements.get('install-update-btn').click();
  await flush();
  assert.equal(elements.get('install-update-btn').disabled, true);
  assert.equal(elements.get('check-update-btn').disabled, true);
  const pollEntries = [...activeIntervals.entries()].filter(([, v]) => v.ms === 900);
  assert.equal(pollEntries.length, 1);

  updateStatusResponse = { status: 'idle' };
  await pollEntries[0][1].fn();
  await flush();
  assert.equal(elements.get('install-update-btn').disabled, false, 'idle status must re-enable install button');
  assert.equal(elements.get('check-update-btn').disabled, false, 'idle status must re-enable check button');
  assert.equal([...activeIntervals.values()].filter(v => v.ms === 900).length, 0, 'idle status must clear 900ms updatePollTimer');

  // Case 2: install returns terminal completed status immediately -> must NOT start leaked 900ms poll timer
  installResponse = { status: 'completed', version: '1.2.0' };
  elements.get('install-update-btn').click();
  await flush();
  assert.equal(elements.get('install-update-btn').disabled, false);
  assert.equal([...activeIntervals.values()].filter(v => v.ms === 900).length, 0, 'terminal install response must not start poll timer');
});
