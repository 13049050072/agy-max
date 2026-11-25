import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTranscriptGoal, resolveConversationGoal, findGoalInterruption, syncConversationGoal, createGoalsStore } from '../lib/goals.mjs';

test('extractTranscriptGoal tracks /goal activation, completion, and cancellation markers', () => {
  const activeSteps = [
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T05:00:00Z', content: '<USER_REQUEST>\n/goal 把全部测试修绿并清理无用导入\n</USER_REQUEST>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-24T05:01:00Z', content: '正在修复第 1 组测试…' }
  ];
  const txActive = extractTranscriptGoal(activeSteps);
  assert.equal(txActive.status, 'active');
  assert.equal(txActive.text, '把全部测试修绿并清理无用导入');
  assert.equal(txActive.stepIndex, 0);

  const completedSteps = [
    ...activeSteps,
    { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-24T05:05:00Z', content: '全部通过！\n<!-- GOAL_COMPLETE -->' }
  ];
  const txCompleted = extractTranscriptGoal(completedSteps);
  assert.equal(txCompleted.status, 'completed');
  assert.equal(txCompleted.completedStepIndex, 2);

  const cancelledSteps = [
    ...activeSteps,
    { step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-24T05:06:00Z', content: '已取消\n<!-- GOAL_CANCELLED -->' }
  ];
  assert.equal(extractTranscriptGoal(cancelledSteps).status, 'cleared');
});

test('createGoalsStore and resolveConversationGoal support live edits, pause/resume elapsed time, and clearing native goals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-goals-'));
  try {
    const store = createGoalsStore(dir);
    const txGoal = {
      text: '原始目标内容',
      status: 'active',
      stepIndex: 2,
      startedAtMs: 1000,
      updatedAtMs: 1000,
      completedStepIndex: null
    };

    const initial = resolveConversationGoal(txGoal, store.get('conv-1'));
    assert.equal(initial.status, 'active');
    assert.equal(initial.text, '原始目标内容');
    assert.equal(initial.custom, false);

    store.save('conv-1', {
      text: '/goal 修改后的新目标内容',
      checklist: [
        { id: 'c1', text: ' 跑通单测 ', done: true },
        { id: 'c2', text: '清理无用导入', done: false },
        { id: 'c3', text: '   ', done: false }
      ],
      guardrails: ['run_tests', 'minimal_diff', 'invalid_guardrail', 'run_tests'],
      sourceStepIndex: 2,
      currentStepIndex: 4,
      startedAtMs: 1000,
      now: 5000
    });
    const edited = resolveConversationGoal(txGoal, store.get('conv-1'));
    assert.equal(edited.status, 'active');
    assert.equal(edited.text, '修改后的新目标内容');
    assert.equal(edited.startedAtMs, 1000);
    assert.equal(edited.updatedAtMs, 5000);
    assert.equal(edited.custom, true);
    assert.deepEqual(edited.checklist, [
      { id: 'c1', text: '跑通单测', done: true },
      { id: 'c2', text: '清理无用导入', done: false }
    ]);
    assert.deepEqual(edited.guardrails, ['run_tests', 'minimal_diff']);

    store.setStatus('conv-1', 'paused', { now: 9000 });
    const paused = resolveConversationGoal(txGoal, store.get('conv-1'));
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pausedElapsedMs, 8000);
    assert.equal(paused.checklist.length, 2);
    assert.deepEqual(paused.guardrails, ['run_tests', 'minimal_diff']);

    store.setStatus('conv-1', 'active', { now: 20000 });
    const resumed = resolveConversationGoal(txGoal, store.get('conv-1'));
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.startedAtMs, 12000);
    assert.equal(resumed.checklist.length, 2);
    assert.deepEqual(resumed.guardrails, ['run_tests', 'minimal_diff']);

    store.setStatus('conv-1', 'cleared', { sourceStepIndex: 2, now: 25000 });
    const cleared = resolveConversationGoal(txGoal, store.get('conv-1'));
    assert.equal(cleared.status, 'cleared');
    assert.equal(cleared.clearedNative, true);

    assert.throws(() => store.save('../bad', { text: 'x' }), /无效/);
    assert.throws(() => store.save('conv-1', { text: '   ' }), /不能为空/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncConversationGoal auto-pauses on user abort or network disconnect, stays paused on follow-up turns, and only resumes on explicit play', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-goals-interrupt-'));
  try {
    const store = createGoalsStore(dir);
    const txGoal = {
      text: '修复所有编译错误并跑通单测',
      status: 'active',
      stepIndex: 10,
      startedAtMs: 1000,
      updatedAtMs: 1000,
      completedStepIndex: null
    };

    // 1. Active turn hit a transient error that is currently retrying (execution.status === 2) -> stays active
    const retrying = syncConversationGoal('conv-int', txGoal, store, {
      turns: [{ stepIndexStart: 10, stepIndexEnd: 11, status: 'error', completedAtMs: 3000 }],
      execution: { conversationId: 'conv-int', status: 2, turnStartStepIndex: 10, terminationReason: 0 },
      now: 3500
    });
    assert.equal(retrying.status, 'active');
    assert.equal(store.get('conv-int'), null);

    // 2. Turn stops externally (user cancel / stopped at step 12, completedAtMs = 6000) -> auto-pauses and freezes elapsed at 5000ms
    const paused = syncConversationGoal('conv-int', txGoal, store, {
      turns: [{ stepIndexStart: 10, stepIndexEnd: 12, status: 'stopped', completedAtMs: 6000 }],
      execution: { conversationId: 'conv-int', status: 1, turnStartStepIndex: 10, lastStepIndex: 12, terminationReason: 2 },
      now: 9000
    });
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pausedElapsedMs, 5000);
    assert.equal(paused.pausedNative, true);
    assert.equal(store.get('conv-int').status, 'paused');

    // 3. User triggers conversation again with normal message ("继续" at step 13..14) -> stays paused!
    const duringContinue = syncConversationGoal('conv-int', txGoal, store, {
      turns: [
        { stepIndexStart: 10, stepIndexEnd: 12, status: 'stopped', completedAtMs: 6000 },
        { stepIndexStart: 13, stepIndexEnd: 13, status: 'running', completedAtMs: null }
      ],
      execution: { conversationId: 'conv-int', status: 2, turnStartStepIndex: 13, terminationReason: 0 },
      now: 15000
    });
    assert.equal(duringContinue.status, 'paused');
    assert.equal(duringContinue.pausedElapsedMs, 5000);

    // Even if model emits <!-- GOAL_CANCELLED --> on step 14 to silence native StopHook while paused, UI goal remains paused
    const txAfterPauseCancel = { ...txGoal, status: 'cleared', completedStepIndex: 14 };
    const afterContinue = syncConversationGoal('conv-int', txAfterPauseCancel, store, {
      turns: [
        { stepIndexStart: 10, stepIndexEnd: 12, status: 'stopped', completedAtMs: 6000 },
        { stepIndexStart: 13, stepIndexEnd: 14, status: 'complete', completedAtMs: 18000 }
      ],
      execution: { conversationId: 'conv-int', status: 1, turnStartStepIndex: 13, lastStepIndex: 14, terminationReason: 4 },
      now: 20000
    });
    assert.equal(afterContinue.status, 'paused');
    assert.equal(afterContinue.pausedNative, false);
    assert.equal(afterContinue.pausedElapsedMs, 5000);

    // 4. User clicks the triangle Play button (▶) at step 14 (now = 30000) -> resumes active without re-triggering on step 12's old stop!
    store.setStatus('conv-int', 'active', { sourceStepIndex: 10, currentStepIndex: 14, now: 30000 });
    const afterPlayIdle = syncConversationGoal('conv-int', txAfterPauseCancel, store, {
      turns: [
        { stepIndexStart: 10, stepIndexEnd: 12, status: 'stopped', completedAtMs: 6000 },
        { stepIndexStart: 13, stepIndexEnd: 14, status: 'complete', completedAtMs: 18000 }
      ],
      execution: { conversationId: 'conv-int', status: 1, turnStartStepIndex: 13, lastStepIndex: 14, terminationReason: 4 },
      now: 32000
    });
    assert.equal(afterPlayIdle.status, 'active');
    assert.equal(afterPlayIdle.startedAtMs, 25000);

    // 5. Subsequent turn (step 15..16) drops due to network disconnect (status: 'error', terminationReason: 1) -> auto-pauses again!
    const pausedAgain = syncConversationGoal('conv-int', txAfterPauseCancel, store, {
      turns: [
        { stepIndexStart: 10, stepIndexEnd: 12, status: 'stopped', completedAtMs: 6000 },
        { stepIndexStart: 13, stepIndexEnd: 14, status: 'complete', completedAtMs: 18000 },
        { stepIndexStart: 15, stepIndexEnd: 16, status: 'error', completedAtMs: 37000 }
      ],
      execution: { conversationId: 'conv-int', status: 1, turnStartStepIndex: 15, lastStepIndex: 16, terminationReason: 1 },
      now: 38000
    });
    assert.equal(pausedAgain.status, 'paused');
    assert.equal(pausedAgain.pausedElapsedMs, 12000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findGoalInterruption supports instant 0ms abort and persisted executor_metadata fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-goals-zero-'));
  try {
    const store = createGoalsStore(dir);
    const txGoal = { text: '快速中止测试', status: 'active', stepIndex: 4, startedAtMs: 5000, updatedAtMs: 5000, completedStepIndex: null };
    const pausedZero = syncConversationGoal('conv-zero', txGoal, store, {
      turns: [],
      executions: [{ index: 0, terminationReason: 2, stepIndex: 4 }],
      now: 5000
    });
    assert.equal(pausedZero.status, 'paused');
    assert.equal(pausedZero.pausedElapsedMs, 0);
    assert.ok(findGoalInterruption({ status: 'active', stepIndex: 4, activeAfterStepIndex: 3 }, {
      executions: [{ index: 0, terminationReason: 1, stepIndex: 5 }]
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
