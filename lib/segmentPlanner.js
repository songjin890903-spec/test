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
  // Performance-layer timing: if the emotional conflict line is followed by a transition tail
  // (“没关系，我还有别的电话。”), cut BEFORE the tail. Keep the core conflict in the current 15s
  // segment and move only the transition tail to the next dialing segment.
  if (/傻子|打错/.test(text) && /没关系|别的电话|另一个号码/.test(nextText)) out.push({ score: 96, reason: '第一次失败核心冲突落点，转场尾句前移到下一通电话', endpoint: '赵一铭拒绝打错解释，火气停在“这种电话也能打错？”' });
  if (/别的电话|另一个号码|还有别的/.test(text) && !/无人接听|不太好使|另一个号码/.test(nextText)) out.push({ score: 95, reason: '第一次失败后进入下一通电话', endpoint: '赵一铭用“还有别的电话”把局面转入下一次拨号' });
  if (/一定能打通|私人电话|直通.*爹/.test(text)) out.push({ score: 95, reason: '最后底牌拨出，等待私人电话结果', endpoint: '赵一铭把希望压到父亲私人电话上' });
  if (/拍电影|开什么玩笑|荒唐/.test(text)) out.push({ score: 92, reason: '父亲变丧尸的消息完成冲击，进入否认落点', endpoint: '赵一铭用“荒唐/拍电影”抵抗刚听到的消息' });
  // recut: 世界乱套后的片段不能靠拉长VO凑15秒，应把后面的原台词“你们看，真的有丧尸！”顺序前移进来。
  // 因此不要在刘秘书警告后强切；真正切点放在刀哥把证据台词说完之后。
  if (/世界乱套|安全地方|躲起来/.test(text)) {
    if (/真的有丧尸/.test(nextText)) out.push({ score: 15, reason: '不在刘秘书警告后硬切，顺序前移刀哥原台词填满15秒', endpoint: '刘秘书警告后继续接刀哥证据台词' });
    else out.push({ score: 88, reason: '刘秘书生存警告结束，进入手机落地动作落点', endpoint: '世界乱套的信息落下，赵一铭的手机将脱手' });
  }
  if (/欢迎来到|新时代/.test(text)) out.push({ score: 99, reason: '压轴宣告完成，本场落点', endpoint: '张玄说出新时代，场景完成' });
  if (/真的有丧尸/.test(text) && /怎么会这样|丧尸末日|新时代/.test(nextText)) out.push({ score: 93, reason: '刘秘书警告压垮赵一铭，手机落地，刀哥用短视频把电话内容接成可见证据', endpoint: '刀哥把证据举到众人面前，短视频画面进入下一段' });
  // Avoid cutting after an open question when the next line is the direct answer.
  if (/怎么了|吗|？|\?/.test(text) && nextDialogue && !/别的电话|一定能打通|拍电影|世界乱套|新时代/.test(text)) {
    out.push({ score: -40, reason: '问题后面还有直接回答，不应切开', endpoint: '' });
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
  if (!dialogues.length) return 1;
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
  // If a very short sample only has one meaningful recut boundary, do not add extra
  // time-bucket cuts that isolate system VO or transition tails into their own 15s segments.
  if (dialogues.length <= 5 && strongBoundaryCount >= 1) count = strongBoundaryCount + 1;
  if (dialogues.length <= 4 && strongBoundaryCount === 0) count = 1;
  if (dialogues.length > 4) count = Math.max(2, count);
  count = Math.min(dialogues.length, Math.max(1, count));
  const manualCap = Number(opts.manualMaxSegments || 0);
  if (manualCap > 0) count = Math.min(count, manualCap);
  return count;
}

function chooseEventBoundaries(scene, targetCount, targetSeconds) {
  const dialogues = scene.dialogues || [];
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

  // If script has too few strong beats, fill by time rhythm but avoid obvious question/answer splits.
  const n = dialogues.length;
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
  if (/不太好使|一定能打通|私人电话/.test(text)) return '第二次失败后，张玄点破身份失效，赵一铭抓住父亲私人电话这张底牌';
  if (/无人接听/.test(text) && /打错|别的电话|怎么可能/.test(text)) return /别的电话/.test(text) ? '第一次失败尾句进入下一通电话' : '第一次专线失败，赵一铭用身份解释异常，范思瑶试探，冲突落在赵一铭拒绝打错';
  if (/世界乱套|躲起来|掉在地上|挂断/.test(text)) return /真的有丧尸/.test(text) ? '刘秘书给出生存警告，赵一铭手机落地，刀哥用原剧本台词把短视频证据接进来' : '刘秘书给出生存警告，赵一铭的权力工具以手机落地作为动作落点';
  if (/大少爷|董事长|成丧尸|拍电影|荒唐/.test(text)) return '私人电话接通，父亲变丧尸的消息击穿赵一铭的最后后台';
  if (/真的有丧尸|大街|商场|马路|丧尸末日|新时代/.test(text)) return '短视频把电话里的荒诞变成可见证据，张玄用最后一句接管解释权';
  return '以一个可拍小事件推动人物关系和情绪变化';
}

function inferTitle(group, actions = []) {
  const text = group.map(d => d.text).join(' ') + ' ' + actions.map(a => a.text).join(' ');
  if (/不太好使|一定能打通|私人电话/.test(text)) return '第二次失败与最后底牌';
  if (/无人接听/.test(text) && /打错|别的电话|怎么可能/.test(text)) return '第一次专线无人接听';
  if (/世界乱套|躲起来|掉在地上|挂断/.test(text)) return '世界乱套与手机落地';
  if (/大少爷|董事长|成丧尸|拍电影|荒唐/.test(text)) return '父亲成丧尸的消息';
  if (/真的有丧尸|大街|商场|马路|丧尸末日|新时代/.test(text)) return '短视频验证与新时代';
  return '台词推进段';
}
function inferEventArc(group, actions = [], index = 0) {
  const text = group.map(d => `${d.speaker || ''} ${d.text || ''}`).join(' ') + ' ' + actions.map(a => a.text).join(' ');
  if (/无人接听/.test(text) && /打错|别的电话|怎么可能/.test(text)) {
    return {
      startState: '赵一铭相信赵氏专线一定能接通，众人仍默认他的身份有效',
      trigger: '系统女声提示无人接听，旧秩序第一次失灵',
      reaction: '赵一铭用“赵氏财团”和“24小时待机”解释异常，范思瑶试探，赵一铭反压',
      endpoint: /别的电话/.test(text) ? '赵一铭不承认失败，转去拨另一个号码' : '赵一铭不承认打错，转场尾句留到下一片段开头'
    };
  }
  if (/不太好使|一定能打通|私人电话/.test(text)) {
    return {
      startState: '赵一铭换第二个号码，试图证明第一次只是意外',
      trigger: '第二次无人接听让身份失效变成重复事实',
      reaction: '赵一铭出汗强撑，张玄冷笑点破，旁人开始动摇',
      endpoint: '赵一铭拿出父亲私人电话作为最后底牌'
    };
  }
  if (/世界乱套|躲起来|掉在地上|挂断/.test(text)) {
    return {
      startState: '赵一铭还在否认父亲变丧尸的事实',
      trigger: '刘秘书给出生存警告并挂断电话',
      reaction: '赵一铭没有继续反驳，手里的手机从权力工具变成噩耗来源',
      endpoint: /真的有丧尸/.test(text) ? '手机落地后，刀哥举起手机说出原剧本证据台词' : '手机啪地掉在地上，形成动作落点'
    };
  }
  if (/大少爷|董事长|成丧尸|拍电影|荒唐/.test(text)) {
    return {
      startState: '私人电话接通，赵一铭短暂以为后台恢复',
      trigger: '刘秘书恐慌说出董事长成丧尸',
      reaction: '赵一铭从命令转为不安，再用“荒唐/拍电影”否认现实',
      endpoint: '父亲这张最后后台被击穿'
    };
  }
  if (/真的有丧尸|大街|商场|马路|丧尸末日|新时代/.test(text)) {
    return {
      startState: '刀哥已经把手机举向众人，电话信息即将被短视频证据坐实',
      trigger: '刀哥手机里的三组丧尸画面出现',
      reaction: '赵一铭和范思瑶的认知被视频击穿，旁人注意力从赵一铭转向张玄',
      endpoint: '张玄说“欢迎来到新时代”，完成本场落点'
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
  const cuts = chooseEventBoundaries(scene, targetCount, targetSeconds);
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
      ...arc
    });
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

module.exports = {
  planSceneSegments,
  planManifestSegments,
  segmentPlanToText,
  validateSegmentPlan,
  chooseAutoSegmentCount,
  estimatePlayableSeconds,
  DEFAULT_TARGET_SECONDS
};
