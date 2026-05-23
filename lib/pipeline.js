const fs = require('fs');
const path = require('path');
const { parseScript, manifestToText, dialogueTable } = require('./parser');
const { planSceneSegments, segmentPlanToText } = require('./segmentPlanner');
const { callModel } = require('./aiClient');
const {
  buildAgentASystem, buildAgentAUser, buildAgentBSystem, buildAgentBUser, buildAgentCSystem
} = require('./prompts');
const {
  DEFAULT_FORBIDDEN_TERMS,
  validateAgentAOutput,
  validateAgentBOutput,
  auditSummary,
  buildRepairUserPrompt
} = require('./validator');
const { cleanAgentAForC, cleanAgentBForC } = require('./cleaners');
const {
  buildSegmentJsonUser,
  extractJson,
  extractJsonDetailed,
  validateSegmentJson,
  summarizeStructuredReport,
  renderSegment,
  renderSegmentJimeng,
  buildStructuredRepairPrompt,
  createSegmentSkeleton,
  mergeWithSkeleton,
  TOOL_VERSION,
  enrichSegmentShots
} = require('./structuredC');


function buildParserDialogueHandoff(manifest) {
  const lines = [];
  lines.push("");
  lines.push("═══════════════════════════════════");
  lines.push("【台词清单·交接AGENT_C用】");
  lines.push("（系统自动生成，来自本地 parser；AGENT_A 不负责重写此账本。）");
  lines.push("═══════════════════════════════════");
  lines.push("说明：以下台词编号、说话人、VO/OS、原文均为硬锁定账本，后续 B/C/Planner/Validator 以此为准。");
  lines.push("最终即梦版会隐藏编号；编号只用于内部防漏、防错配。");
  for (const scene of manifest.scenes || []) {
    lines.push("");
    lines.push(("场景" + scene.id + "：" + (scene.header || "")).trim());
    lines.push(dialogueTable(scene) || "无台词");
  }
  lines.push("═══════════════════════════════════");
  return lines.join("\n");
}

function appendParserDialogueHandoff(output, manifest) {
  const handoff = buildParserDialogueHandoff(manifest);
  return (String(output || "").trim() + "\n\n" + handoff).trim();
}

function debugWrite(options, name, data) {
  const dir = options && options.debugDir;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name.replace(/[\\/:*?"<>|]+/g, '_'));
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    fs.writeFileSync(file, text, 'utf8');
  } catch (_) {}
}

function makeEmitter(onEvent) {
  return (event) => {
    if (onEvent) onEvent({ time: new Date().toISOString(), ...event });
  };
}

function makeProvidedAgentAResult({ scriptText, annotatedScript = '', directorNotes = '', mode = 'ai' }) {
  return {
    manifest: parseScript(scriptText),
    output: annotatedScript,
    report: {
      ok: true,
      source: 'provided',
      mode,
      directorNotesProvided: !!String(directorNotes || '').trim()
    }
  };
}

function mergeCostumeCardSources(agentBOutput = '', manualCostumeCard = '') {
  const normalizedAgentB = String(agentBOutput || '').trim();
  const normalizedManual = String(manualCostumeCard || '').trim();
  if (!normalizedAgentB) return normalizedManual;
  if (!normalizedManual) return normalizedAgentB;
  return [
    normalizedAgentB,
    '【用户补充服化道/视觉要求】',
    normalizedManual
  ].join('\n\n');
}

async function repairIfNeeded({ stage, config, system, output, report, manifest, maxRepair = 1, emit }) {
  let current = output;
  let currentReport = report;
  for (let i = 0; i < maxRepair && !currentReport.ok; i++) {
    emit?.({ type: 'repair', stage, message: `校验未通过：${auditSummary(currentReport)}，开始第${i + 1}次修复` });
    const user = buildRepairUserPrompt({ stage, originalText: current, report: currentReport, manifestText: manifestToText(manifest) });
    current = await callModel({ config, system, user, temperature: 0.1, maxTokens: config.maxTokens || 8192 });
    if (stage === 'AGENT_A') current = cleanAgentAForC(current, buildParserDialogueHandoff(manifest));
    currentReport = stage === 'AGENT_A' ? validateAgentAOutput(manifest, current) : validateAgentBOutput(current);
  }
  return { output: current, report: currentReport };
}

async function repairStructuredIfNeeded({ config, system, scene, segment, raw, parsed, report, maxRepair = 1, emit, forbiddenTerms, options = {} }) {
  let currentRaw = raw;
  let currentParsed = parsed;
  let currentReport = report;
  for (let i = 0; i < maxRepair && !currentReport.ok; i++) {
    emit?.({ type: 'repair', stage: 'AGENT_C', sceneId: scene.id, message: `片段${segment.id}结构校验未通过：${summarizeStructuredReport(currentReport)}，开始第${i + 1}次局部JSON修复` });
    const user = buildStructuredRepairPrompt({ scene, segment, originalJsonText: currentRaw, report: currentReport });
    debugWrite(options, `${scene.id}_${segment.id}_repair_${i + 1}_request.txt`, user);
    currentRaw = await callModel({ config, system, user, temperature: 0.05, maxTokens: Math.min(config.maxTokens || 8192, 8192) });
    debugWrite(options, `${scene.id}_${segment.id}_repair_${i + 1}_raw.txt`, currentRaw);
    const detail = extractJsonDetailed(currentRaw);
    debugWrite(options, `${scene.id}_${segment.id}_repair_${i + 1}_cleaned.json`, detail.cleaned || '');
    if (!detail.ok) {
      currentParsed = null;
      currentReport = { ok: false, errors: { parseErrors: ['JSON解析失败：' + detail.error + (detail.context ? '\n附近内容：' + detail.context : '')] } };
      debugWrite(options, `${scene.id}_${segment.id}_repair_${i + 1}_parse_error.json`, currentReport);
      continue;
    }
    const skeleton = createSegmentSkeleton(scene, segment, options.cleanB || '', options.visualStyle || 'plain');
    currentParsed = mergeWithSkeleton(detail.value, skeleton);
    currentRaw = JSON.stringify(currentParsed, null, 2);
    debugWrite(options, `${scene.id}_${segment.id}_repair_${i + 1}_merged.json`, currentParsed);
    currentReport = validateSegmentJson(scene, segment, currentParsed, { forbiddenTerms });
  }
  return { raw: currentRaw, parsed: currentParsed, report: currentReport };
}

async function runAgentA({ scriptText, directorNotes = '', mode = 'ai', config, options = {}, onEvent }) {
  const emit = makeEmitter(onEvent);
  const manifest = parseScript(scriptText);
  emit({ type: 'parse', stage: 'AGENT_A', message: `解析完成：${manifest.stats.sceneCount}场，${manifest.stats.formalDialogueCount}条正式台词，${manifest.stats.actionCount}条动作` });
  const system = buildAgentASystem({ mode, fullRules: !!options.fullRules });
  const user = buildAgentAUser({ manifest, mode, directorNotes });
  emit({ type: 'model_start', stage: 'AGENT_A', message: '开始生成批注剧本' });
  let output = await callModel({ config, system, user, temperature: 0.1, maxTokens: config.maxTokens || 12000 });
  const parserHandoff = buildParserDialogueHandoff(manifest);
  output = cleanAgentAForC(output, parserHandoff);
  const allDialogueCount = manifest.scenes.reduce((n, sc) => n + (sc.dialogues?.length || 0), 0);
  emit({ type: "ledger", stage: "AGENT_A", message: `已由本地parser自动追加台词清单：全部台词${allDialogueCount}条（正式${manifest.stats.formalDialogueCount}，短句/短吼${Math.max(0, allDialogueCount - manifest.stats.formalDialogueCount)}）` });
  let report = validateAgentAOutput(manifest, output);
  const repaired = await repairIfNeeded({ stage: 'AGENT_A', config, system, output, report, manifest, maxRepair: options.maxRepair ?? 1, emit });
  output = repaired.output;
  report = repaired.report;
  emit({ type: 'done', stage: 'AGENT_A', message: `AGENT_A完成：${auditSummary(report)}`, report });
  return { manifest, output, report };
}

async function runAgentB({ scriptText, annotatedScript = '', config, options = {}, onEvent }) {
  const emit = makeEmitter(onEvent);
  const manifest = parseScript(scriptText);
  const system = buildAgentBSystem({ fullRules: !!options.fullRules });
  const user = buildAgentBUser({ manifest, annotatedScript, visualStyle: options.visualStyle || 'plain' });
  emit({ type: 'model_start', stage: 'AGENT_B', message: '开始生成服化道资产卡' });
  let output = await callModel({ config, system, user, temperature: 0.2, maxTokens: config.maxTokens || 10000 });
  let report = validateAgentBOutput(output);
  const repaired = await repairIfNeeded({ stage: 'AGENT_B', config, system, output, report, manifest, maxRepair: 0, emit });
  output = repaired.output;
  report = repaired.report;
  emit({ type: 'done', stage: 'AGENT_B', message: report.ok ? 'AGENT_B完成' : `AGENT_B完成但结构不完整：${auditSummary(report)}`, report });
  return { manifest, output, report };
}

async function runAgentC({ scriptText, annotatedScript = '', costumeCard = '', config, options = {}, onEvent, annotation = null }) {
  const emit = makeEmitter(onEvent);
  const manifest = parseScript(scriptText);
  const parserHandoff = buildParserDialogueHandoff(manifest);
  const cleanA = cleanAgentAForC(annotatedScript, parserHandoff);
  const cleanB = cleanAgentBForC(costumeCard);
  const forbiddenTerms = [...DEFAULT_FORBIDDEN_TERMS, ...String(options.forbiddenTerms || '').split(/[、,，\n]/).map(s => s.trim()).filter(Boolean)];
  const selectedScenes = options.sceneIds?.length ? new Set(options.sceneIds) : null;
  const scenes = manifest.scenes.filter(s => !selectedScenes || selectedScenes.has(s.id));
  emit({ type: 'parse', stage: 'AGENT_C', message: `C ${TOOL_VERSION}硬锁准备：${scenes.length}场；程序锁片段/台词/镜头/输出白名单，默认不让模型重写C结构` });

  const sceneOutputs = [];
  const sceneReports = [];
  for (const scene of scenes) {
    const system = buildAgentCSystem({ sceneType: scene.sceneType, fullRules: !!options.fullRules }) + `\n\n【${TOOL_VERSION}骨架填空模式】\n不要直接写最终提示词。程序已预填 covers/speaker/line/lens/movement/E。你只填 visual、speakerAction、listenerReaction、physicalFeedback、soundDesign 等可拍字段。只输出JSON对象，不要Markdown，不要解释。`;
    const segments = planSceneSegments(scene, { ...options, annotatedScript: cleanA });
    emit({ type: "plan", stage: "PLANNER", sceneId: scene.id, message: `事件分段规划锁定：${segments.length}段（${segments.map(x => x.id + ":" + x.dialogueIds.join(",")).join(" / ")}）`, report: { ok: true, sceneId: scene.id, summary: segmentPlanToText(scene, segments) } });
    debugWrite(options, `${scene.id}_segment_plan.json`, { sceneId: scene.id, segments, planText: segmentPlanToText(scene, segments) });
    let renderedSegments = [];
    const internalSegments = [];
    const segmentReports = [];

    // 第一阶段：快速生成所有骨架（顺序执行，<1ms）
    const segInfos = segments.map((segment, segIdx) => {
      const totalSegs = segments.length;
      segment.isLastSegment = (segIdx === totalSegs - 1);
      const skeleton = createSegmentSkeleton(scene, segment, cleanB, options.visualStyle || 'plain', { annotation });
      const parsed = mergeWithSkeleton({}, skeleton);
      const report = validateSegmentJson(scene, segment, parsed, { forbiddenTerms });
      debugWrite(options, `${scene.id}_${segment.id}_hardlock.json`, parsed);
      debugWrite(options, `${scene.id}_${segment.id}_validation.json`, report);
      segmentReports.push({ segmentId: segment.id, ...report, summary: summarizeStructuredReport(report) });
      return { segment, parsed, skeleton, report, index: segIdx };
    });

    // 第二阶段：并行 enrichment（耗时大户，Promise.all 并发）
    emit({ type: 'model_start', stage: 'AGENT_C', sceneId: scene.id, message: `并行增强${segments.length}个片段...` });
    const enrichedResults = await Promise.all(segInfos.map(({ segment, parsed }, segIdx) =>
      enrichSegmentShots({
        scene, segment, parsed, costumeCard: cleanB, config,
        prevSegmentEnd: '', annotation, segIndex: segIdx, totalSegs: segments.length,
        previousStyleLock: null, forbiddenTerms
      })
    ));

    // 第三阶段：顺序处理结果（校验/渲染/更新）
    for (let segIdx = 0; segIdx < segInfos.length; segIdx++) {
      const { segment, parsed } = segInfos[segIdx];
      let report = segmentReports[segIdx];
      const enriched = enrichedResults[segIdx];

      // ⚠️ 硬兜底：强制所有片段恰好 15s（先台词保底，再比例填满/压缩）
      if (enriched && enriched.shots && enriched.shots.length) {
        const shots = enriched.shots;
        function shotMinDur(sh) {
          const lines = sh.dialogueLines || [];
          if (!lines.length) return 0;
          let t = 0;
          for (const d of lines) {
            const txt = d.text || '';
            const ch = txt.length;
            if (!ch) continue;
            t += Math.max(1, ch / 3.6 + (txt.match(/[，、,]/g)||[]).length*0.45 + (txt.match(/[。！？!?]/g)||[]).length*0.7);
          }
          return Math.round(t * 10) / 10;
        }
        const mins = shots.map(shotMinDur);
        const minSum = mins.reduce((a, b) => a + b, 0);
        const dialogueCount = mins.filter(m => m > 0).length;
        const totalRaw = shots.reduce((s, sh) => s + parseFloat(String(sh.duration || '2').replace('s', '')), 0);
        const needFix = totalRaw > 15.01 || (totalRaw < 14.5 && totalRaw > 0);
        if (needFix) {
          const minBudget = minSum + (shots.length - dialogueCount) * 1.5;
          let remain = 15;
          // 使用权重分配：优先用现有 duration 作为权重基础
          for (let i = 0; i < shots.length; i++) {
            const raw = parseFloat(String(shots[i].duration || '2').replace('s', ''));
            const weight = Math.max(raw, 1);
            const isLast = i === shots.length - 1;
            if (minBudget > 15) {
              // 台词太挤，纯比例分配
              const budget = isLast ? remain : Math.min(remain - (shots.length - 1 - i) * 1.5, Math.max(1.5, weight * 15 / totalRaw));
              shots[i].duration = `${Math.round(Math.max(1.5, Math.min(budget, remain)) * 10) / 10}s`;
            } else {
              // 先给保底，再按权重分配剩余
              const extraBudget = 15 - minSum - (shots.length - dialogueCount) * 1.5;
              const base = mins[i] > 0 ? mins[i] : 1.5;
              const extra = isLast ? (remain - base) : Math.max(0, extraBudget * weight / totalRaw);
              const want = Math.round((base + Math.max(0, extra)) * 10) / 10;
              const cap = isLast ? remain : Math.round((remain - (shots.length - 1 - i) * 1.5) * 10) / 10;
              shots[i].duration = `${Math.min(want, cap)}s`;
            }
            remain = Math.round((remain - parseFloat(shots[i].duration.replace('s', ''))) * 10) / 10;
          }
        }
      }

      if (enriched !== parsed) {
        debugWrite(options, `${scene.id}_${segment.id}_enriched.json`, enriched);
        report = validateSegmentJson(scene, segment, enriched, { forbiddenTerms });
        segmentReports[segIdx] = { segmentId: segment.id, ...report, summary: summarizeStructuredReport(report) };
      }

      renderedSegments.push(renderSegment(enriched));
      internalSegments.push(JSON.stringify(enriched, null, 2));
      emit({ type: 'scene_done', stage: 'AGENT_C', sceneId: scene.id, message: `片段${segment.id}完成：${summarizeStructuredReport(report)}`, report });
      if (!report.ok && options.failFast !== false) {
        const fatalKeys = ['parseErrors', 'missingCovers', 'duplicateCovers', 'speakerErrors', 'lineErrors', 'voErrors'];
        const nonSourceFatal = fatalKeys.reduce((n, k) => n + ((report.errors?.[k] || []).length), 0);
        if (nonSourceFatal > 0) {
          throw new Error(`片段${segment.id}未通过校验，已停止继续生成：${summarizeStructuredReport(report)}`);
        }
      }
    }
    const ok = segmentReports.every(r => r.ok);
    // A画面物理系统去重：只保留第一个片段的A部分（新管道）
    renderedSegments = deduplicateARenderings(renderedSegments);
    sceneOutputs.push({ sceneId: scene.id, header: scene.header, sceneType: scene.sceneType, content: renderedSegments.join('\n\n'), internalContent: internalSegments.join('\n\n') });
    sceneReports.push({ sceneId: scene.id, ok, segments: segmentReports, summary: ok ? '通过' : segmentReports.map(r => `${r.segmentId}:${r.summary}`).join('；') });
  }
  const output = sceneOutputs.map(s => `═══════════════════════════════════\n场景 ${s.sceneId} ${s.header}\n═══════════════════════════════════\n\n${s.content}`).join('\n\n');
  const internalOutput = sceneOutputs.map(s => `═══════════════════════════════════\n场景 ${s.sceneId} ${s.header}\n═══════════════════════════════════\n\n${s.internalContent}`).join('\n\n');
  const ok = sceneReports.every(r => r.ok);
  emit({ type: 'done', stage: 'AGENT_C', message: ok ? 'AGENT_C结构化完成且校验通过' : 'AGENT_C结构化完成但仍有校验问题', report: sceneReports });
  return { manifest, output, internalOutput, report: { ok, scenes: sceneReports }, sceneOutputs };
}

async function runFull({ scriptText, directorNotes = '', mode = 'ai', config, options = {}, onEvent }) {
  const emit = makeEmitter(onEvent);
  emit({ type: 'start', stage: 'FULL', message: `开始全流程：A → B → C(${TOOL_VERSION}硬锁输出)` });
  const a = await runAgentA({ scriptText, directorNotes, mode, config, options, onEvent });
  const b = await runAgentB({ scriptText, annotatedScript: a.output, config, options, onEvent });
  const c = await runAgentC({ scriptText, annotatedScript: a.output, costumeCard: b.output, config, options, onEvent });
  emit({ type: 'done', stage: 'FULL', message: '全流程完成' });
  return { manifest: a.manifest, agentA: a, agentB: b, agentC: c };
}

// ── 新管道渲染去重：只保留第一个片段的【A】画面物理系统 ────────────────
async function runGenerateFlow({
  scriptText,
  annotatedScript = '',
  costumeCard = '',
  config,
  options = {},
  onEvent,
  directorNotes = '',
  mode = 'ai',
  annotation = null
}) {
  const emit = makeEmitter(onEvent);
  const providedAnnotatedScript = String(annotatedScript || '').trim();
  const shouldRunAgentA = !providedAnnotatedScript && options.skipAgentA !== true;

  emit({
    type: 'start',
    stage: 'FLOW',
    message: shouldRunAgentA
      ? `Unified flow started: A -> B -> C (${TOOL_VERSION})`
      : `Unified flow started: reuse Agent A -> B -> C (${TOOL_VERSION})`
  });

  const agentA = shouldRunAgentA
    ? await runAgentA({ scriptText, directorNotes, mode, config, options, onEvent })
    : makeProvidedAgentAResult({ scriptText, annotatedScript: providedAnnotatedScript, directorNotes, mode });

  if (!shouldRunAgentA) {
    emit({
      type: 'done',
      stage: 'AGENT_A',
      message: 'Skip AGENT_A: reuse provided annotated script',
      report: agentA.report
    });
  }

  const agentB = await runAgentB({
    scriptText,
    annotatedScript: agentA.output,
    config,
    options,
    onEvent
  });

  const combinedCostumeCard = mergeCostumeCardSources(agentB.output, costumeCard);
  emit({
    type: 'merge',
    stage: 'AGENT_B',
    message: String(costumeCard || '').trim()
      ? 'AGENT_B output merged with manual costume card'
      : 'AGENT_B output will be used directly by AGENT_C'
  });

  const agentC = await runAgentC({
    scriptText,
    annotatedScript: agentA.output,
    costumeCard: combinedCostumeCard,
    config,
    options,
    onEvent,
    annotation
  });

  emit({ type: 'done', stage: 'FLOW', message: 'Unified flow completed' });
  return {
    manifest: agentC.manifest || agentA.manifest,
    agentA,
    agentB,
    agentC,
    annotatedScript: agentA.output,
    costumeCard: combinedCostumeCard
  };
}

function deduplicateARenderings(renderedSegments) {
  if (!Array.isArray(renderedSegments) || renderedSegments.length <= 1) return renderedSegments;
  // 匹配【片段X】+【A】画面物理系统 到 下一个【B】或文本结束
  const A_BLOCK_RE = /【片段[^】]*】[^\n]*\n?【A】画面物理系统[：:]?\n?[\s\S]*?(?=\n【[B-G]】|$)/;
  return renderedSegments.map((seg, idx) => {
    if (idx === 0) return seg; // 第一个片段保留A
    return seg.replace(A_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  });
}

module.exports = { runAgentA, runAgentB, runAgentC, runFull, runGenerateFlow, mergeCostumeCardSources };
