import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { collectPackage } from '../lib/package.mjs';
import { installPlugin, uninstallPlugin, installationPaths, atomicJson } from '../lib/lifecycle.mjs';
import { syncBundledAgyFast, cleanupBundledAgyFast, MANAGED_MARKER, PARKED_MARKER } from '../lib/agy-fast-bundle.mjs';

function dirLinkType() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

function tryFileSymlink(target, path) {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (err) {
    if (process.platform === 'win32' && err?.code === 'EPERM') return false;
    throw err;
  }
}

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

test('managed install disables agy-fast self-updater without touching unrelated cache settings', async () => {
  const s = createSandbox();
  try {
    const cacheDir = join(s.paths.root, 'cache', 'agy-fast');
    mkdirSync(cacheDir, { recursive: true });
    const cacheConfig = join(cacheDir, 'config.json');
    atomicJson(cacheConfig, { toolLoading: 'lazy', channel: 'main' });
    const bundle = collectPackage(resolve('.'));
    await installPlugin({ bundle, home: s.home, stop: async () => {} });
    assert.deepEqual(JSON.parse(readFileSync(cacheConfig, 'utf8')), { toolLoading: 'lazy', channel: 'main', autoUpdate: 'off' });
    await uninstallPlugin({ home: s.home, stop: async () => {} });
    assert.equal(JSON.parse(readFileSync(cacheConfig, 'utf8')).autoUpdate, 'off');
    // An unreadable cache config is left as is and does not block the install.
    writeFileSync(cacheConfig, '{not json');
    await installPlugin({ bundle, home: s.home, stop: async () => {} });
    assert.equal(readFileSync(cacheConfig, 'utf8'), '{not json');
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
    const cacheConfig = join(s.paths.root, 'cache', 'agy-fast', 'config.json');
    mkdirSync(dirname(cacheConfig), { recursive: true });
    atomicJson(cacheConfig, { autoUpdate: 'notify' });
    const bundle = collectPackage(resolve('.'));
    await installPlugin({ bundle, home: s.home, stop: async () => {} });
    assert.equal(existsSync(join(fastDir, MANAGED_MARKER)), false);
    // The user's own agy-fast keeps its own update setting.
    assert.equal(JSON.parse(readFileSync(cacheConfig, 'utf8')).autoUpdate, 'notify');
    assert.equal(readFileSync(join(fastDir, 'USER_CUSTOM.txt'), 'utf8'), 'keep-me');

    // User toggles agyFast OFF -> parked safely with previousEnabled recorded
    syncBundledAgyFast({ home: s.home, enabled: false });
    assert.equal(existsSync(fastDir), false);
    const parkedDir = join(s.paths.data, 'parked-plugins', 'agy-fast');
    assert.deepEqual(JSON.parse(readFileSync(join(parkedDir, PARKED_MARKER), 'utf8')), { userOwned: true, previousEnabled: true });

    // User uninstalls Antigravity Max while standalone agy-fast was parked -> restored intact and re-enabled!
    await uninstallPlugin({ home: s.home, stop: async () => {} });
    assert.equal(existsSync(fastDir), true);
    assert.equal(existsSync(join(fastDir, PARKED_MARKER)), false);
    assert.equal(readFileSync(join(fastDir, 'USER_CUSTOM.txt'), 'utf8'), 'keep-me');
    assert.equal(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins['agy-fast'].enabled, true);
  } finally {
    s.clean();
  }
});

test('cleanupBundledAgyFast restores previousEnabled state and CLI toggle for parked user-owned agy-fast', () => {
  const s = createSandbox();
  try {
    const fastDir = join(s.paths.root, 'config', 'plugins', 'agy-fast');
    mkdirSync(fastDir, { recursive: true });
    writeFileSync(join(fastDir, 'plugin.json'), JSON.stringify({ name: 'agy-fast', version: '0.9.9' }));
    writeFileSync(join(fastDir, 'USER_CUSTOM.txt'), 'keep-me');

    // Case 1: standalone was enabled -> restored with enabled=true and CLI enabled
    atomicJson(s.paths.config, { plugins: { other: { enabled: true }, 'agy-fast': { enabled: true } } });
    syncBundledAgyFast({ home: s.home, enabled: false, runCli: false });
    const cliCalls1 = [];
    const res1 = cleanupBundledAgyFast({ home: s.home, runCli: en => { cliCalls1.push(en); return true; } });
    assert.deepEqual(res1, { ok: true, restored: true, retained: [] });
    assert.deepEqual(cliCalls1, [true]);
    assert.equal(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins['agy-fast'].enabled, true);

    // Case 2: standalone was originally disabled -> restored with enabled=false and CLI NOT enabled
    atomicJson(s.paths.config, { plugins: { other: { enabled: true }, 'agy-fast': { enabled: false } } });
    syncBundledAgyFast({ home: s.home, enabled: false, runCli: false });
    const cliCalls2 = [];
    const res2 = cleanupBundledAgyFast({ home: s.home, runCli: en => { cliCalls2.push(en); return true; } });
    assert.deepEqual(res2, { ok: true, restored: true, retained: [] });
    assert.deepEqual(cliCalls2, []);
    assert.equal(existsSync(join(fastDir, 'USER_CUSTOM.txt')), true);
    assert.equal(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins['agy-fast'].enabled, false);
  } finally {
    s.clean();
  }
});

test('uninstall retains parked user-owned agy-fast instead of deleting it when restore fails', async () => {
  const s = createSandbox();
  try {
    const fastDir = join(s.paths.root, 'config', 'plugins', 'agy-fast');
    mkdirSync(fastDir, { recursive: true });
    writeFileSync(join(fastDir, 'plugin.json'), JSON.stringify({ name: 'agy-fast', version: '0.9.9' }));
    writeFileSync(join(fastDir, 'USER_CUSTOM.txt'), 'precious-data');

    const bundle = collectPackage(resolve('.'));
    await installPlugin({ bundle, home: s.home, stop: async () => {} });
    writeFileSync(join(s.paths.data, 'settings.json'), '{"agyFast":false}');
    syncBundledAgyFast({ home: s.home, enabled: false });

    const parkedDir = join(s.paths.data, 'parked-plugins', 'agy-fast');
    assert.equal(existsSync(parkedDir), true);

    // Inject a symlink inside parkedDir so assertCleanTree fails during restore
    const externalDir = join(s.root, 'external-target');
    mkdirSync(externalDir, { recursive: true });
    symlinkSync(externalDir, join(parkedDir, 'linked-dir'), dirLinkType());

    const result = await uninstallPlugin({ home: s.home, purge: true, stop: async () => {} });
    assert.equal(result.removed, true);
    assert.equal(result.purged, true);
    assert.ok(result.retained.includes(parkedDir));
    // Parked user plugin MUST survive purge while other plugin data is purged
    assert.equal(existsSync(parkedDir), true);
    assert.equal(readFileSync(join(parkedDir, 'USER_CUSTOM.txt'), 'utf8'), 'precious-data');
    assert.equal(existsSync(join(s.paths.data, 'settings.json')), false);
  } finally {
    s.clean();
  }
});

test('uninstalling after disabling managed agy-fast cleans up dangling config.json entry', async () => {
  const s = createSandbox();
  try {
    const bundle = collectPackage(resolve('.'));
    await installPlugin({ bundle, home: s.home, stop: async () => {} });
    const fastDir = join(s.paths.root, 'config', 'plugins', 'agy-fast');
    assert.equal(existsSync(fastDir), true);

    // Disable managed agy-fast (removes targetDir, leaves enabled: false in config.json)
    syncBundledAgyFast({ home: s.home, enabled: false });
    assert.equal(existsSync(fastDir), false);
    assert.equal(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins['agy-fast'].enabled, false);

    // Uninstall agy-max -> dangling agy-fast entry must be removed from config.json
    await uninstallPlugin({ home: s.home, stop: async () => {} });
    assert.equal(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins['agy-fast'], undefined);
    assert.deepEqual(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins.other, { enabled: true });

    // Also handles legacy v1.1.0 dangling { enabled: false } without managed marker file
    atomicJson(s.paths.config, { plugins: { other: { enabled: true }, 'agy-fast': { enabled: false } } });
    const res = cleanupBundledAgyFast({ home: s.home });
    assert.deepEqual(res, { ok: true, restored: false, retained: [] });
    assert.equal(JSON.parse(readFileSync(s.paths.config, 'utf8')).plugins['agy-fast'], undefined);
  } finally {
    s.clean();
  }
});

test('deleted .local.md rules do not resurrect after toggle and backup restore enforces symlink/size checks', async () => {
  const s = createSandbox();
  try {
    const bundle = collectPackage(resolve('.'));
    await installPlugin({ bundle, home: s.home, stop: async () => {} });
    const fastDir = join(s.paths.root, 'config', 'plugins', 'agy-fast');
    const rulesDir = join(fastDir, 'rules');
    const backupDir = join(s.paths.data, 'agy-fast-local-rules');

    writeFileSync(join(rulesDir, 'A.local.md'), '# rule A\n', 'utf8');
    writeFileSync(join(rulesDir, 'B.local.md'), '# rule B\n', 'utf8');

    // Toggle OFF then ON -> restores both and clears backupDir
    syncBundledAgyFast({ home: s.home, enabled: false });
    assert.equal(existsSync(join(backupDir, 'A.local.md')), true);
    assert.equal(existsSync(join(backupDir, 'B.local.md')), true);
    syncBundledAgyFast({ home: s.home, enabled: true });
    assert.equal(existsSync(join(rulesDir, 'A.local.md')), true);
    assert.equal(existsSync(join(rulesDir, 'B.local.md')), true);
    assert.equal(existsSync(backupDir), false);

    // Delete B.local.md, plant a stale backup file, toggle OFF then ON -> only A survives
    rmSync(join(rulesDir, 'B.local.md'));
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'STALE.local.md'), '# zombie\n', 'utf8');
    syncBundledAgyFast({ home: s.home, enabled: false });
    assert.equal(existsSync(join(backupDir, 'A.local.md')), true);
    assert.equal(existsSync(join(backupDir, 'B.local.md')), false);
    assert.equal(existsSync(join(backupDir, 'STALE.local.md')), false);
    syncBundledAgyFast({ home: s.home, enabled: true });
    assert.equal(existsSync(join(rulesDir, 'A.local.md')), true);
    assert.equal(existsSync(join(rulesDir, 'B.local.md')), false);
    assert.equal(existsSync(join(rulesDir, 'STALE.local.md')), false);

    // Delete all local rules, plant stale backup, toggle OFF -> backupDir is removed; toggle ON -> none resurrect
    rmSync(join(rulesDir, 'A.local.md'));
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'A.local.md'), '# zombie A\n', 'utf8');
    syncBundledAgyFast({ home: s.home, enabled: false });
    assert.equal(existsSync(backupDir), false);

    // Prepare backupDir with valid rule, oversized rule (>256KB), and symlinked rule before re-enabling
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'GOOD.local.md'), '# valid\n', 'utf8');
    writeFileSync(join(backupDir, 'OVERSIZED.local.md'), 'x'.repeat(256 * 1024 + 1), 'utf8');
    const secretFile = join(s.root, 'secret.txt');
    writeFileSync(secretFile, 'top-secret', 'utf8');
    const createdFileSymlink = tryFileSymlink(secretFile, join(backupDir, 'EVIL.local.md'));
    symlinkSync(join(s.root, 'missing-dir'), join(backupDir, 'DANGLING.local.md'), dirLinkType());

    syncBundledAgyFast({ home: s.home, enabled: true });
    assert.equal(readFileSync(join(rulesDir, 'GOOD.local.md'), 'utf8'), '# valid\n');
    assert.equal(existsSync(join(rulesDir, 'OVERSIZED.local.md')), false);
    if (createdFileSymlink) assert.equal(existsSync(join(rulesDir, 'EVIL.local.md')), false);
    assert.equal(existsSync(join(rulesDir, 'DANGLING.local.md')), false);
    assert.equal(existsSync(backupDir), false);
    assert.equal(readFileSync(secretFile, 'utf8'), 'top-secret');
  } finally {
    s.clean();
  }
});

test('dangling symlinks cannot bypass assertSafeOwned or assertCleanTree in agy-fast-bundle', () => {
  const s = createSandbox();
  try {
    const pluginsDir = join(s.paths.root, 'config', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    const fastDir = join(pluginsDir, 'agy-fast');
    const externalNonExistent = join(s.root, 'outside-nonexistent');

    // Dangling symlink at targetDir must be rejected by assertSafeOwned
    symlinkSync(externalNonExistent, fastDir, dirLinkType());
    assert.throws(() => syncBundledAgyFast({ home: s.home, enabled: true }), /符号链接/);
    assert.equal(existsSync(externalNonExistent), false);
    rmSync(fastDir, { force: true });

    // Dangling symlink inside targetDir must be rejected by assertCleanTree
    mkdirSync(fastDir, { recursive: true });
    writeFileSync(join(fastDir, 'plugin.json'), JSON.stringify({ name: 'agy-fast', version: '0.9.9' }));
    symlinkSync(externalNonExistent, join(fastDir, 'broken-link'), dirLinkType());
    assert.throws(() => syncBundledAgyFast({ home: s.home, enabled: false }), /符号链接/);
  } finally {
    s.clean();
  }
});
