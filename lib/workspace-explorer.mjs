import { execFile } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDatabase } from './database.mjs';
import { resolveLocalFilePath } from './launcher.mjs';

const realpathCanonical = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync;
const MAX_RECENT_WORKSPACES = 20;
const MAX_DIR_ENTRIES = 400;
const MAX_SEARCH_RESULTS = 120;
const MAX_SEARCH_SCAN = 8000;
const MAX_TEXT_PREVIEW_BYTES = 196608;
const MAX_TEXT_EDIT_BYTES = 512 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_NOTEBOOK_BYTES = 5 * 1024 * 1024;
const MAX_NOTEBOOK_CELLS = 60;
const SKIP_SEARCH_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'target', '.cache', '.pytest_cache']);
const IMAGE_MIMES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
});

const toPosix = value => String(value || '').replaceAll('\\', '/');

function collectHomeRoots(homeDir) {
  const roots = new Set();
  for (const candidate of [homeDir, homedir()]) {
    if (!candidate) continue;
    roots.add(toPosix(resolve(candidate)).replace(/\/+$/, '').toLowerCase());
    try {
      roots.add(toPosix(realpathCanonical(candidate)).replace(/\/+$/, '').toLowerCase());
    } catch {}
  }
  return [...roots];
}

function isRestrictedSecretPath(filePath, homeRoots, { isPreview = false } = {}) {
  const norm = toPosix(filePath).replace(/\/+$/, '');
  const lower = norm.toLowerCase();
  const base = basename(norm).toLowerCase();
  for (const hRoot of homeRoots) {
    for (const sub of ['.ssh', '.aws', '.gnupg', '.kube', '.gemini/antigravity/plugin_data/agy-max/accounts', '.gemini/antigravity/plugin_data/agy-powertools/accounts']) {
      const prefix = `${hRoot}/${sub}`;
      if (lower === prefix || lower.startsWith(`${prefix}/`)) return true;
    }
  }
  if (/(?:^|\/)\.(?:ssh|aws|gnupg|kube)(?:\/|$)/i.test(lower)) return true;
  if (/(?:^|\/)\.gemini\/antigravity\/plugin_data\/(?:agy-max|agy-powertools)\/accounts(?:\/|$)/i.test(lower)) return true;
  if (base === 'thought-profiles.json') return true;
  if (lower === '/etc/shadow' || lower === '/etc/master.passwd' || lower === '/etc/sudoers') return true;
  if (isPreview) {
    if (base === '.env' || base.startsWith('.env.')) return true;
    if (/\.(?:pem|key|p12|pfx)$/i.test(base)) return true;
    if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  }
  return false;
}

function defaultRunCommand(cmd, args, options = {}) {
  return new Promise(resolvePromise => {
    execFile(cmd, args, { windowsHide: true, timeout: options.timeoutMs || 60000, maxBuffer: 1024 * 1024, cwd: options.cwd }, (error, stdout = '', stderr = '') => {
      resolvePromise({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        message: error?.message || ''
      });
    });
  });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tempPath, filePath);
}

function isInsideRoot(rootPath, candidatePath, platform = process.platform) {
  const norm = p => (platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(norm(rootPath), norm(candidatePath));
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}

function parseNotebookCells(rawJson) {
  const parsed = JSON.parse(rawJson);
  const rawCells = Array.isArray(parsed?.cells) ? parsed.cells : [];
  const cells = [];
  for (let i = 0; i < rawCells.length && cells.length < MAX_NOTEBOOK_CELLS; i++) {
    const c = rawCells[i];
    if (!c || typeof c !== 'object') continue;
    const cellType = c.cell_type === 'markdown' ? 'markdown' : 'code';
    const source = Array.isArray(c.source) ? c.source.join('') : String(c.source || '');
    const outputs = [];
    if (Array.isArray(c.outputs)) {
      for (const out of c.outputs.slice(0, 6)) {
        if (typeof out?.text === 'string') outputs.push(out.text);
        else if (Array.isArray(out?.text)) outputs.push(out.text.join(''));
        else if (out?.data?.['text/plain']) {
          const plain = out.data['text/plain'];
          outputs.push(Array.isArray(plain) ? plain.join('') : String(plain));
        }
      }
    }
    cells.push({
      index: i + 1,
      type: cellType,
      executionCount: Number.isInteger(c.execution_count) ? c.execution_count : null,
      source: source.slice(0, 16000),
      output: outputs.join('\n').slice(0, 8000)
    });
  }
  return { cells, totalCells: rawCells.length };
}

export function createWorkspaceExplorer({
  dataDir,
  appDir = join(homedir(), '.gemini', 'antigravity'),
  homeDir = homedir(),
  platform = process.platform,
  runCommand = defaultRunCommand
} = {}) {
  const recentFile = dataDir ? join(dataDir, 'recent-workspaces.json') : '';
  const homeRoots = collectHomeRoots(homeDir);
  const approvedRoots = new Map();
  const hostRoots = new Set();

  function rememberApprovedRoot(realDir, updatedAtMs = Date.now()) {
    approvedRoots.set(realDir, Math.max(Number(updatedAtMs) || 0, approvedRoots.get(realDir) || 0));
    if (approvedRoots.size > 80) {
      const oldest = [...approvedRoots.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) approvedRoots.delete(oldest[0]);
    }
  }

  function resolveWorkspaceCandidate(rawOrUri) {
    const raw = String(rawOrUri || '').trim();
    if (!raw) throw new Error('未指定文件夹路径');
    let localPath = '';
    if (raw.startsWith('file://')) {
      localPath = resolveLocalFilePath(raw, { platform });
    } else if (isAbsolute(raw)) {
      localPath = resolve(raw);
    } else {
      throw new Error('文件夹路径格式无效');
    }
    if (!existsSync(localPath)) throw new Error('文件夹不存在');
    const real = realpathCanonical(localPath);
    const st = statSync(real);
    if (!st.isDirectory()) throw new Error('目标路径不是文件夹');
    if (dirname(real) === real) throw new Error('不支持直接挂载系统根目录');
    if (isRestrictedSecretPath(real, homeRoots)) throw new Error('出于安全保护，禁止访问敏感凭证目录');
    return {
      realPath: real,
      uri: pathToFileURL(real).href,
      name: basename(real) || real
    };
  }

  function hydrateSavedRecents() {
    if (!recentFile) return [];
    const saved = readJsonSafe(recentFile, { items: [] });
    const list = Array.isArray(saved?.items) ? saved.items : [];
    const valid = [];
    for (const item of list) {
      try {
        const info = resolveWorkspaceCandidate(item?.uri || item?.path || '');
        const ts = Number(item?.updatedAtMs) || 0;
        valid.push({ uri: info.uri, path: info.realPath, name: info.name, updatedAtMs: ts });
      } catch { /* Skip deleted or invalid folders. */ }
    }
    return valid;
  }

  function saveRecentsList(items) {
    if (!recentFile) return;
    try {
      writeJsonAtomic(recentFile, {
        items: items.slice(0, MAX_RECENT_WORKSPACES).map(it => ({
          uri: it.uri,
          path: it.path,
          name: it.name,
          updatedAtMs: it.updatedAtMs
        }))
      });
    } catch { /* Persistence is optional. */ }
  }

  function discoverDbWorkspaces() {
    const convDir = appDir ? join(appDir, 'conversations') : '';
    if (!convDir || !existsSync(convDir)) return [];
    let files = [];
    try {
      files = readdirSync(convDir, { withFileTypes: true })
        .filter(d => d.isFile() && d.name.endsWith('.db') && !d.name.startsWith('conversation_summaries'))
        .map(d => {
          const full = join(convDir, d.name);
          let mtimeMs = 0;
          try { mtimeMs = statSync(full).mtimeMs; } catch {}
          return { id: d.name.slice(0, -3), mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 24);
    } catch {
      return [];
    }
    const found = [];
    for (const f of files) {
      try {
        const wsUri = readDatabase(appDir, f.id)?.workspaceUri;
        if (!wsUri) continue;
        const info = resolveWorkspaceCandidate(wsUri);
        found.push({ uri: info.uri, path: info.realPath, name: info.name, updatedAtMs: f.mtimeMs });
      } catch {}
    }
    return found;
  }

  function recentWorkspaces({ clientWorkspaces = [] } = {}) {
    const byReal = new Map();
    const merge = (entry, fromHost = false) => {
      try {
        const info = resolveWorkspaceCandidate(entry?.uri || entry?.path || entry);
        const ts = Number(entry?.updatedAtMs) || 0;
        if (fromHost) hostRoots.add(info.realPath);
        const prev = byReal.get(info.realPath);
        if (!prev || ts > prev.updatedAtMs) {
          byReal.set(info.realPath, { uri: info.uri, path: info.realPath, name: info.name, updatedAtMs: ts });
        }
      } catch {}
    };
    for (const item of hydrateSavedRecents()) merge(item);
    for (const item of discoverDbWorkspaces()) merge(item);
    if (Array.isArray(clientWorkspaces)) {
      for (const item of clientWorkspaces.slice(0, 30)) merge(item, true);
      while (hostRoots.size > 80) hostRoots.delete(hostRoots.values().next().value);
    }
    return [...byReal.values()]
      .sort((a, b) => (b.updatedAtMs - a.updatedAtMs) || a.name.localeCompare(b.name))
      .slice(0, MAX_RECENT_WORKSPACES);
  }

  function authorizeWorkspaceRoot(workspaceOrUri, now = Date.now()) {
    const info = resolveWorkspaceCandidate(workspaceOrUri);
    rememberApprovedRoot(info.realPath, now);
    return info;
  }

  function mountWorkspace(workspaceOrUri) {
    const now = Date.now();
    const info = authorizeWorkspaceRoot(workspaceOrUri, now);
    const current = hydrateSavedRecents().filter(it => it.path !== info.realPath);
    current.unshift({ uri: info.uri, path: info.realPath, name: info.name, updatedAtMs: now });
    saveRecentsList(current);
    return { ok: true, uri: info.uri, path: info.realPath, name: info.name };
  }

  function ensureAuthorizedRoot(rootUri) {
    const info = resolveWorkspaceCandidate(rootUri);
    if (approvedRoots.has(info.realPath) || hostRoots.has(info.realPath)) return info;
    const matchesRoot = item => item.path === info.realPath;
    if (!hydrateSavedRecents().some(matchesRoot) && !discoverDbWorkspaces().some(matchesRoot)) {
      throw new Error('工作区尚未授权，请先挂载该文件夹');
    }
    return info;
  }

  function listDir({ rootUri, relPath = '' } = {}) {
    const root = ensureAuthorizedRoot(rootUri);
    const cleanRel = String(relPath || '').trim().replace(/^[/\\]+/, '');
    const targetCandidate = cleanRel ? resolve(root.realPath, cleanRel) : root.realPath;
    if (!existsSync(targetCandidate)) throw new Error('目录不存在');
    const targetReal = realpathCanonical(targetCandidate);
    if (!isInsideRoot(root.realPath, targetReal, platform)) throw new Error('目录路径超出当前工作区');
    if (isRestrictedSecretPath(targetReal, homeRoots)) throw new Error('出于安全保护，禁止访问敏感目录');
    const st = statSync(targetReal);
    if (!st.isDirectory()) throw new Error('目标不是文件夹');

    const dirents = readdirSync(targetReal, { withFileTypes: true });
    const items = [];
    for (const d of dirents) {
      const childFull = join(targetReal, d.name);
      let isDir = d.isDirectory();
      let childReal = childFull;
      if (d.isSymbolicLink()) {
        try {
          childReal = realpathCanonical(childFull);
          if (!isInsideRoot(root.realPath, childReal, platform)) continue;
          isDir = statSync(childReal).isDirectory();
        } catch {
          continue;
        }
      }
      if (isRestrictedSecretPath(childReal, homeRoots)) continue;
      const childRel = toPosix(relative(root.realPath, childFull));
      items.push({
        name: d.name,
        relPath: childRel,
        uri: pathToFileURL(childReal).href,
        isDirectory: isDir
      });
    }
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    const truncated = items.length > MAX_DIR_ENTRIES;
    return {
      ok: true,
      rootUri: root.uri,
      rootName: root.name,
      rootPath: root.realPath,
      relPath: toPosix(relative(root.realPath, targetReal)),
      entries: truncated ? items.slice(0, MAX_DIR_ENTRIES) : items,
      truncated
    };
  }

  function searchFiles({ rootUri, query = '', limit = MAX_SEARCH_RESULTS } = {}) {
    const q = String(query || '').trim().replace(/\\/g, '/').toLowerCase();
    if (!q) return listDir({ rootUri });
    const root = ensureAuthorizedRoot(rootUri);
    const cap = Math.max(1, Math.min(Number(limit) || MAX_SEARCH_RESULTS, 200));
    const queue = [root.realPath];
    const matches = [];
    let scanned = 0;
    let truncated = false;

    while (queue.length > 0 && scanned < MAX_SEARCH_SCAN) {
      const currentDir = queue.shift();
      let dirents;
      try {
        dirents = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        scanned++;
        if (scanned > MAX_SEARCH_SCAN) { truncated = true; break; }
        const full = join(currentDir, d.name);
        let isDir = d.isDirectory();
        let real = full;
        if (d.isSymbolicLink()) {
          try {
            real = realpathCanonical(full);
            if (!isInsideRoot(root.realPath, real, platform)) continue;
            isDir = statSync(real).isDirectory();
          } catch {
            continue;
          }
        }
        if (isRestrictedSecretPath(real, homeRoots)) continue;
        const relPosix = toPosix(relative(root.realPath, full));
        const nameLower = d.name.toLowerCase();
        const relLower = relPosix.toLowerCase();
        if (nameLower.includes(q) || relLower.includes(q)) {
          const score = nameLower === q ? 0 : nameLower.startsWith(q) ? 1 : nameLower.includes(q) ? 2 : 3;
          matches.push({
            name: d.name,
            relPath: relPosix,
            uri: pathToFileURL(real).href,
            isDirectory: isDir,
            score
          });
        }
        if (isDir && (!SKIP_SEARCH_DIRS.has(d.name) || q.includes(nameLower))) {
          queue.push(real);
        }
      }
    }

    matches.sort((a, b) => (a.score - b.score) || (a.relPath.length - b.relPath.length) || a.relPath.localeCompare(b.relPath));
    if (matches.length > cap) truncated = true;
    return {
      ok: true,
      rootUri: root.uri,
      rootName: root.name,
      entries: matches.slice(0, cap).map(({ score, ...rest }) => rest),
      truncated
    };
  }

  function resolveAuthorizedFile(rootUri, fileUri) {
    const raw = String(fileUri || '').trim();
    if (!raw) throw new Error('未指定文件');
    const localPath = raw.startsWith('file://') ? resolveLocalFilePath(raw, { platform }) : (isAbsolute(raw) ? resolve(raw) : '');
    if (!localPath || !existsSync(localPath)) throw new Error('文件不存在');
    const realFile = realpathCanonical(localPath);
    if (isRestrictedSecretPath(realFile, homeRoots, { isPreview: true })) throw new Error('出于安全保护，禁止预览敏感凭证文件');
    const st = lstatSync(realFile);
    if (!st.isFile()) throw new Error('目标不是普通文件');

    let authorized = false;
    if (rootUri) {
      const root = ensureAuthorizedRoot(rootUri);
      authorized = isInsideRoot(root.realPath, realFile, platform);
    }
    if (!authorized) {
      hydrateSavedRecents();
      for (const approved of approvedRoots.keys()) {
        if (isInsideRoot(approved, realFile, platform)) { authorized = true; break; }
      }
    }
    if (!authorized) throw new Error('文件不在当前已授权的项目目录内');
    return { realFile, st };
  }

  function writeTextFile({ rootUri = '', fileUri = '', content, expectedMtimeMs, overwrite = false } = {}) {
    if (typeof content !== 'string') throw new Error('文件内容无效');
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_EDIT_BYTES) throw new Error('文件内容超过 512 KB，请在外部编辑器中修改');
    const { realFile, st } = resolveAuthorizedFile(rootUri, fileUri);
    // Someone else (usually the agent) changed the file since it was opened; let the user decide.
    if (!overwrite && st.mtimeMs !== Number(expectedMtimeMs)) return { ok: false, conflict: true, mtimeMs: st.mtimeMs };
    const tmp = join(dirname(realFile), `.${basename(realFile)}.agy-save-${process.pid}-${Date.now()}`);
    try {
      writeFileSync(tmp, content, 'utf8');
      chmodSync(tmp, st.mode & 0o7777);
      renameSync(tmp, realFile);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* Temp file may not exist. */ }
      throw error;
    }
    const next = statSync(realFile);
    return { ok: true, mtimeMs: next.mtimeMs, size: next.size };
  }

  function readFilePreview({ rootUri = '', fileUri = '' } = {}) {
    const { realFile, st } = resolveAuthorizedFile(rootUri, fileUri);
    const uri = pathToFileURL(realFile).href;
    const name = basename(realFile);
    const ext = extname(name).toLowerCase();
    const size = st.size;

    if (Object.hasOwn(IMAGE_MIMES, ext) && size <= MAX_IMAGE_PREVIEW_BYTES) {
      const bytes = readFileSync(realFile);
      return {
        ok: true,
        kind: 'image',
        name,
        path: realFile,
        uri,
        size,
        dataUrl: `data:${IMAGE_MIMES[ext]};base64,${bytes.toString('base64')}`
      };
    }

    if (ext === '.ipynb' && size <= MAX_NOTEBOOK_BYTES) {
      try {
        const rawText = readFileSync(realFile, 'utf8');
        const nb = parseNotebookCells(rawText);
        return {
          ok: true,
          kind: 'notebook',
          name,
          path: realFile,
          uri,
          size,
          cells: nb.cells,
          totalCells: nb.totalCells
        };
      } catch { /* Fall through to text preview if malformed JSON. */ }
    }

    const binaryExts = new Set(['.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.dmg', '.exe', '.dll', '.so', '.dylib', '.pt', '.pth', '.ckpt', '.safetensors', '.onnx', '.bin', '.mp4', '.mov', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);
    if (binaryExts.has(ext)) {
      return { ok: true, kind: 'binary', name, path: realFile, uri, size, ext };
    }

    const readLen = Math.min(size, MAX_TEXT_PREVIEW_BYTES);
    const buf = Buffer.allocUnsafe(readLen);
    const fd = openSync(realFile, 'r');
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, readLen, 0);
    } finally {
      closeSync(fd);
    }
    const slice = buf.subarray(0, bytesRead);
    const probeLen = Math.min(bytesRead, 4096);
    for (let i = 0; i < probeLen; i++) {
      if (slice[i] === 0) {
        return { ok: true, kind: 'binary', name, path: realFile, uri, size, ext };
      }
    }
    const content = slice.toString('utf8');
    const truncated = size > MAX_TEXT_PREVIEW_BYTES;
    return {
      ok: true,
      kind: 'text',
      name,
      path: realFile,
      uri,
      size,
      mtimeMs: st.mtimeMs,
      content,
      truncated,
      // Non-UTF-8 files (e.g. GBK) would be corrupted by a lossy round trip, so they stay read-only.
      editable: !truncated && Buffer.from(content, 'utf8').equals(slice)
    };
  }

  async function pickFolder() {
    let res;
    if (platform === 'darwin') {
      res = await runCommand('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择要浏览的项目文件夹")']);
      if (!res.ok) {
        if (/(-128|User canceled|用户已取消)/i.test(`${res.stderr} ${res.message}`)) return { ok: true, cancelled: true };
        throw new Error('无法打开文件夹选择器');
      }
    } else if (platform === 'win32') {
      const ps = [
        '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);',
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        '$d.Description = "选择要浏览的项目文件夹";',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'
      ].join(' ');
      res = await runCommand('powershell.exe', ['-NoProfile', '-STA', '-Command', ps]);
      if (!res.ok) throw new Error('无法打开文件夹选择器');
      if (!res.stdout.trim()) return { ok: true, cancelled: true };
    } else {
      res = await runCommand('zenity', ['--file-selection', '--directory', '--title=选择要浏览的项目文件夹']);
      if (!res.ok) {
        if (res.code === 1) return { ok: true, cancelled: true };
        const kd = await runCommand('kdialog', ['--getexistingdirectory', homeDir]);
        if (!kd.ok) return { ok: true, cancelled: true };
        res = kd;
      }
    }
    const picked = res.stdout.trim();
    if (!picked) return { ok: true, cancelled: true };
    return { ...mountWorkspace(picked), cancelled: false };
  }

  return {
    recentWorkspaces,
    mountWorkspace,
    authorizeWorkspaceRoot,
    listDir,
    searchFiles,
    readFilePreview,
    writeTextFile,
    pickFolder
  };
}
