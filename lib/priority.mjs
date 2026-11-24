import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VALID_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const VALID_STATES = new Set(['waiting', 'active', 'unread', 'idle']);

function normalizeScope(scope) {
  const raw = String(scope || '').trim();
  return raw ? raw.slice(0, 160) : 'local';
}

function sanitizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  const seen = new Set();
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [id, raw] = pair;
    if (typeof id !== 'string' || !VALID_ID_RE.test(id) || seen.has(id) || !raw || typeof raw !== 'object') continue;
    if (!VALID_STATES.has(raw.attentionState)) continue;
    seen.add(id);
    out.push([id, {
      attentionState: raw.attentionState,
      updatedAtMs: Number.isFinite(raw.updatedAtMs) && raw.updatedAtMs > 0 ? Math.trunc(raw.updatedAtMs) : 0,
      retainedSinceMs: Number.isFinite(raw.retainedSinceMs) && raw.retainedSinceMs > 0 ? Math.trunc(raw.retainedSinceMs) : 0,
      nativeUnread: Boolean(raw.nativeUnread),
      ...(raw.dismissedAtUpdateMs ? {
        dismissedAtUpdateMs: Number.isFinite(raw.dismissedAtUpdateMs) && raw.dismissedAtUpdateMs > 0
          ? Math.trunc(raw.dismissedAtUpdateMs)
          : true
      } : {}),
      ...(typeof raw.title === 'string' && raw.title.trim() ? { title: raw.title.trim().slice(0, 200) } : {}),
      ...(typeof raw.projectId === 'string' && raw.projectId.trim() ? { projectId: raw.projectId.trim().slice(0, 160) } : {}),
      ...(typeof raw.projectName === 'string' && raw.projectName.trim() ? { projectName: raw.projectName.trim().slice(0, 120) } : {})
    }]);
  }
  return out.slice(-100);
}

export function createPriorityStore(directory = join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-max')) {
  const filePath = join(directory, 'priority.json');

  function readAll() {
    try {
      if (!existsSync(filePath)) return { scopes: {} };
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      const scopes = parsed?.scopes && typeof parsed.scopes === 'object' && !Array.isArray(parsed.scopes) ? parsed.scopes : {};
      return { scopes };
    } catch {
      return { scopes: {} };
    }
  }

  function writeAll(scopes) {
    mkdirSync(directory, { recursive: true });
    const keys = Object.keys(scopes).slice(-24);
    const cleanScopes = {};
    for (const key of keys) {
      const item = scopes[key];
      if (!item || typeof item !== 'object') continue;
      cleanScopes[key] = {
        open: Boolean(item.open),
        entries: sanitizeEntries(item.entries),
        savedAtMs: Number.isFinite(item.savedAtMs) ? Math.trunc(item.savedAtMs) : Date.now()
      };
    }
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ format: 1, scopes: cleanScopes }, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
    return cleanScopes;
  }

  return {
    get(scope = 'local') {
      const key = normalizeScope(scope);
      const raw = readAll().scopes[key];
      if (!raw || typeof raw !== 'object') return { open: false, entries: [] };
      return {
        open: Boolean(raw.open),
        entries: sanitizeEntries(raw.entries)
      };
    },
    save(scope = 'local', payload = {}) {
      const key = normalizeScope(scope);
      const all = readAll().scopes;
      const prev = all[key] || { open: false, entries: [] };
      const next = {
        open: typeof payload?.open === 'boolean' ? payload.open : Boolean(prev.open),
        entries: Array.isArray(payload?.entries) ? sanitizeEntries(payload.entries) : sanitizeEntries(prev.entries),
        savedAtMs: Date.now()
      };
      const written = writeAll({ ...all, [key]: next });
      return {
        open: written[key].open,
        entries: written[key].entries
      };
    }
  };
}
