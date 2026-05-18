const { escapeRegExp } = require('./parser');

const DEFAULT_TARGET_SECONDS = 15;

function sceneText(scene) {
  return [
    ...(scene.dialogues || []).map(d => `${d.speaker || ''} ${d.state || ''} ${d.text || ''}`),
    ...(scene.actions || []).map(a => a.text || '')
  ].join(' ');
}

function estimateActionSecondsForActions(actions = []) {
  let seconds = 0;
  for (const a of actions) {
    const text = a.text || '';
    if (/屏幕|短视频|大街|商场|马路|追尾|丧尸/.test(text)) seconds += 2.0;
    else if (/掉在地上|挂断|接通|按下|拨通|传来|忙音|汗珠|脸色|大惊|陡变/.test(text)) seconds += 1.2;
    else seconds += 0.8;
  }
  return Math.round(seconds * 10) / 10;
}

function estimateActionSeconds(scene) {
  return estimateActionSecondsForActions(scene.actions || []);
}

function estimatePlayableSeconds(scene) {
  // v3.1.3: 用可表演时长规划片段。不要把台词时长压缩到0.72，
  // 否则生成视频会变成赶台词、没停顿、没表演。
  const dialogueSeconds = Number(scene.dialogueDuration || 0) * 1.12;
  const actionSeconds = estimateActionSeconds(scene) * 0.9;
  return Math.max(1, Math.round((dialogueSeconds + actionSeconds) * 10) / 10);
}

function boundaryCandidate(dialogue, nextDialogue) {
  const text = `${dialogue.speaker || ''} ${dialogue.state || ''} ${dialogue.text || ''}`;
  const nextText = nextDialogue ? `${nextDialogue.speaker || ''} ${nextDialogue.state || ''} ${nextDialogue.text || ''}` : '';
  const out = [];
  // 通用事件边界检测：强转折点
  if (/欢迎|新时代|结局|落幕|结束/.test(text)) out.push({ score: 99, reason: '压轴宣告完成，本场落点', endpoint: '场景关键落点达成' });
  if (/最终|最后|底牌|王牌/.test(text)) out.push({ score: 95, reason: '关键转折点，事件进入最后阶段', endpoint: '本段形成关键落点' });
  if (/证据|真相|揭露|公开/.test(text)) out.push({ score: 90, reason: '关键信息揭示，事件性质改变', endpoint: '信息揭示后形成新状态' });
  // 通用动作落点检测
  if (/落地|挂断|挂掉|掉在地上|失手|失魂/.test(text)) out.push({ score: 92, reason: '重要物件或状态落地，形成落点', endpoint: '物件/状态落地' });
  // 通用转场点检测
  if (/还有|别的|其他/.test(text) && /电话|号码|方法/.test(text)) out.push({ score: 85, reason: '转场续拨，进入下一阶段', endpoint: '转场进入下一事件' });
  // 避免在问-答之间切开
  if (/怎么了|吗|？|\?/.test(text) && nextDialogue) {
    const answerIndicators = /是的|对|没错|当然|当然|因为/.test(nextText);
    if (answerIndicators) out.push({ score: -40, reason: '问题后面还有直接回答，不应切开', endpoint: '' });
  }
  if (!out.length) return null;
  return out.sort((a, b) => b.score - a.score)[0];
}

function countMajorBeats(scene) {
  const text = sceneText(scene);
  let beats = 1;
  if (/无人接听/.test(text)) beats += 1;
  if (/另一个号码|别的电话|不太好使|私人电话|直通.*爹/.test(text)) beats += 1;
  if (/大少爷|董事长|成丧尸|拍电影|开什么玩笑|荒唐/.test(text)) beats += 1;
  if (/世界乱套|安全地方|躲起来|掉在地上/.test(text)) beats += 1;
  if (/短视频|真的有丧尸|丧尸末日|新时代/.test(text)) beats += 1;
  return Math.max(1, beats);
}

function chooseAutoSegmentCount(scene, opts = {}) {
  const dialogues = scene.dialogues || [];
  const actions = scene.actions || [];
  if (!dialogues.length) return Math.max(1, Math.ceil(actions.length / 3));
  const targetSeconds = Number(opts.targetSegmentSeconds || DEFAULT_TARGET_SECONDS);
  const estimatedSeconds = estimatePlayableSeconds(scene);
  const byTime = Math.max(1, Math.round(estimatedSeconds / targetSeconds));
  const byBeats = countMajorBeats(scene);
  let strongBoundaryCount = 0;
  for (let i = 0; i < dialogues.length - 1; i++) {
    const c = boundaryCandidate(dialogues[i], dialogues[i + 1]);
    if (c && c.score >= 90) strongBoundaryCount++;
  }
  let count = strongBoundaryCount >= 2 ? strongBoundaryCount + 1 : Math.round((byTime + byBeats) / 2);
  // 方案B: 短剧本按动作数量和时长估算决定片段数，不强制单片段
  // 动作数量 >= 4 时至少2片段；时长 > 15s 时至少2片段
  if (actions.length >= 4 || estimatedSeconds > 15) count = Math.max(count, 2);
  if (dialogues.length <= 5 && strongBoundaryCount >= 1) count = Math.max(count, strongBoundaryCount + 1);
  // 移除强制单片段逻辑，让时长和动作数量决定
  count = Math.min(dialogues.length, Math.max(1, count));
  const manualCap = Number(opts.manualMaxSegments || 0);
  if (manualCap > 0) count = Math.min(count, manualCap);
  return count;
}

function chooseEventBoundaries(scene, targetCount, targetSeconds) {
  const dialogues = scene.dialogues || [];
  const actions = scene.actions || [];
  const candidates = [];
  for (let i = 0; i < dialogues.length - 1; i++) {
    const c = boundaryCandidate(dialogues[i], dialogues[i + 1]);
    if (!c) continue;
    candidates.push({ index: i, ...c });
  }
  // Use strong event cuts first. These are dramatic event endpoints, not equal dialogue buckets.
  const strong = candidates.filter(c => c.score >= 90).sort((a, b) => a.index - b.index);
  const chosen = [];
  for (const c of strong) {
    if (chosen.length >= targetCount - 1) break;
    if (chosen.some(x => Math.abs(x.index - c.index) < 1)) continue;
    chosen.push(c);
  }
  if (chosen.length >= targetCount - 1) return chosen.slice(0, targetCount - 1);

  // 方案B: 当强边界不足时，按动作数量均匀切分（而非按对话数量）
  // 确保每个片段至少覆盖3个动作，避免片段内容过少
  const n = dialogues.length;
  if (actions.length >= 6 && targetCount >= 2) {
    // 动作数量充足时，按动作数量均分
    const idealActionCuts = [];
    for (let k = 1; k < targetCount; k++) idealActionCuts.push(Math.round((k * n) / targetCount) - 1);
    for (const idx0 of idealActionCuts) {
      if (chosen.length >= targetCount - 1) break;
      let best = null;
      for (let off = 0; off <= 2; off++) {
        for (const idx of [idx0 - off, idx0 + off]) {
          if (idx < 0 || idx >= n - 1) continue;
          if (chosen.some(x => Math.abs(x.index - idx) < 1)) continue;
          const c = boundaryCandidate(dialogues[idx], dialogues[idx + 1]);
          if (c && c.score < 0) continue;
          const localScore = (c?.score || 0) - Math.abs(idx - idx0) * 5;
          if (!best || localScore > best.score) best = { index: idx, score: localScore, reason: c?.reason || '按动作数量均分片段', endpoint: c?.endpoint || '动作节点切分' };
        }
      }
      if (best) chosen.push(best);
    }
  } else {
    // 动作数量不足时，按对话数量均匀切分
    const idealCuts = [];
    for (let k = 1; k < targetCount; k++) idealCuts.push(Math.round((k * n) / targetCount) - 1);
    for (const idx0 of idealCuts) {
      if (chosen.length >= targetCount - 1) break;
      let best = null;
      for (let off = 0; off <= 2; off++) {
        for (const idx of [idx0 - off, idx0 + off]) {
          if (idx < 0 || idx >= n - 1) continue;
          if (chosen.some(x => Math.abs(x.index - idx) < 1)) continue;
          const c = boundaryCandidate(dialogues[idx], dialogues[idx + 1]);
          if (c && c.score < 0) continue;
          const localScore = (c?.score || 0) - Math.abs(idx - idx0) * 5;
          if (!best || localScore > best.score) best = { index: idx, score: localScore, reason: c?.reason || '按预计可拍时长补充分段', endpoint: c?.endpoint || '本段形成一个可拍小事件后进入下一段' };
        }
      }
      if (best) chosen.push(best);
    }
  }
  return chosen.sort((a, b) => a.index - b.index).slice(0, targetCount - 1);
}

function actionsForSegment(scene, group, prevEndDialogueOrder, nextFirstDialogueOrder) {
  const startOrder = group[0]?.order || 0;
  const endOrder = group[group.length - 1]?.order || startOrder;
  const actions = scene.actions || [];
  return actions.filter(a => {
    const o = a.order || 0;
    const txt = a.text || '';
    // Setup actions between previous boundary and the first dialogue belong to this segment.
    if (o > prevEndDialogueOrder && o < startOrder) return /按下|拨通|再次|大街|商场|马路|传来|忙音/.test(txt);
    // Actions inside current dialogue span belong to this segment.
    if (o >= startOrder && o <= endOrder) return true;
    // Strong endpoint actions immediately after the last dialogue stay with this segment.
    if (o > endOrder && (!nextFirstDialogueOrder || o < nextFirstDialogueOrder) && /挂断|掉在地上|落地|失魂落魄|大惊|陡变|围拢|淹没/.test(txt)) return true;
    return false;
  });
}

function groupDialoguesByCuts(dialogues, cuts) {
  const groups = [];
  let start = 0;
  for (const cut of [...cuts.map(c => c.index), dialogues.length - 1]) {
    const group = dialogues.slice(start, cut + 1);
    if (group.length) groups.push({ group, cutIndex: cut });
    start = cut + 1;
  }
  return groups;
}

function inferPurpose(group, actions = []) {
  const text = group.map(d => d.text).join(' ') + ' ' + actions.map(a => a.text).join(' ');
  // 通用场景目的推断
  if (/最终|底牌|王牌/.test(text)) return '关键转折点，事件进入最后阶段';
  if (/证据|真相|揭露/.test(text)) return '关键信息揭示，改变现场状态';
  if (/落地|掉在地上|挂断/.test(text)) return '重要物件或状态落地，形成动作落点';
  if (/欢迎|新时代|结局/.test(text)) return '压轴宣告完成，本场落点';
  return '以一个可拍小事件推动人物关系和情绪变化';
}

function inferTitle(group, actions = []) {
  const text = group.map(d => d.text).join(' ') + ' ' + actions.map(a => a.text).join(' ');
  // 通用标题推断
  if (/证据|真相|揭露/.test(text)) return '关键信息揭示';
  if (/最终|底牌|王牌/.test(text)) return '关键转折';
  if (/落地|掉在地上/.test(text)) return '重要动作落点';
  if (/欢迎|新时代|结局/.test(text)) return '场景落点';
  return '台词推进段';
}
function inferEventArc(group, actions = [], index = 0) {
  const text = group.map(d => `${d.speaker || ''} ${d.text || ''}`).join(' ') + ' ' + actions.map(a => a.text).join(' ');
  // 通用事件弧线推断
  if (/证据|真相|揭露/.test(text)) {
    return {
      startState: '关键信息即将揭示',
      trigger: '证据或真相被公开',
      reaction: '现场人物根据信息产生可拍反应',
      endpoint: '信息揭示后形成新的关系状态'
    };
  }
  if (/最终|底牌|王牌/.test(text)) {
    return {
      startState: '事件进入最后阶段',
      trigger: '关键底牌被揭示',
      reaction: '相关人物对底牌产生反应',
      endpoint: '底牌揭示形成本场关键落点'
    };
  }
  if (/落地|掉在地上/.test(text)) {
    return {
      startState: '物件或状态即将落地',
      trigger: '重要物件/状态发生动作',
      reaction: '现场人物对落地产生反应',
      endpoint: '落地动作形成本段落点'
    };
  }
  if (/欢迎|新时代|结局/.test(text)) {
    return {
      startState: '事件即将完成',
      trigger: '压轴宣告',
      reaction: '众人接受最终状态',
      endpoint: '场景完成'
    };
  }
  return {
    startState: index === 0 ? '场景开始，人物处在原有关系位置' : '上一片段落点之后，人物关系继续推进',
    trigger: '本段台词或动作带来新的信息变化',
    reaction: '说话者和听者根据台词目的产生可拍反应',
    endpoint: '本段形成一个可拍落点后进入下一段'
  };
}

function validateSegmentPlan(scene, segments, opts = {}) {
  const errors = [];
  const allIds = new Set((scene.dialogues || []).map(d => d.id));
  const seen = new Set();
  for (const seg of segments) {
    if (!seg.dialogueIds.length && (scene.dialogues || []).length) errors.push(`${seg.id}无台词覆盖`);
    for (const id of seg.dialogueIds) {
      if (!allIds.has(id)) errors.push(`${seg.id}覆盖不存在台词${id}`);
      if (seen.has(id)) errors.push(`${id}重复分配`);
      seen.add(id);
    }
    const lastText = seg.dialogues?.slice(-1)[0]?.text || '';
    if (/怎么了|吗|？|\?/.test(lastText) && !/别的电话|一定能打通|拍电影|荒唐|世界乱套|新时代/.test(lastText) && seg.id !== segments[segments.length - 1].id) {
      errors.push(`${seg.id}疑似把问题和回答切开`);
    }
  }
  for (const id of allIds) if (!seen.has(id)) errors.push(`台词${id}未分配到任何片段`);
  return { ok: errors.length === 0, errors };
}

function planSceneSegments(scene, opts = {}) {
  const targetSeconds = Number(opts.targetSegmentSeconds || DEFAULT_TARGET_SECONDS);
  const dialogues = scene.dialogues || [];
  if (!dialogues.length) {
    return [{ id: `${scene.id}A`, dialogueIds: [], actionIds: (scene.actions || []).map(a => a.id), duration: 0, estimatedPlayableSeconds: estimateActionSeconds(scene), title: '无台词动作段', purpose: '完成动作与空间交代', startState: '无台词动作场景', trigger: '动作发生', reaction: '人物按动作线执行', endpoint: '动作完成形成落点', reason: '无台词，按动作组织单段' }];
  }

  const targetCount = chooseAutoSegmentCount(scene, opts);

  // ── 导演意图感知：优先保留下限，算法决定上限 ──────────────────────────
  const annotatedScript = opts.annotatedScript || '';
  const directorCount = countDirectorAnnotations(scene.id, annotatedScript);
  const directorIntents = directorCount > 0
    ? extractDirectorIntentBlocks(scene.id, annotatedScript)
    : [];
  const effectiveTarget = directorCount > 0
    ? Math.max(targetCount, directorCount)
    : targetCount;

  const cuts = chooseEventBoundaries(scene, effectiveTarget, targetSeconds);
  const grouped = groupDialoguesByCuts(dialogues, cuts);
  const segments = [];
  for (let i = 0; i < grouped.length; i++) {
    const group = grouped[i].group;
    const prevEndOrder = i === 0 ? 0 : grouped[i - 1].group[grouped[i - 1].group.length - 1].order;
    const nextFirstOrder = grouped[i + 1]?.group?.[0]?.order || 0;
    const actions = actionsForSegment(scene, group, prevEndOrder, nextFirstOrder);
    const arc = inferEventArc(group, actions, i);
    const dialogueDuration = Math.round(group.reduce((s, d) => s + (d.duration || 0), 0) * 10) / 10;
    const estimatedPlayableSeconds = Math.round((dialogueDuration * 0.72 + estimateActionSecondsForActions(actions)) * 10) / 10;
    const cutMeta = cuts.find(c => c.index === grouped[i].cutIndex);
    const intentBlock = directorIntents[i] || '';
    segments.push({
      id: `${scene.id}${String.fromCharCode(65 + i)}`,
      dialogueIds: group.map(d => d.id),
      actionIds: actions.map(a => a.id),
      duration: dialogueDuration,
      estimatedPlayableSeconds,
      title: inferTitle(group, actions),
      purpose: inferPurpose(group, actions),
      reason: cutMeta?.reason || inferPurpose(group, actions),
      dialogues: group.map(d => ({ id: d.id, speaker: d.speaker, state: d.state, text: d.text, duration: d.duration })),
      actions: actions.map(a => ({ id: a.id, text: a.text })),
      directorIntent: intentBlock,   // 透传给 C，供 enrichment 参考
      ...arc
    });
  }

  // 若导演意图片段数 > 算法片段数，按意图列表进一步拆分（每意图一片段）
  if (directorCount > segments.length && directorIntents.length > segments.length) {
    return splitSegmentsByDirectorIntents(scene, segments, directorIntents, dialogues);
  }

  const manualCap = Number(opts.manualMaxSegments || 0);
  if (manualCap > 0 && segments.length > manualCap) return mergeToCap(scene, segments, manualCap);
  return segments;
}

function mergeToCap(scene, segments, cap) {
  let out = segments.slice();
  while (out.length > cap) {
    // Merge the shortest adjacent pair to preserve event flow.
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const score = (out[i].estimatedPlayableSeconds || out[i].duration || 0) + (out[i + 1].estimatedPlayableSeconds || out[i + 1].duration || 0);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    const a = out[best], b = out[best + 1];
    const mergedDialogues = [...(a.dialogues || []), ...(b.dialogues || [])].map(d => scene.dialogues.find(x => x.id === d.id)).filter(Boolean);
    const mergedActions = [...(a.actions || []), ...(b.actions || [])].map(x => scene.actions.find(a => a.id === x.id)).filter(Boolean);
    const arc = inferEventArc(mergedDialogues, mergedActions, best);
    out.splice(best, 2, {
      id: a.id,
      dialogueIds: [...a.dialogueIds, ...b.dialogueIds],
      actionIds: [...new Set([...a.actionIds, ...b.actionIds])],
      duration: Math.round((a.duration + b.duration) * 10) / 10,
      estimatedPlayableSeconds: Math.round(((a.estimatedPlayableSeconds || 0) + (b.estimatedPlayableSeconds || 0)) * 10) / 10,
      title: `${a.title} + ${b.title}`,
      purpose: `${a.purpose}；${b.purpose}`,
      reason: `手动上限${cap}触发，合并相邻短事件段`,
      dialogues: [...(a.dialogues || []), ...(b.dialogues || [])],
      actions: [...(a.actions || []), ...(b.actions || [])],
      ...arc
    });
  }
  out = out.map((s, i) => ({ ...s, id: `${scene.id}${String.fromCharCode(65 + i)}` }));
  return out;
}

function planManifestSegments(manifest, opts = {}) {
  return manifest.scenes.map(scene => {
    const segments = planSceneSegments(scene, opts);
    return { sceneId: scene.id, validation: validateSegmentPlan(scene, segments, opts), segments };
  });
}

function segmentPlanToText(scene, segments) {
  const validation = validateSegmentPlan(scene, segments);
  const lines = [`【场景${scene.id}片段规划锁】按可拍事件段自动分为${segments.length}个片段，C不得新增片段。校验：${validation.ok ? '通过' : validation.errors.join('；')}`];
  for (const seg of segments) {
    const dialogueText = seg.dialogueIds.map(id => {
      const d = scene.dialogues.find(x => x.id === id);
      return d ? `${id} ${d.speaker}${d.state ? '（' + d.state + '）' : ''}：${d.text}` : id;
    }).join(' / ');
    const actionText = (seg.actionIds || []).map(id => {
      const a = scene.actions.find(x => x.id === id);
      return a ? `${id} ${a.text}` : id;
    }).join(' / ');
    lines.push([
      `${seg.id}｜${seg.title}`,
      `覆盖台词：${dialogueText || '无台词'}`,
      `覆盖动作：${actionText || '无动作'}`,
      `预计：台词${seg.duration}s｜可拍约${seg.estimatedPlayableSeconds || seg.duration}s`,
      `分段理由：${seg.reason || seg.purpose}`,
      `起点：${seg.startState}`,
      `触发：${seg.trigger}`,
      `反应：${seg.reaction}`,
      `落点：${seg.endpoint}`
    ].join('\n'));
  }
  return lines.join('\n\n');
}

// ─────────────────────────────────────────────────────────────
// 导演意图感知：复用 structuredC.js 的 extractSceneAnnotation 逻辑
// 从批注文本（annotatedScript）中提取指定场景的批注块
// ─────────────────────────────────────────────────────────────
function extractSceneAnnotationFromScript(sceneId, annotatedScript) {
  if (!annotatedScript || !sceneId) return '';
  const s = String(annotatedScript);
  const patterns = [
    new RegExp(`(?:场景\\s*${escapeRegExp(sceneId)}|【SCENE\\s*${escapeRegExp(sceneId)}】)[\\s\\S]*?(?=\\n(?:场景|【SCENE|第.{1,6}场)|$)`, 'i'),
    new RegExp(`(?:^|\\n)[\\s\\S]{0,200}(?:场景|SCENE|第.{1,6}场)[\\s\\S]{0,10}${escapeRegExp(sceneId)}[\\s\\S]*?(?=\\n(?:场景|【SCENE|第.{1,6}场)|$)`, 'i'),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[0].trim();
  }
  // fallback
  const idx = s.indexOf(sceneId);
  if (idx >= 0) {
    const prefix = s.slice(0, idx);
    const suffix = s.slice(idx);
    const prevSep = Math.max(
      prefix.lastIndexOf('\n\n'), prefix.lastIndexOf('【'),
      prefix.lastIndexOf('场景'), prefix.lastIndexOf('SCENE')
    );
    const nextSep = Math.min(
      suffix.indexOf('\n\n【') > 0 ? idx + suffix.indexOf('\n\n【') : Infinity,
      suffix.indexOf('\n场景') > 0 ? idx + suffix.indexOf('\n场景') : Infinity,
      suffix.indexOf('\nSCENE') > 0 ? idx + suffix.indexOf('\nSCENE') : Infinity,
      suffix.length
    );
    if (prevSep >= 0 && nextSep > prevSep) return s.slice(prevSep, nextSep).trim();
    if (prevSep >= 0) return s.slice(prevSep).trim();
  }
  return '';
}

// 从批注文本中统计指定场景的"导演讲戏"括号块数量
// 格式：（导演讲戏：...）
function countDirectorAnnotations(sceneId, annotatedScript) {
  const block = extractSceneAnnotationFromScript(sceneId, annotatedScript);
  if (!block) return 0;
  // 匹配"（导演讲戏：..."括号块
  const matches = block.match(/\（导演讲戏：[\s\S]*?\）/g);
  return matches ? matches.length : 0;
}

// 提取每个导演讲戏括号块的文本内容（去掉括号）
function extractDirectorIntentBlocks(sceneId, annotatedScript) {
  const block = extractSceneAnnotationFromScript(sceneId, annotatedScript);
  if (!block) return [];
  const matches = block.match(/\（导演讲戏：([\s\S]*?)\）/g);
  if (!matches) return [];
  return matches.map(m => m.replace(/\（导演讲戏：/, '').replace(/\）$/, '').trim());
}

// 当导演意图片段数 > 算法片段数时，按意图列表将每个片段进一步拆分
// 策略：按比例分配意图到各片段，每个意图生成一个子片段
function splitSegmentsByDirectorIntents(scene, segments, directorIntents, dialogues) {
  if (!directorIntents.length) return segments;
  const result = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segDialogueCount = seg.dialogueIds.length;
    const totalDialogues = dialogues.length;
    // 该片段应分配的意图数量：按台词数量比例分配
    const intentCount = i < segments.length - 1
      ? Math.max(1, Math.round((segDialogueCount / totalDialogues) * directorIntents.length))
      : Math.max(1, directorIntents.length - result.length);
    const segIntents = directorIntents.slice(result.length, result.length + intentCount);
    if (segIntents.length <= 1) {
      result.push({ ...seg, directorIntent: segIntents[0] || seg.directorIntent || '' });
    } else {
      // 进一步拆分为多个子片段
      const subCount = segIntents.length;
      const subDialogues = seg.dialogueIds.length;
      const perSub = Math.ceil(subDialogues / subCount);
      for (let j = 0; j < subCount; j++) {
        const subDialogueIds = seg.dialogueIds.slice(j * perSub, (j + 1) * perSub);
        const subDialogueObjs = subDialogueIds.map(id => dialogues.find(d => d.id === id)).filter(Boolean);
        const subDuration = Math.round(subDialogueObjs.reduce((s, d) => s + (d.duration || 0), 0) * 10) / 10;
        const subActions = (seg.actions || []).slice(j, j + 1);
        result.push({
          id: `${scene.id}${String.fromCharCode(65 + result.length)}`,
          dialogueIds: subDialogueIds,
          actionIds: subActions.map(a => a.id),
          duration: subDuration,
          estimatedPlayableSeconds: Math.round((subDuration * 0.72 + estimateActionSecondsForActions(subActions)) * 10) / 10,
          title: seg.title,
          purpose: seg.purpose,
          reason: `导演意图感知：${segIntents[j].slice(0, 30)}…`,
          dialogues: subDialogueObjs.map(d => ({ id: d.id, speaker: d.speaker, state: d.state, text: d.text, duration: d.duration })),
          actions: subActions.map(a => ({ id: a.id, text: a.text })),
          directorIntent: segIntents[j],
          startState: seg.startState,
          trigger: segIntents[j].slice(0, 50),
          reaction: seg.reaction,
          endpoint: seg.endpoint
        });
      }
    }
  }
  // 重新编号
  return result.map((s, i) => ({ ...s, id: `${scene.id}${String.fromCharCode(65 + i)}` }));
}

module.exports = {
  planSceneSegments,
  planManifestSegments,
  segmentPlanToText,
  validateSegmentPlan,
  chooseAutoSegmentCount,
  estimatePlayableSeconds,
  estimateActionSeconds,
  DEFAULT_TARGET_SECONDS
};
