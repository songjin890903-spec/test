const { escapeRegExp } = require('./parser');

const DEFAULT_FORBIDDEN_TERMS = [
  '绿云大厦', '绿云', '城市燃烧', '远方城市燃烧', '希望或者审判', '新子民', '旧世界最后合影',
  '审判者', '预言者', '上帝视角', '像在欣赏猎物', '非人气质',
  '末日教主', '权力交接', '仪式感剪影', '逆光轮廓', '双臂抱胸', '城市火光', '旧世界', '新世界的预言'
];

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  const re = new RegExp(escapeRegExp(needle), 'g');
  return (String(haystack || '').match(re) || []).length;
}

function sanitizeModelOutput(text) {
  let s = String(text || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
  s = s.replace(/<scene_plan>[\s\S]*?<\/scene_plan>/gi, '');
  s = s.replace(/```[\s\S]*?```/g, m => m.replace(/```[a-zA-Z]*\n?|```/g, ''));
  const firstAt = s.search(/(?:^|\n)@[^\n]+\n\s*【片段/);
  if (firstAt > 0 && firstAt < 2000) s = s.slice(firstAt).trim();
  s = s.replace(/^\s*(好的|收到|以下是|补写说明|我将|现在开始)[^\n]*\n+/gm, '');
  return s.trim();
}

function normalizeForCoverage(s) {
  return String(s || '').replace(/[\s，。！？、；：：“”‘’"'（）()【】\[\]《》<>…\.\,\!\?\;\:\-—_·~]/g, '');
}

function textLooksLikePart(said, expected) {
  const a = normalizeForCoverage(said);
  const b = normalizeForCoverage(expected);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a) || (a.length >= 4 && b.includes(a.slice(0, Math.min(a.length, 8))));
}

function validateTextCoverage(manifest, text, opts = {}) {
  const { requireActions = false, requireDialogueIds = false, allowDuplicates = false } = opts;
  const missingDialogues = [];
  const duplicateDialogues = [];
  const missingDialogueIds = [];
  const missingActions = [];
  for (const d of manifest.dialogues) {
    const count = countOccurrences(text, d.text);
    if (count === 0) missingDialogues.push({ id: d.id, speaker: d.speaker, text: d.text, sceneId: d.sceneId });
    if (!allowDuplicates && count > 1 && !d.isShortShout) duplicateDialogues.push({ id: d.id, text: d.text, count });
    if (requireDialogueIds && !String(text || '').includes(`[${d.id}]`)) missingDialogueIds.push({ id: d.id, text: d.text, sceneId: d.sceneId });
  }
  if (requireActions) {
    for (const a of manifest.actions) {
      const rawWithoutMarker = a.raw.replace(/^▲\s*/, '').trim();
      if (!String(text || '').includes(rawWithoutMarker)) missingActions.push({ id: a.id, text: a.text, sceneId: a.sceneId });
    }
  }
  return {
    ok: missingDialogues.length === 0 && missingDialogueIds.length === 0 && missingActions.length === 0 && duplicateDialogues.length === 0,
    missingDialogues,
    duplicateDialogues,
    missingDialogueIds,
    missingActions
  };
}

function extractDialogueListText(text) {
  const s = String(text || '');
  const m = s.match(/【台词清单·交接AGENT_C用】[\s\S]*$/) || s.match(/台词清单[\s\S]*$/);
  return m ? m[0] : '';
}

function extractSceneScopedText(text, sceneId) {
  const s = String(text || '');
  if (!sceneId) return '';
  const marker = new RegExp(`(?:场景|SCENE|【SCENE)\\s*${escapeRegExp(sceneId)}`, 'i');
  const m = marker.exec(s);
  if (!m) return '';
  const start = m.index;
  const rest = s.slice(start + m[0].length);
  const next = rest.search(/(?:\n|^)\s*(?:场景|SCENE|【SCENE)\s*\d+[-－]\d+/i);
  const end = next >= 0 ? start + m[0].length + next : s.length;
  return s.slice(start, end);
}

function validateAgentAOutput(manifest, text) {
  const base = validateTextCoverage(manifest, text, { requireActions: true, requireDialogueIds: true, allowDuplicates: true });
  const missingSceneFeel = [];
  const missingActionLineDesign = [];
  for (const scene of manifest.scenes) {
    const sceneText = extractSceneScopedText(text, scene.id) || String(text || '');
    if (!/【场景感受】/.test(sceneText)) missingSceneFeel.push({ sceneId: scene.id });
    if (!/【动作线设计】/.test(sceneText)) missingActionLineDesign.push({ sceneId: scene.id });
  }
  const hasDialogueList = /【台词清单·交接AGENT_C用】/.test(String(text || '')) || /台词清单/.test(String(text || ''));
  const listText = extractDialogueListText(text);
  const dialogueListMissingIds = [];
  for (const d of manifest.dialogues) {
    const hay = listText || String(text || '');
    if (!hay.includes(d.id) || !hay.includes(d.text)) dialogueListMissingIds.push({ id: d.id, speaker: d.speaker, text: d.text, sceneId: d.sceneId });
  }
  return {
    ...base,
    duplicateDialogues: [],
    ok: base.missingDialogues.length === 0 && base.missingDialogueIds.length === 0 && base.missingActions.length === 0 &&
      hasDialogueList && dialogueListMissingIds.length === 0 && missingSceneFeel.length === 0 && missingActionLineDesign.length === 0,
    hasDialogueList,
    dialogueListMissingIds,
    missingSceneFeel,
    missingActionLineDesign
  };
}

function validateAgentBOutput(text) {
  const s = String(text || '');
  return {
    ok: /【角色词条】/.test(s) && /【场景词条】/.test(s) && /画面物理系统/.test(s),
    hasCharacters: /【角色词条】/.test(s),
    hasScenes: /【场景词条】/.test(s),
    hasPhysics: /画面物理系统/.test(s)
  };
}

function getDialogueById(manifest, id) {
  return manifest.dialogues.find(d => d.id === id);
}

function expectedDialogueParts(d) {
  const text = String(d.text || '').trim();
  const duration = Number(d.duration || 0);
  const isShortSystemVo = (d.channel === 'vo' || /VO|旁白|画外音/.test(String(d.speaker || ''))) && /无人接听|忙音|系统/.test(text) && Array.from(text).length <= 18;
  if (duration <= 3 || isShortSystemVo) return [{ id: d.id, text, kind: 'single' }];
  let rawParts = text.split(/(?<=[，。！？、；…]|\.\.\.)/).map(x => x.trim()).filter(Boolean);
  const targetParts = duration > 8 ? 3 : 2;
  if (rawParts.length < targetParts) {
    rawParts = [];
    const chars = Array.from(text);
    const size = Math.ceil(chars.length / targetParts);
    for (let i = 0; i < chars.length; i += size) rawParts.push(chars.slice(i, i + size).join(''));
  }
  if (rawParts.length > targetParts) {
    const buckets = Array.from({ length: targetParts }, () => '');
    rawParts.forEach((part, i) => { buckets[Math.min(targetParts - 1, i % targetParts)] += part; });
    rawParts = buckets.filter(Boolean);
  }
  return rawParts.map((part, i) => ({ id: `${d.id}-${i + 1}`, text: part, kind: duration > 8 && i > 0 ? 'soundPicture' : 'split' }));
}

function validateCDialogueCarrying(manifest, text) {
  const s = String(text || '');
  const missingTaggedDialogues = [];
  const duplicateTaggedDialogues = [];
  const wrongTaggedDialogues = [];
  const longDialogueSplitErrors = [];
  const soundPictureErrors = [];
  const tagged = [...s.matchAll(/台词\s*\[(D\d{3,}(?:-\d+)?)\][^：:]*[：:]\s*[“"]?([^”"\n]+)[”"]?/g)];
  const counts = new Map();
  const saidById = new Map();
  for (const m of tagged) {
    const id = m[1];
    const said = (m[2] || '').trim();
    counts.set(id, (counts.get(id) || 0) + 1);
    saidById.set(id, [...(saidById.get(id) || []), said]);
    const base = id.replace(/-\d+$/, '');
    const d = getDialogueById(manifest, base);
    if (!d) wrongTaggedDialogues.push({ id, said, reason: '未知台词ID' });
  }
  for (const d of manifest.dialogues) {
    const parts = expectedDialogueParts(d);
    if (Number(d.duration || 0) > 3) {
      if ((counts.get(d.id) || 0) > 0) longDialogueSplitErrors.push({ id: d.id, reason: '长台词使用了未拆分Dxxx，必须使用Dxxx-1/Dxxx-2子段', text: d.text });
      for (const part of parts) {
        const c = counts.get(part.id) || 0;
        if (c === 0) missingTaggedDialogues.push({ id: part.id, speaker: d.speaker, text: part.text, sceneId: d.sceneId });
        if (c > 1) duplicateTaggedDialogues.push({ id: part.id, text: part.text, count: c });
        for (const said of saidById.get(part.id) || []) {
          if (!textLooksLikePart(said, part.text)) wrongTaggedDialogues.push({ id: part.id, said, expected: part.text, reason: '台词子段与原文片段不匹配' });
        }
        if (part.kind === 'soundPicture') {
          const idx = s.indexOf(`台词[${part.id}]`);
          const window = idx >= 0 ? s.slice(Math.max(0, idx - 180), idx + 240) : '';
          if (!/声画分离/.test(window)) soundPictureErrors.push({ id: part.id, text: part.text, reason: '>8秒台词子段缺少【声画分离】标注' });
        }
      }
    } else {
      const c = (counts.get(d.id) || 0) + parts.reduce((sum, p) => sum + (counts.get(p.id) || 0), 0);
      if (c === 0) missingTaggedDialogues.push({ id: d.id, speaker: d.speaker, text: d.text, sceneId: d.sceneId });
      if (c > 1) duplicateTaggedDialogues.push({ id: d.id, text: d.text, count: c });
      const idsToCheck = [d.id, ...parts.map(p => p.id)];
      for (const id of idsToCheck) {
        for (const said of saidById.get(id) || []) {
          if (!textLooksLikePart(said, d.text)) wrongTaggedDialogues.push({ id, said, expected: d.text, reason: '台词ID与原文不匹配' });
        }
      }
    }
  }
  return { missingTaggedDialogues, duplicateTaggedDialogues, wrongTaggedDialogues, longDialogueSplitErrors, soundPictureErrors };
}

function validateCStructure(text) {
  const s = String(text || '');
  const structureErrors = [];
  const shotFormatErrors = [];
  const missingPhysicalFeedback = [];
  if (/<think>|<\/think>|<analysis>|<scene_plan>/i.test(s)) structureErrors.push('输出包含思考/规划标签');
  if (/→\s*【A】|→\s*【B】|→\s*【C】/.test(s)) structureErrors.push('片段被压成箭头串联格式，必须换行分节');
  if (/\[\d+\]\s*\d+(?:\.\d+)?s\s*(?:特写|近景|中景|远景|全景|手机主观)/.test(s)) structureErrors.push('镜号使用了[1]简表格式，必须使用“镜1  2s · [景别] ... 焦段XXmm”');
  const segmentMatches = [...s.matchAll(/(?:^|\n)@[^\n]+\n\s*【片段([^】]+)】[\s\S]*?(?=(?:\n@[^\n]+\n\s*【片段)|$)/g)];
  if (segmentMatches.length === 0) structureErrors.push('未找到合格片段块：@角色 后接 【片段】');
  for (const seg of segmentMatches) {
    const segId = seg[1];
    const block = seg[0];
    for (const sec of ['【A】', '【B】', '【C】', '【D】', '【E】', '【F】']) {
      if (!block.includes(sec)) structureErrors.push(`片段${segId}缺少${sec}`);
    }
    const shotHeads = [...block.matchAll(/(?:^|\n)镜\d+\s+\d+(?:\.\d+)?s\s*·\s*\[[^\]]+\][^\n]*焦段\d+mm/g)];
    if (shotHeads.length === 0) shotFormatErrors.push(`片段${segId}没有合格镜号头`);
    const badHeads = [...block.matchAll(/(?:^|\n)(?:\[\d+\]|镜\d+)[^\n]*/g)].map(m => m[0].trim()).filter(line => !/^镜\d+\s+\d+(?:\.\d+)?s\s*·\s*\[[^\]]+\].*焦段\d+mm/.test(line));
    for (const line of badHeads.slice(0, 5)) shotFormatErrors.push(`片段${segId}镜号格式错误：${line}`);
    const shotBlocks = block.split(/(?=\n镜\d+\s+)/).filter(x => /^\n?镜\d+\s+/.test(x));
    for (const shot of shotBlocks) {
      const head = (shot.match(/^\n?(镜\d+)/) || [])[1] || '镜号';
      if (!/（[^）]{4,}）/.test(shot)) missingPhysicalFeedback.push(`片段${segId}${head}缺少中文括号物理反馈`);
    }
  }
  return { structureErrors, shotFormatErrors, missingPhysicalFeedback };
}

function validateCInteraction(text) {
  const speakerInteractionErrors = [];
  const listenerInteractionErrors = [];
  const overShoulderErrors = [];
  const soundPictureInteractionErrors = [];
  const s = String(text || '');
  const shotBlocks = s.split(/(?=\n镜\d+\s+)/).filter(x => /^\n?镜\d+\s+/.test(x));
  for (const shot of shotBlocks) {
    const head = (shot.match(/^\n?(镜\d+)/) || [])[1] || '镜号';
    const hasDialogue = /台词\s*\[D\d{3,}(?:-\d+)?\]/.test(shot);
    if (hasDialogue) {
      if (!/(看向|视线|转向|落到|扫过|抬头|低头|回到|盯住|望向)/.test(shot)) {
        speakerInteractionErrors.push(`${head}含台词但缺少说话者视线路径/头部落点`);
      }
      if (!/(前景|后景|过肩|反打|听者|众人|范思瑶|赵一铭|张玄|刀哥|打手|刘秘书|对方|旁观者|肩线|衣袖|手机屏幕)/.test(shot)) {
        listenerInteractionErrors.push(`${head}含台词但缺少听者在场或反应对象`);
      }
      if (!/(后退|抬起|放下|拿开|转身|迈|靠近|缩|停住|举起|垂下|换重心|抓住|松开|撑住|低头|抬头|扭头|停在)/.test(shot)) {
        listenerInteractionErrors.push(`${head}含台词但缺少可见身体动作`);
      }
    }
    if (/过肩/.test(shot)) {
      if (!/(手机|屏幕|手|肩|身体|门框|地面|听者|说话者|赵一铭|范思瑶|张玄|刀哥)/.test(shot)) overShoulderErrors.push(`过肩镜缺少关系锚点`);
    }
    if (/声画分离/.test(shot)) {
      if (!/(画面聚焦|画面转向|画面落在|听者|范思瑶|赵一铭|张玄|刀哥|手机|屏幕|手|地面|众人)/.test(shot)) {
        soundPictureInteractionErrors.push(`${head}声画分离没有明确画面承载对象`);
      }
    }
  }
  return { speakerInteractionErrors, listenerInteractionErrors, overShoulderErrors, soundPictureInteractionErrors };
}

function validateCExpressionRules(text) {
  const expressionTemplateErrors = [];
  const dialoguePurposeErrors = [];
  const s = String(text || '');
  const banned = ['皱眉', '瞪眼', '瞪大眼', '脸色难看', '表情凝重', '眼神复杂', '震惊地', '愤怒地', '害怕地', '惊恐地', '痛苦地', '面露震惊', '表情震惊'];
  for (const term of banned) {
    const count = (s.match(new RegExp(term, 'g')) || []).length;
    if (count) expressionTemplateErrors.push('出现万能表情词“' + term + '”' + count + '次，应改成由台词目的派生的可演过程');
  }
  const shotBlocks = s.split(/(?=\n镜\d+\s+)/).filter(x => /^\n?镜\d+\s+/.test(x));
  for (const shot of shotBlocks) {
    const head = (shot.match(/^\n?(镜\d+)/) || [])[1] || '镜号';
    const hasDialogue = /台词\s*\[D\d{3,}(?:-\d+)?\]/.test(shot);
    if (!hasDialogue) continue;
    if (!/(先|再|才|却|说到|听到|开口前|说完|话出口|那一瞬|一半|停住|压住|收回|松开|落回|抬起|垂下|看向|扫过|落到|回到|像是|像要|想笑|嘴角|声音|语气)/.test(shot)) {
      dialoguePurposeErrors.push(head + '含台词但缺少“台词目的→表情/动作变化过程”，容易变成念台词');
    }
    if (/(皱眉|瞪眼|脸色|震惊|愤怒|害怕|惊恐|痛苦)/.test(shot) && !/(因为|像是|不是|而是|先|再|才|压住|收回|停住|落回|说到|听到|开口前|说完)/.test(shot)) {
      expressionTemplateErrors.push(head + '使用情绪/表情标签但没有台词触发和控制失败过程');
    }
  }
  return { expressionTemplateErrors, dialoguePurposeErrors };
}

function getMotionCategories(shot) {
  const cats = new Set();
  if (/(推进|推入|推近|前推|贴近|贴着)/.test(shot)) cats.add('推进');
  if (/(后撤|拉远|后拉|退开|后退)/.test(shot)) cats.add('后撤');
  if (/(横移|侧移|平移|横向|侧向|半弧|绕行|环绕)/.test(shot)) cats.add('横移/侧移');
  if (/过肩/.test(shot)) cats.add('过肩');
  if (/反打/.test(shot)) cats.add('反打');
  if (/(INSERT|锁定|特写|压到最紧|锁死)/i.test(shot)) cats.add('INSERT/锁定');
  if (/(焦平面|跟焦|转焦|焦点|收紧|松开)/.test(shot)) cats.add('焦平面');
  if (/(停住|静止|见证|稳住|等待)/.test(shot)) cats.add('停住见证');
  if (/(贴地|低角度|低机位)/.test(shot)) cats.add('贴地/低机位');
  if (/(手持|呼吸抖动|轻微抖动|震颤)/.test(shot)) cats.add('手持');
  return cats;
}

function validateCMotionAndFocal(text) {
  const s = String(text || '');
  const motionTemplateErrors = [];
  const motionDiversityErrors = [];
  const focalLengthErrors = [];
  const segmentMatches = [...s.matchAll(/(?:^|\n)@[^\n]+\n\s*【片段([^】]+)】[\s\S]*?(?=(?:\n@[^\n]+\n\s*【片段)|$)/g)];
  for (const seg of segmentMatches) {
    const segId = seg[1];
    const block = seg[0];
    const slideMatches = [...block.matchAll(/滑到|滑回|滑向|滑入/g)];
    if (slideMatches.length > 2) motionTemplateErrors.push(`片段${segId}“滑到/滑回/滑向”出现${slideMatches.length}次，超过2次`);
    const shotBlocks = block.split(/(?=\n镜\d+\s+)/).filter(x => /^\n?镜\d+\s+/.test(x));
    let previousSlide = false;
    const cats = new Set();
    const focalCounts = new Map();
    for (const shot of shotBlocks) {
      const head = (shot.match(/^\n?(镜\d+)/) || [])[1] || '镜号';
      const hasSlide = /滑到|滑回|滑向|滑入/.test(shot);
      if (previousSlide && hasSlide) motionTemplateErrors.push(`片段${segId}${head}连续使用滑动结构`);
      previousSlide = hasSlide;
      for (const c of getMotionCategories(shot)) cats.add(c);
      const focal = shot.match(/焦段(\d+)mm/);
      if (focal) {
        const mm = Number(focal[1]);
        focalCounts.set(mm, (focalCounts.get(mm) || 0) + 1);
        if (/\[特写|\[大特写/.test(shot) && mm < 70) focalLengthErrors.push(`片段${segId}${head}特写焦段${mm}mm偏短，手机/手指/屏幕INSERT优先85-100mm`);
        if (/\[全景|\[大远景/.test(shot) && mm > 70) focalLengthErrors.push(`片段${segId}${head}全景焦段${mm}mm偏长，空间关系优先24-50mm`);
        if (/(手机|屏幕|听筒|手指|拇指|汗珠)/.test(shot) && /\[特写|INSERT|锁定/.test(shot) && mm < 70) {
          focalLengthErrors.push(`片段${segId}${head}物件/手机特写焦段${mm}mm偏短，优先85-100mm`);
        }
      }
    }
    if (shotBlocks.length >= 6 && cats.size < 4) motionDiversityErrors.push(`片段${segId}镜头运动类型只有${cats.size}类，至少4类；已识别：${[...cats].join('、') || '无'}`);
    if (shotBlocks.length >= 4 && cats.size < 3) motionDiversityErrors.push(`片段${segId}镜头运动类型不足3类，容易模板化`);
    if (shotBlocks.length >= 5) {
      const distinctFocals = focalCounts.size;
      const maxSame = Math.max(0, ...focalCounts.values());
      if (distinctFocals < 3) focalLengthErrors.push(`片段${segId}焦段变化不足，${shotBlocks.length}个镜号仅${distinctFocals}种焦段`);
      if (maxSame > Math.ceil(shotBlocks.length * 0.75)) focalLengthErrors.push(`片段${segId}同一焦段使用过多，焦段没有服务镜头任务`);
    }
  }
  return { motionTemplateErrors, motionDiversityErrors, focalLengthErrors };
}


function validateCExpressionDiversity(text) {
  const repeatedExpressionErrors = [];
  const s = String(text || '');
  const patterns = [
    '嘴角抬到一半', '嘴角.*停住', '视线.*落回手机', '强撑.*收掉', '手指.*停住',
    '眼睛.*亮一下', '没有立刻', '先.*再.*才', '像要.*证明', '像把.*推远'
  ];
  for (const pat of patterns) {
    const re = new RegExp(pat, 'g');
    const count = (s.match(re) || []).length;
    if (count > 2) repeatedExpressionErrors.push('表演过程模板“' + pat + '”出现' + count + '次，容易形成新的AI感，应根据具体台词换动作');
  }
  const shotBlocks = s.split(/(?=\n镜\d+\s+)/).filter(x => /^\n?镜\d+\s+/.test(x));
  for (const shot of shotBlocks) {
    const head = (shot.match(/^\n?(镜\d+)/) || [])[1] || '镜号';
    if (/台词\s*\[D\d{3,}(?:-\d+)?\]/.test(shot) && /(像是|像要|像把|像在)/.test(shot) && !/(说到|听到|开口前|说完|这句|这个词|那一瞬)/.test(shot)) {
      repeatedExpressionErrors.push(head + '使用“像...”解释表演但没有绑定具体台词触发点');
    }
  }
  return { repeatedExpressionErrors };
}

function validateCSourceAndScreenLayer(text) {
  const sourceScopeErrors = [];
  const screenLayerErrors = [];
  const s = String(text || '');
  const forbiddenReality = [
    /丧尸(?:冲进|涌进|进入|闯入|包围|扑向).*?(?:祖宅|院内|张家|众人)/,
    /(?:祖宅|院内|张家).*?丧尸(?:冲进|涌进|进入|闯入|包围|扑向)/,
    /天空.*?(?:变色|异象|绿云|血色)/,
    /军队.*?(?:崩溃|开火|撤退|溃败)/,
    /城市.*?(?:燃烧|爆炸|火光|崩塌)/
  ];
  for (const re of forbiddenReality) {
    const m = s.match(re);
    if (m) screenLayerErrors.push('屏幕层内容疑似溢出到现实层：' + m[0].slice(0, 80));
  }
  const overActions = ['冲过去夺手机', '跑出院子', '跪下', '抱住赵一铭', '张玄拍肩', '打手逃走', '范思瑶扑过去', '刀哥冲出'];
  for (const term of overActions) {
    if (s.includes(term)) sourceScopeErrors.push('自然演员反应越界：' + term + '，可能改变剧情事件');
  }
  const suspiciousEvents = ['新增', '忽然出现', '突然冲进来', '远处爆炸', '警笛大作', '乌鸦', '血色天空'];
  for (const term of suspiciousEvents) {
    if (s.includes(term)) sourceScopeErrors.push('疑似未授权事件/气氛扩展：' + term);
  }
  return { sourceScopeErrors, screenLayerErrors };
}

function validateEFixedRestrictions(text) {
  const eRestrictionErrors = [];
  const s = String(text || '');
  const segmentMatches = [...s.matchAll(/(?:^|\n)@[^\n]+\n\s*【片段([^】]+)】[\s\S]*?(?=(?:\n@[^\n]+\n\s*【片段)|$)/g)];
  const required = [
    { name: '禁字幕', re: /严禁出现字幕|禁止出现字幕|无字幕|禁字幕/ },
    { name: '禁文字标题角标水印Logo平台标识', re: /(文字标题|标题).*?(角标|水印|Logo|logo|平台标识)|(水印|Logo|logo|平台标识).*?(严禁|禁止)/ },
    { name: '禁背景音乐BGM', re: /严禁出现背景音乐|禁止背景音乐|禁背景音乐|严禁.*?(配乐|BGM)|禁止.*?(配乐|BGM)/i },
    { name: '保留真实音效', re: /保留.*?(音效|环境音|物件音|电话声|脚步声|呼吸声|手机提示音|屏幕视频原声)/ },
    { name: '禁止新增未授权内容', re: /禁止新增.*?(未授权|地点|角色|灾难奇观|世界观设定)/ },
    { name: '禁止自创台词', re: /禁止自创台词|严禁自创台词|台词必须来自原剧本/ }
  ];
  for (const seg of segmentMatches) {
    const segId = seg[1];
    const block = seg[0];
    const eMatch = block.match(/【E】[\s\S]*?(?=\n【F】|\n---\n|\n@[^\n]+\n\s*【片段|$)/);
    const eText = eMatch ? eMatch[0] : '';
    for (const item of required) {
      if (!item.re.test(eText)) eRestrictionErrors.push(`片段${segId}【E】缺少固定限制：${item.name}`);
    }
  }
  return { eRestrictionErrors };
}

function validateCOutput(manifest, text, opts = {}) {
  const forbiddenTerms = opts.forbiddenTerms || DEFAULT_FORBIDDEN_TERMS;
  const carry = validateCDialogueCarrying(manifest, text);
  const { missingTaggedDialogues, duplicateTaggedDialogues, wrongTaggedDialogues, longDialogueSplitErrors, soundPictureErrors } = carry;
  const report = { ok: true, missingDialogues: missingTaggedDialogues.slice(), duplicateDialogues: duplicateTaggedDialogues.slice(), missingDialogueIds: [], missingActions: [] };
  const extraDialogueLikeLines = [];
  const forbiddenHits = [];
  const internalLeaks = [];
  const allowedDialogueTexts = new Map(manifest.dialogues.map(d => [d.text, d]));
  const speakerNames = [...new Set(manifest.dialogues.map(d => d.speaker.replace(/[（）]/g, '').replace(/OS$/i, '')).filter(Boolean))];
  const speakerPattern = speakerNames.length ? speakerNames.map(escapeRegExp).join('|') : '台词';
  const dialogueLineRe = new RegExp(`(?:^|\\n)\\s*(?:台词\\s*)?(?:\\[(D\\d{3,}(?:-\\d+)?)\\])?\\s*(?:${speakerPattern})?(?:（[^）]*）)?[：:]\\s*[“\"]?([^”\"\\n]+)[”\"]?`, 'g');
  for (const m of String(text || '').matchAll(dialogueLineRe)) {
    const id = m[1];
    const said = (m[2] || '').trim();
    if (!said || said.length < 2) continue;
    if (id) continue;
    if (!allowedDialogueTexts.has(said) && ![...allowedDialogueTexts.keys()].some(t => t.includes(said) || said.includes(t))) {
      if (!/^(画风|空间|光源|人物位置|人物状态|限制指令|声音设计|台词覆盖|禁止项|出现了|无|场景类型|焦段|起始状态)$/.test(said)) {
        extraDialogueLikeLines.push({ text: said });
      }
    }
  }
  for (const term of forbiddenTerms) {
    if (term && String(text || '').includes(term)) forbiddenHits.push(term);
  }
  const leakPatterns = ['<think>', '</think>', '<scene_plan>', '</scene_plan>', '<analysis>', '</analysis>', '好的，收到', '补写说明', '导演讲戏', 'Agent A', 'Agent B', '批注要求', '根据规则', '我将', '用户要求我', '我需要', '现在开始'];
  for (const p of leakPatterns) {
    if (String(text || '').includes(p)) internalLeaks.push(p);
  }
  const structure = validateCStructure(text);
  const interaction = validateCInteraction(text);
  const expression = validateCExpressionRules(text);
  const expressionDiversity = validateCExpressionDiversity(text);
  const motion = validateCMotionAndFocal(text);
  const sourceLayer = validateCSourceAndScreenLayer(text);
  const eFixed = validateEFixedRestrictions(text);
  const ok = missingTaggedDialogues.length === 0 && duplicateTaggedDialogues.length === 0 &&
    wrongTaggedDialogues.length === 0 && longDialogueSplitErrors.length === 0 && soundPictureErrors.length === 0 &&
    extraDialogueLikeLines.length === 0 && forbiddenHits.length === 0 && internalLeaks.length === 0 &&
    structure.structureErrors.length === 0 && structure.shotFormatErrors.length === 0 &&
    structure.missingPhysicalFeedback.length === 0 &&
    interaction.speakerInteractionErrors.length === 0 && interaction.listenerInteractionErrors.length === 0 &&
    interaction.overShoulderErrors.length === 0 && interaction.soundPictureInteractionErrors.length === 0 &&
    expression.expressionTemplateErrors.length === 0 && expression.dialoguePurposeErrors.length === 0 && expressionDiversity.repeatedExpressionErrors.length === 0 &&
    motion.motionTemplateErrors.length === 0 && motion.motionDiversityErrors.length === 0 && motion.focalLengthErrors.length === 0 &&
    sourceLayer.sourceScopeErrors.length === 0 && sourceLayer.screenLayerErrors.length === 0 &&
    eFixed.eRestrictionErrors.length === 0;
  return {
    ...report,
    ok,
    missingTaggedDialogues,
    duplicateTaggedDialogues,
    wrongTaggedDialogues,
    longDialogueSplitErrors,
    soundPictureErrors,
    extraDialogueLikeLines,
    forbiddenHits,
    internalLeaks,
    ...structure,
    ...interaction,
    ...expression,
    ...expressionDiversity,
    ...motion,
    ...sourceLayer,
    ...eFixed
  };
}

function auditSummary(report) {
  const parts = [];
  if (report.missingDialogues?.length) parts.push(`漏台词${report.missingDialogues.length}`);
  if (report.duplicateDialogues?.length) parts.push(`重复台词${report.duplicateDialogues.length}`);
  if (report.missingDialogueIds?.length) parts.push(`缺原文ID${report.missingDialogueIds.length}`);
  if (report.missingTaggedDialogues?.length) parts.push(`缺台词ID${report.missingTaggedDialogues.length}`);
  if (report.wrongTaggedDialogues?.length) parts.push(`ID错配${report.wrongTaggedDialogues.length}`);
  if (report.longDialogueSplitErrors?.length) parts.push(`长台词未拆${report.longDialogueSplitErrors.length}`);
  if (report.soundPictureErrors?.length) parts.push(`缺声画分离${report.soundPictureErrors.length}`);
  if (report.extraDialogueLikeLines?.length) parts.push(`疑似自创台词${report.extraDialogueLikeLines.length}`);
  if (report.forbiddenHits?.length) parts.push(`幻想禁词${report.forbiddenHits.length}`);
  if (report.internalLeaks?.length) parts.push(`过程泄漏${report.internalLeaks.length}`);
  if (report.structureErrors?.length) parts.push(`结构错误${report.structureErrors.length}`);
  if (report.shotFormatErrors?.length) parts.push(`镜号格式错${report.shotFormatErrors.length}`);
  if (report.missingPhysicalFeedback?.length) parts.push(`缺物理反馈${report.missingPhysicalFeedback.length}`);
  if (report.speakerInteractionErrors?.length) parts.push(`缺说话者视线路径${report.speakerInteractionErrors.length}`);
  if (report.listenerInteractionErrors?.length) parts.push(`缺听者互动${report.listenerInteractionErrors.length}`);
  if (report.overShoulderErrors?.length) parts.push(`过肩镜问题${report.overShoulderErrors.length}`);
  if (report.soundPictureInteractionErrors?.length) parts.push(`声画分离承载问题${report.soundPictureInteractionErrors.length}`);
  if (report.expressionTemplateErrors?.length) parts.push(`表情模板化${report.expressionTemplateErrors.length}`);
  if (report.dialoguePurposeErrors?.length) parts.push(`台词表演目的缺失${report.dialoguePurposeErrors.length}`);
  if (report.repeatedExpressionErrors?.length) parts.push(`表演过程重复${report.repeatedExpressionErrors.length}`);
  if (report.sourceScopeErrors?.length) parts.push(`来源越界${report.sourceScopeErrors.length}`);
  if (report.screenLayerErrors?.length) parts.push(`屏幕层溢出${report.screenLayerErrors.length}`);
  if (report.motionTemplateErrors?.length) parts.push(`运镜模板化${report.motionTemplateErrors.length}`);
  if (report.motionDiversityErrors?.length) parts.push(`运镜不丰富${report.motionDiversityErrors.length}`);
  if (report.focalLengthErrors?.length) parts.push(`焦段问题${report.focalLengthErrors.length}`);
  if (report.eRestrictionErrors?.length) parts.push(`E固定禁令缺失${report.eRestrictionErrors.length}`);
  if (report.missingActions?.length) parts.push(`漏动作${report.missingActions.length}`);
  if (report.hasDialogueList === false) parts.push('缺台词清单');
  if (report.dialogueListMissingIds?.length) parts.push(`台词清单漏ID${report.dialogueListMissingIds.length}`);
  if (report.missingSceneFeel?.length) parts.push(`缺场景感受${report.missingSceneFeel.length}`);
  if (report.missingActionLineDesign?.length) parts.push(`缺动作线设计${report.missingActionLineDesign.length}`);
  if (report.hasCharacters === false) parts.push('缺角色词条');
  if (report.hasScenes === false) parts.push('缺场景词条');
  if (report.hasPhysics === false) parts.push('缺画面物理系统');
  return parts.length ? parts.join(' / ') : '通过';
}

function buildRepairUserPrompt({ stage, originalText, report, manifestText }) {
  const missing = [
    ...(report.missingDialogues || []),
    ...(report.missingTaggedDialogues || []),
    ...(stage === 'AGENT_A' ? (report.dialogueListMissingIds || []) : [])
  ];
  const duplicate = stage === 'AGENT_C' ? (report.duplicateDialogues || []) : [];
  const wrong = report.wrongTaggedDialogues || [];
  const extra = report.extraDialogueLikeLines || [];
  const forbidden = report.forbiddenHits || [];
  const leaks = report.internalLeaks || [];
  const structureErrors = report.structureErrors || [];
  const shotFormatErrors = report.shotFormatErrors || [];
  const missingPhysicalFeedback = report.missingPhysicalFeedback || [];
  const longDialogueSplitErrors = report.longDialogueSplitErrors || [];
  const soundPictureErrors = report.soundPictureErrors || [];
  const speakerInteractionErrors = report.speakerInteractionErrors || [];
  const listenerInteractionErrors = report.listenerInteractionErrors || [];
  const overShoulderErrors = report.overShoulderErrors || [];
  const soundPictureInteractionErrors = report.soundPictureInteractionErrors || [];
  const expressionTemplateErrors = report.expressionTemplateErrors || [];
  const dialoguePurposeErrors = report.dialoguePurposeErrors || [];
  const motionTemplateErrors = report.motionTemplateErrors || [];
  const motionDiversityErrors = report.motionDiversityErrors || [];
  const focalLengthErrors = report.focalLengthErrors || [];
  const repeatedExpressionErrors = report.repeatedExpressionErrors || [];
  const sourceScopeErrors = report.sourceScopeErrors || [];
  const screenLayerErrors = report.screenLayerErrors || [];
  const missingActions = report.missingActions || [];
  const eRestrictionErrors = report.eRestrictionErrors || [];
  return [
    `你正在修复 ${stage} 输出。只输出修复后的完整正文，不要解释，不要写“收到/补写说明”，禁止<think>。`,
    stage === 'AGENT_C' ? 'AGENT_C必须恢复完整分镜格式：@角色 @场景、【片段】、【A】【B】【C】【D】【E】【F】，镜号必须是“镜1  2s · [景别] 复合运镜  焦段85mm”，每镜必须有（物理反馈）。长台词必须拆成Dxxx-1/Dxxx-2子段，>8秒必须有【声画分离】；每个台词镜号必须有说话者视线路径、听者在场和可见身体反应；表情必须从台词目的派生，禁止皱眉/瞪眼/脸色难看等万能表情。镜头运动要丰富但不能滑来滑去，同一片段滑动结构最多2次；焦段必须匹配任务且有变化。' : '',
    stage === 'AGENT_A' ? 'AGENT_A修复只做覆盖补齐：保留原剧本正文、补齐缺失[Dxxx]/[Axxx]、补齐【台词清单·交接AGENT_C用】。注意：AGENT_A允许同一台词在正文和台词清单中各出现一次，不要因为重复而删除台词清单。' : '',
    '修复目标：',
    missing.length ? `必须补齐这些台词，并用格式 台词[Dxxx] 或 台词[Dxxx-1] 角色：“原文”：\n${missing.map(x => `${x.id} ${x.speaker || ''}：${x.text}`).join('\n')}` : '无漏台词。',
    missingActions.length ? `必须补齐这些动作行原文：\n${missingActions.map(x => `${x.id} ${x.text}`).join('\n')}` : '',
    report.hasDialogueList === false ? '必须在末尾补充【台词清单·交接AGENT_C用】。' : '',
    report.missingSceneFeel?.length ? `必须为这些场景补【场景感受】：${report.missingSceneFeel.map(x => x.sceneId).join('、')}` : '',
    report.missingActionLineDesign?.length ? `必须为这些场景补【动作线设计】：${report.missingActionLineDesign.map(x => x.sceneId).join('、')}` : '',
    duplicate.length ? `删除重复台词，只保留一次：\n${duplicate.map(x => `${x.id} ${x.text} 出现${x.count}次`).join('\n')}` : '',
    wrong.length ? `修正这些台词ID错配：\n${wrong.map(x => `${x.id} 应为：${x.expected || ''} 实际：${x.said}`).join('\n')}` : '',
    extra.length ? `删除或改写疑似自创台词，不允许新增原剧本之外的对白：\n${extra.map(x => x.text).join('\n')}` : '',
    forbidden.length ? `删除幻想禁词/未授权设定：${forbidden.join('、')}` : '',
    leaks.length ? `删除过程泄漏词：${leaks.join('、')}` : '',
    structureErrors.length ? `修复结构错误：${structureErrors.join('；')}` : '',
    shotFormatErrors.length ? `修复镜号格式错误：${shotFormatErrors.slice(0, 20).join('；')}` : '',
    missingPhysicalFeedback.length ? `每个镜号补充中文括号物理反馈：${missingPhysicalFeedback.slice(0, 20).join('；')}` : '',
    longDialogueSplitErrors.length ? `长台词必须拆分为Dxxx-1/Dxxx-2，不可单镜整句：${longDialogueSplitErrors.map(x => x.id).join('、')}` : '',
    soundPictureErrors.length ? `这些长台词子段必须加【声画分离】并拍听者/物件/空间反应：${soundPictureErrors.map(x => x.id).join('、')}` : '',
    speakerInteractionErrors.length ? `补说话者视线路径/组织动作/消化动作：${speakerInteractionErrors.slice(0, 20).join('；')}` : '',
    listenerInteractionErrors.length ? `补听者在场和可见大动作反应：${listenerInteractionErrors.slice(0, 20).join('；')}` : '',
    overShoulderErrors.length ? `修复过肩镜前景/后景和虚焦听者身体状态：${overShoulderErrors.slice(0, 20).join('；')}` : '',
    soundPictureInteractionErrors.length ? `修复声画分离画面承载对象：${soundPictureInteractionErrors.slice(0, 20).join('；')}` : '',
    expressionTemplateErrors.length ? `删除万能表情，改成台词目的派生的表演过程：${expressionTemplateErrors.slice(0, 20).join('；')}` : '',
    dialoguePurposeErrors.length ? `补“台词目的→表情/动作变化过程”：${dialoguePurposeErrors.slice(0, 20).join('；')}` : '',
    motionTemplateErrors.length ? `修复运镜模板化：${motionTemplateErrors.slice(0, 20).join('；')}` : '',
    motionDiversityErrors.length ? `增加镜头运动丰富度：${motionDiversityErrors.slice(0, 20).join('；')}` : '',
    focalLengthErrors.length ? `修复焦段问题：${focalLengthErrors.slice(0, 20).join('；')}` : '',
    repeatedExpressionErrors.length ? `修复表演过程重复，避免把新规则又写成模板：${repeatedExpressionErrors.slice(0, 20).join('；')}` : '',
    sourceScopeErrors.length ? `删除来源越界/改变剧情的演员动作，只保留小范围自然反应：${sourceScopeErrors.slice(0, 20).join('；')}` : '',
    screenLayerErrors.length ? `修复屏幕层/现实层错误：短视频画面只能在手机屏幕内，不得溢出到院内现实空间：${screenLayerErrors.slice(0, 20).join('；')}` : '',
    eRestrictionErrors.length ? `每个片段【E】必须补齐固定限制：严禁出现字幕；严禁出现任何文字标题、角标、水印、Logo、平台标识；严禁出现背景音乐、配乐、BGM；保留真实环境音、物件音、电话声、脚步声、呼吸声、手机提示音、屏幕视频原声等必要音效；禁止新增未授权地点、角色、灾难奇观或世界观设定；禁止自创台词，台词必须来自原剧本。缺失项：${eRestrictionErrors.slice(0,20).join('；')}` : '',
    '原始锁定剧本如下，台词必须逐字来自这里：',
    manifestText,
    '待修复正文如下：',
    originalText
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  DEFAULT_FORBIDDEN_TERMS,
  countOccurrences,
  sanitizeModelOutput,
  validateTextCoverage,
  validateAgentAOutput,
  validateAgentBOutput,
  validateCOutput,
  auditSummary,
  buildRepairUserPrompt
};
