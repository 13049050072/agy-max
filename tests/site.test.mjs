import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../scripts/build-site.mjs';
import { collectPackage } from '../lib/package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function extractLocalRefs(html) {
  const refs = [];
  const pattern = /(?:href|src|data-shot-src)="([^"]+)"/g;
  for (const match of html.matchAll(pattern)) {
    const value = match[1];
    if (!value || value.startsWith('http://') || value.startsWith('https://') || value.startsWith('#') || value.startsWith('mailto:')) {
      continue;
    }
    refs.push(value);
  }
  return refs;
}

test('buildSite generates bilingual pages with valid relative assets', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'agy-max-site-'));
  try {
    const result = buildSite({ root, outDir });
    assert.equal(result.images, 9);
    assert.equal(existsSync(join(outDir, '.nojekyll')), true);

    for (const relPage of ['index.html', 'zh/index.html']) {
      const pagePath = join(outDir, relPage);
      assert.equal(existsSync(pagePath), true, `missing ${relPage}`);
      const html = readFileSync(pagePath, 'utf8');
      assert.match(html, new RegExp(`v${result.version.replaceAll('.', '\\.')}`));
      assert.equal(html.includes('·'), false, `${relPage} must not contain middle dot separators`);

      for (const ref of extractLocalRefs(html)) {
        const resolved = resolve(dirname(pagePath), ref);
        const target = ref.endsWith('/') ? join(resolved, 'index.html') : resolved;
        assert.equal(existsSync(target), true, `broken relative ref ${ref} in ${relPage}`);
      }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('site directory and build-site script stay excluded from release bundle', () => {
  const bundle = collectPackage(root);
  const paths = bundle.files.map(file => file.path);
  assert.equal(paths.some(p => p.startsWith('site/')), false);
  assert.equal(paths.includes('scripts/build-site.mjs'), false);
});
