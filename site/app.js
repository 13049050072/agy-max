const root = document.documentElement;
const shell = document.getElementById('workbench-shell');

function syncWorkbenchToTheme(theme) {
  if (!shell || shell.dataset.userPickedPalette === '1') return;
  const target = theme === 'dark' ? 'obsidian' : 'crystal';
  setWorkbenchPalette(target, false);
}

function setWorkbenchPalette(palette, userPicked = true) {
  if (!shell) return;
  shell.dataset.wbPalette = palette;
  if (userPicked) shell.dataset.userPickedPalette = '1';
  document.querySelectorAll('.palette-card[data-wb-palette]').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.wbPalette === palette);
  });
}

function setGaugeMode(mode) {
  if (!shell) return;
  shell.dataset.gauge = mode;
  const label = document.querySelector('.gauge-mode-text');
  if (label) {
    label.textContent = mode === 'ring' ? label.dataset.ringLabel : label.dataset.vialLabel;
  }
  document.querySelectorAll('[data-set-gauge]').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.setGauge === mode);
  });
}

// Theme toggle
const themeBtn = document.getElementById('theme-toggle');
syncWorkbenchToTheme(root.dataset.theme || 'light');

themeBtn?.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('agy-max-site-theme', next);
  } catch {}
  syncWorkbenchToTheme(next);
  syncDashboardShot(next);
});

// Demo mode tabs
document.querySelectorAll('[data-demo-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    const id = tab.dataset.demoTab;
    document.querySelectorAll('[data-demo-tab]').forEach(btn => {
      const active = btn.dataset.demoTab === id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-demo-panel]').forEach(panel => {
      panel.classList.toggle('is-active', panel.dataset.demoPanel === id);
    });
  });
});

// Palette & gauge interactive controls inside workbench
document.querySelectorAll('.palette-card[data-wb-palette]').forEach(btn => {
  btn.addEventListener('click', () => setWorkbenchPalette(btn.dataset.wbPalette, true));
});

document.querySelectorAll('[data-set-gauge]').forEach(btn => {
  btn.addEventListener('click', () => setGaugeMode(btn.dataset.setGauge));
});

document.getElementById('wb-gauge-toggle')?.addEventListener('click', () => {
  setGaugeMode(shell?.dataset.gauge === 'ring' ? 'vial' : 'ring');
});

document.querySelectorAll('[data-wb-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-wb-preset]').forEach(b => b.classList.toggle('is-active', b === btn));
  });
});

// Inline File Tree editing micro-demo
const editBtn = document.getElementById('wb-inline-edit-btn');
const codePre = document.getElementById('wb-code-preview');
const codeEditor = document.getElementById('wb-code-editor');
const editorStatus = document.getElementById('wb-editor-status');

function finishInlineEdit() {
  if (!editBtn || !codePre || !codeEditor || !editorStatus) return;
  codePre.textContent = codeEditor.value;
  codeEditor.hidden = true;
  codePre.hidden = false;
  editBtn.classList.remove('is-editing');
  editBtn.textContent = editBtn.dataset.editLabel || 'Edit';
  editorStatus.textContent = editorStatus.dataset.saved || 'Saved';
  editorStatus.classList.add('is-saved');
  window.setTimeout(() => {
    editorStatus.textContent = editorStatus.dataset.default || '';
    editorStatus.classList.remove('is-saved');
  }, 2400);
}

editBtn?.addEventListener('click', () => {
  if (!codePre || !codeEditor) return;
  if (codeEditor.hidden) {
    codeEditor.value = codePre.textContent || '';
    codePre.hidden = true;
    codeEditor.hidden = false;
    editBtn.classList.add('is-editing');
    editBtn.textContent = editBtn.dataset.saveLabel || 'Save';
    codeEditor.focus();
  } else {
    finishInlineEdit();
  }
});

codeEditor?.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    finishInlineEdit();
  }
});

// Screenshots switcher + Lightbox
const shotMainImg = document.getElementById('shot-main-img');
const shotMainTitle = document.getElementById('shot-main-title');
const shotMainCaption = document.getElementById('shot-main-caption');
let currentShotId = 'hero';

function selectShot(id) {
  const tab = document.querySelector(`.shot-tab[data-shot-id="${id}"]`);
  if (!tab || !shotMainImg || !shotMainTitle || !shotMainCaption) return;
  currentShotId = id;
  shotMainImg.src = tab.dataset.shotSrc || '';
  shotMainImg.alt = tab.dataset.shotTitle || '';
  shotMainTitle.textContent = tab.dataset.shotTitle || '';
  shotMainCaption.textContent = tab.dataset.shotCaption || '';
  document.querySelectorAll('.shot-tab, .shot-thumb').forEach(el => {
    el.classList.toggle('is-active', el.dataset.shotId === id);
  });
}

function syncDashboardShot(theme) {
  if (theme === 'dark' && currentShotId === 'dash-light') selectShot('dash-dark');
  if (theme === 'light' && currentShotId === 'dash-dark') selectShot('dash-light');
}

document.querySelectorAll('.shot-tab, .shot-thumb').forEach(el => {
  el.addEventListener('click', () => selectShot(el.dataset.shotId));
});

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxTitle = document.getElementById('lightbox-title');
const lightboxDesc = document.getElementById('lightbox-desc');

function openLightbox() {
  if (!lightbox || !lightboxImg || !shotMainImg) return;
  lightboxImg.src = shotMainImg.src;
  lightboxImg.alt = shotMainImg.alt;
  if (lightboxTitle && shotMainTitle) lightboxTitle.textContent = shotMainTitle.textContent;
  if (lightboxDesc && shotMainCaption) lightboxDesc.textContent = shotMainCaption.textContent;
  lightbox.hidden = false;
}

function closeLightbox() {
  if (lightbox) lightbox.hidden = true;
}

document.getElementById('shot-zoom-trigger')?.addEventListener('click', openLightbox);
document.getElementById('lightbox-close')?.addEventListener('click', closeLightbox);
lightbox?.addEventListener('click', event => {
  if (event.target === lightbox) closeLightbox();
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && lightbox && !lightbox.hidden) closeLightbox();
});

// Copy helpers (Hero prompt, Agent install box, CLI commands)
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

document.querySelectorAll('[data-copy-text]').forEach(btn => {
  const labelNode = btn.querySelector('.cta-label') || btn;
  const originalText = btn.dataset.copyDefault || labelNode.textContent;
  btn.addEventListener('click', async () => {
    try {
      await copyText(btn.dataset.copyText || '');
      labelNode.textContent = btn.dataset.copyDone || 'Copied';
      btn.classList.add('is-copied');
      window.setTimeout(() => {
        labelNode.textContent = originalText;
        btn.classList.remove('is-copied');
      }, 2200);
    } catch {}
  });
});

// Live GitHub star count & latest release tag (fails silently offline)
const repo = document.body.dataset.repo;
if (repo) {
  fetch(`https://api.github.com/repos/${repo}`, { headers: { Accept: 'application/vnd.github+json' } })
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      const starsEl = document.getElementById('gh-stars');
      if (starsEl && typeof data?.stargazers_count === 'number') {
        starsEl.textContent = `★ ${data.stargazers_count}`;
      }
    })
    .catch(() => {});

  fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      const verEl = document.getElementById('hero-version');
      if (verEl && typeof data?.tag_name === 'string' && data.tag_name) {
        verEl.textContent = data.tag_name;
      }
    })
    .catch(() => {});
}
