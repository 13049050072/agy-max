import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { collectPackage } from '../lib/package.mjs';
import { installPlugin, uninstallPlugin, installationPaths, atomicJson } from '../lib/lifecycle.mjs';
import { syncBundledAgyFast, MANAGED_MARKER } from '../lib/agy-fast-bundle.mjs';

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'agy-fast-bundle-'));
  const home = join(root, 'home');
  const paths = installationPaths(home);
  mkdirSync(join(paths.root, 'config'), { recursive: true });
  atomicJson(paths.config, { plugins: { other: { enabled: true } } });
  return { root, home, paths, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('installPlugin deploys bundled agy-fast by default, toggle disables/restores it while preserving local rules, and uninstall cleans up managed copy', async () => {
  const s = createSandbox();
  try {
    const bundle = collectPackage(resolve('.'));
    await installPlugin({ bundle, home: s.home, stop: async () => {} });
    const fastDir = join(s.paths.root, 'config', 'plugins', 'agy-fast');
    assert.equal(existsSync(join(fastDir, 'plugin.json')), true);
    assert.equal(existsSync(join(fastDir, 'dist', 'mcp-server.mjs')), true);
    assert.equal(existsSync(join(fastDir, MANAGED_MARKER)), true);
    assert.equal(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins['agy-fast'].enabled, true);

    // User adds a personal rules/AGENTS.local.md and then turns agyFast OFF
    writeFileSync(join(fastDir, 'rules', 'AGENTS.local.md'), '# custom override\n', 'utf8');
    const cliCalls = [];
    syncBundledAgyFast({ home: s.home, enabled: false, runCli: en => { cliCalls.push(en); return true; } });
    assert.deepEqual(cliCalls, [false]);
    assert.equal(existsSync(fastDir), false);
    assert.equal(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins['agy-fast'].enabled, false);

    // Turning agyFast back ON restores both runtime files and AGENTS.local.md
    syncBundledAgyFast({ home: s.home, enabled: true, runCli: en => { cliCalls.push(en); return true; } });
    assert.deepEqual(cliCalls, [false, true]);
    assert.equal(existsSync(join(fastDir, 'dist', 'mcp-server.mjs')), true);
    assert.equal(readFileSync(join(fastDir, 'rules', 'AGENTS.local.md'), 'utf8'), '# custom override\n');
    assert.equal(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins['agy-fast'].enabled, true);

    // Uninstalling Antigravity Max cleans up managed agy-fast too
    await uninstallPlugin({ home: s.home, stop: async () => {} });
    assert.equal(existsSync(fastDir), false);
    assert.equal(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins['agy-fast'], undefined);
  } finally {
    s.clean();
  }
});

test('pre-existing standalone agy-fast can be toggled off/on and is preserved when Antigravity Max is uninstalled', async () => {
  const s = createSandbox();
  try {
    const fastDir = join(s.paths.root, 'config', 'plugins', 'agy-fast');
    mkdirSync(fastDir, { recursive: true });
    writeFileSync(join(fastDir, 'plugin.json'), JSON.stringify({ name: 'agy-fast', version: '0.9.9' }));
    writeFileSync(join(fastDir, 'USER_CUSTOM.txt'), 'keep-me');
    const bundle = collectPackage(resolve('.'));
    await installPlugin({ bundle, home: s.home, stop: async () => {} });
    assert.equal(existsSync(join(fastDir, MANAGED_MARKER)), false);
    assert.equal(readFileSync(join(fastDir, 'USER_CUSTOM.txt'), 'utf8'), 'keep-me');

    // User toggles agyFast OFF -> parked safely
    syncBundledAgyFast({ home: s.home, enabled: false });
    assert.equal(existsSync(fastDir), false);

    // User uninstalls Antigravity Max while standalone agy-fast was parked -> restored intact!
    await uninstallPlugin({ home: s.home, stop: async () => {} });
    assert.equal(existsSync(fastDir), true);
    assert.equal(readFileSync(join(fastDir, 'USER_CUSTOM.txt'), 'utf8'), 'keep-me');
  } finally {
    s.clean();
  }
});
