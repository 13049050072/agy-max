import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync, cpSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const AGY_FAST_ID = 'agy-fast';
export const MANAGED_MARKER = '.agy-max-managed.json';
export const PARKED_MARKER = '.agy-max-parked.json';
export const MANAGED_STATE_FILE = 'agy-fast-managed.json';
const MAX_LOCAL_RULE_BYTES = 256 * 1024;
const LOCAL_RULE_NAME_RE = /^[a-zA-Z0-9._-]+\.local\.md$/;

// Bundled agy-fast is updated with agy-max; its own updater must stay off.
function disableBundledAgyFastUpdater(home) {
  const cacheDir = join(home, '.gemini', 'cache', 'agy-fast');
  const configPath = join(cacheDir, 'config.json');
  let cfg = {};
  if (existsSync(configPath)) {
    // Leave a config we can't read alone rather than failing the enable.
    try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch { return; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
  }
  if (cfg.autoUpdate === 'off') return;
  writeAtomicJson(configPath, { ...cfg, autoUpdate: 'off' });
}

function assertSafeOwned(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('目标路径越界');
  let cur = resolve(root);
  if (lstatSync(cur, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('目标目录不能是符号链接');
  for (const part of rel.split(/[\\/]/)) {
    cur = join(cur, part);
    if (lstatSync(cur, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('目标路径包含符号链接');
  }
  return resolve(target);
}

function assertCleanTree(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
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

function readConfigPluginEntry(root, configPath) {
  assertSafeOwned(root, configPath);
  if (!existsSync(configPath)) return undefined;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return undefined;
    return cfg.plugins?.[AGY_FAST_ID];
  } catch {
    return undefined;
  }
}

function isDanglingDisabledConfigEntry(root, configPath) {
  const entry = readConfigPluginEntry(root, configPath);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  return entry.enabled === false && Object.keys(entry).every(k => k === 'enabled');
}

function updateConfigPluginState(root, configPath, state) {
  assertSafeOwned(root, configPath);
  let cfg = {};
  if (existsSync(configPath)) {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
  }
  if (state === undefined) {
    if (!cfg.plugins || !(AGY_FAST_ID in cfg.plugins)) return;
    delete cfg.plugins[AGY_FAST_ID];
  } else {
    cfg.plugins ||= {};
    cfg.plugins[AGY_FAST_ID] = { ...(cfg.plugins[AGY_FAST_ID] || {}), enabled: Boolean(state) };
  }
  writeAtomicJson(configPath, cfg);
}

function readLocalRulesFromDir(dir) {
  const dirStat = lstatSync(dir, { throwIfNoEntry: false });
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];
  const saved = [];
  for (const name of readdirSync(dir)) {
    if (!LOCAL_RULE_NAME_RE.test(name)) continue;
    const p = join(dir, name);
    try {
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (st && st.isFile() && !st.isSymbolicLink() && st.size <= MAX_LOCAL_RULE_BYTES) {
        saved.push({ name, bytes: readFileSync(p) });
      }
    } catch {}
  }
  return saved;
}

function snapshotLocalRules(pluginDir) {
  return readLocalRulesFromDir(join(pluginDir, 'rules'));
}

function restoreLocalRules(pluginDir, entries) {
  if (!entries?.length) return;
  const rulesDir = join(pluginDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });
  for (const { name, bytes } of entries) {
    if (LOCAL_RULE_NAME_RE.test(name)) {
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
  const managedStateFile = join(dataDir, MANAGED_STATE_FILE);
  const sourceDir = vendorDir ? resolve(vendorDir) : fileURLToPath(new URL('./vendor/agy-fast', import.meta.url));

  assertSafeOwned(resolvedHome, pluginsDir);
  assertSafeOwned(resolvedHome, dataDir);

  if (existsSync(targetDir) && lstatSync(targetDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    updateConfigPluginState(root, configPath, enabled);
    tryAgyCliToggle(resolvedHome, enabled, { runCli });
    return { ok: true, enabled: Boolean(enabled), mode: 'symlink' };
  }

  assertSafeOwned(resolvedHome, targetDir);
  assertSafeOwned(resolvedHome, parkedDir);
  assertSafeOwned(resolvedHome, localRulesBackupDir);
  assertSafeOwned(resolvedHome, managedStateFile);

  if (existsSync(targetDir)) {
    const manifestPath = join(targetDir, 'plugin.json');
    if (existsSync(manifestPath)) {
      const name = JSON.parse(readFileSync(manifestPath, 'utf8'))?.name;
      if (name && name !== AGY_FAST_ID) throw new Error('agy-fast 目录被其他插件占用');
    }
  }

  if (enabled) {
    const parkedStat = lstatSync(parkedDir, { throwIfNoEntry: false });
    if (!existsSync(targetDir) && parkedStat && !parkedStat.isSymbolicLink()) {
      assertCleanTree(parkedDir);
      mkdirSync(dirname(targetDir), { recursive: true });
      try {
        cpSync(parkedDir, targetDir, { recursive: true, force: true });
      } catch (err) {
        try { rmSync(targetDir, { recursive: true, force: true }); } catch {}
        throw err;
      }
      try { unlinkSync(join(targetDir, PARKED_MARKER)); } catch {}
      rmSync(parkedDir, { recursive: true, force: true });
      try { unlinkSync(managedStateFile); } catch {}
    } else if (!existsSync(targetDir)) {
      if (!existsSync(join(sourceDir, 'plugin.json'))) return { ok: false, enabled: true, reason: 'missing-vendor' };
      const vendorVer = JSON.parse(readFileSync(join(sourceDir, 'plugin.json'), 'utf8')).version || '0.3.1';
      mkdirSync(dirname(targetDir), { recursive: true });
      cpSync(sourceDir, targetDir, { recursive: true, force: true });
      const backupStat = lstatSync(localRulesBackupDir, { throwIfNoEntry: false });
      if (backupStat && !backupStat.isSymbolicLink() && backupStat.isDirectory()) {
        const entries = readLocalRulesFromDir(localRulesBackupDir);
        restoreLocalRules(targetDir, entries);
        rmSync(localRulesBackupDir, { recursive: true, force: true });
      }
      writeAtomicJson(join(targetDir, MANAGED_MARKER), { managedBy: 'agy-max', version: vendorVer });
      writeAtomicJson(managedStateFile, { managedBy: 'agy-max', version: vendorVer });
    } else if (existsSync(join(targetDir, MANAGED_MARKER)) && existsSync(join(sourceDir, 'plugin.json'))) {
      assertCleanTree(targetDir);
      const localRules = snapshotLocalRules(targetDir);
      const vendorVer = JSON.parse(readFileSync(join(sourceDir, 'plugin.json'), 'utf8')).version || '0.3.1';
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true, force: true });
      restoreLocalRules(targetDir, localRules);
      writeAtomicJson(join(targetDir, MANAGED_MARKER), { managedBy: 'agy-max', version: vendorVer });
      writeAtomicJson(managedStateFile, { managedBy: 'agy-max', version: vendorVer });
    } else {
      try { unlinkSync(managedStateFile); } catch {}
    }
    // A user's own agy-fast install keeps its own update setting.
    if (existsSync(join(targetDir, MANAGED_MARKER))) disableBundledAgyFastUpdater(resolvedHome);
    updateConfigPluginState(root, configPath, true);
    tryAgyCliToggle(resolvedHome, true, { runCli });
    return { ok: true, enabled: true, installed: existsSync(targetDir) };
  }

  const previousEntry = readConfigPluginEntry(root, configPath);
  const previousEnabled = previousEntry?.enabled !== false;

  if (existsSync(targetDir)) {
    assertCleanTree(targetDir);
    const managed = existsSync(join(targetDir, MANAGED_MARKER));
    if (managed) {
      const localRules = snapshotLocalRules(targetDir);
      const backupStat = lstatSync(localRulesBackupDir, { throwIfNoEntry: false });
      if (backupStat) {
        assertCleanTree(localRulesBackupDir);
        rmSync(localRulesBackupDir, { recursive: true, force: true });
      }
      if (localRules.length) {
        mkdirSync(localRulesBackupDir, { recursive: true });
        for (const { name, bytes } of localRules) writeFileSync(join(localRulesBackupDir, name), bytes, { mode: 0o644 });
      }
      writeAtomicJson(managedStateFile, { managedBy: 'agy-max', disabled: true });
      rmSync(targetDir, { recursive: true, force: true });
    } else {
      if (lstatSync(parkedDir, { throwIfNoEntry: false })) {
        assertCleanTree(parkedDir);
        rmSync(parkedDir, { recursive: true, force: true });
      }
      mkdirSync(dirname(parkedDir), { recursive: true });
      cpSync(targetDir, parkedDir, { recursive: true, force: true });
      writeAtomicJson(join(parkedDir, PARKED_MARKER), { userOwned: true, previousEnabled });
      try { unlinkSync(managedStateFile); } catch {}
      rmSync(targetDir, { recursive: true, force: true });
    }
  } else if (!lstatSync(parkedDir, { throwIfNoEntry: false })) {
    writeAtomicJson(managedStateFile, { managedBy: 'agy-max', disabled: true });
  }

  tryAgyCliToggle(resolvedHome, false, { runCli });
  updateConfigPluginState(root, configPath, false);
  return { ok: true, enabled: false, installed: false };
}

export function cleanupBundledAgyFast({ home = homedir(), runCli } = {}) {
  const resolvedHome = resolve(home);
  const root = join(resolvedHome, '.gemini');
  const configPath = join(root, 'config', 'config.json');
  const pluginsDir = join(root, 'config', 'plugins');
  const targetDir = join(pluginsDir, AGY_FAST_ID);
  const dataDir = join(root, 'antigravity', 'plugin_data', 'agy-max');
  const parkedDir = join(dataDir, 'parked-plugins', AGY_FAST_ID);
  const localRulesBackupDir = join(dataDir, 'agy-fast-local-rules');
  const managedStateFile = join(dataDir, MANAGED_STATE_FILE);

  const parkedStat = lstatSync(parkedDir, { throwIfNoEntry: false });
  if (parkedStat) {
    if (parkedStat.isSymbolicLink()) {
      return { ok: false, restored: false, retained: [parkedDir] };
    }
    try {
      assertSafeOwned(resolvedHome, pluginsDir);
      assertSafeOwned(resolvedHome, parkedDir);
      const markerPath = join(parkedDir, PARKED_MARKER);
      const markerStat = lstatSync(markerPath, { throwIfNoEntry: false });
      const parkedMeta = markerStat && markerStat.isFile() && !markerStat.isSymbolicLink()
        ? JSON.parse(readFileSync(markerPath, 'utf8'))
        : null;
      if (parkedMeta?.userOwned) {
        assertSafeOwned(resolvedHome, targetDir);
        if (lstatSync(targetDir, { throwIfNoEntry: false })) {
          return { ok: false, restored: false, retained: [parkedDir] };
        }
        assertCleanTree(parkedDir);
        mkdirSync(dirname(targetDir), { recursive: true });
        try {
          cpSync(parkedDir, targetDir, { recursive: true, force: true });
        } catch (err) {
          try { rmSync(targetDir, { recursive: true, force: true }); } catch {}
          throw err;
        }
        try { unlinkSync(join(targetDir, PARKED_MARKER)); } catch {}
        const shouldEnable = parkedMeta.previousEnabled !== false;
        try { updateConfigPluginState(root, configPath, shouldEnable); } catch {}
        if (shouldEnable) tryAgyCliToggle(resolvedHome, true, { runCli });
        try {
          rmSync(parkedDir, { recursive: true, force: true });
        } catch {
          return { ok: false, restored: true, retained: [parkedDir] };
        }
        try { unlinkSync(managedStateFile); } catch {}
        return { ok: true, restored: true, retained: [] };
      }
      if (markerStat && !(parkedMeta && parkedMeta.userOwned === false)) {
        return { ok: false, restored: false, retained: [parkedDir] };
      }
      assertCleanTree(parkedDir);
      rmSync(parkedDir, { recursive: true, force: true });
      return { ok: true, restored: false, retained: [] };
    } catch {
      return { ok: false, restored: false, retained: [parkedDir] };
    }
  }

  try {
    assertSafeOwned(resolvedHome, pluginsDir);
    const targetStat = lstatSync(targetDir, { throwIfNoEntry: false });
    if (targetStat && !targetStat.isSymbolicLink() && existsSync(join(targetDir, MANAGED_MARKER))) {
      assertSafeOwned(resolvedHome, targetDir);
      assertCleanTree(targetDir);
      tryAgyCliToggle(resolvedHome, false, { runCli });
      rmSync(targetDir, { recursive: true, force: true });
      updateConfigPluginState(root, configPath, undefined);
      try { unlinkSync(managedStateFile); } catch {}
      const backupStat = lstatSync(localRulesBackupDir, { throwIfNoEntry: false });
      if (backupStat && !backupStat.isSymbolicLink()) {
        try { rmSync(localRulesBackupDir, { recursive: true, force: true }); } catch {}
      }
      return { ok: true, restored: false, retained: [] };
    }
    if (!targetStat) {
      const hasManagedMarker = Boolean(lstatSync(managedStateFile, { throwIfNoEntry: false }));
      const hasRulesBackup = Boolean(lstatSync(localRulesBackupDir, { throwIfNoEntry: false }));
      if (hasManagedMarker || hasRulesBackup || isDanglingDisabledConfigEntry(root, configPath)) {
        updateConfigPluginState(root, configPath, undefined);
      }
      try { unlinkSync(managedStateFile); } catch {}
    }
    return { ok: true, restored: false, retained: [] };
  } catch {
    return { ok: false, restored: false, retained: [] };
  }
}
