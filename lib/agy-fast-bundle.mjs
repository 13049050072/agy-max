import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync, cpSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const AGY_FAST_ID = 'agy-fast';
export const MANAGED_MARKER = '.agy-max-managed.json';
export const PARKED_MARKER = '.agy-max-parked.json';
const MAX_LOCAL_RULE_BYTES = 256 * 1024;

function assertSafeOwned(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('目标路径越界');
  let cur = resolve(root);
  if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) throw new Error('目标目录不能是符号链接');
  for (const part of rel.split(/[\\/]/)) {
    cur = join(cur, part);
    if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) throw new Error('目标路径包含符号链接');
  }
  return resolve(target);
}

function assertCleanTree(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('清理目录中包含符号链接');
  if (stat.isDirectory()) for (const name of readdirSync(path)) assertCleanTree(join(path, name));
}

function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.agy-max-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
}

function updateConfigPluginState(root, configPath, state) {
  assertSafeOwned(root, configPath);
  let cfg = {};
  if (existsSync(configPath)) {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
  }
  cfg.plugins ||= {};
  if (state === undefined) delete cfg.plugins[AGY_FAST_ID];
  else cfg.plugins[AGY_FAST_ID] = { ...(cfg.plugins[AGY_FAST_ID] || {}), enabled: Boolean(state) };
  writeAtomicJson(configPath, cfg);
}

function snapshotLocalRules(pluginDir) {
  const rulesDir = join(pluginDir, 'rules');
  if (!existsSync(rulesDir) || lstatSync(rulesDir).isSymbolicLink()) return [];
  const saved = [];
  for (const name of readdirSync(rulesDir)) {
    if (!name.endsWith('.local.md')) continue;
    const p = join(rulesDir, name);
    try {
      const st = lstatSync(p);
      if (st.isFile() && !st.isSymbolicLink() && st.size <= MAX_LOCAL_RULE_BYTES) {
        saved.push({ name, bytes: readFileSync(p) });
      }
    } catch {}
  }
  return saved;
}

function restoreLocalRules(pluginDir, entries) {
  if (!entries?.length) return;
  const rulesDir = join(pluginDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });
  for (const { name, bytes } of entries) {
    if (/^[a-zA-Z0-9._-]+\.local\.md$/.test(name)) {
      writeFileSync(join(rulesDir, name), bytes, { mode: 0o644 });
    }
  }
}

function tryAgyCliToggle(home, enable, { runCli, platform = process.platform, env = process.env } = {}) {
  if (typeof runCli === 'function') return Boolean(runCli(enable));
  if (runCli === false) return false;
  if (runCli !== true && resolve(home) !== resolve(homedir())) return false;
  const sub = enable ? 'enable' : 'disable';
  const candidates = platform === 'win32'
    ? ['agy.cmd', 'agy.exe', env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Antigravity', 'resources', 'app', 'bin', 'agy.cmd')].filter(Boolean)
    : ['agy', join(home, '.local', 'bin', 'agy'), '/Applications/Antigravity.app/Contents/Resources/app/bin/agy', '/opt/homebrew/bin/agy', '/usr/local/bin/agy'];
  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ['plugin', sub, AGY_FAST_ID], {
        stdio: 'ignore',
        timeout: 6000,
        windowsHide: true,
        shell: platform === 'win32' && bin.endsWith('.cmd'),
        env: { ...env, HOME: home, USERPROFILE: home }
      });
      if (!res.error && res.status === 0) return true;
    } catch {}
  }
  return false;
}

export function syncBundledAgyFast({ home = homedir(), enabled = true, vendorDir, runCli } = {}) {
  const resolvedHome = resolve(home);
  const root = join(resolvedHome, '.gemini');
  const configPath = join(root, 'config', 'config.json');
  const pluginsDir = join(root, 'config', 'plugins');
  const targetDir = join(pluginsDir, AGY_FAST_ID);
  const dataDir = join(root, 'antigravity', 'plugin_data', 'agy-max');
  const parkedDir = join(dataDir, 'parked-plugins', AGY_FAST_ID);
  const localRulesBackupDir = join(dataDir, 'agy-fast-local-rules');
  const sourceDir = vendorDir ? resolve(vendorDir) : fileURLToPath(new URL('./vendor/agy-fast', import.meta.url));

  assertSafeOwned(resolvedHome, pluginsDir);
  assertSafeOwned(resolvedHome, dataDir);

  if (existsSync(targetDir) && lstatSync(targetDir).isSymbolicLink()) {
    updateConfigPluginState(root, configPath, enabled);
    tryAgyCliToggle(resolvedHome, enabled, { runCli });
    return { ok: true, enabled: Boolean(enabled), mode: 'symlink' };
  }

  assertSafeOwned(resolvedHome, targetDir);
  assertSafeOwned(resolvedHome, parkedDir);

  if (existsSync(targetDir)) {
    const manifestPath = join(targetDir, 'plugin.json');
    if (existsSync(manifestPath)) {
      const name = JSON.parse(readFileSync(manifestPath, 'utf8'))?.name;
      if (name && name !== AGY_FAST_ID) throw new Error('agy-fast 目录被其他插件占用');
    }
  }

  if (enabled) {
    if (!existsSync(targetDir) && existsSync(parkedDir) && !lstatSync(parkedDir).isSymbolicLink()) {
      assertCleanTree(parkedDir);
      mkdirSync(dirname(targetDir), { recursive: true });
      cpSync(parkedDir, targetDir, { recursive: true, force: true });
      try { unlinkSync(join(targetDir, PARKED_MARKER)); } catch {}
      rmSync(parkedDir, { recursive: true, force: true });
    } else if (!existsSync(targetDir)) {
      if (!existsSync(join(sourceDir, 'plugin.json'))) return { ok: false, enabled: true, reason: 'missing-vendor' };
      const vendorVer = JSON.parse(readFileSync(join(sourceDir, 'plugin.json'), 'utf8')).version || '0.3.0';
      mkdirSync(dirname(targetDir), { recursive: true });
      cpSync(sourceDir, targetDir, { recursive: true, force: true });
      if (existsSync(localRulesBackupDir) && !lstatSync(localRulesBackupDir).isSymbolicLink()) {
        const entries = readdirSync(localRulesBackupDir)
          .filter(n => n.endsWith('.local.md'))
          .map(n => ({ name: n, bytes: readFileSync(join(localRulesBackupDir, n)) }));
        restoreLocalRules(targetDir, entries);
      }
      writeAtomicJson(join(targetDir, MANAGED_MARKER), { managedBy: 'agy-max', version: vendorVer });
    } else if (existsSync(join(targetDir, MANAGED_MARKER)) && existsSync(join(sourceDir, 'plugin.json'))) {
      assertCleanTree(targetDir);
      const localRules = snapshotLocalRules(targetDir);
      const vendorVer = JSON.parse(readFileSync(join(sourceDir, 'plugin.json'), 'utf8')).version || '0.3.0';
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true, force: true });
      restoreLocalRules(targetDir, localRules);
      writeAtomicJson(join(targetDir, MANAGED_MARKER), { managedBy: 'agy-max', version: vendorVer });
    }
    updateConfigPluginState(root, configPath, true);
    tryAgyCliToggle(resolvedHome, true, { runCli });
    return { ok: true, enabled: true, installed: existsSync(targetDir) };
  }

  tryAgyCliToggle(resolvedHome, false, { runCli });
  updateConfigPluginState(root, configPath, false);

  if (existsSync(targetDir)) {
    assertCleanTree(targetDir);
    const managed = existsSync(join(targetDir, MANAGED_MARKER));
    if (managed) {
      const localRules = snapshotLocalRules(targetDir);
      if (localRules.length) {
        mkdirSync(localRulesBackupDir, { recursive: true });
        for (const { name, bytes } of localRules) writeFileSync(join(localRulesBackupDir, name), bytes, { mode: 0o644 });
      }
      rmSync(targetDir, { recursive: true, force: true });
    } else {
      if (existsSync(parkedDir)) rmSync(parkedDir, { recursive: true, force: true });
      mkdirSync(dirname(parkedDir), { recursive: true });
      cpSync(targetDir, parkedDir, { recursive: true, force: true });
      writeAtomicJson(join(parkedDir, PARKED_MARKER), { userOwned: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  }
  return { ok: true, enabled: false, installed: false };
}

export function cleanupBundledAgyFast({ home = homedir(), runCli } = {}) {
  const resolvedHome = resolve(home);
  const root = join(resolvedHome, '.gemini');
  const configPath = join(root, 'config', 'config.json');
  const targetDir = join(root, 'config', 'plugins', AGY_FAST_ID);
  const parkedDir = join(root, 'antigravity', 'plugin_data', 'agy-max', 'parked-plugins', AGY_FAST_ID);

  try {
    assertSafeOwned(resolvedHome, join(root, 'config', 'plugins'));
    if (existsSync(parkedDir) && !lstatSync(parkedDir).isSymbolicLink()) {
      const parkedMeta = existsSync(join(parkedDir, PARKED_MARKER))
        ? JSON.parse(readFileSync(join(parkedDir, PARKED_MARKER), 'utf8'))
        : null;
      if (parkedMeta?.userOwned && !existsSync(targetDir)) {
        assertCleanTree(parkedDir);
        mkdirSync(dirname(targetDir), { recursive: true });
        cpSync(parkedDir, targetDir, { recursive: true, force: true });
        try { unlinkSync(join(targetDir, PARKED_MARKER)); } catch {}
      }
      rmSync(parkedDir, { recursive: true, force: true });
      return;
    }
    if (existsSync(targetDir) && !lstatSync(targetDir).isSymbolicLink() && existsSync(join(targetDir, MANAGED_MARKER))) {
      assertCleanTree(targetDir);
      tryAgyCliToggle(resolvedHome, false, { runCli });
      rmSync(targetDir, { recursive: true, force: true });
      updateConfigPluginState(root, configPath, undefined);
    }
  } catch {}
}
