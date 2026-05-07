const PUNCT_RE = /[\s，。！？、；：：“”‘’"'「」『』（）()【】\[\]《》<>…\.\,\!\?\;\:\-—_·~]/g;
const MOTION_VERBS = [
  '挥刀','挥剑','抽刀','抽剑','拔刀','拔剑','举刀','劈砍','斩向','刺向','砍向',
  '出拳','踢飞','格挡','闪避','弹开','震飞','扼住','掐住','撞飞','砸向',
  '扑向','猛冲','暴起','突围','围攻','厮杀','追逐','逃窜',
  '利爪','精气','掀飞','抽干','炸开','跺脚','腾空','飞跃','武戏','武打','升格','五段式'
];

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t ]+$/gm, '')
    .trim();
}

function stripPunctuation(text) {
  return String(text || '').replace(PUNCT_RE, '');
}

function countTextChars(text) {
  return Array.from(stripPunctuation(text)).length;
}

function countMatches(text, words) {
  let total = 0;
  for (const w of words) {
    const re = new RegExp(escapeRegExp(w), 'g');
    total += (String(text || '').match(re) || []).length;
  }
  return total;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchSceneHeader(line) {
  const t = String(line || '').trim();
  if (!t) return null;
  let m = t.match(/^(?:场景\s*)?(\d+\s*[-－]\s*\d+)\s*(.*)$/);
  if (m) return { id: m[1].replace(/\s/g, '').replace('－', '-'), header: m[2].trim() };
  m = t.match(/^第\s*(\d+)\s*场\s*(.*)$/);
  if (m) return { id: String(m[1]), header: m[2].trim() };
  return null;
}

function splitTransitionTailText(text) {
  const s = String(text || '').trim();
  // Performance-layer timing: do not slow the whole conflict down.
  // If a long rebuttal ends with the transition tail “没关系，我还有别的电话。”,
  // split that tail into its own original dialogue unit so the segment planner can
  // cut before it and place it at the start of the next dialing segment.
  const m = s.match(/^(.*?这种电话也能打错[？?])(（略一犹豫）?没关系，我还有别的电话。?)$/);
  if (m) return [m[1].trim(), m[2].trim()].filter(Boolean);
  return [s];
}

function parseLine(raw, counters, currentSceneId) {
  const line = String(raw || '').trim();
  if (!line) return { type: 'blank', raw };
  if (/^人物[：:]/.test(line)) {
    return { type: 'cast', raw: line, castText: line.replace(/^人物[：:]/, '').trim() };
  }
  if (/^▲/.test(line)) {
    const id = `A${String(++counters.action).padStart(3, '0')}`;
    return { type: 'action', id, sceneId: currentSceneId, raw: line, text: line.replace(/^▲\s*/, '').trim() };
  }
  let m = line.match(/^（(VO|旁白|画外音)）[：:]\s*(.+)$/i);
  if (m) {
    const id = `D${String(++counters.dialogue).padStart(3, '0')}`;
    const text = m[2].trim();
    return makeDialogue({ id, sceneId: currentSceneId, raw: line, speaker: `（${m[1]}）`, state: '', text, channel: 'vo' });
  }
  m = line.match(/^(.{1,24}?OS)[：:]\s*(.+)$/i);
  if (m) {
    const id = `D${String(++counters.dialogue).padStart(3, '0')}`;
    const text = m[2].trim();
    return makeDialogue({ id, sceneId: currentSceneId, raw: line, speaker: m[1].trim(), state: '', text, channel: 'os' });
  }
  // Character dialogue. Avoid treating headings/notes as dialogue by excluding known prefixes.
  if (!/^(结构节点|情绪走向|观众带走|痛点类型|爽点方向|主打情绪|信任主线|马斯洛定位|剧魂一句话)/.test(line)) {
    m = line.match(/^([^：:（）()【】\[\]\s]{1,18})(?:[（(]([^）)]{1,30})[）)])?[：:]\s*(.+)$/);
    if (m && !['人物','时间','地点','场景'].includes(m[1])) {
      const speaker = m[1].trim();
      const state = (m[2] || '').trim();
      const parts = splitTransitionTailText(m[3].trim());
      if (parts.length > 1) {
        return {
          type: 'multi',
          raw: line,
          entries: parts.map(partText => {
            const id = `D${String(++counters.dialogue).padStart(3, '0')}`;
            return makeDialogue({
              id,
              sceneId: currentSceneId,
              raw: `${speaker}${state ? '（' + state + '）' : ''}：${partText}`,
              speaker,
              state,
              text: partText,
              channel: 'dialogue'
            });
          })
        };
      }
      const id = `D${String(++counters.dialogue).padStart(3, '0')}`;
      const text = parts[0];
      return makeDialogue({ id, sceneId: currentSceneId, raw: line, speaker, state, text, channel: 'dialogue' });
    }
  }
  return { type: 'info', raw: line };
}

function makeDialogue({ id, sceneId, raw, speaker, state, text, channel }) {
  const charCount = countTextChars(text);
  return {
    type: 'dialogue', id, sceneId, raw, speaker, state, text, channel,
    charCount,
    isShortShout: charCount <= 5,
    duration: estimateDialogueDuration({ text, state, channel, charCount })
  };
}

function estimateDialogueDuration({ text, state = '', channel = 'dialogue', charCount = countTextChars(text), forbidFast = false }) {
  const cue = `${state} ${text}`;
  // v3.1.3: 台词节奏优先。宁可多拆一个镜头，也不要让人物连珠炮念词。
  // 这里估的是“可表演时长”，不是最快语速。
  let cps = 3.6;
  if (channel === 'vo' || channel === 'os' || /旁白|画外音|独白/.test(cue)) cps = 2.5;
  else if (/悲痛|克制|低沉|压抑|颤音|恐惧后压低/.test(cue)) cps = 2.3;
  else if (/激动|爆发|愤怒|不耐烦|慌乱|大喜|恐慌|急促|吼|喊|咆哮/.test(cue)) cps = 4.8;
  const commaPause = (String(text).match(/[，、]/g) || []).length * 0.45;
  const sentencePause = (String(text).match(/[。！？!?]/g) || []).length * 0.75;
  const ellipsisPause = (String(text).match(/…|\.\.\./g) || []).length * 0.9;
  const parentheticalPause = (String(text).match(/[（(][^）)]{1,20}[）)]/g) || []).length * 0.6;
  // 给演员组织语言、对嘴和动作反应的最小呼吸，不让台词贴着数学最短时长跑。
  const performanceBreath = channel === 'dialogue' ? Math.min(0.85, Math.max(0.25, charCount * 0.025)) : 0.25;
  const extra = forbidFast ? 1 : 0;
  return Math.round((charCount / cps + commaPause + sentencePause + ellipsisPause + parentheticalPause + performanceBreath + extra) * 10) / 10;
}

function parseScript(text) {
  const normalized = normalizeText(text);
  const physicalLines = normalized ? normalized.split('\n') : [];
  const scenes = [];
  const counters = { dialogue: 0, action: 0, line: 0 };
  let current = null;

  function ensureScene(fallback = false) {
    if (!current) {
      current = { id: fallback ? '0-0' : '1-1', header: fallback ? '未识别场景' : '', cast: [], lines: [], rawHeader: '' };
      scenes.push(current);
    }
    return current;
  }

  for (const raw of physicalLines) {
    const line = String(raw || '').trim();
    const sceneHeader = matchSceneHeader(line);
    if (sceneHeader) {
      current = { id: sceneHeader.id, header: sceneHeader.header, cast: [], lines: [], rawHeader: line };
      scenes.push(current);
      continue;
    }
    if (!line) continue;
    const scene = ensureScene(true);
    const parsed = parseLine(line, counters, scene.id);
    if (parsed.type === 'multi') {
      for (const entry of parsed.entries || []) {
        entry.order = ++counters.line;
        scene.lines.push(entry);
      }
      continue;
    }
    parsed.order = ++counters.line;
    if (parsed.type === 'cast') {
      scene.cast = parsed.castText.split(/[、,，\s]+/).filter(Boolean);
    }
    if (parsed.type !== 'blank') scene.lines.push(parsed);
  }

  for (const scene of scenes) {
    scene.dialogues = scene.lines.filter(l => l.type === 'dialogue');
    scene.formalDialogues = scene.dialogues.filter(d => !d.isShortShout);
    scene.actions = scene.lines.filter(l => l.type === 'action');
    scene.motionVerbCount = countMatches(scene.lines.map(l => l.raw).join('\n'), MOTION_VERBS);
    scene.sceneType = detectSceneType(scene);
    scene.formalDialogueDuration = Math.round(scene.formalDialogues.reduce((s, d) => s + d.duration, 0) * 10) / 10;
    scene.dialogueDuration = Math.round(scene.dialogues.reduce((s, d) => s + d.duration, 0) * 10) / 10;
    scene.segmentMin = Math.max(1, Math.ceil(scene.dialogueDuration / 12));
  }

  const dialogues = scenes.flatMap(s => s.dialogues);
  const actions = scenes.flatMap(s => s.actions);
  return {
    sourceText: normalized,
    scenes,
    dialogues,
    actions,
    stats: {
      sceneCount: scenes.length,
      dialogueCount: dialogues.length,
      formalDialogueCount: dialogues.filter(d => !d.isShortShout).length,
      shortShoutCount: dialogues.filter(d => d.isShortShout).length,
      actionCount: actions.length,
      charCount: normalized.length
    }
  };
}

function detectSceneType(scene) {
  const formal = scene.formalDialogues.length;
  const motion = scene.motionVerbCount;
  if (formal >= 3) return 'wenxi';
  if (formal <= 2 && motion >= 3) return 'wuxi';
  if (formal <= 1 && motion >= 1) return 'wuxi';
  return 'wenxi';
}

function manifestToText(manifest, sceneFilterIds = null) {
  const sceneSet = sceneFilterIds ? new Set(sceneFilterIds) : null;
  const chunks = [];
  for (const scene of manifest.scenes) {
    if (sceneSet && !sceneSet.has(scene.id)) continue;
    chunks.push(`【SCENE ${scene.id}】${scene.header ? ' ' + scene.header : ''}`);
    if (scene.cast.length) chunks.push(`人物：${scene.cast.join(' ')}`);
    for (const line of scene.lines) {
      if (line.type === 'dialogue' || line.type === 'action') chunks.push(`[${line.id}] ${line.raw}`);
      else chunks.push(line.raw);
    }
  }
  return chunks.join('\n');
}

function dialogueTable(scene) {
  return scene.dialogues.map(d => {
    const type = d.isShortShout ? '短吼' : (d.channel === 'vo' || d.channel === 'os' ? 'VO/OS' : '正式台词');
    return `${d.id}\t${type}\t${d.speaker}${d.state ? '（' + d.state + '）' : ''}\t${d.text}\t去标点${d.charCount}字\t最短${d.duration}s`;
  }).join('\n');
}

function allocateSegments(scene) {
  const minSegments = scene.segmentMin || 1;
  const segments = [];
  let current = { id: `${scene.id}${String.fromCharCode(65)}`, dialogueIds: [], duration: 0 };
  let segIndex = 0;
  const allocatedDialogues = scene.dialogues;
  if (!allocatedDialogues.length) return [current];
  for (const d of allocatedDialogues) {
    if (current.dialogueIds.length && current.duration + d.duration > 12 && segments.length + 1 < Math.max(minSegments, 99)) {
      segments.push(current);
      segIndex += 1;
      current = { id: `${scene.id}${String.fromCharCode(65 + segIndex)}`, dialogueIds: [], duration: 0 };
    }
    current.dialogueIds.push(d.id);
    current.duration = Math.round((current.duration + d.duration) * 10) / 10;
  }
  segments.push(current);
  while (segments.length < minSegments) {
    segIndex += 1;
    segments.push({ id: `${scene.id}${String.fromCharCode(65 + segIndex)}`, dialogueIds: [], duration: 0 });
  }
  return segments;
}

module.exports = {
  MOTION_VERBS,
  normalizeText,
  stripPunctuation,
  countTextChars,
  estimateDialogueDuration,
  parseScript,
  manifestToText,
  dialogueTable,
  allocateSegments,
  escapeRegExp
};
