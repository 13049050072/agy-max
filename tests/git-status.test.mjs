import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePorcelainV2Status, parseNumstat, readGitStatus, readGitFileDiff } from '../lib/git-status.mjs';

test('parsePorcelainV2Status and parseNumstat handle branches, detached HEAD, renames, and quoted UTF-8 paths', () => {
  const porcelain = [
    '# branch.oid 1234567890abcdef',
    '# branch.head feat/codex-ui',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/app.mjs',
    '? "docs/\\344\\270\\255\\346\\226\\207.md"'
  ].join('\n');
  const status = parsePorcelainV2Status(porcelain);
  assert.equal(status.branch, 'feat/codex-ui');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.deepEqual(status.files, [
    { path: 'src/app.mjs', status: 'M' },
    { path: 'docs/中文.md', status: '?' }
  ]);

  const detached = parsePorcelainV2Status('# branch.oid abcdef012345\n# branch.head (detached)\n');
  assert.equal(detached.branch, 'HEAD@abcdef0');

  const numstat = parseNumstat('12\t4\tsrc/app.mjs\n-\t-\tassets/logo.png\n');
  assert.deepEqual(numstat.get('src/app.mjs'), { additions: 12, deletions: 4, binary: false });
  assert.deepEqual(numstat.get('assets/logo.png'), { additions: 0, deletions: 0, binary: true });
});

test('readGitStatus and readGitFileDiff use --no-optional-locks, count untracked lines, preview diffs, and reject path traversal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-git-repo-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    const init = git('init', '-b', 'main');
    if (init.status !== 0) git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    writeFileSync(join(dir, 'hello.js'), 'const a = 1;\nconst b = 2;\n');
    git('add', 'hello.js');
    git('commit', '-m', 'init');

    writeFileSync(join(dir, 'hello.js'), 'const a = 1;\nconst b = 42;\nconst c = 3;\n');
    writeFileSync(join(dir, 'new-note.txt'), 'line1\nline2\nline3\n');

    const observedArgs = [];
    const trackingExec = (cmd, args, opts, cb) => {
      observedArgs.push(args);
      return execFile(cmd, args, opts, cb);
    };

    const uri = pathToFileURL(dir).href;
    const status = await readGitStatus(uri, { force: true, execGit: trackingExec });
    assert.equal(status.isRepo, true);
    assert.ok(observedArgs.every(args => args[0] === '--no-optional-locks'));
    assert.equal(status.changedCount, 2);
    assert.equal(status.additions, 5);
    assert.equal(status.deletions, 1);

    const modPatch = await readGitFileDiff(uri, 'hello.js', { status: 'M', execGit: trackingExec });
    assert.equal(modPatch.ok, true);
    assert.match(modPatch.patch, /\+const b = 42;/);
    assert.match(modPatch.patch, /-const b = 2;/);

    const untrackedPatch = await readGitFileDiff(uri, 'new-note.txt', { status: '?', execGit: trackingExec });
    assert.equal(untrackedPatch.ok, true);
    assert.match(untrackedPatch.patch, /\+line1/);

    await assert.rejects(() => readGitFileDiff(uri, '../outside.txt'), /越界/);
    await assert.rejects(() => readGitFileDiff(uri, '/etc/passwd'), /无效/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readGitStatus and readGitFileDiff enforce Git hardening flags, block fsmonitor/local filters, reject symlinks/.git, verify untracked status, and support deleted files', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'agy-git-hardening-'));
  const dir = join(temp, 'repo');
  mkdirSync(dir, { recursive: true });
  try {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    const init = git('init', '-b', 'main');
    if (init.status !== 0) git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');

    writeFileSync(join(dir, '.gitignore'), 'ignored-secret.txt\n');
    writeFileSync(join(dir, 'tracked.txt'), 'tracked-v1\n');
    writeFileSync(join(dir, 'to-delete.txt'), 'gone-line-1\ngone-line-2\n');
    git('add', '.gitignore', 'tracked.txt', 'to-delete.txt');
    git('commit', '-m', 'init');

    writeFileSync(join(dir, 'tracked.txt'), 'tracked-v2\n');
    writeFileSync(join(dir, 'ignored-secret.txt'), 'SUPER_SECRET_DO_NOT_LEAK\n');
    unlinkSync(join(dir, 'to-delete.txt'));
    writeFileSync(join(temp, 'outside-secret.txt'), 'OUTSIDE_SECRET_CONTENT\nline2\nline3\n');

    if (process.platform !== 'win32') {
      symlinkSync(join(temp, 'outside-secret.txt'), join(dir, 'evil-link.txt'));
      symlinkSync(temp, join(dir, 'evil-dir-link'));
    }

    // Configure malicious core.fsmonitor that would create a marker file if ever executed
    const markerFile = join(temp, 'fsmonitor-pwned.txt');
    git('config', 'core.fsmonitor', `node -e "require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'pwned')"`);

    const observed = [];
    const trackingExec = (cmd, args, opts, cb) => {
      observed.push({ args, env: opts?.env });
      return execFile(cmd, args, opts, cb);
    };

    const uri = pathToFileURL(dir).href;
    const status = await readGitStatus(uri, { force: true, execGit: trackingExec });
    assert.equal(status.isRepo, true);
    assert.equal(existsSync(markerFile), false, 'core.fsmonitor must never execute during readGitStatus');

    // Symlink must not be followed to count lines of outside file
    if (process.platform !== 'win32') {
      const linkEntry = status.files.find(f => f.path === 'evil-link.txt');
      if (linkEntry) assert.equal(linkEntry.additions, 0);
    }

    // Deleted tracked file diff still works
    const delDiff = await readGitFileDiff(uri, 'to-delete.txt', { execGit: trackingExec });
    assert.equal(delDiff.ok, true);
    assert.match(delDiff.patch, /-gone-line-1/);

    // Spoofed status='?' must NOT dump gitignored or tracked files directly via openSync
    const spoofedIgnored = await readGitFileDiff(uri, 'ignored-secret.txt', { status: '?', execGit: trackingExec });
    assert.equal(spoofedIgnored.ok, true);
    assert.equal(spoofedIgnored.patch, '');
    assert.equal(spoofedIgnored.patch.includes('SUPER_SECRET_DO_NOT_LEAK'), false);

    const spoofedTracked = await readGitFileDiff(uri, 'tracked.txt', { status: '?', execGit: trackingExec });
    assert.equal(spoofedTracked.ok, true);
    assert.match(spoofedTracked.patch, /-tracked-v1/);
    assert.match(spoofedTracked.patch, /\+tracked-v2/);

    // .git subpaths and symlinks are always rejected (even with spoofed status='?')
    await assert.rejects(() => readGitFileDiff(uri, '.git/config', { status: '?', execGit: trackingExec }), /\.git/);
    if (process.platform !== 'win32') {
      await assert.rejects(() => readGitFileDiff(uri, 'evil-link.txt', { status: '?', execGit: trackingExec }), /符号链接/);
      await assert.rejects(() => readGitFileDiff(uri, 'evil-dir-link/outside-secret.txt', { status: '?', execGit: trackingExec }), /符号链接/);
    }

    assert.equal(existsSync(markerFile), false, 'core.fsmonitor must never execute during readGitFileDiff');

    // Verify all hardening flags and env on every git invocation
    assert.ok(observed.length > 0);
    for (const { args, env } of observed) {
      assert.equal(args[0], '--no-optional-locks');
      assert.ok(args.includes('--literal-pathspecs'));
      assert.ok(args.includes('core.fsmonitor=false'));
      assert.ok(args.includes('core.untrackedCache=false'));
      assert.ok(args.includes('core.sshCommand=false'));
      assert.ok(args.includes('diff.external='));
      assert.ok(args.includes('core.pager=cat'));
      assert.equal(env?.GIT_TERMINAL_PROMPT, '0');
      const diffIdx = args.indexOf('diff');
      if (diffIdx >= 0) {
        assert.ok(args.includes('--no-ext-diff'));
        assert.ok(args.includes('--no-textconv'));
        assert.ok(args.includes('--ignore-submodules=all'));
      }
    }

    // Local filter.*.clean must block both readGitStatus and readGitFileDiff
    git('config', 'filter.evil.clean', 'cat');
    const blockedStatus = await readGitStatus(uri, { force: true, execGit: trackingExec });
    assert.equal(blockedStatus.isRepo, false);
    await assert.rejects(() => readGitFileDiff(uri, 'tracked.txt', { execGit: trackingExec }), /过滤器/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('readGitStatus distinguishes Git unavailable, timeout, and a non-repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-git-status-reasons-'));
  try {
    const noGit = () => { throw Object.assign(new Error('git not found'), { code: 'ENOENT' }); };
    const timeout = (_cmd, _args, _opts, done) => done({ killed: true, signal: 'SIGTERM' });
    const nonRepo = (_cmd, _args, _opts, done) => done({ code: 128 }, '', 'fatal: not a git repository');
    for (const [execGit, ok, reason] of [
      [noGit, false, 'git-unavailable'],
      [timeout, false, 'git-timeout'],
      [nonRepo, true, 'not-a-repo']
    ]) {
      assert.deepEqual(await readGitStatus(dir, { force: true, execGit }), { ok, isRepo: false, reason });
      await assert.rejects(() => readGitFileDiff(dir, 'readme.md', { execGit }), { code: reason });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readGitStatus retains Chinese filenames from UTF-8 porcelain and numstat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-git-status-unicode-'));
  try {
    const name = '\u8d44\u6599 \u7b14\u8bb0.txt';
    const execGit = (_cmd, args, _opts, done) => {
      assert.ok(args.includes('core.quotepath=false'));
      if (args.includes('rev-parse')) done(null, dir + '\n');
      else if (args.includes('config')) done({ code: 1 });
      else if (args.includes('status')) done(null, '1 .M N... 100644 100644 100644 aaa bbb ' + name + '\n');
      else done(null, '3\t2\t' + name + '\n');
    };
    const status = await readGitStatus(dir, { force: true, execGit });
    assert.equal(status.files[0].path, name);
    assert.equal(status.additions, 3);
    assert.equal(status.deletions, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
