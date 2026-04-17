// ============================================================
// Agent A v7 · JSON 批注引擎
// ----------------------------------------------------------------
// 核心思路：LLM 只产 JSON 批注，代码按原文拼装最终批注版剧本。
// 台词由代码写入，不由 LLM 写入 → 遗漏率数学上归零。
//
// 对外导出：
//   parseSceneItemsV7(sceneContent)      → items[]
//   buildAnnotationPromptV7(...)         → string
//   parseAnnotationJSON(text)            → annotationData | null
//   validateAnnotationV7(...)            → errors[]
//   assembleAnnotationV7(...)            → 批注版剧本（v6 字节级格式）
//   generateSummaryV7(...)               → 批注摘要（代码生成）
//   getAnnotationStatsV7(...)            → 统计数据
// ============================================================

'use strict';

// ─── 常量 ───────────────────────────────────────────────────
const DIVIDER = '═══════════════════════════════════';
const QUOTE_STRIP_RE = /[""「」『』"']/g;

// 识别"原文里已经存在的（导演讲戏：）块"——要先剥干净
const DN_MARKER = '（导演讲戏：';

// 场景标题的多种候选格式（和 server.js 里的 parseRawScript 保持一致）
const SCENE_HEADER_RE_LIST = [
  /^场景(\S+)\s+(.+)/m,
  /^(\d+[-–]\d+[A-Za-z]?)\s+((?:日|夜|晨|黄昏|傍晚|清晨)\s+(?:内|外|内外)\s+.+)/m,
  /^第(\S+)[场幕]\s*(.*)/m,
];

// ─── 剥离已有导演讲戏块（同 server.js 的 processDirectorNotes·简化版）──
function stripExistingDN(text) {
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(DN_MARKER, cursor);
    if (start === -1) { result += text.substring(cursor); break; }
    result += text.substring(cursor, start);
    let depth = 1;
    let pos = start + 1;
    while (pos < text.length && depth > 0) {
      if (text[pos] === '（') depth++;
      else if (text[pos] === '）') depth--;
      pos++;
    }
    if (depth === 0) {
      // 跳过整块
    } else {
      result += text.substring(start, pos);
    }
    cursor = pos;
  }
  return result;
}

// ============================================================
// 1. parseSceneItemsV7：把场景内容拆成有序 items
// ============================================================
// 每个 item：{ id, type, text, original }
//   id:     "A1","A2","D1","D2"（唯一稳定标识·LLM 按此挂批注）
//   type:   "action" | "dialogue" | "raw"（raw = 既非▲也非台词的原文行·如场景标题/人物行）
//   text:   用于 LLM 识别的截断文本（前 40 字）
//   original: 完整原文，用于最终拼装
// ============================================================
function parseSceneItemsV7(sceneContent) {
  // 先剥离任何已有的（导演讲戏：）块，得到纯净原文
  const clean = stripExistingDN(sceneContent);
  const lines = clean.split('\n').map(l => l.rstrip ? l.rstrip() : l.replace(/\s+$/, ''));

  const items = [];
  let actionIdx = 0;
  let dialogueIdx = 0;

  // 跳过裸露的批注标记行（【无特殊批注】【待补充】——这些是 v6 输出标记·不是剧本原文）
  const STANDALONE_TAGS = /^【(?:无特殊批注|待补充|场景感受|动作线设计|人物内心|镜头意图|禁止)】/;

  // 识别场景标题的相关行（标题行、人物行、分隔线——这些不生成批注）
  const isHeaderLine = (line) => {
    const t = line.trim();
    if (!t) return true;
    if (/^[─━═\-—*]{3,}$/.test(t)) return true;               // 分隔线
    if (/^场景\S/.test(t)) return true;                        // 场景标题
    if (/^第\S+[场幕]/.test(t)) return true;                   // 第X场
    if (/^\d+[-–]\d+[A-Za-z]?\s/.test(t)) return true;         // 1-1 标题
    if (/^(?:时间|地点|人物)[：:]/.test(t)) return true;        // 时间/地点/人物
    if (/^[（(]/.test(t) && /[）)]$/.test(t)) return true;     // 纯括号行（旁白提示等）
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // 空行或旧批注标记行——跳过不生成 item
    if (!trimmed) continue;
    if (STANDALONE_TAGS.test(trimmed)) continue;

    // 表头行——保留为 raw item（拼装时原样输出·但不挂批注）
    if (isHeaderLine(rawLine)) {
      items.push({
        id: `H${items.filter(x => x.type === 'raw').length + 1}`,
        type: 'raw',
        text: trimmed.slice(0, 40),
        original: rawLine,
      });
      continue;
    }

    // ▲ 动作行
    if (trimmed.startsWith('▲')) {
      actionIdx++;
      items.push({
        id: `A${actionIdx}`,
        type: 'action',
        text: trimmed.slice(1, 41).trim(), // 去掉▲标记取前40字
        original: rawLine,
      });
      continue;
    }

    // 台词行：XXX：xxx 格式（冒号前≤15字作为角色名）
    // 豁免（旁白）（画外音）（VO）前缀
    const colonIdx = trimmed.indexOf('：');
    if (colonIdx > 0 && colonIdx <= 15) {
      const charPart = trimmed.substring(0, colonIdx).trim();
      const contentPart = trimmed.substring(colonIdx + 1).trim();
      if (contentPart.length >= 2 && !charPart.startsWith('【') && !charPart.startsWith('（')) {
        // 过滤批注内的关键词当角色名的误判
        const isAnnotationKeyword = /必须捕捉|稳帧点|镜头意图|人物内心|场景感受|禁止|节点缺口|补充方案|身体反应|心理状态|情绪走向|观众带走|结构节点|优先级|作用|补充|内容|方法论|导演/.test(charPart);
        if (!isAnnotationKeyword) {
          dialogueIdx++;
          items.push({
            id: `D${dialogueIdx}`,
            type: 'dialogue',
            character: charPart.replace(/[（(][^）)]*[）)]/, '').trim(),
            text: trimmed.slice(0, 40),
            original: rawLine,
          });
          continue;
        }
      }
    }

    // 其他行——当作 raw 原文（保留·不挂批注）
    items.push({
      id: `R${items.filter(x => x.type === 'raw').length + 1}`,
      type: 'raw',
      text: trimmed.slice(0, 40),
      original: rawLine,
    });
  }

  return items;
}

// ============================================================
// 2. buildAnnotationPromptV7：构建 JSON 批注 prompt
// ============================================================
// mode = 'ai' | 'director'
// options.soulCard      — AI 模式必填
// options.prevFeel      — 上一场情绪落点（衔接参考，可空）
// options.sceneSegments — director 模式的本场讲戏段落
// options.globalSegments — director 模式的全局讲戏段落
// options.expectedShots — 从讲戏里推断的镜头数（用于 intent_capture 校验）
// ============================================================
function buildAnnotationPromptV7(scene, items, mode, options = {}) {
  const {
    soulCard = '', prevFeel = null,
    sceneSegments = [], globalSegments = [],
  } = options;

  // 过滤出需要批注的 items（raw 不需要批注）
  const annotatableItems = items.filter(it => it.type !== 'raw');

  // 角色列表
  const chars = (scene.characters && scene.characters.length)
    ? scene.characters.join('、')
    : '见剧本';

  let p = '';

  p += `你是剧本批注 JSON 引擎。你不复制剧本原文，不复制讲戏文本，只产出 JSON 批注数据。\n\n`;
  p += `场景信息：\n`;
  p += `· 场景编号：${scene.id}\n`;
  p += `· 场景标题：${scene.header || ''}\n`;
  p += `· 人物列表（剧本写法·角色名以此为准）：${chars}\n\n`;

  // ─── 条目清单（LLM 按此 ID 挂批注）───
  p += `═══ 本场条目清单（共 ${annotatableItems.length} 条，需逐条给出批注或状态）═══\n`;
  for (const it of annotatableItems) {
    const label = it.type === 'action' ? '▲动作' : `台词·${it.character || ''}`;
    p += `[${it.id}] ${label}：${it.text}\n`;
  }
  p += `\n`;

  // ─── 衔接参考 ───
  if (prevFeel) {
    p += `上一场情绪落点（衔接参考，勿写入当前场的情绪曲线）：${prevFeel}\n\n`;
  }

  // ─── 模式分支 ───
  if (mode === 'director') {
    p += `═══ 工作模式：导演讲戏 ═══\n`;
    if (sceneSegments.length > 0) {
      p += `本场对应导演讲戏（${sceneSegments.length} 条，已由用户确认映射）：\n`;
      for (const seg of sceneSegments) {
        const typeLabel = { feel: '场景感受', intent: '镜头意图', inner: '人物内心', forbid: '禁止项', global: '全局' }[seg.type] || seg.type;
        p += `· [${typeLabel}] ${seg.text}\n`;
      }
      p += `\n`;
    } else {
      p += `本场无对应导演讲戏。所有条目的 status 标为 "pending"（除非是纯信息交代，可标 "no_annotation"）。\n\n`;
    }
    if (globalSegments && globalSegments.length > 0) {
      p += `全局讲戏指令（适用所有场景）：\n`;
      for (const seg of globalSegments) {
        p += `· ${seg.text}\n`;
      }
      p += `\n`;
    }
    p += `讲戏处理规则：\n`;
    p += `1. 去口水：删"嗯/啊/就是说/然后呢/那个/对吧"等填充词，保全部视觉和表演指令。\n`;
    p += `2. 不压缩：导演讲了 N 个镜头就给 N 条 intent_capture，不合并。\n`;
    p += `3. 多方案：导演说"或者"→ 用 camera_options 字段给 方案A / 方案B。\n`;
    p += `4. 强调标记：导演说"一定要/必须/重音"→ 在对应字段前缀 ⚠️必须。\n`;
    p += `5. 分配铁律：一段讲戏可能跨多个条目 ID。按画面主体拆开分别挂到对应 ID·不要全堆在第一个 ID。\n`;
    p += `6. 角色名修正：导演录音里的同音字口误（如"苏青寒"），一律改回剧本里的写法（"苏清寒"）。\n`;
    p += `7. 场景感受即使导演没明说也要从讲戏内容归纳一句。\n`;
    p += `\n`;
  } else {
    p += `═══ 工作模式：AI 剧作分析 ═══\n`;
    if (soulCard) {
      p += `剧魂定位卡（必须遵循）：\n${soulCard}\n\n`;
    }
    p += `分析规则：\n`;
    p += `1. 所有批注来源于剧作方法论 + 剧本原文推理，不编造剧本未发生的情节。\n`;
    p += `2. 每条【人物内心】必须同时给心理状态（mental）和身体反应（body）两层·只有心理没有身体的批注无效。\n`;
    p += `3. 重要情绪节点必须标稳帧点（stable_frame）。\n`;
    p += `4. 开场如果缺少"暖"的建立·或世界观未交代·用 cold_open 字段标出。\n`;
    p += `\n`;
  }

  // ─── JSON 输出契约 ───
  p += `═══ 严格 JSON 输出契约 ═══\n`;
  p += `1. 从 { 开始·到 } 结束。不要任何代码块标记（不写 \`\`\`json）。不要任何解释文字。\n`;
  p += `2. annotatable items 全集 = 上方条目清单。你必须为 **每一个 ID** 都在 annotations 里给出条目·一个都不能少。\n`;
  p += `3. annotations[ID] 的"状态"三选一：\n`;
  p += `   · { "status": "annotated", "intent_capture": [...], "inner": {...}, ... } — 该条有批注\n`;
  p += `   · { "status": "no_annotation" } — 纯信息交代，不需要批注\n`;
  p += `   · { "status": "pending" } — ${mode === 'director' ? '导演讲戏未覆盖' : '暂无特别批注'}\n`;
  p += `4. 顶层字段必填（即使导演没明说也要归纳）：\n`;
  p += `   · scene_feel: 一句话整体情绪任务\n`;
  p += `   · emotion_flow: { "start": "...", "trigger": "...", "end": "..." } — 三节点必须是不同的情绪描述·不能是同一情绪的三个近义词\n`;
  p += `   · audience_takeaway: 观众带走的情绪/问题\n`;
  p += `   · structure_node: 结构节点类型\n`;
  p += `   · action_thread: 数组·每个有名字的角色一条·字段 {character, task, source}·source 三选一："剧本原文" / "上下文推断" / "无"·无道具任务时 task 写"无道具任务·依赖第二层情绪驱动肢体"\n`;
  p += `   · action_thread_turning_point: 一句话·指向某条 ID·说明情绪拐点处谁的动作线怎么变\n`;
  p += `5. 可选字段：forbidden_global（全场禁止项数组）·cold_open（开场铺垫需求对象，可空）\n`;
  p += `6. annotations[ID] 当 status="annotated" 时的可选字段：\n`;
  p += `   · intent_capture: 数组·每条是"具体可拍的画面"（不是情绪词）\n`;
  p += `   · stable_frame: 字符串·"哪一帧·停多久·为什么"\n`;
  p += `   · intent_gap: { "gap": "...", "plan": "...", "priority": "必须补" | "建议补" }\n`;
  p += `   · camera_options: [ { "label": "方案A", "detail": "..." }, ... ]\n`;
  p += `   · inner: { "mental": "...", "body": ["...", "..."] }  — body 必须是可拍的具体身体动作·不是形容词\n`;
  p += `   · forbid: { "what": "...", "why": "..." }\n`;
  p += `   · must_flag: true/false — 导演标注了⚠️必须/一定要时为 true\n`;
  p += `\n`;

  // ─── Schema 示例 ───
  p += `═══ 标准输出示例（完全按此结构输出）═══\n`;
  p += `{\n`;
  p += `  "scene_feel": "旧敌重逢·张玄确认身份后的冷处理",\n`;
  p += `  "emotion_flow": { "start": "平静·不自觉", "trigger": "听到'祸害你妹妹'", "end": "杀意·但压住不发" },\n`;
  p += `  "audience_takeaway": "张玄会杀·但他选择慢慢杀",\n`;
  p += `  "structure_node": "压力铺垫·第一层",\n`;
  p += `  "action_thread": [\n`;
  p += `    { "character": "张玄", "task": "检查自己的手指", "source": "剧本原文" },\n`;
  p += `    { "character": "王龙", "task": "无道具任务·依赖第二层情绪驱动肢体", "source": "无" }\n`;
  p += `  ],\n`;
  p += `  "action_thread_turning_point": "D2 王龙喊出祸害你妹妹·张玄检查手指的动作骤停·头抬起来",\n`;
  p += `  "forbidden_global": ["张玄不要愤怒·要冷静的杀意"],\n`;
  p += `  "cold_open": null,\n`;
  p += `  "annotations": {\n`;
  p += `    "A1": { "status": "annotated", "intent_capture": ["大特写锁定张玄右手·指节翻转时的细节"], "inner": { "mental": "不屑·自我确认", "body": ["低头看自己的手·翻来覆去地看", "眼神完全不在王龙身上"] } },\n`;
  p += `    "D1": { "status": "no_annotation" },\n`;
  p += `    "D2": { "status": "annotated", "must_flag": true, "inner": { "mental": "纯动物性生理恐惧", "body": ["喉管被掐·声音发不全", "嘴张着像鱼"] }, "forbid": { "what": "戏剧化的认出旧敌表演", "why": "王龙是原始求生·不是戏剧识别" } }\n`;
  p += `  }\n`;
  p += `}\n\n`;

  p += `⚠️ 输出 JSON 前·在脑中核对：上方条目清单有 ${annotatableItems.length} 个 ID·annotations 对象必须包含这 ${annotatableItems.length} 个 key·一个都不能漏。\n`;
  p += `⚠️ emotion_flow 的 start / trigger / end 必须是三个真正不同的情绪描述·如果你写的三句话前四字相似度高于 70%·视为无效批注。\n`;
  p += `\n请直接输出 JSON：`;

  return p;
}

// ============================================================
// 3. parseAnnotationJSON：三层兜底 JSON 解析
// ============================================================
function parseAnnotationJSON(text) {
  if (!text || typeof text !== 'string') return null;

  // 第一层：直接 JSON.parse
  try {
    return JSON.parse(text);
  } catch {}

  // 第二层：截取第一个 { 到最后一个 }
  let clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  clean = clean.substring(start, end + 1);
  try {
    return JSON.parse(clean);
  } catch {}

  // 第三层：修复常见错误（去掉尾随逗号）
  try {
    const fixed = clean
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/([{,]\s*)(['"])?([a-zA-Z_][a-zA-Z0-9_]*)\2(\s*:)/g, '$1"$3"$4');
    return JSON.parse(fixed);
  } catch {}

  return null;
}

// ============================================================
// 4. validateAnnotationV7：全量校验
// ============================================================
// 返回 errors[]·空数组表示通过
// ============================================================
function validateAnnotationV7(data, items, sceneSegments = []) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['JSON 解析失败或不是对象'];

  // ─── 顶层字段 ───
  if (!data.scene_feel || typeof data.scene_feel !== 'string' || data.scene_feel.trim().length < 3) {
    errors.push('scene_feel 缺失或过短');
  }

  // emotion_flow 三节点检查
  const ef = data.emotion_flow;
  if (!ef || typeof ef !== 'object') {
    errors.push('emotion_flow 缺失或结构错误');
  } else {
    const { start, trigger, end } = ef;
    if (!start || !trigger || !end) {
      errors.push('emotion_flow 三节点（start/trigger/end）不全');
    } else if (typeof start !== 'string' || typeof trigger !== 'string' || typeof end !== 'string') {
      errors.push('emotion_flow 三节点必须是字符串');
    } else {
      // 同质化检查
      const sim = (a, b) => {
        const sa = a.trim().slice(0, 4);
        const sb = b.trim().slice(0, 4);
        if (!sa || !sb) return 0;
        let n = 0;
        for (const ch of sa) if (sb.includes(ch)) n++;
        return n / Math.max(sa.length, 1);
      };
      if (sim(start, trigger) >= 0.7 || sim(trigger, end) >= 0.7 || sim(start, end) >= 0.7) {
        errors.push('emotion_flow 三节点过于相似（前 4 字相似度 ≥70%）·不是真正的情绪弧线');
      }
    }
  }

  if (!data.action_thread || !Array.isArray(data.action_thread) || data.action_thread.length === 0) {
    errors.push('action_thread 缺失或为空数组');
  } else {
    for (const at of data.action_thread) {
      if (!at || typeof at !== 'object') {
        errors.push('action_thread 内含非对象元素');
        break;
      }
      if (!at.character || !at.task) {
        errors.push('action_thread 元素缺少 character 或 task 字段');
        break;
      }
      if (!at.source) {
        errors.push('action_thread 元素缺少 source 字段（应为"剧本原文"/"上下文推断"/"无"之一）');
        break;
      }
    }
  }

  // ─── annotations 覆盖完整性 ───
  const annotatableIds = items.filter(it => it.type !== 'raw').map(it => it.id);
  const annos = data.annotations || {};
  if (typeof annos !== 'object') {
    errors.push('annotations 必须是对象');
  } else {
    const missingIds = annotatableIds.filter(id => !(id in annos));
    if (missingIds.length > 0) {
      errors.push(`annotations 缺少 ${missingIds.length} 个条目 ID：${missingIds.slice(0, 5).join(',')}${missingIds.length > 5 ? '...' : ''}`);
    }

    // 每个 annotation 的 status 校验
    for (const id of annotatableIds) {
      const a = annos[id];
      if (!a) continue; // 上面已经报了缺失
      if (typeof a !== 'object') {
        errors.push(`annotations.${id} 不是对象`);
        continue;
      }
      const status = a.status;
      if (!['annotated', 'no_annotation', 'pending'].includes(status)) {
        errors.push(`annotations.${id} 的 status 必须是 annotated/no_annotation/pending 之一`);
        continue;
      }
      // annotated 状态下至少要有一个批注字段
      if (status === 'annotated') {
        const hasAny = a.intent_capture || a.stable_frame || a.intent_gap || a.camera_options || a.inner || a.forbid;
        if (!hasAny) {
          errors.push(`annotations.${id} status=annotated 但所有批注字段都空`);
        }
        // inner 字段结构校验
        if (a.inner && typeof a.inner === 'object' && a.inner !== null) {
          if (!a.inner.mental && !a.inner.body) {
            errors.push(`annotations.${id}.inner 既无 mental 也无 body`);
          }
        }
      }
    }
  }

  // ─── intent_capture "不压缩"校验（仅 director 模式·从讲戏文本推断期望镜头数）───
  if (sceneSegments && sceneSegments.length > 0) {
    // 扫讲戏里表示"多镜头"的信号
    const intentTexts = sceneSegments.filter(s => s.type === 'intent').map(s => s.text || '').join(' ');
    // 数第几/先/再/然后/接着/最后 的出现次数（大致等于镜头数）
    const sequenceSignals = intentTexts.match(/先|再|然后|接着|最后|紧接着|下一个|第[一二三四五六七八九十1-9]个?|一连串|连续/g) || [];
    const bulletMarkers = intentTexts.match(/^\s*[\d一二三四五六七八九]\s*[、.）)]/gm) || [];
    const hintedShotCount = Math.max(sequenceSignals.length, bulletMarkers.length);

    if (hintedShotCount >= 3) {
      // 累加所有 annotations 里的 intent_capture 条目数
      let totalIntentCount = 0;
      for (const id of annotatableIds) {
        const a = annos[id];
        if (a?.intent_capture && Array.isArray(a.intent_capture)) {
          totalIntentCount += a.intent_capture.length;
        }
      }
      if (totalIntentCount < Math.ceil(hintedShotCount * 0.6)) {
        errors.push(`intent_capture 可能被压缩：讲戏暗示约 ${hintedShotCount} 个镜头·当前只给了 ${totalIntentCount} 条批注`);
      }
    }
  }

  return errors;
}

// ============================================================
// 5. assembleAnnotationV7：按 v6 字节级格式拼装批注版剧本
// ============================================================
// 输入：scene, items, data（验证过的 JSON）
// 输出：批注版剧本字符串（和 v6 完全同格式·Agent B/C 零感知）
// ============================================================
function assembleAnnotationV7(scene, items, data) {
  const out = [];

  // ─── 场景标题块 ───
  out.push(DIVIDER);
  out.push(`场景${scene.id}  ${scene.header || ''}`.trim());
  if (scene.characters && scene.characters.length) {
    out.push(`人物：${scene.characters.join('、')}`);
  }
  out.push(DIVIDER);

  // ─── 场景级（导演讲戏：）块 ───
  out.push('（导演讲戏：');
  out.push(`【场景感受】${ensureString(data.scene_feel)}`);
  if (data.structure_node) out.push(`结构节点：${ensureString(data.structure_node)}`);
  const ef = data.emotion_flow;
  if (ef && ef.start && ef.trigger && ef.end) {
    out.push(`情绪走向：${ef.start} → ${ef.trigger} → ${ef.end}`);
  }
  if (data.audience_takeaway) out.push(`观众带走：${ensureString(data.audience_takeaway)}`);
  out.push('【动作线设计】');
  for (const at of (data.action_thread || [])) {
    const charName = at.character || '?';
    const task = at.task || '?';
    out.push(`${charName}：${task}`);
  }
  if (data.action_thread_turning_point) {
    out.push(`情绪拐点处的动作线变化：${ensureString(data.action_thread_turning_point)}`);
  }
  out.push('）');
  out.push('');

  // ─── Cold Open（如有）───
  if (data.cold_open && typeof data.cold_open === 'object' && (data.cold_open.content || data.cold_open.desc)) {
    out.push('（导演讲戏：');
    out.push(`【镜头意图·节点缺口】开场缺少"暖"的建立或世界观交代`);
    out.push(`导演补充方案：Cold Open（必须补）·${ensureString(data.cold_open.content || data.cold_open.desc)}`);
    out.push('优先级：必须补');
    out.push('）');
    out.push('');
  }

  // ─── 全局禁止项（如有）───
  if (Array.isArray(data.forbidden_global) && data.forbidden_global.length > 0) {
    out.push('（导演讲戏：');
    for (const f of data.forbidden_global) {
      out.push(`【禁止】${ensureString(f)}`);
    }
    out.push('）');
    out.push('');
  }

  // ─── 逐 item 拼装 ───
  const annos = data.annotations || {};
  for (const it of items) {
    if (it.type === 'raw') {
      // 场景标题、人物行等——已经在上面输出过·跳过同内容重复
      // 但对于非标题的 raw（如"（画外音）xxx"这种），保留
      if (!isSceneHeaderText(it.original, scene)) {
        out.push(it.original);
      }
      continue;
    }

    // action 或 dialogue——先输出原文
    out.push(it.original);

    const a = annos[it.id];
    if (!a || a.status === 'pending') {
      out.push('【待补充】');
      continue;
    }
    if (a.status === 'no_annotation') {
      out.push('【无特殊批注】');
      continue;
    }

    // status === 'annotated'：输出（导演讲戏：...）块
    const block = assembleAnnotationBlock(a);
    if (!block) {
      // 没有任何可输出的批注字段——降级为【无特殊批注】
      out.push('【无特殊批注】');
    } else {
      out.push(...block);
    }
  }

  return out.join('\n');
}

// 拼装单条 annotation 的（导演讲戏：...）块
function assembleAnnotationBlock(a) {
  const lines = [];
  const mustPrefix = a.must_flag ? '⚠️必须·' : '';

  // intent_capture
  if (Array.isArray(a.intent_capture) && a.intent_capture.length > 0) {
    const joined = a.intent_capture.map(ensureString).filter(Boolean).join('·');
    if (joined) lines.push(`【镜头意图】必须捕捉：${mustPrefix}${joined}`);
  } else if (typeof a.intent_capture === 'string' && a.intent_capture.trim()) {
    lines.push(`【镜头意图】必须捕捉：${mustPrefix}${a.intent_capture.trim()}`);
  }

  // stable_frame
  if (a.stable_frame && ensureString(a.stable_frame)) {
    lines.push(`【镜头意图】稳帧点：${ensureString(a.stable_frame)}`);
  }

  // intent_gap
  if (a.intent_gap && typeof a.intent_gap === 'object') {
    const gap = ensureString(a.intent_gap.gap);
    const plan = ensureString(a.intent_gap.plan);
    const prio = a.intent_gap.priority || '建议补';
    if (gap) lines.push(`【镜头意图·节点缺口】${gap}`);
    if (plan) lines.push(`导演补充方案：${plan}（${prio}）`);
    if (gap || plan) lines.push(`优先级：${prio}`);
  }

  // camera_options
  if (Array.isArray(a.camera_options) && a.camera_options.length > 0) {
    for (const opt of a.camera_options) {
      if (!opt) continue;
      const label = opt.label || '方案';
      const detail = ensureString(opt.detail);
      if (detail) lines.push(`【镜头意图·${label}】${detail}`);
    }
  }

  // inner
  if (a.inner && typeof a.inner === 'object') {
    const mental = ensureString(a.inner.mental);
    let body = a.inner.body;
    if (Array.isArray(body)) {
      body = body.map(ensureString).filter(Boolean).join('·');
    } else {
      body = ensureString(body);
    }
    if (mental && body) {
      lines.push(`【人物内心】${mental} → ${body}`);
    } else if (mental) {
      lines.push(`【人物内心】${mental}`);
    } else if (body) {
      lines.push(`【人物内心】${body}`);
    }
  }

  // forbid
  if (a.forbid && typeof a.forbid === 'object') {
    const what = ensureString(a.forbid.what);
    const why = ensureString(a.forbid.why);
    if (what && why) {
      lines.push(`【禁止】${what}——${why}`);
    } else if (what) {
      lines.push(`【禁止】${what}`);
    }
  }

  if (lines.length === 0) return null;
  return ['（导演讲戏：', ...lines, '）'];
}

// ─── 辅助：强制转字符串（LLM 偶尔把字符串字段写成数组或对象）───
function ensureString(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(ensureString).filter(Boolean).join('·');
  if (typeof v === 'object') {
    // 尝试取 text/detail/content 字段
    return ensureString(v.text || v.detail || v.content || v.value || '');
  }
  return String(v).trim();
}

// ─── 辅助：判断 raw 行是否是场景标题（避免重复输出）───
function isSceneHeaderText(line, scene) {
  const t = (line || '').trim();
  if (!t) return false;
  if (/^[═─━]{3,}$/.test(t)) return true;
  if (scene.id && t.includes(scene.id)) return true;
  if (scene.header && t.includes(scene.header)) return true;
  if (/^人物[：:]/.test(t)) return true;
  return false;
}

// ============================================================
// 6. generateSummaryV7：代码生成摘要（不走 API·省一次大调用）
// ============================================================
// 输入：scenes, allResults (批注版剧本数组), allData (JSON 数据数组), validations
// 输出：批注摘要字符串
// ============================================================
function generateSummaryV7(scenes, allResults, allData, validations) {
  const lines = [];
  lines.push(DIVIDER);
  lines.push('【批注摘要】');
  lines.push(DIVIDER);
  lines.push('');

  const total = scenes.length;
  let totalAnnotated = 0;
  let totalNoAnn = 0;
  let totalPending = 0;
  let totalIntent = 0;
  let totalInner = 0;
  let totalForbid = 0;
  let totalStable = 0;
  let totalColdOpen = 0;
  let withFeel = 0;
  let withActionThread = 0;
  const emotionFlowLine = [];
  const structureNodes = {};

  for (let i = 0; i < scenes.length; i++) {
    const data = allData[i];
    if (!data) continue;

    const scene = scenes[i];
    const annos = data.annotations || {};
    for (const id in annos) {
      const a = annos[id];
      if (!a) continue;
      if (a.status === 'annotated') totalAnnotated++;
      else if (a.status === 'no_annotation') totalNoAnn++;
      else if (a.status === 'pending') totalPending++;
      if (a.intent_capture) totalIntent += Array.isArray(a.intent_capture) ? a.intent_capture.length : 1;
      if (a.inner) totalInner++;
      if (a.forbid) totalForbid++;
      if (a.stable_frame) totalStable++;
    }
    if (data.cold_open && (data.cold_open.content || data.cold_open.desc)) totalColdOpen++;
    if (data.scene_feel) withFeel++;
    if (Array.isArray(data.action_thread) && data.action_thread.length > 0) withActionThread++;

    // 情绪节奏线
    if (data.emotion_flow && data.emotion_flow.end) {
      emotionFlowLine.push(`${scene.id}：${data.emotion_flow.end}`);
    }

    // 节点分布
    const node = data.structure_node || '未指定';
    structureNodes[node] = (structureNodes[node] || 0) + 1;
  }

  lines.push(`批注场景总数：${total}`);
  lines.push(`场景感受覆盖：${withFeel}/${total}`);
  lines.push(`动作线设计覆盖：${withActionThread}/${total}`);
  lines.push('');
  lines.push(`【批注分布】`);
  lines.push(`· annotated（有批注的条目）：${totalAnnotated} 条`);
  lines.push(`· no_annotation（纯信息交代）：${totalNoAnn} 条`);
  lines.push(`· pending（待补充）：${totalPending} 条`);
  lines.push('');
  lines.push(`【批注类型计数】`);
  lines.push(`· 镜头意图（intent_capture）：${totalIntent} 条`);
  lines.push(`· 人物内心（inner）：${totalInner} 条`);
  lines.push(`· 稳帧点（stable_frame）：${totalStable} 个`);
  lines.push(`· 禁止项（forbid）：${totalForbid} 条`);
  lines.push(`· Cold Open：${totalColdOpen} 场`);
  lines.push('');
  lines.push(`【结构节点分布】`);
  for (const node in structureNodes) {
    lines.push(`· ${node}：${structureNodes[node]} 场`);
  }
  lines.push('');
  if (emotionFlowLine.length > 0) {
    lines.push(`【全集情绪落点追踪】`);
    for (const f of emotionFlowLine) lines.push(`· ${f}`);
    lines.push('');
  }

  // 验证警告
  const warnings = [];
  for (const v of (validations || [])) {
    if (v && v.errors && v.errors.length > 0) {
      warnings.push(`场景${v.sceneId}：${v.errors.length} 条验证警告`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`【验证警告】`);
    for (const w of warnings) lines.push(`· ${w}`);
    lines.push('');
  } else {
    lines.push(`【验证状态】全部场景通过 ✓`);
    lines.push('');
  }

  lines.push(DIVIDER);
  lines.push('→ 批注完成·可进入 Agent B（服化道锁定）或 Agent C（分镜提示词）');
  lines.push(DIVIDER);

  return lines.join('\n');
}

// ============================================================
// 7. getAnnotationStatsV7：供前端展示的统计
// ============================================================
function getAnnotationStatsV7(items, data) {
  const annotatableIds = items.filter(it => it.type !== 'raw').map(it => it.id);
  const annos = (data && data.annotations) || {};

  let annotated = 0, noAnn = 0, pending = 0, missing = 0;
  let intentCount = 0, innerCount = 0, forbidCount = 0, stableCount = 0;

  for (const id of annotatableIds) {
    const a = annos[id];
    if (!a) { missing++; continue; }
    if (a.status === 'annotated') annotated++;
    else if (a.status === 'no_annotation') noAnn++;
    else if (a.status === 'pending') pending++;
    if (a.intent_capture) intentCount += Array.isArray(a.intent_capture) ? a.intent_capture.length : 1;
    if (a.inner) innerCount++;
    if (a.forbid) forbidCount++;
    if (a.stable_frame) stableCount++;
  }

  return {
    total: annotatableIds.length,
    dialogues: items.filter(it => it.type === 'dialogue').length,
    actions: items.filter(it => it.type === 'action').length,
    annotated, noAnn, pending, missing,
    hasFeel: !!(data && data.scene_feel),
    hasActionThread: !!(data && Array.isArray(data.action_thread) && data.action_thread.length > 0),
    innerCount, intentCount, forbidCount, stableCount,
  };
}

module.exports = {
  parseSceneItemsV7,
  buildAnnotationPromptV7,
  parseAnnotationJSON,
  validateAnnotationV7,
  assembleAnnotationV7,
  generateSummaryV7,
  getAnnotationStatsV7,
  // 内部函数也导出·方便单测
  _internal: {
    stripExistingDN,
    assembleAnnotationBlock,
    ensureString,
  },
};
