import { execFile } from 'node:child_process';
import { existsSync, lstatSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLocalFilePath } from './launcher.mjs';

const STATUS_CACHE = new Map();
const POSITIVE_TTL_MS = 8000;
const NEGATIVE_TTL_MS = 15000;
const realpathCanonical = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync;

const GIT_HARDENING_FLAGS = [
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.sshCommand=false',
  '-c', 'diff.external=',
  '-c', 'core.pager=cat'
];
const GIT_SAFE_DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'];

function runGit(cwd, args, { execGit = execFile, timeoutMs = 3500 } = {}) {
  return new Promise(resolvePromise => {
    execGit(
      'git',
      [...GIT_HARDENING_FLAGS, ...args],
      {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      },
      (error, stdout = '', stderr = '') => {
        resolvePromise({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || '')
        });
      }
    );
  });
}

async function hasLocalGitFilters(repoRootReal, { execGit = execFile } = {}) {
  const localFilters = await runGit(
    repoRootReal,
    ['config', '--local', '--includes', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'],
    { execGit }
  );
  // git config exits with code 1 when no keys match; exit 0 (matches) or any error fails closed.
  return localFilters.code !== 1;
}

function isOutsideRoot(rootReal, targetPath) {
  const rel = relative(rootReal, targetPath);
  return !rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel);
}

function hasForbiddenRepoSegment(relPath) {
  return relPath.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git');
}

function resolveWorkspaceDir(workspaceOrUri, { platform = process.platform } = {}) {
  const raw = String(workspaceOrUri || '').trim();
  if (!raw) return '';
  if (raw.startsWith('file://')) {
    try { return resolveLocalFilePath(raw, { platform }); } catch { return ''; }
  }
  return isAbsolute(raw) ? raw : '';
}

function unquoteGitPath(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  try {
    const inner = s.slice(1, -1);
    const bytes = [];
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\' && i + 1 < inner.length) {
        const next = inner[i + 1];
        if (/[0-7]{3}/.test(inner.slice(i + 1, i + 4))) {
          bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
          i += 3;
          continue;
        }
        const map = { n: 10, r: 13, t: 9, '\\': 92, '"': 34 };
        if (map[next] !== undefined) {
          bytes.push(map[next]);
          i++;
          continue;
        }
      }
      bytes.push(...Buffer.from(inner[i], 'utf8'));
    }
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return s.slice(1, -1);
  }
}

function mapPorcelainStatus(xy) {
  const pair = String(xy || '').padEnd(2, '.');
  if (pair.includes('U') || pair === 'AA' || pair === 'DD') return 'U';
  if (pair[0] === 'R' || pair[1] === 'R') return 'R';
  if (pair[0] === 'A' || pair[1] === 'A') return 'A';
  if (pair[0] === 'D' || pair[1] === 'D') return 'D';
  return 'M';
}

export function parsePorcelainV2Status(output) {
  let branch = 'HEAD';
  let oid = '';
  let ahead = 0;
  let behind = 0;
  const files = [];

  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      oid = line.slice(13).trim();
    } else if (line.startsWith('# branch.head ')) {
      branch = line.slice(14).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.slice(12).trim().match(/^\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number(m[1]) || 0;
        behind = Number(m[2]) || 0;
      }
    } else if (line.startsWith('? ')) {
      const filePath = unquoteGitPath(line.slice(2));
      if (filePath) files.push({ path: filePath, status: '?' });
    } else if (line.startsWith('1 ') || line.startsWith('u ')) {
      const isUnmerged = line.startsWith('u ');
      const parts = line.split(' ');
      const xy = parts[1] || 'M.';
      const minCols = isUnmerged ? 10 : 8;
      let idx = 0;
      for (let count = 0; count < minCols && idx >= 0; count++) {
        idx = line.indexOf(' ', idx) + 1;
      }
      const filePath = idx > 0 ? unquoteGitPath(line.slice(idx)) : '';
      if (filePath) files.push({ path: filePath, status: isUnmerged ? 'U' : mapPorcelainStatus(xy) });
    } else if (line.startsWith('2 ')) {
      const parts = line.split(' ');
      const xy = parts[1] || 'R.';
      let idx = 0;
      for (let count = 0; count < 9 && idx >= 0; count++) {
        idx = line.indexOf(' ', idx) + 1;
      }
      if (idx > 0) {
        const rest = line.slice(idx);
        const tabIdx = rest.indexOf('\t');
        const newPath = unquoteGitPath(tabIdx >= 0 ? rest.slice(0, tabIdx) : rest);
        if (newPath) files.push({ path: newPath, status: mapPorcelainStatus(xy) });
      }
    }
  }

  if (branch === '(detached)' || !branch) {
    branch = oid && oid !== '(initial)' ? `HEAD@${oid.slice(0, 7)}` : 'HEAD';
  }
  return { branch, ahead, behind, files };
}

export function parseNumstat(output) {
  const map = new Map();
  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const binary = parts[0] === '-' || parts[1] === '-';
    const add = binary ? 0 : (Number(parts[0]) || 0);
    const del = binary ? 0 : (Number(parts[1]) || 0);
    let filePath = unquoteGitPath(parts.slice(2).join('\t'));
    const arrowMatch = filePath.match(/^(.*)\{[^}]* => ([^}]*)\}(.*)$/);
    if (arrowMatch) {
      filePath = `${arrowMatch[1]}${arrowMatch[2]}${arrowMatch[3]}`.replace(/\/+/g, '/');
    } else if (filePath.includes(' => ')) {
      filePath = filePath.split(' => ').pop().trim();
    }
    const prev = map.get(filePath) || { additions: 0, deletions: 0, binary: false };
    map.set(filePath, {
      additions: prev.additions + add,
      deletions: prev.deletions + del,
      binary: prev.binary || binary
    });
  }
  return map;
}

function countUntrackedTextLines(fullPath, repoRootReal, maxBytes = 131072) {
  let fd;
  try {
    const rel = relative(repoRootReal, fullPath);
    if (isOutsideRoot(repoRootReal, fullPath) || hasForbiddenRepoSegment(rel)) {
      return { additions: 0, binary: false };
    }
    let cursor = repoRootReal;
    for (const part of rel.split(/[\\/]/)) {
      cursor = join(cursor, part);
      const segStat = lstatSync(cursor, { throwIfNoEntry: false });
      if (!segStat || segStat.isSymbolicLink()) return { additions: 0, binary: false };
    }
    const lst = lstatSync(fullPath, { throwIfNoEntry: false });
    if (!lst || lst.isSymbolicLink() || !lst.isFile() || lst.size <= 0 || lst.size > maxBytes) {
      return { additions: 0, binary: false };
    }
    const realFull = realpathCanonical(fullPath);
    if (isOutsideRoot(repoRootReal, realFull) || hasForbiddenRepoSegment(relative(repoRootReal, realFull))) {
      return { additions: 0, binary: false };
    }
    fd = openSync(realFull, 'r');
    const buf = Buffer.allocUnsafe(lst.size);
    const n = readSync(fd, buf, 0, lst.size, 0);
    const slice = buf.subarray(0, n);
    if (slice.includes(0)) return { additions: 0, binary: true };
    const text = slice.toString('utf8');
    const lines = text.split('\n');
    const count = text.endsWith('\n') ? Math.max(0, lines.length - 1) : lines.length;
    return { additions: count, binary: false };
  } catch {
    return { additions: 0, binary: false };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export async function readGitStatus(workspaceOrUri, { force = false, platform = process.platform, execGit = execFile, now = Date.now() } = {}) {
  const dir = resolveWorkspaceDir(workspaceOrUri, { platform });
  if (!dir || !existsSync(dir)) return { ok: true, isRepo: false };

  const cached = STATUS_CACHE.get(dir);
  if (!force && cached && cached.expiresAt > now) return cached.value;

  const topRes = await runGit(dir, ['rev-parse', '--show-toplevel'], { execGit });
  if (!topRes.ok || !topRes.stdout.trim()) {
    const miss = { ok: true, isRepo: false };
    STATUS_CACHE.set(dir, { value: miss, expiresAt: now + NEGATIVE_TTL_MS });
    return miss;
  }
  const repoRoot = topRes.stdout.trim();
  const repoRootReal = realpathCanonical(repoRoot);
  if (await hasLocalGitFilters(repoRootReal, { execGit })) {
    const miss = { ok: true, isRepo: false };
    STATUS_CACHE.set(dir, { value: miss, expiresAt: now + NEGATIVE_TTL_MS });
    return miss;
  }
  const statusRes = await runGit(repoRootReal, ['status', '--porcelain=v2', '--branch', '-uall'], { execGit });
  if (!statusRes.ok) {
    const miss = { ok: true, isRepo: false };
    STATUS_CACHE.set(dir, { value: miss, expiresAt: now + NEGATIVE_TTL_MS });
    return miss;
  }

  const parsed = parsePorcelainV2Status(statusRes.stdout);
  let numstatMap = new Map();
  if (parsed.files.length > 0) {
    const diffHead = await runGit(repoRootReal, ['diff', 'HEAD', ...GIT_SAFE_DIFF_FLAGS, '--numstat', '--'], { execGit });
    if (diffHead.ok) {
      numstatMap = parseNumstat(diffHead.stdout);
    } else {
      const [unstaged, staged] = await Promise.all([
        runGit(repoRootReal, ['diff', ...GIT_SAFE_DIFF_FLAGS, '--numstat', '--'], { execGit }),
        runGit(repoRootReal, ['diff', '--cached', ...GIT_SAFE_DIFF_FLAGS, '--numstat', '--'], { execGit })
      ]);
      numstatMap = parseNumstat(`${unstaged.stdout}\n${staged.stdout}`);
    }
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  const enriched = parsed.files.map(entry => {
    const normalizedRel = entry.path.replace(/\\/g, '/');
    const fullPath = resolve(repoRootReal, normalizedRel);
    let statInfo = numstatMap.get(normalizedRel) || numstatMap.get(entry.path) || null;
    if (!statInfo && entry.status === '?') {
      const untracked = countUntrackedTextLines(fullPath, repoRootReal);
      statInfo = { additions: untracked.additions, deletions: 0, binary: untracked.binary };
    }
    const additions = statInfo?.additions || 0;
    const deletions = statInfo?.deletions || 0;
    totalAdditions += additions;
    totalDeletions += deletions;
    return {
      path: normalizedRel,
      uri: pathToFileURL(fullPath).href,
      status: entry.status,
      additions,
      deletions,
      binary: Boolean(statInfo?.binary)
    };
  });

  const maxFiles = 120;
  const value = {
    ok: true,
    isRepo: true,
    repoRoot: repoRootReal,
    repoUri: pathToFileURL(repoRootReal).href,
    branch: parsed.branch,
    ahead: parsed.ahead,
    behind: parsed.behind,
    changedCount: enriched.length,
    additions: totalAdditions,
    deletions: totalDeletions,
    truncatedFiles: enriched.length > maxFiles,
    files: enriched.slice(0, maxFiles),
    updatedAtMs: now
  };
  STATUS_CACHE.set(dir, { value, expiresAt: now + POSITIVE_TTL_MS });
  if (STATUS_CACHE.size > 24) STATUS_CACHE.delete(STATUS_CACHE.keys().next().value);
  return value;
}

function safeRepoSubpath(repoRoot, relPath) {
  const raw = String(relPath || '').trim();
  if (!raw || raw.includes('\0') || isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new Error('无效的仓库内文件路径');
  }
  const repoRootReal = realpathCanonical(repoRoot);
  const full = resolve(repoRootReal, raw);
  const rel = relative(repoRootReal, full);
  if (isOutsideRoot(repoRootReal, full)) throw new Error('文件路径越界');
  if (hasForbiddenRepoSegment(rel)) {
    if (rel.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) {
      throw new Error('禁止访问 .git 目录内文件');
    }
    throw new Error('文件路径越界');
  }

  let cursor = repoRootReal;
  let nearestExisting = repoRootReal;
  for (const part of rel.split(/[\\/]/)) {
    cursor = join(cursor, part);
    const lst = lstatSync(cursor, { throwIfNoEntry: false });
    if (!lst) break;
    if (lst.isSymbolicLink()) {
      throw new Error('禁止读取符号链接文件');
    }
    nearestExisting = cursor;
  }

  const targetLstat = lstatSync(full, { throwIfNoEntry: false });
  if (targetLstat) {
    if (targetLstat.isSymbolicLink()) {
      throw new Error('禁止读取符号链接文件');
    }
    const realFull = realpathCanonical(full);
    if (isOutsideRoot(repoRootReal, realFull)) {
      throw new Error('文件路径越界');
    }
    const realRel = relative(repoRootReal, realFull);
    if (hasForbiddenRepoSegment(realRel)) {
      throw new Error('禁止访问 .git 目录内文件');
    }
    return { full: realFull, rel: realRel.replace(/\\/g, '/'), exists: true };
  }

  const realAncestor = realpathCanonical(nearestExisting);
  if (realAncestor !== repoRootReal && isOutsideRoot(repoRootReal, realAncestor)) {
    throw new Error('文件路径越界');
  }
  return { full, rel: rel.replace(/\\/g, '/'), exists: false };
}

function capPatchText(rawPatch, maxLines = 220, maxChars = 24000) {
  const text = String(rawPatch || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return { patch: '', truncated: false };
  const sliced = text.length > maxChars ? text.slice(0, maxChars) : text;
  const lines = sliced.split('\n');
  const truncated = text.length > maxChars || lines.length > maxLines;
  return {
    patch: (lines.length > maxLines ? lines.slice(0, maxLines) : lines).join('\n'),
    truncated
  };
}

export async function readGitFileDiff(workspaceOrUri, relPath, { status = '', platform = process.platform, execGit = execFile } = {}) {
  const dir = resolveWorkspaceDir(workspaceOrUri, { platform });
  if (!dir || !existsSync(dir)) throw new Error('工作区目录不存在');
  const topRes = await runGit(dir, ['rev-parse', '--show-toplevel'], { execGit });
  if (!topRes.ok || !topRes.stdout.trim()) throw new Error('当前目录不是 Git 仓库');
  const repoRootReal = realpathCanonical(topRes.stdout.trim());
  if (await hasLocalGitFilters(repoRootReal, { execGit })) {
    throw new Error('为避免运行外部过滤器，已关闭此仓库的 Git 差异预览');
  }
  const { full, rel, exists } = safeRepoSubpath(repoRootReal, relPath);

  const untrackedRes = await runGit(
    repoRootReal,
    ['ls-files', '--others', '--exclude-standard', '-z', '--', rel],
    { execGit }
  );
  const isUntracked = untrackedRes.ok && untrackedRes.stdout.split('\0').includes(rel);

  if (isUntracked && exists) {
    let fd;
    try {
      const lst = lstatSync(full, { throwIfNoEntry: false });
      if (!lst || lst.isSymbolicLink() || !lst.isFile()) {
        return { ok: true, path: rel, patch: '', binary: false, truncated: false };
      }
      const readLen = Math.min(lst.size, 32768);
      fd = openSync(full, 'r');
      const buf = Buffer.allocUnsafe(readLen);
      const n = readLen > 0 ? readSync(fd, buf, 0, readLen, 0) : 0;
      const slice = buf.subarray(0, n);
      if (slice.includes(0)) return { ok: true, path: rel, patch: '', binary: true, truncated: false };
      const rawLines = slice.toString('utf8').replace(/\r\n/g, '\n').split('\n');
      if (rawLines.at(-1) === '') rawLines.pop();
      const synthetic = [
        `--- /dev/null`,
        `+++ b/${rel}`,
        `@@ -0,0 +1,${rawLines.length} @@`,
        ...rawLines.map(l => `+${l}`)
      ].join('\n');
      const capped = capPatchText(synthetic);
      return { ok: true, path: rel, patch: capped.patch, binary: false, truncated: capped.truncated || lst.size > readLen };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
  }

  let diffRes = await runGit(repoRootReal, ['diff', 'HEAD', ...GIT_SAFE_DIFF_FLAGS, '--unified=3', '--', rel], { execGit });
  if (!diffRes.ok) {
    const [unstaged, staged] = await Promise.all([
      runGit(repoRootReal, ['diff', ...GIT_SAFE_DIFF_FLAGS, '--unified=3', '--', rel], { execGit }),
      runGit(repoRootReal, ['diff', '--cached', ...GIT_SAFE_DIFF_FLAGS, '--unified=3', '--', rel], { execGit })
    ]);
    diffRes = { ok: true, stdout: [staged.stdout, unstaged.stdout].filter(Boolean).join('\n') };
  }
  const out = diffRes.stdout || '';
  if (/^Binary files .* differ$/m.test(out)) {
    return { ok: true, path: rel, patch: '', binary: true, truncated: false };
  }
  const capped = capPatchText(out);
  return { ok: true, path: rel, patch: capped.patch, binary: false, truncated: capped.truncated };
}
