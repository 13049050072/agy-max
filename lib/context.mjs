// Compare usage and capacity from the same generation. Local tokenizer estimates
// can differ substantially from provider tokenization, particularly for tools.
export function contextSnapshot(generation, fallbackTokens = 0) {
  const metadata = generation?.context;
  const reportedMaxTokens = metadata?.maxTokens > 0 ? metadata.maxTokens : null;
  const actual = generation?.providerInputTokens;
  const hasActual = Number.isFinite(actual) && actual > 0;
  const estimatedUsedTokens = metadata?.usedTokens ?? null;
  const usedTokens = hasActual ? actual : Math.max(0, estimatedUsedTokens ?? fallbackTokens);
  // An inconsistent capacity cannot support an honest utilization percentage.
  const maxTokens = reportedMaxTokens != null && usedTokens <= reportedMaxTokens ? reportedMaxTokens : null;
  const percent = tokens => maxTokens ? Number((tokens / maxTokens * 100).toFixed(1)) : null;
  const groups = (metadata?.categories || []).flatMap(group => {
    const skills = group.label === 'System Prompt' && group.children?.find(child => child.label === 'skills');
    return skills ? [{ ...group, tokens: Math.max(0, group.tokens - skills.tokens) }, { key: 'skills', label: 'Skills', tokens: skills.tokens, tone: 'active' }] : [group];
  }).filter(group => Number.isFinite(group.tokens) && group.tokens > 0);
  const total = groups.reduce((sum, group) => sum + Math.max(0, group.tokens), 0);
  // The provider supplies only the total. Category counts remain estimates and
  // are labeled as such in the UI. Largest remainders preserve the exact total.
  const apportioned = groups.map(group => total ? usedTokens * Math.max(0, group.tokens) / total : 0);
  const counts = apportioned.map(Math.floor);
  const order = apportioned.map((value, index) => ({ index, remainder: value - counts[index] })).sort((a, b) => b.remainder - a.remainder);
  if (total) for (let i = 0, remaining = usedTokens - counts.reduce((a, b) => a + b, 0); i < remaining; i++) counts[order[i % order.length].index]++;
  const categories = groups.map((group, index) => ({ ...group, reportedTokens: group.tokens, tokens: total ? counts[index] : group.tokens, estimated: true, percent: percent(total ? counts[index] : group.tokens) }));
  if (!categories.length && usedTokens > 0) categories.push({ key: 'input', label: '输入上下文', tokens: usedTokens, estimated: !hasActual, percent: percent(usedTokens), tone: 'active' });
  const freeTokens = maxTokens == null ? null : maxTokens - usedTokens;
  if (freeTokens != null) categories.push({ key: 'free', label: '剩余空间', tokens: freeTokens, percent: percent(freeTokens), tone: 'free' });
  return { usedTokens, maxTokens, reportedMaxTokens, estimatedUsedTokens, usedPercent: percent(usedTokens), freePercent: freeTokens == null ? null : percent(freeTokens), categories, source: hasActual ? 'provider-usage' : metadata ? 'client-estimate' : 'transcript' };
}

export function shortModelName(name) {
  const clean = String(name || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (!clean) return 'Unknown';
  const g4 = clean.match(/^gemini[\s-]+4[\s-]+([a-z0-9]+)/i);
  if (g4) return g4[1].charAt(0).toUpperCase() + g4[1].slice(1).toLowerCase();
  const gVer = clean.match(/^gemini[\s-]+(\d+(?:\.\d+)?)[\s-]+(pro|flash)/i);
  if (gVer) return `${gVer[1]} ${gVer[2].charAt(0).toUpperCase()}${gVer[2].slice(1).toLowerCase()}`;
  return clean.replace(/-(?:high|xhigh|medium|low|trial|n)$/i, '');
}

// Antigravity writes CHECKPOINT steps without a new gen_metadata row until the
// next user message; project post-compaction usage immediately from the summary.
export function compactGeneration(latestGen, generations = [], checkpoints = []) {
  const normalized = (checkpoints || []).map(cp => typeof cp === 'number' ? { stepIndex: cp, summaryTokens: 0 } : cp).filter(cp => Number.isInteger(cp?.stepIndex));
  const lastCp = normalized.at(-1);
  if (!latestGen || !lastCp) return latestGen;
  const stepIndices = (generations || []).flatMap(g => Array.isArray(g?.stepIndices) ? g.stepIndices : []);
  if (!stepIndices.length || lastCp.stepIndex <= Math.max(...stepIndices)) return latestGen;
  const summaryTokens = Math.max(0, Number(lastCp.summaryTokens) || 0);
  const categories = latestGen.context?.categories || [];
  const isMsg = c => c?.label === 'Chat Messages';
  const nonMsgCats = categories.filter(c => !isMsg(c));
  const nonMsgEst = nonMsgCats.reduce((sum, c) => sum + Math.max(0, Number(c.tokens) || 0), 0);
  const prevMsg = categories.find(isMsg);
  let compactedProviderTokens = null;
  let compactedEstUsed = latestGen.context?.usedTokens ?? null;
  let nextCategories = categories;
  if (categories.length) {
    nextCategories = [...nonMsgCats, ...(summaryTokens > 0 || prevMsg ? [{ ...(prevMsg || { key: 'messages', label: 'Chat Messages', children: [], tone: 'active' }), tokens: summaryTokens }] : [])];
    compactedEstUsed = nonMsgEst + summaryTokens;
    const hasProvider = (Number.isFinite(latestGen.providerInputTokens) && latestGen.providerInputTokens > 0)
      || (generations || []).some(g => Number.isFinite(g?.providerInputTokens) && g.providerInputTokens > 0);
    if (hasProvider) {
      let rawDelta = Number.isFinite(latestGen.providerInputTokens) && latestGen.providerInputTokens > 0 && latestGen.context?.usedTokens > 0
        ? latestGen.context.usedTokens - latestGen.providerInputTokens
        : 0;
      if (rawDelta <= 0) {
        const baseline = (generations || []).find(g => g?.providerInputTokens > 0 && g?.context?.usedTokens > g.providerInputTokens);
        if (baseline) rawDelta = baseline.context.usedTokens - baseline.providerInputTokens;
      }
      const offset = Math.max(0, Math.min(rawDelta, Math.floor(nonMsgEst * 0.45)));
      compactedProviderTokens = Math.max(summaryTokens, nonMsgEst - offset + summaryTokens);
    }
  } else {
    compactedEstUsed = summaryTokens || null;
    const firstGen = (generations || []).find(g => g?.providerInputTokens > 0);
    if (firstGen && generations.length > 1 && firstGen.providerInputTokens < latestGen.providerInputTokens) {
      compactedProviderTokens = firstGen.providerInputTokens + summaryTokens;
    } else if (summaryTokens > 0 && (!latestGen.providerInputTokens || summaryTokens < latestGen.providerInputTokens)) {
      compactedProviderTokens = summaryTokens;
    }
  }
  return {
    ...latestGen,
    providerInputTokens: compactedProviderTokens,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    compacted: true,
    context: latestGen.context ? {
      ...latestGen.context,
      usedTokens: compactedEstUsed,
      categories: nextCategories
    } : null
  };
}

export function modelContexts(generations = [], checkpointSteps = [], checkpoints = []) {
  const valid = (generations || []).filter(g => g?.modelName && ((Number.isFinite(g.providerInputTokens) && g.providerInputTokens > 0) || (g.context?.usedTokens > 0)));
  const knownExecutionEnum = valid.find(g => g.executionModelEnum)?.executionModelEnum || null;
  const hasOrchestrator = Boolean(knownExecutionEnum) || valid.some(g => g.role === 'execution' || g.role === 'planner' || /orchestrator/i.test(g.modelName || ''));
  const map = new Map();
  let lastKey = '';
  for (const g of valid) {
    const used = Number.isFinite(g.providerInputTokens) && g.providerInputTokens > 0 ? g.providerInputTokens : g.context.usedTokens;
    const rawMax = g.context?.maxTokens > 0 ? g.context.maxTokens : null;
    const maxTokens = rawMax != null && used <= rawMax ? rawMax : null;
    const inferredRole = g.role || (knownExecutionEnum && g.modelEnum ? (g.modelEnum === knownExecutionEnum ? 'execution' : 'planner') : '');
    const role = hasOrchestrator ? (inferredRole || 'planner') : '';
    const shortName = shortModelName(g.modelName);
    const key = `${role}:${shortName.toLowerCase()}`;
    const prev = map.get(key);
    let compactions = prev?.compactions || 0;
    if (prev && prev.usedTokens > 0 && used < prev.usedTokens * 0.72 && prev.usedTokens - used > 30000) compactions++;
    const resolvedMax = maxTokens ?? prev?.maxTokens ?? null;
    const usedPercent = resolvedMax ? Number((used / resolvedMax * 100).toFixed(1)) : null;
    map.set(key, {
      key,
      role,
      shortName,
      fullName: g.modelName,
      usedTokens: used,
      maxTokens: resolvedMax,
      usedPercent,
      compactions,
      isCurrent: false
    });
    lastKey = key;
  }
  const compactedLast = compactGeneration(valid.at(-1), generations, checkpoints.length ? checkpoints : checkpointSteps);
  const hasTrailingCompaction = Boolean(compactedLast && compactedLast !== valid.at(-1));
  const models = [...map.values()].map(entry => {
    const isCurrent = entry.key === lastKey;
    if (!isCurrent || !hasTrailingCompaction) return { ...entry, isCurrent };
    const used = Number.isFinite(compactedLast.providerInputTokens) && compactedLast.providerInputTokens > 0
      ? compactedLast.providerInputTokens
      : (compactedLast.context?.usedTokens ?? entry.usedTokens);
    const usedPercent = entry.maxTokens && used <= entry.maxTokens ? Number((used / entry.maxTokens * 100).toFixed(1)) : null;
    return { ...entry, usedTokens: used, usedPercent, isCurrent };
  });
  const detectedCompactions = models.reduce((sum, entry) => sum + entry.compactions, 0);
  const compactions = Math.max(Array.isArray(checkpointSteps) ? checkpointSteps.length : 0, detectedCompactions);
  if (compactions > detectedCompactions) {
    const target = models.length === 1 ? models[0] : (hasTrailingCompaction ? models.find(m => m.isCurrent) : null);
    if (target) target.compactions += compactions - detectedCompactions;
  }
  return { models, hasOrchestrator, compactions };
}
