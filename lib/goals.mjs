import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeAtomicFile(filePath, content) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.agy-goals-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, content, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tempPath, filePath);
        return;
      } catch (err) {
        if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(err?.code)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } finally {
    try { unlinkSync(tempPath); } catch {}
  }
}

const VALID_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const VALID_STATUSES = new Set(['active', 'paused', 'completed', 'cleared']);
const ABNORMAL_TERMINATION_REASONS = new Set([1, 2, 3, 6, 11]);
export const GOAL_GUARDRAIL_IDS = Object.freeze(['run_tests', 'minimal_diff', 'no_new_deps', 'final_summary']);
const VALID_GUARDRAILS = new Set(GOAL_GUARDRAIL_IDS);

function normalizeGoalText(raw) {
  return String(raw || '').replace(/\r\n/g, '\n').replace(/^\/goal\b\s*/i, '').trim().slice(0, 8000);
}

export function normalizeGoalChecklist(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < raw.length && out.length < 20; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const text = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) continue;
    let id = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(item.id) ? item.id : `chk-${out.length + 1}`;
    while (seenIds.has(id)) id = `${id}-${out.length + 1}`;
    seenIds.add(id);
    out.push({ id, text, done: Boolean(item.done) });
  }
  return out;
}

export function normalizeGoalGuardrails(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    if (typeof id === 'string' && VALID_GUARDRAILS.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export function extractTranscriptGoal(steps = [], database = null) {
  if (!Array.isArray(steps) || !steps.length) return null;
  let current = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    const timing = database?.times?.get?.(step.step_index);
    const stepMs = timing?.createdMs ?? (step.created_at ? Date.parse(step.created_at) : null);

    if (step.type === 'USER_INPUT') {
      const content = typeof step.content === 'string' ? step.content : '';
      if (/^Error: The stream was interrupted/i.test(content)) continue;
      const reqMatch = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      const userReq = (reqMatch ? reqMatch[1] : content).trim();
      const hasSlashGoal = /^\/goal(?:\s|$)/i.test(userReq) || content.includes('/goal is a [Slash Command]:');
      if (hasSlashGoal) {
        const text = normalizeGoalText(userReq) || '目标任务';
        current = {
          text,
          status: 'active',
          stepIndex: Number.isInteger(step.step_index) ? step.step_index : i,
          startedAtMs: Number.isFinite(stepMs) ? stepMs : null,
          updatedAtMs: Number.isFinite(stepMs) ? stepMs : null,
          completedStepIndex: null
        };
      }
      continue;
    }

    if (current && step.type === 'PLANNER_RESPONSE') {
      const reply = typeof step.content === 'string' ? step.content : '';
      if (reply.includes('<!-- GOAL_COMPLETE -->')) {
        current.status = 'completed';
        current.completedStepIndex = Number.isInteger(step.step_index) ? step.step_index : i;
      } else if (reply.includes('<!-- GOAL_CANCELLED -->')) {
        current.status = 'cleared';
        current.completedStepIndex = Number.isInteger(step.step_index) ? step.step_index : i;
      }
    }
  }
  return current;
}

export function resolveConversationGoal(transcriptGoal, storedEntry) {
  const tx = transcriptGoal && typeof transcriptGoal === 'object' ? transcriptGoal : null;
  const saved = storedEntry && typeof storedEntry === 'object' ? storedEntry : null;

  if (saved) {
    const txStep = Number.isInteger(tx?.stepIndex) ? tx.stepIndex : -1;
    const savedStep = Number.isInteger(saved.sourceStepIndex) ? saved.sourceStepIndex : -1;
    if (tx && txStep > savedStep) {
      if (tx.status !== 'active') return null;
      return {
        text: tx.text,
        status: 'active',
        startedAtMs: tx.startedAtMs || Date.now(),
        updatedAtMs: tx.updatedAtMs || tx.startedAtMs || Date.now(),
        stepIndex: txStep,
        activeAfterStepIndex: txStep - 1,
        checklist: [],
        guardrails: [],
        custom: false
      };
    }
    if (saved.status === 'cleared' || saved.status === 'completed') {
      return saved.status === 'cleared' ? { status: 'cleared', clearedNative: Boolean(tx && tx.status === 'active'), text: '' } : null;
    }
    const stepFloor = Math.max(saved.editedAfterStepIndex ?? -1, saved.activeAfterStepIndex ?? -1);
    if (tx?.status === 'completed' && Number.isInteger(tx.completedStepIndex) && tx.completedStepIndex > stepFloor) {
      return null;
    }
    if (saved.status === 'active' && tx?.status === 'cleared' && Number.isInteger(tx.completedStepIndex) && tx.completedStepIndex > stepFloor) {
      return null;
    }
    const baseStart = saved.startedAtMs || tx?.startedAtMs || saved.updatedAtMs || Date.now();
    const rawPausedMs = saved.pausedElapsedMs != null ? Number(saved.pausedElapsedMs) : NaN;
    const pausedAccum = Number.isFinite(rawPausedMs) && rawPausedMs >= 0 ? rawPausedMs : null;
    const stepIndex = Math.max(txStep, savedStep);
    const defaultActiveAfter = stepIndex >= 0 ? stepIndex - 1 : -1;
    const activeAfterStepIndex = Number.isInteger(saved.activeAfterStepIndex) && saved.activeAfterStepIndex >= defaultActiveAfter
      ? saved.activeAfterStepIndex
      : defaultActiveAfter;
    const isPaused = saved.status === 'paused';
    return {
      text: saved.text,
      status: isPaused ? 'paused' : 'active',
      startedAtMs: baseStart,
      updatedAtMs: saved.updatedAtMs || baseStart,
      pausedElapsedMs: isPaused ? pausedAccum : null,
      ...(isPaused ? { pausedNative: Boolean(tx && tx.status === 'active') } : {}),
      stepIndex,
      activeAfterStepIndex,
      checklist: normalizeGoalChecklist(saved.checklist),
      guardrails: normalizeGoalGuardrails(saved.guardrails),
      custom: true
    };
  }

  if (tx && tx.status === 'active') {
    const ts = tx.startedAtMs || Date.now();
    return {
      text: tx.text,
      status: 'active',
      startedAtMs: ts,
      updatedAtMs: tx.updatedAtMs || ts,
      pausedElapsedMs: null,
      stepIndex: tx.stepIndex,
      activeAfterStepIndex: Number.isInteger(tx.stepIndex) ? tx.stepIndex - 1 : -1,
      checklist: [],
      guardrails: [],
      custom: false
    };
  }
  return null;
}

export function findGoalInterruption(goal, { turns = [], executions = [], execution = null } = {}) {
  if (!goal || goal.status !== 'active') return null;
  const threshold = Number.isInteger(goal.activeAfterStepIndex)
    ? goal.activeAfterStepIndex
    : (Number.isInteger(goal.stepIndex) ? goal.stepIndex - 1 : -1);

  if (Array.isArray(turns)) {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (!t || typeof t !== 'object') continue;
      const endStep = Number.isInteger(t.stepIndexEnd) ? t.stepIndexEnd : (Number.isInteger(t.stepIndexStart) ? t.stepIndexStart : -1);
      if (endStep <= threshold) continue;
      const isLast = i === turns.length - 1;
      if (t.status === 'stopped' || (t.status === 'error' && (!isLast || !execution || execution.status === 1))) {
        return {
          reason: t.status,
          stepIndex: endStep,
          atMs: Number.isFinite(t.completedAtMs) ? t.completedAtMs : null
        };
      }
    }
  }

  if (Array.isArray(executions)) {
    for (const ex of executions) {
      if (!ex || !Number.isInteger(ex.stepIndex) || ex.stepIndex <= threshold) continue;
      if (ABNORMAL_TERMINATION_REASONS.has(ex.terminationReason)) {
        return {
          reason: ex.terminationReason === 2 ? 'stopped' : 'error',
          stepIndex: ex.stepIndex,
          atMs: null
        };
      }
    }
  }

  if (execution && execution.status === 1 && ABNORMAL_TERMINATION_REASONS.has(execution.terminationReason)) {
    const execStep = Number.isInteger(execution.lastStepIndex)
      ? execution.lastStepIndex
      : (Number.isInteger(execution.turnStartStepIndex)
          ? execution.turnStartStepIndex
          : (Number.isInteger(execution.userTurnStartStepIndex) ? execution.userTurnStartStepIndex : -1));
    if (execStep > threshold) {
      return {
        reason: execution.terminationReason === 2 ? 'stopped' : 'error',
        stepIndex: execStep,
        atMs: null
      };
    }
  }

  return null;
}

export function syncConversationGoal(conversationId, transcriptGoal, goalsStore, { turns = [], executions = [], execution = null, now = Date.now() } = {}) {
  const saved = goalsStore?.get?.(conversationId) || null;
  const resolved = resolveConversationGoal(transcriptGoal, saved);
  if (!resolved || resolved.status !== 'active') return resolved;
  const interruption = findGoalInterruption(resolved, { turns, executions, execution });
  if (!interruption || !goalsStore?.setStatus) return resolved;
  const pauseAtMs = Number.isFinite(interruption.atMs) && interruption.atMs >= (resolved.startedAtMs || 0)
    ? interruption.atMs
    : now;
  const pausedEntry = goalsStore.setStatus(conversationId, 'paused', {
    fallbackText: resolved.text,
    sourceStepIndex: resolved.stepIndex ?? transcriptGoal?.stepIndex ?? -1,
    currentStepIndex: interruption.stepIndex,
    startedAtMs: resolved.startedAtMs,
    now: pauseAtMs
  });
  return resolveConversationGoal(transcriptGoal, pausedEntry);
}

export function createGoalsStore(directory = join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-max')) {
  const filePath = join(directory, 'goals.json');

  function readAll() {
    try {
      if (!existsSync(filePath)) return {};
      const parsed = readJsonFile(filePath);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAll(map) {
    mkdirSync(directory, { recursive: true });
    const entries = Object.entries(map)
      .filter(([id, item]) => VALID_ID_RE.test(id) && item && typeof item === 'object' && VALID_STATUSES.has(item.status))
      .sort((a, b) => (Number(b[1].updatedAtMs) || 0) - (Number(a[1].updatedAtMs) || 0))
      .slice(0, 200);
    const clean = Object.fromEntries(entries);
    writeAtomicFile(filePath, JSON.stringify(clean, null, 2) + '\n');
    return clean;
  }

  function ensureValidId(conversationId) {
    const id = String(conversationId || '').trim();
    if (!VALID_ID_RE.test(id)) throw new Error('无效的会话标识');
    return id;
  }

  return {
    get(conversationId) {
      if (!VALID_ID_RE.test(String(conversationId || ''))) return null;
      return readAll()[conversationId] || null;
    },
    save(conversationId, { text, checklist, guardrails, sourceStepIndex = -1, currentStepIndex = -1, startedAtMs = null, now = Date.now() } = {}) {
      const id = ensureValidId(conversationId);
      const normalized = normalizeGoalText(text);
      if (!normalized) throw new Error('目标内容不能为空');
      const all = readAll();
      const rawPrev = all[id];
      const prev = rawPrev && !(Number.isInteger(sourceStepIndex) && sourceStepIndex >= 0 && sourceStepIndex > (rawPrev.sourceStepIndex ?? -1))
        ? rawPrev
        : null;
      const startMs = (prev && prev.status !== 'cleared' && Number.isFinite(prev.startedAtMs))
        ? prev.startedAtMs
        : (Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : now);
      const effectiveSource = Math.max(Number.isInteger(rawPrev?.sourceStepIndex) ? rawPrev.sourceStepIndex : -1, Number.isInteger(sourceStepIndex) ? sourceStepIndex : -1);
      const defaultActiveAfter = effectiveSource >= 0 ? effectiveSource - 1 : -1;
      const next = {
        text: normalized,
        status: prev?.status === 'paused' ? 'paused' : 'active',
        startedAtMs: startMs,
        updatedAtMs: now,
        pausedElapsedMs: prev?.status === 'paused' ? (prev.pausedElapsedMs ?? Math.max(0, now - startMs)) : null,
        sourceStepIndex: effectiveSource,
        editedAfterStepIndex: Number.isInteger(currentStepIndex) ? currentStepIndex : -1,
        activeAfterStepIndex: Number.isInteger(prev?.activeAfterStepIndex) ? prev.activeAfterStepIndex : defaultActiveAfter,
        checklist: checklist !== undefined ? normalizeGoalChecklist(checklist) : normalizeGoalChecklist(prev?.checklist),
        guardrails: guardrails !== undefined ? normalizeGoalGuardrails(guardrails) : normalizeGoalGuardrails(prev?.guardrails)
      };
      all[id] = next;
      writeAll(all);
      return next;
    },
    setStatus(conversationId, status, { fallbackText = '', sourceStepIndex = -1, currentStepIndex = -1, startedAtMs = null, now = Date.now() } = {}) {
      const id = ensureValidId(conversationId);
      if (!['active', 'paused', 'cleared'].includes(status)) throw new Error('不支持的目标状态');
      const all = readAll();
      const rawPrev = all[id];
      const prev = rawPrev && !(Number.isInteger(sourceStepIndex) && sourceStepIndex >= 0 && sourceStepIndex > (rawPrev.sourceStepIndex ?? -1))
        ? rawPrev
        : null;
      const effectiveSource = Math.max(Number.isInteger(rawPrev?.sourceStepIndex) ? rawPrev.sourceStepIndex : -1, Number.isInteger(sourceStepIndex) ? sourceStepIndex : -1);
      if (status === 'cleared') {
        const next = {
          text: '',
          status: 'cleared',
          startedAtMs: null,
          updatedAtMs: now,
          pausedElapsedMs: null,
          sourceStepIndex: effectiveSource,
          editedAfterStepIndex: -1,
          activeAfterStepIndex: -1,
          checklist: [],
          guardrails: []
        };
        all[id] = next;
        writeAll(all);
        return next;
      }
      const text = normalizeGoalText(prev?.text || fallbackText);
      if (!text) throw new Error('当前没有可操作的目标');
      const prevStart = Number.isFinite(prev?.startedAtMs) && prev.startedAtMs > 0
        ? prev.startedAtMs
        : (Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : now);
      let nextStart = prevStart;
      let pausedElapsedMs = null;
      if (status === 'paused') {
        pausedElapsedMs = prev?.status === 'paused' && Number.isFinite(prev.pausedElapsedMs)
          ? prev.pausedElapsedMs
          : Math.max(0, now - prevStart);
      } else if (prev?.status === 'paused' && Number.isFinite(prev.pausedElapsedMs)) {
        nextStart = Math.max(1, now - prev.pausedElapsedMs);
      }
      const defaultActiveAfter = effectiveSource >= 0 ? effectiveSource - 1 : -1;
      const activeAfterStepIndex = status === 'active' && Number.isInteger(currentStepIndex) && currentStepIndex >= 0
        ? Math.max(prev?.activeAfterStepIndex ?? defaultActiveAfter, currentStepIndex)
        : (Number.isInteger(prev?.activeAfterStepIndex) ? prev.activeAfterStepIndex : defaultActiveAfter);
      const editedAfterStepIndex = status === 'active' && Number.isInteger(currentStepIndex) && currentStepIndex >= 0
        ? Math.max(prev?.editedAfterStepIndex ?? -1, currentStepIndex)
        : (prev?.editedAfterStepIndex ?? -1);
      const next = {
        text,
        status,
        startedAtMs: nextStart,
        updatedAtMs: now,
        pausedElapsedMs,
        sourceStepIndex: effectiveSource,
        editedAfterStepIndex,
        activeAfterStepIndex,
        checklist: normalizeGoalChecklist(prev?.checklist),
        guardrails: normalizeGoalGuardrails(prev?.guardrails)
      };
      all[id] = next;
      writeAll(all);
      return next;
    }
  };
}
