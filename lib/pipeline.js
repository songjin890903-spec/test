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
  buildStructuredRepairPrompt,
  createSegmentSkeleton,
  mergeWithSkeleton,
  TOOL_VERSION
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
  let output = await callModel({ config, system, user, temperature: 0.2, maxTokens: config.maxTokens || 12000 });
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

async function runAgentC({ scriptText, annotatedScript = '', costumeCard = '', config, options = {}, onEvent }) {
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
    const segments = planSceneSegments(scene, options);
    emit({ type: "plan", stage: "PLANNER", sceneId: scene.id, message: `事件分段规划锁定：${segments.length}段（${segments.map(x => x.id + ":" + x.dialogueIds.join(",")).join(" / ")}）`, report: { ok: true, sceneId: scene.id, summary: segmentPlanToText(scene, segments) } });
    debugWrite(options, `${scene.id}_segment_plan.json`, { sceneId: scene.id, segments, planText: segmentPlanToText(scene, segments) });
    const renderedSegments = [];
    const internalSegments = [];
    const segmentReports = [];
    for (const segment of segments) {
      emit({ type: 'model_start', stage: 'AGENT_C', sceneId: scene.id, message: `生成片段${segment.id}硬锁版：跳过C模型自由写作，按parser账本直接渲染` });
      const skeleton = createSegmentSkeleton(scene, segment, cleanB, options.visualStyle || 'plain');
      const parsed = mergeWithSkeleton({}, skeleton);
      const report = validateSegmentJson(scene, segment, parsed, { forbiddenTerms });
      debugWrite(options, `${scene.id}_${segment.id}_hardlock.json`, parsed);
      debugWrite(options, `${scene.id}_${segment.id}_validation.json`, report);
      segmentReports.push({ segmentId: segment.id, ...report, summary: summarizeStructuredReport(report) });
      renderedSegments.push(renderSegment(parsed));
      internalSegments.push(JSON.stringify(parsed, null, 2));
      emit({ type: 'scene_done', stage: 'AGENT_C', sceneId: scene.id, message: `片段${segment.id}完成：${summarizeStructuredReport(report)}`, report });
      if (!report.ok && options.failFast !== false) {
        throw new Error(`片段${segment.id}未通过校验，已停止继续生成：${summarizeStructuredReport(report)}`);
      }
    }
    const ok = segmentReports.every(r => r.ok);
    sceneOutputs.push({ sceneId: scene.id, header: scene.header, sceneType: scene.sceneType, content: renderedSegments.join('\n\n---\n\n'), internalContent: internalSegments.join('\n\n---\n\n') });
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

module.exports = { runAgentA, runAgentB, runAgentC, runFull };
