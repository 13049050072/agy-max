import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCREENSHOT_ASSETS } from '../site/content.mjs';
import { renderPage } from '../site/render.mjs';

export function buildSite({ root, outDir }) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const siteSrc = join(root, 'site');
  const assetsOut = join(outDir, 'assets');
  const imagesOut = join(assetsOut, 'images');

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'zh'), { recursive: true });
  mkdirSync(imagesOut, { recursive: true });

  writeFileSync(
    join(outDir, 'index.html'),
    renderPage({ locale: 'en', version: pkg.version, assetPrefix: './' }),
    'utf8'
  );
  writeFileSync(
    join(outDir, 'zh', 'index.html'),
    renderPage({ locale: 'zh', version: pkg.version, assetPrefix: '../' }),
    'utf8'
  );

  copyFileSync(join(siteSrc, 'styles.css'), join(outDir, 'styles.css'));
  copyFileSync(join(siteSrc, 'app.js'), join(outDir, 'app.js'));
  copyFileSync(join(root, 'assets', 'logo.svg'), join(assetsOut, 'logo.svg'));

  for (const item of SCREENSHOT_ASSETS) {
    copyFileSync(join(root, 'docs', 'images', item.file), join(imagesOut, item.file));
  }

  writeFileSync(join(outDir, '.nojekyll'), '', 'utf8');

  return {
    version: pkg.version,
    outDir,
    pages: ['index.html', 'zh/index.html'],
    images: SCREENSHOT_ASSETS.length
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = resolve(process.argv[2] || join(root, 'dist', 'site'));
  console.log(JSON.stringify(buildSite({ root, outDir })));
}
