const fs = require('fs');
const path = require('path');
const { stripPunctuation, escapeRegExp, manifestToText } = require('./parser');
const { splitDialogueIntoParts } = require('./prompts');
const { segmentPlanToText } = require('./segmentPlanner');
const { buildPerformancePlan } = require('./performancePlanner');

const TOOL_VERSION = 'v3.1.3-dialoguepace-recut-stable-performance-causality-visualstyles-carry';

const E_FIXED = [
  '严禁出现字幕',
  '严禁出现任何文字标题、角标、水印、Logo、平台标识',
  '严禁出现背景音乐、配乐、BGM',
  '保留真实环境音、物件音、电话声、脚步声、呼吸声、手机提示音、屏幕视频原声等必要音效',
  '禁止新增未授权地点、角色、灾难奇观或世界观设定',
  '禁止自创台词，台词必须来自原剧本'
];

const EXPRESSION_BLACKLIST = [
  '皱眉','眉头','瞪眼','表情凝重','眼神复杂','震惊地','愤怒地','害怕地',
  '复杂','凝重','压迫感','仪式感','宿命感','像是','仿佛','似乎','带着一种','某种','隐约','微妙','象征','代表','暗示','说明','不是笑，是确认','不是.*而是'
];

// 渲染层视觉模板句黑名单 — 这些是AI容易生成的通用/空洞描述，必须过滤
// 注意："画面中无人开口"是VO场景的正确画面说明，不在此列
const VISUAL_TEMPLATE_BLACKLIST = [
  '面向对手把台词说出来',
  '身体跟着台词内容有轻微起伏',
  '承接上一动作',
  '下一步动作的接棒物',
  '接棒物',
  '微微变化',
  '环境声低底噪',
  '动作未完成',
  '听者保持当前状态',
  '人物状态紧张',
  '气氛压抑'
];

function isVisualTemplateText(text) {
  return VISUAL_TEMPLATE_BLACKLIST.some(t => text.includes(t));
}

const HARD_SOURCE_BLACKLIST = [
  '绿云','城市燃烧','远方城市','军队崩溃','天空异象','丧尸冲进祖宅','审判者','预言者','末日教主','权力交接',
  '黑色商务车','顶级商务车','老槐树','槐树','西装笔挺','整理袖扣','黄昏','暮色','冷空气白雾','白雾','通话计时器','时长00:00','To be continued','抓住他的袖口','抓张玄袖口','靠在张玄','靠到了张玄','咬住自己的指关节','咬手指','手按在胸口','手按胸口','空气变稠','旧秩序失效','像一个观众','有趣的前奏','小品'
];

function norm(s) { return stripPunctuation(String(s || '')).toLowerCase(); }
function includesLoose(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x) || (x.length >= 4 && y.includes(x.slice(0, Math.min(8, x.length))));
}

// ============================================================
// ContentAnalyzer — 统一语义分析器
// 输入: shot 对象，输出: 语义标签字典
// 替代散落在各函数中的硬编码关键词判断
// ============================================================
function analyzeShot(shot) {
  // 合并所有文本字段用于分析
  const allText = [
    shot.task || '',
    shot.segmentTitle || '',
    ...(shot.actionTexts || []),
    ...(shot.dialogueLines || []).map(x => x.text || ''),
    ...(shot.dialogueLines || []).map(x => x.originalText || x.text || '')
  ].join(' ');

  const dl = (shot.dialogueLines || [])[0] || {};
  const text = String(dl.text || '').trim();
  const speaker = String(dl.speaker || '').trim();
  const vm = String(dl.voiceMode || '').trim();
  const audioMode = String(shot.audioMode || '').trim();

  // 1. voiceMode 语义分类
  const isPhone = vm === 'phone' || vm === 'vo' || /VO|电话|旁白|画外音|OS/.test(speaker);
  const isVO = vm === 'vo' || vm === 'os';
  const isSpoken = vm === 'spoken' || vm === 'spoken_split';

  // 2. 情绪语义标签 — 基于语气词，不绑定具体角色/情节
  const emotion = detectEmotion(text, allText);

  // 3. 场景关键词 — 物件/动作/状态
  const keywords = extractKeywords(allText);

  // 4. 角色关系位推断 — 基于voiceMode，不绑定角色名
  const speakerRole = inferSpeakerRole(shot, vm);

  // 5. 镜头位置特征
  const index = Math.max(0, Number(shot.no || 1) - 1);
  const total = Math.max(1, Number(shot.segmentShotCount || shot.no || 1));
  const isFirstShot = index === 0;
  const isLastShot = index === total - 1;
  const isAlternating = index % 2 === 0; // 用于轮询变化

  return {
    vm,            // voiceMode 原始值
    isPhone,       // 电话/VO类型
    isVO,          // 纯旁白类型
    isSpoken,      // 实际对话类型
    emotion,       // 情绪标签
    keywords,      // 场景关键词
    speakerRole,   // 说话者角色位
    index,         // 镜号索引(0-based)
    isFirstShot,   // 首镜
    isLastShot,    // 末镜
    isAlternating, // 偶数镜(用于轮询)
    allText,       // 合并全文
    dl,            // 首条对话行
    speaker,       // 说话者原文
    text           // 台词原文
  };
}

function detectEmotion(text, allText) {
  const combined = text + ' ' + allText;
  // 质疑/反问 — 语气上扬但被压制
  if (/怎么可能|怎么会|不是吧|不会吧|什么鬼|凭什么|怎么就|怎么又|傻子|打错/.test(combined)) {
    return 'doubt';
  }
  // 警告/紧急 — 信息密度高，语速急
  if (/警告|危险|紧急|没开玩笑|来不及|快|赶紧|快跑|小心/.test(combined)) {
    return 'alert';
  }
  // 震惊/冲击 — 信息击穿认知防线
  if (/乱套|完了|怎么会这样|天塌了|不敢相信|愣|呆|僵/.test(combined)) {
    return 'shock';
  }
  // 荒诞/不信任 — 台词内容荒唐
  if (/荒唐|玩笑|假的|不信|你信吗|真的假的/.test(combined)) {
    return 'absurd';
  }
  // 否定/拒绝 — 关闭式回应
  if (/关我|不关我|我不管|别找我|别烦我|滚/.test(combined)) {
    return 'reject';
  }
  // 追问/确认 — 开放式等待
  if (/你是谁|不认识|没见过|等一下|等等/.test(combined)) {
    return 'probe';
  }
  // 命令/指示 — 权力位明确
  if (/给我|找.*来|叫.*来|必须|一定/.test(combined)) {
    return 'command';
  }
  // 宣告/转折 — 信息不对称释放
  if (/欢迎|新时代|紧急|警告|危险|其实|但是|不过/.test(combined)) {
    return 'reveal';
  }
  // 中性/信息 — 无明显情绪标记
  return 'neutral';
}

function extractKeywords(allText) {
  const kw = { phone: false, video: false, drop: false, sound: false, outdoor: false, indoor: false };
  if (/手机|屏幕|通话|拨号|号码|按键|通讯录/.test(allText)) kw.phone = true;
  if (/短视频|视频|外放/.test(allText)) kw.video = true;
  if (/落地|掉在地上|摔|滑落|裂/.test(allText)) kw.drop = true;
  if (/忙音|等待音|提示音|无人接听|电话声/.test(allText)) kw.sound = true;
  if (/院子|祖宅|户外|室外|天空|旧宅/.test(allText)) kw.outdoor = true;
  if (/房间|室内|屋内|客厅|卧室/.test(allText)) kw.indoor = true;
  return kw;
}

function inferSpeakerRole(shot, vm) {
  // 基于voiceMode推断说话者/听话者关系位
  // 不依赖具体角色名，而是基于信息流方向
  if (vm === 'phone') {
    // 电话中：说话者持手机，听者处于观察位
    return 'phoneSpeaker';
  }
  if (vm === 'vo' || vm === 'os') {
    // 旁白/画外音：画面中无人开口，信息来自画外
    return 'voiceover';
  }
  if (vm === 'spoken' || vm === 'spoken_split') {
    // 实际对话：首镜倾向于反应者主动，中间镜倾向于信息传递
    const index = Math.max(0, Number(shot.no || 1) - 1);
    if (index === 0) return 'activeListener'; // 首镜常是听话者被激起反应
    return 'dialogueSpeaker';
  }
  return 'unknown';
}
function safeJsonStringify(obj) { return JSON.stringify(obj, null, 2); }
function num(n, fallback = 0) { const x = Number(n); return Number.isFinite(x) ? x : fallback; }
function round1(n) { return Math.round(num(n) * 10) / 10; }
function isVoiceOnlyDialogue(d) {
  return d && (d.channel === 'vo' || d.channel === 'os' || /VO|旁白|画外音|OS/.test(String(d.speaker || '') + String(d.state || '')));
}
function voiceModeFor(d, part) {
  if (!d) return 'none';
  if (d.channel === 'os' || /OS/.test(String(d.speaker || '') + String(d.state || ''))) return 'os';
  if (d.channel === 'vo' || /VO|旁白|画外音/.test(String(d.speaker || '') + String(d.state || ''))) return /刘秘书|电话|无人接听|拨打/.test(String(d.speaker || '') + String(d.text || '')) ? 'phone' : 'vo';
  if (String(part?.id || '').includes('-') && /声画分离|反打继续|继续/.test(part?.mode || '')) return 'spoken_split';
  return 'spoken';
}

function estimatePartDuration(text, baseDialogue) {
  const t = String(text || '');
  const charCount = Array.from(stripPunctuation(t)).length;
  const cue = `${baseDialogue?.state || ''} ${baseDialogue?.text || ''}`;
  let cps = 3.6;
  if (baseDialogue?.channel === 'vo' || baseDialogue?.channel === 'os' || /旁白|画外音|独白/.test(cue)) cps = 2.5;
  else if (/悲痛|克制|低沉|压抑|颤音|恐惧后压低/.test(cue)) cps = 2.3;
  else if (/激动|爆发|愤怒|不耐烦|慌乱|大喜|恐慌|急促|吼|喊|咆哮/.test(cue)) cps = 4.8;
  const commaPause = (t.match(/[，、]/g) || []).length * 0.45;
  const sentencePause = (t.match(/[。！？!?]/g) || []).length * 0.75;
  const ellipsisPause = (t.match(/…|\.\.\./g) || []).length * 0.9;
  const parentheticalPause = (t.match(/[（(][^）)]{1,20}[）)]/g) || []).length * 0.6;
  const breath = baseDialogue?.channel === 'dialogue' ? Math.min(1.0, Math.max(0.35, charCount * 0.03)) : 0.25;
  return round1(charCount / cps + commaPause + sentencePause + ellipsisPause + parentheticalPause + breath);
}

function estimateCompactPartDuration(text, baseDialogue) {
  const t = String(text || '');
  const charCount = Array.from(stripPunctuation(t)).length;
  const cue = `${baseDialogue?.state || ''} ${baseDialogue?.text || ''}`;
  let cps = 7.2;
  if (baseDialogue?.channel === 'vo' || baseDialogue?.channel === 'os' || /旁白|画外音|独白/.test(cue)) cps = 6.2;
  if (/悲痛|低沉|压抑|颤音|恐惧后压低/.test(cue)) cps = 5.2;
  if (/激动|爆发|愤怒|不耐烦|慌乱|大喜|恐慌|急促|吼|喊|咆哮/.test(cue)) cps = 7.8;
  const punctuation = (t.match(/[，、。！？!?；]/g) || []).length * 0.12;
  const parentheticalPause = (t.match(/[（(][^）)]{1,20}[）)]/g) || []).length * 0.35;
  let v = charCount / cps + punctuation + parentheticalPause + 0.35;
  if (charCount <= 5) v = Math.min(v, 1.4);
  else if (charCount <= 12) v = Math.max(v, 2.0);
  else if (charCount <= 22) v = Math.max(v, 2.6);
  else v = Math.max(v, 3.2);
  return round1(Math.max(1.2, Math.min(3.8, v)));
}

function splitByPunctuation(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const out = [];
  let buf = '';
  for (const ch of Array.from(t)) {
    buf += ch;
    if (/[，。！？；、…]/.test(ch)) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function mergeTinyChunks(chunks, minChars = 7) {
  const out = [];
  for (const ch of chunks) {
    const len = Array.from(stripPunctuation(ch)).length;
    if (out.length && len < minChars) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

function packDialogueChunks(chunks, targetParts, baseDialogue) {
  chunks = mergeTinyChunks(chunks);
  if (chunks.length <= targetParts) return chunks;
  const packs = Array.from({ length: targetParts }, () => '');
  let idx = 0;
  for (const ch of chunks) {
    const currentDur = estimatePartDuration(packs[idx], baseDialogue);
    const nextDur = estimatePartDuration((packs[idx] || '') + ch, baseDialogue);
    if (packs[idx] && nextDur > 3.1 && idx < targetParts - 1) idx++;
    packs[idx] += ch;
  }
  return packs.map(x => x.trim()).filter(Boolean);
}

function splitDialogueForC(d) {
  const text = String(d.text || '').trim();
  if (!text) return [];
  const isVoice = d.channel === 'vo' || d.channel === 'os' || /VO|旁白|画外音|OS/.test(String(d.speaker || '') + String(d.state || ''));
  const charCount = Array.from(stripPunctuation(text)).length;
  const isShortVoice = isVoice && charCount <= 18;
  if (isShortVoice) return [{ id: d.id, text, mode: '单镜号可承载·系统声不拆', duration: estimateCompactPartDuration(text, d) }];
  let parts = [];
  // 通用：按语义密度和标点拆分，不再绑定特定情节
  
  if (!parts.length && charCount > 34) {
    let chunks = splitByPunctuation(text);
    chunks = mergeTinyChunks(chunks, 8);
    const targetParts = charCount > 54 ? 3 : 2;
    parts = packDialogueChunks(chunks, targetParts, d);
  }
  if (!parts.length) parts = [text];

  return parts.map((partText, i) => ({
    id: parts.length === 1 ? d.id : `${d.id}-${i + 1}`,
    text: partText,
    mode: parts.length === 1 ? '单镜号可承载·片段预算内' : (i === 0 ? '起始镜号·语义短句' : '递进镜号·动作必须变化'),
    duration: estimateCompactPartDuration(partText, d)
  }));
}

function expectedPartsForSegment(scene, segment) {
  const out = [];
  for (const id of segment.dialogueIds || []) {
    const d = scene.dialogues.find(x => x.id === id);
    if (!d) continue;
    const parts = splitDialogueForC(d);
    for (const p of parts) {
      out.push({
        ...p,
        baseId: d.id,
        speaker: d.speaker,
        state: d.state || '',
        channel: d.channel,
        originalText: d.text,
        duration: p.duration || d.duration,
        fullDuration: d.duration,
        charCount: Array.from(stripPunctuation(p.text || d.text)).length,
        sceneId: d.sceneId,
        voiceMode: voiceModeFor(d, p),
        mustUseAudioVisualSplit: /声画分离/.test(p.mode || '')
      });
    }
  }
  return out;
}

function actionsForSegment(scene, segment) {
  const ids = new Set(segment.actionIds || []);
  return (scene.actions || []).filter(a => ids.has(a.id));
}

function extractPictureSystemFromB(costumeCard) {
  const s = String(costumeCard || '');
  const patterns = [
    /【画面物理系统(?:｜A_FULL|\|A_FULL|·A_FULL)?】[\s\S]*?(?=\n【[^\n】]+】|\n##|\n#|$)/,
    /【C\.A画面物理系统·权威母版】[\s\S]*?【画面物理系统(?:｜A_FULL|\|A_FULL|·A_FULL)?】[\s\S]*?(?=\n【[^\n】]+】|\n##|\n#|$)/
  ];
  let raw = '';
  for (const re of patterns) {
    const m = s.match(re);
    if (m) { raw = m[0]; break; }
  }
  if (!raw) return null;
  const block = raw.replace(/[\s\S]*?【画面物理系统(?:｜A_FULL|\|A_FULL|·A_FULL)?】[^\n]*\n?/, '').trim();
  const obj = {};
  const lines = block.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^画风[:：]/.test(line)) obj.style = line.replace(/^画风[:：]\s*/, '');
    else if (/^影像质感[:：]/.test(line)) obj.texture = line.replace(/^影像质感[:：]\s*/, '');
    else if (/^材质[:：]/.test(line)) obj.material = line.replace(/^材质[:：]\s*/, '');
    else if (/^光[:：]/.test(line)) obj.light = line.replace(/^光[:：]\s*/, '');
    else if (/^氛围[:：]/.test(line)) obj.atmosphere = line.replace(/^氛围[:：]\s*/, '');
    else if (/^渲染[:：]/.test(line)) obj.render = line.replace(/^渲染[:：]\s*/, '');
  }
  const keys = ['style','texture','material','light','atmosphere','render'];
  const bad = /写实短剧质感|日外自然光|自然光，光源来自天空|手机玻璃有冷白反光与指纹·硬质地面粗糙低反光/;
  if (keys.every(k => obj[k]) && !keys.some(k => bad.test(String(obj[k] || '')))) return obj;
  if (Object.keys(obj).length >= 4) return obj;
  return null;
}

function needsPoeticRewrite(physics) {
  const text = Object.values(physics || {}).join(' ');
  if (!text.trim()) return true;
  if (/不追求唯美|无体积|无烟无雾|无强晕光|无人工镜头光晕|不形成明显发光边缘|冷感基调|偏冷白|5500K/.test(text)) return true;
  let score = 0;
  if (/唯美|电影级|大片|精美|通透|梦幻/.test(text)) score++;
  if (/逆光|侧逆光|轮廓光|rim light|边缘光/.test(text)) score++;
  if (/空气|浮尘|尘雾|水汽|薄雾|体积光|光束|光雾/.test(text)) score++;
  if (/halation|bloom|晕光|高光溢出|柔和高光/.test(text)) score++;
  if (/浅景深|柔焦|焦外|虚化|光斑/.test(text)) score++;
  return score < 4;
}

function poeticPhysicsForScene(scene, fromB = null) {
  const header = String(scene.header || '');
  const isDay = /日|昼|白天/.test(header);
  const isOldHouse = /祖宅|旧宅|院/.test(header);
  const baseMaterial = fromB && fromB.material && !/[……]|...|[补充]|Fernel/.test(fromB.material) ? cleanPhysicsClause(fromB.material) : '';
  if (isOldHouse || isDay) {
    return {
      visualStyle: 'poetic',
      style: '电影级唯美写实·按场景类型设计精致空气感和层次光影·真实可拍但强调人物轮廓光、浅景深、空气介质和柔和高光，拒绝灰扑扑纪实和廉价短剧光',
      texture: '数字电影机模拟胶片·轻中颗粒·浅景深·人物面部、手机屏幕和手部动作清晰·背景按场景类型虚化·亮部有柔和halation，高光轻微溢出但不爆白·焦外光斑柔软',
      material: baseMaterial || '手机玻璃冷白高反射，带指纹油渍和Fresnel边缘反光·场景表面按材质PBR逻辑呈现，粗糙纹理、微裂纹、积尘和接触阴影·衣料、发丝和皮肤在逆光下有柔和边缘高光·皮肤保留毛孔、轻微汗光和柔和SSS，不磨皮',
      light: '根据场景环境设计主光，可偏暖也可随环境调整；优先形成逆光/侧逆光和发丝、肩线、衣缘轮廓光·前方由地面、墙面或门框反射柔和补光，面部暗侧被提亮但不打平，光比约1:2.5到1:3·手机屏幕近景提供冷白底光，与环境主光形成冷暖对比',
      atmosphere: '空气中有明显但克制的环境介质：按场景选择浮尘、树影和光束，潮湿场景用水汽，室内用尘埃或轻烟·逆光照亮空气颗粒，人物周围形成柔和空气光晕·背景被薄雾与浅景深轻微软化，暗部带少量冷调',
      render: '电影化HDR/类ACES·高光柔滚降·适度halation和轻微bloom·轻中胶片颗粒·极轻色差·禁止透明干空气、普通灰墙背景、廉价短剧光、硬闪光、塑料皮肤、CG感、动漫化和过饱和'
    };
  }
  return {
    visualStyle: 'poetic',
    style: '电影级唯美写实·根据剧本环境主动设计精美光影，不把唯美等同金光·真实可拍但强调空气感、人物轮廓美感、前后景虚实和材质高光',
    texture: '数字电影机模拟胶片·轻中颗粒·浅景深·人物面部和关键物件优先清晰·背景柔和虚化·亮部有克制halation和柔软焦外层次',
    material: baseMaterial || '核心物件按PBR呈现：玻璃、水面、金属有Fresnel与环境反射，布料有纤维与柔和高光，墙地面保留粗糙纹理和AO，皮肤有毛孔、轻微SSS与真实汗光',
    light: '主光来自场景可解释光源并明确方向、色温和光比；优先设计侧逆光、逆光、轮廓光、反射补光和暗部层次，人物面部不打平，关键物件可提供局部补光',
    atmosphere: '空气介质依据环境选择尘埃、水汽、薄雾、烟、树影或窗光；光在空气里有形状，背景被光雾和浅景深软化，暗部可带冷调形成冷暖对比',
    render: '电影化HDR/类ACES·高光柔滚降·适度halation·轻微bloom·轻中颗粒·极轻色差·禁止廉价滤镜、CG感、塑料皮肤、过饱和和无来源强光'
  };
}

function defaultPhysics(scene, costumeCard, visualStyle = 'plain') {
  const fromB = extractPictureSystemFromB(costumeCard);
  if (visualStyle === 'poetic') return needsPoeticRewrite(fromB) ? poeticPhysicsForScene(scene, fromB) : { ...fromB, visualStyle };
  if (fromB) return { ...fromB, visualStyle };
  const header = String(scene.header || '');
  const isDay = /日|昼|白天/.test(header);
  const isOldHouse = /祖宅|旧宅|院/.test(header);
  const isPoetic = visualStyle === 'poetic';
  if (isPoetic) {
    if (isOldHouse || isDay) {
      return {
        visualStyle,
        style: '电影级唯美写实·按场景类型设计精美光线与空气层次·真实可拍但拒绝灰扑扑纪实和廉价滤镜',
        texture: '数字电影机模拟胶片·轻中颗粒·浅景深·人物面部、手机屏幕和手部动作清晰·背景按场景类型虚化·亮部有克制胶片晕光',
        material: '手机玻璃冷白高反射并带指纹油渍和Fresnel边缘反光·场景表面保留粗糙纹理、砖缝积尘和AO·衣料、发丝、皮肤在逆光下有柔和边缘高光·皮肤有毛孔、轻微汗光与SSS透光感',
        light: '根据场景光源设计主光，优先使用侧后方或后方光制造逆光/侧逆光和人物轮廓光·前方由地面、墙面或水面反射柔和补光，面部暗侧有层次但不打平·手机屏幕近景提供冷白底光，与环境光形成冷暖对比·光比约1:2.5到1:3.5',
        atmosphere: '空气中有与环境匹配的薄介质：按场景选择浮尘、树影和水汽，室内用尘埃或香烟雾·逆光照亮空气颗粒，人物周围形成柔和光晕·背景被光雾和浅景深软化，暗部可带少量冷调',
        render: '电影化HDR/类ACES·高光柔滚降·适度halation和轻微bloom·轻中胶片颗粒·极轻色差·禁止塑料皮肤、CG感、动漫化、过饱和、硬闪光和无来源强炫光'
      };
    }
    return {
      visualStyle,
      style: '电影级唯美写实·根据剧本地点、时段和情绪主动设计精美光影，不把唯美等同金光，真实可拍但强调空气感、层次和人物轮廓美感',
      texture: '数字电影机模拟胶片·轻中颗粒·浅景深·人物面部和关键物件优先清晰·背景柔和虚化·亮部有克制胶片晕光',
      material: '核心物件按PBR呈现：玻璃、水面、金属有Fresnel与环境反射，布料有纤维与柔和高光，墙地面保留粗糙纹理和AO，皮肤有毛孔、轻微SSS与真实汗光',
      light: '主光必须来自可解释光源并明确方向、色温、光比和补光来源；优先设计侧逆光、逆光、轮廓光、反射补光和暗部层次，不打平人物面部',
      atmosphere: '空气介质依据环境选择：尘埃、水汽、薄雾、烟、树影或窗光；光在空气中有形状，背景被浅景深和光雾软化，暗部可带冷调形成冷暖对比',
      render: '电影化HDR/类ACES·高光柔滚降·适度halation·轻微bloom·轻中颗粒·极轻色差·禁止廉价滤镜、CG感、塑料皮肤、过饱和和无来源强光'
    };
  }
  if (isOldHouse || isDay) {
    return {
      visualStyle,
      style: '现实短剧写实·按场景类型设计画面，强调日常空间被异常事件击穿后的压迫感，而不是通用短剧模板',
      texture: '数字拍摄模拟轻微胶片·中浅景深·人物脸部与手机屏幕优先清晰·院门和外围人物略虚化，保留轻微现场感但不做夸张手持晃动',
      material: '手机玻璃有冷白屏幕反光、指纹油膜和边缘 Fresnel·场景表面按材质PBR逻辑呈现，高粗糙度并有积尘和风化痕迹·粗糙地面低反光且有细砂颗粒·人物皮肤保留毛孔和轻微汗渍但不过度油亮',
      light: '画面左前上方日光被环境切割后进入，色温约5200K偏中性冷白；人物受光侧清晰、背光侧进入柔和阴影，光比约1:3.5；手机屏幕在近景中提供局部冷白补光，地面给下颌和手部少量漫反射，角落和接触处 AO 加重',
      atmosphere: '空气干燥略有尘感，无夸张灾难奇观；焦平面在说话人物面部与手机屏幕之间切换，背景压暗并略虚化，暗部带青灰冷调，让电话声和手机屏幕成为异常感来源',
      render: '类 ACES 色彩管理·高光柔滚降·轻微胶片颗粒·无强晕光·极轻色差·避免过度磨皮、游戏感、动漫化、过饱和和无来源强光'
    };
  }
  return {
    visualStyle,
    style: '场景写实电影感·依据剧本地点和情绪主动设计的视觉系统·中高写实，禁止退回通用模板',
    texture: '数字拍摄模拟胶片·轻中颗粒·中浅景深·人物面部和关键物件优先清晰，背景按剧情压力适度虚化',
    material: '核心物件与场景表面按 PBR 逻辑呈现：玻璃、金属有 Fresnel 和指纹油膜，布料有纤维纹理与褶皱 AO，墙地面高粗糙度并有接触阴影，皮肤保留基础纹理与轻微 SSS',
    light: '主光必须来自场景可解释光源，明确方向、色温和光比；人物暗侧由地面、墙面反射形成柔和补光但不打平，关键物件可提供局部补光，角落和接触面 AO 加重',
    atmosphere: '氛围介质和色彩只服务剧情情绪，焦平面锁在人物面部或关键物件，背景按叙事压暗或虚化，暗部允许少量冷调形成层次',
    render: '电影化 HDR/类 ACES·高光柔滚降·轻微胶片颗粒·轻度晕光或无晕光按场景选择·极轻色差·避免塑料感、游戏感、动漫化、过饱和与无来源强光'
  };
}

function chooseShotCount(scene, segment, initialGroupCount) {
  if (scene.sceneType === 'wuxi') return Math.min(6, Math.max(4, initialGroupCount || 5));
  const estimated = num(segment.estimatedPlayableSeconds, num(segment.duration, 15));
  const base = Math.max(1, initialGroupCount || 1);
  if (/短视频|视频验证|新时代/.test(String(segment.title || ''))) return Math.max(5, Math.min(8, base));
  // 15秒是硬目标，但不靠多个弱空镜硬凑。优先保留台词/动作组，最多补1个接棒镜。
  let count = Math.min(6, base + 1);
  if (estimated > 32 && estimated <= 42) count = Math.min(7, Math.max(count, base));
  else if (estimated > 42) count = Math.min(8, Math.max(count, base));
  return Math.max(4, Math.min(8, count));
}

function makeActionGroup(action) {
  return { type: 'action', actionIds: [action.id], actionTexts: [action.text], items: [], duration: 1, baseIds: new Set(), text: action.text };
}
function makeDialogueGroup(p) {
  return {
    type: 'dialogue',
    actionIds: [],
    actionTexts: [],
    items: [{ coverId: p.id, baseId: p.baseId, speaker: p.speaker, state: p.state || '', text: p.text, originalText: p.originalText || p.text, channel: p.channel, voiceMode: p.voiceMode, duration: p.duration, mode: p.mode || '' }],
    // p.duration is already the performable duration for this dialogue segment.
    duration: Math.max(1.2, Math.min(3.8, num(p.duration, 2.2))),
    baseIds: new Set([p.baseId]),
    text: p.text
  };
}
function mergeGroups(a, b) {
  return {
    type: a.type === b.type ? a.type : 'mixed',
    actionIds: [...(a.actionIds || []), ...(b.actionIds || [])],
    actionTexts: [...(a.actionTexts || []), ...(b.actionTexts || [])],
    items: [...(a.items || []), ...(b.items || [])],
    duration: round1(num(a.duration) + num(b.duration)),
    baseIds: new Set([...(a.baseIds || []), ...(b.baseIds || [])]),
    text: [a.text, b.text].filter(Boolean).join(' / ')
  };
}
function mergeScore(a, b) {
  let score = 0;
  const aDialogue = (a.items || []).length > 0;
  const bDialogue = (b.items || []).length > 0;
  if (!aDialogue || !bDialogue) score += 100;
  const sameBase = [...(a.baseIds || [])].some(x => (b.baseIds || new Set()).has(x));
  if (sameBase && num(a.duration) + num(b.duration) > 3.2) score -= 500;
  else if (sameBase && num(a.duration) + num(b.duration) <= 3.2) score += 90;
  const sameSpeaker = a.items?.length && b.items?.length && a.items.every(x => b.items.some(y => y.speaker === x.speaker));
  if (sameSpeaker && num(a.duration) + num(b.duration) <= 3.2) score += 40;
  if (num(a.duration) + num(b.duration) <= 2.8) score += 30;
  if ((a.items || []).some(x => x.voiceMode === 'vo' || x.voiceMode === 'phone' || x.voiceMode === 'os') && bDialogue) score -= 50;
  const diffSpeaker = a.items?.length && b.items?.length && !sameSpeaker;
  if (diffSpeaker && num(a.duration) + num(b.duration) > 3) score -= 80;
  return score;
}
function compactGroups(groups, target) {
  let out = groups.slice();
  while (out.length > target && out.length > 1) {
    let best = { idx: 0, score: -Infinity };
    for (let i = 0; i < out.length - 1; i++) {
      const score = mergeScore(out[i], out[i + 1]);
      if (score > best.score) best = { idx: i, score };
    }
    out.splice(best.idx, 2, mergeGroups(out[best.idx], out[best.idx + 1]));
  }
  return out;
}
function expandGroups(groups, target) {
  const out = groups.slice();
  const joinedText = out.map(g => [g.text, ...(g.actionTexts || []), ...((g.items || []).map(x => x.text || ''))].join(' ')).join(' ');
  // 高潮落点保护：压轴宣告后不能再补弱镜或动作回退镜，宁可把时长并入高潮镜头。
  if (/欢迎来到|新时代/.test(joinedText)) return out;
  // 最多补一个弱镜头：把反应、物件、接棒合成同一个可拍镜，不能连续堆空镜。
  if (out.length < target && !out.some(g => g.type === 'bridge')) {
    out.push({ type: 'bridge', taskHint: '合并反应/物件/下片段接棒，补足15秒但只占一个镜号', items: [], actionIds: [], actionTexts: [], duration: 1.8, baseIds: new Set(), text: '' });
  }
  return out;
}

function buildInitialGroups(scene, segment, expected) {
  const groups = [];
  const actionIdSet = new Set(segment.actionIds || []);
  const dialogueIdSet = new Set(segment.dialogueIds || []);
  const dialogueById = new Map((scene.dialogues || []).map(d => [d.id, d]));
  const partsByBase = new Map();
  for (const p of expected || []) {
    if (!partsByBase.has(p.baseId)) partsByBase.set(p.baseId, []);
    partsByBase.get(p.baseId).push(p);
  }
  const entries = [];
  const segmentDialogueText = (segment.dialogueIds || [])
    .map(id => dialogueById.get(id)?.text || '')
    .join(' ');
  for (const a of scene.actions || []) {
    if (!actionIdSet.has(a.id)) continue;
    const actionText = String(a.text || '');
    // If the transition tail "没关系，我还有别的电话。" starts this segment,
    // the following script action "又按下另外一个号码" is already carried by that
    // dialogue shot. Do not create a second mirror-action shot that repeats dialing.
    if (/没关系|别的电话/.test(segmentDialogueText) && /另外一个号码|按下/.test(actionText)) continue;
    entries.push({ kind: 'action', order: a.order || 0, action: a });
  }
  for (const id of segment.dialogueIds || []) {
    const d = dialogueById.get(id);
    if (d) entries.push({ kind: 'dialogue', order: d.order || 0, dialogue: d });
  }
  entries.sort((a, b) => (a.order || 0) - (b.order || 0) || (a.kind === 'action' ? -1 : 1));
  for (const entry of entries) {
    if (entry.kind === 'action') {
      groups.push(makeActionGroup(entry.action));
    } else {
      // recut bridge: 当关键台词需要接棒动作时，在此生成过渡动作组
      const parts = partsByBase.get(entry.dialogue.id) || [];
      // Keep complete short / medium line together. Only split when timing requires it.
      for (const p of parts) groups.push(makeDialogueGroup(p));
    }
  }
  return groups.length ? groups : [{ type: 'space', items: [], actionIds: [], actionTexts: [], duration: 2, baseIds: new Set(), text: '' }];
}
function shotSizeForGroup(index, group, total) {
  if ((group.actionTexts || []).some(t => /手机|屏幕|汗珠|手指|掉在地上|通话/.test(t)) || group.type === 'insert') return '特写';
  if (index === 0) return '中景';
  if (index === total - 1) return '中景';
  if ((group.items || []).some(x => x.voiceMode === 'vo' || x.voiceMode === 'phone')) return '近景';
  return index % 3 === 0 ? '过肩中近景' : index % 3 === 1 ? '近景' : '中近景';
}
function lensForGroup(index, group, total) {
  const text = [group.text, ...(group.actionTexts || [])].join(' ');
  if (/手机|屏幕|手指|汗珠|落地|裂|通话/.test(text) || group.type === 'insert') return '100mm';
  if (index === 0) return '35mm';
  if (index === total - 1) return '50mm';
  if ((group.items || []).length && index % 2 === 0) return '85mm';
  return index % 3 === 0 ? '50mm' : '85mm';
}
function poeticCarryIndices(total) {
  total = Math.max(1, Number(total || 0));
  if (total <= 1) return [0];
  if (total <= 3) return [0, total - 1];
  if (total === 4) return [0, 1, 3];
  if (total === 5) return [0, 2, 4];
  return [0, 2, total - 2, total - 1];
}
function isPoeticCarryIndex(index, total) {
  return new Set(poeticCarryIndices(total)).has(index);
}
function movementForGroup(index, group, total, visualStyle = 'plain') {
  const text = [group.text, ...(group.actionTexts || [])].join(' ');
  const poetic = visualStyle === 'poetic';
  const carry = poetic && isPoeticCarryIndex(index, total);
  if (poetic) {
    if (index === 0) return carry ? '逆光尘埃压进首镜' : '从关键物件进入';
    if (index === total - 1) return carry ? '反应和光线一起压到落点' : '反应留在当前镜头里';
    if (/手机|屏幕|手指|落地|通话/.test(text) || group.type === 'insert') return carry ? '关键物件在柔焦里接棒' : '关键物件接到下一步动作';
    return carry ? '人物被光影和关系同时压住' : '人物动作接到下一句台词';
  }
  if (index === 0) return '从关键物件进入状态';
  if (index === total - 1) return '落点反应并入本镜';
  if (/手机|屏幕|手指|落地|通话/.test(text) || group.type === 'insert') return '物件状态推动关系变化';
  return '状态推进到台词落点';
}
function taskForGroup(group, index, total) {
  if ((group.items || []).length) {
    const ids = group.items.map(x => x.coverId).join('、');
    const names = [...new Set(group.items.map(x => x.speaker))].join('、');
    return `${ids} 表演因果承载；${names}的声音归属锁定，必须写出说话者状态、原台词作用对象和可见变化`;
  }
  if ((group.actionTexts || []).length) return `动作承载：${group.actionTexts.join(' / ')}`;
  return group.taskHint || (index === 0 ? '建立空间关系和片段起点' : index === total - 1 ? '关系变化与下片段接棒' : '补足可见关系变化');
}
function durationCapForGroup(g) {
  const text = [g.text, ...(g.actionTexts || [])].join(' ');
  // recut: 禁止把单个VO/纯反应镜硬拉到5秒以上。超过4秒必须有两段以上台词或明确动作递进。
  if ((g.items || []).length) {
    const hasMulti = (g.items || []).length >= 2 || /没开玩笑.*总之|安全地方.*世界乱套|私人电话.*一定能打通|欢迎来到|新时代/.test(text);
    return hasMulti ? 4.4 : 3.8;
  }
  if ((g.actionTexts || []).length) return /短视频|举起|屏幕朝向|手机落地|掉在地上/.test(text) ? 3.4 : 2.8;
  return 2.4;
}
function durationFloorForGroup(g) {
  if ((g.items || []).length) return 1.2;
  if ((g.actionTexts || []).length) return 1.2;
  return 1.4;
}
function distributeDurations(groups, segment) {
  // 除最后一片段由上游明确允许实际收尾外，常规文戏片段必须填满15秒。
  const total = 15;
  const base = groups.map(g => Math.max(durationFloorForGroup(g), Math.min(durationCapForGroup(g), num(g.duration, 2))));
  const sum = base.reduce((a, b) => a + b, 0) || groups.length * 2;
  let vals = base.map((x, i) => Math.max(durationFloorForGroup(groups[i]), Math.min(durationCapForGroup(groups[i]), round1(x * total / sum))));
  let diff = round1(total - vals.reduce((a, b) => a + b, 0));
  // 先把余量分给有台词镜头，再给强动作镜头，最后才给唯一接棒镜。
  const order = groups.map((g, i) => ({ i, score: (g.items || []).length ? 3 : (g.actionTexts || []).length ? 2 : 1 }))
    .sort((a, b) => b.score - a.score || a.i - b.i).map(x => x.i);
  let guard = 0;
  while (Math.abs(diff) >= 0.1 && guard++ < 200) {
    let changed = false;
    for (const i of order) {
      if (diff >= 0.1) {
        const cap = durationCapForGroup(groups[i]);
        if (vals[i] + 0.1 <= cap) { vals[i] = round1(vals[i] + 0.1); diff = round1(diff - 0.1); changed = true; }
      } else if (diff <= -0.1) {
        const floor = durationFloorForGroup(groups[i]);
        if (vals[i] - 0.1 >= floor) { vals[i] = round1(vals[i] - 0.1); diff = round1(diff + 0.1); changed = true; }
      }
      if (Math.abs(diff) < 0.1) break;
    }
    if (!changed) break;
  }
  if (Math.abs(diff) >= 0.1 && vals.length) vals[vals.length - 1] = round1(vals[vals.length - 1] + diff);
  return vals.map(v => `${round1(v)}s`);
}

function getDefaultCast(scene) {
  if (scene.cast && scene.cast.length) return scene.cast;
  return ['角色A', '角色B', '角色C'];
}
function inferPreviousFrame(scene, segment) {
  const cast = getDefaultCast(scene);
  if (!segment || /A$/.test(segment.id || '')) {
    return `${cast[0] || '主角'}站在场景中央，等待某事发生，${cast.slice(1).join('、') || '其他人物'}在旁边观察。`;
  }
  return '上一段末帧的动作和接棒物保持可见，本段从该接棒物的相反景别或角度进入。';
}
function inferFirstFramePlan(scene, segment) {
  return '本片段第一镜从上一段接棒物进入，景别或视角必须和上一段末镜不同。';
}
function inferPositions(scene, segment) {
  const cast = getDefaultCast(scene);
  const main = cast[0] || '主角';
  const secondary = cast[1] || '次要角色';
  const others = cast.slice(2);
  return [
    `${main}：画面中央偏前，承接上一段动作`,
    `${secondary}：${main}侧后方，保持观察距离`,
    ...(others.length ? others.map((c, i) => `${c}：场景边缘位置，${i === 0 ? '保持旁观' : '外围观察'}`) : [])
  ];
}
function inferStates(scene, segment) {
  const cast = getDefaultCast(scene);
  const main = cast[0] || '主角';
  const secondary = cast[1] || '次要角色';
  const others = cast.slice(2);
  return [
    `${main}：承接上一段动作结果，保持当前状态`,
    `${secondary}：观察${main}，等待进一步发展`,
    ...(others.length ? others.map(c => `${c}：保持旁观或外围观察`) : [])
  ];
}
function cleanupChinesePunctuation(text) {
  return String(text || '')
    .replace(/，\s*。/g, '。')
    .replace(/。\s*。+/g, '。')
    .replace(/，\s*，+/g, '，')
    .replace(/\s+([，。！？；：])/g, '$1')
    .replace(/([，。！？；：])\s+/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstFrameDirectivesFromState(startingState) {
  const ff = startingState && startingState.firstFramePlan ? String(startingState.firstFramePlan) : '';
  if (!ff) return {};
  const directives = {};
  if (/近景/.test(ff)) { directives.shotSize = '近景'; directives.lens = '85mm'; }
  if (/中近景/.test(ff)) { directives.shotSize = '中近景'; directives.lens = '85mm'; }
  if (/特写/.test(ff) || /手部|地面手机|屏幕/.test(ff)) { directives.shotSize = '特写'; directives.lens = '100mm'; }
  if (/中景/.test(ff) && !directives.shotSize) { directives.shotSize = '中景'; directives.lens = '35mm'; }
  if (/手部|掌心|拇指/.test(ff)) directives.movement = '贴着手部缓慢推进';
  else if (/耳侧|贴回耳边|听筒/.test(ff)) directives.movement = '贴近耳侧轻微推进';
  else if (/地面手机|落点/.test(ff)) directives.movement = '从地面手机缓慢上移';
  else if (/举起手机|屏幕朝向/.test(ff)) directives.movement = '跟随举手机动作稳定推进';
  return directives;
}

// v3.1.2: B 的 firstFramePlan 只作为镜1景别/运镜依据，不能原文复制进C正文。
function applyFirstFrameDirectivesToFirstShot(shot, startingState) {
  if (!shot || !startingState) return shot;
  const d = firstFrameDirectivesFromState(startingState);
  const keepPoeticMovement = shot.visualStyle === 'poetic' && /光|雾|尘|柔焦|冷暖|光斑|逆光|前景/.test(String(shot.movement || ''));
  return {
    ...shot,
    shotSize: d.shotSize || shot.shotSize,
    movement: keepPoeticMovement ? shot.movement : (d.movement || shot.movement),
    lens: d.lens || shot.lens
  };
}

function createSegmentSkeleton(scene, segment, costumeCard = '', visualStyle = 'plain') {
  const expected = expectedPartsForSegment(scene, segment);
  const initial = buildInitialGroups(scene, segment, expected);
  const target = chooseShotCount(scene, segment, initial.length);
  let groups = compactGroups(initial, target);
  groups = expandGroups(groups, target);
  const durations = distributeDurations(groups, segment);
  const shots = groups.map((group, idx) => {
    const items = group.items || [];
    const covers = items.map(x => x.coverId);
    return {
      no: idx + 1,
      segmentTitle: segment.title || segment.reason || segment.id,
      duration: durations[idx] || '2s',
      shotSize: shotSizeForGroup(idx, group, groups.length),
      movement: movementForGroup(idx, group, groups.length, visualStyle),
      lens: lensForGroup(idx, group, groups.length),
      task: taskForGroup(group, idx, groups.length),
      covers,
      dialogueLines: items.map(x => ({ coverId: x.coverId, baseId: x.baseId, speaker: x.speaker, state: x.state, text: x.text, originalText: x.originalText || x.text, voiceMode: x.voiceMode, mouthSync: x.voiceMode === 'spoken' || x.voiceMode === 'spoken_split' })),
      actionIds: group.actionIds || [],
      actionTexts: group.actionTexts || [],
      audioMode: items.length ? (items.every(x => x.voiceMode !== 'spoken' && x.voiceMode !== 'spoken_split') ? 'voice_only' : items.some(x => x.voiceMode === 'spoken_split') ? 'spoken_split' : 'spoken') : 'none',
      audioVisualSplit: items.some(x => x.voiceMode === 'spoken_split'),
      visual: '',
      speakerAction: '',
      listenerReaction: '',
      physicalFeedback: '',
      sound: '',
      visualStyle,
      segmentShotCount: groups.length
    };
  });
  return {
    segmentId: segment.id,
    sceneId: scene.id,
    sceneHeader: scene.header || '',
    charactersLine: scene.cast && scene.cast.length ? scene.cast.map(x => '@' + x).join(' ') : '@角色A @角色B @角色C @角色D',
    title: segment.title || segment.reason || segment.id,
    sceneFeeling: segment.reason || '按可拍事件段推进',
    visualStyle,
    physics: defaultPhysics(scene, costumeCard, visualStyle),
    startingState: {
      space: `${scene.header || '场景空间'}。按剧本场景信息组织场面调度底图。`,
      previousLastFrame: segment.prevLastFrame || inferPreviousFrame(scene, segment),
      firstFramePlan: inferFirstFramePlan(scene, segment),
      positions: inferPositions(scene, segment),
      states: inferStates(scene, segment)
    },
    shots,
    soundDesign: '保留真实环境音、电话声、手机提示音、手机屏幕视频原声和物件音；无背景音乐。',
    restrictions: E_FIXED.slice(),
    debugCoverage: expected.map(p => ({ id: p.id, speaker: p.speaker, text: p.text, voiceMode: p.voiceMode }))
  };
}

function stripJsonEnvelope(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s.trim();
}
function extractJsonDetailed(text) {
  const cleaned = stripJsonEnvelope(text);
  try { return { ok: true, cleaned, value: JSON.parse(cleaned) }; }
  catch (e) {
    const m = /position (\d+)/.exec(e.message || '');
    let context = '';
    if (m) {
      const i = Number(m[1]);
      context = cleaned.slice(Math.max(0, i - 120), Math.min(cleaned.length, i + 120));
    }
    return { ok: false, cleaned, error: e.message, context };
  }
}
function extractJson(text) {
  const r = extractJsonDetailed(text);
  if (!r.ok) throw new Error(r.error + (r.context ? '\n附近内容：' + r.context : ''));
  return r.value;
}
function editableFieldsFromShot(shot) {
  return { no: shot.no, visual: shot.visual || '', speakerAction: shot.speakerAction || '', listenerReaction: shot.listenerReaction || '', physicalFeedback: shot.physicalFeedback || '', sound: shot.sound || '' };
}
function sanitizePerformanceText(text) {
  let s = String(text || '').trim();
  const replacements = [
    [/像一个观众在看一段并不意外的小品/g, '安静地看着对方反应'],
    [/等待旧秩序失效/g, '等待结果'],
    [/旧秩序失效/g, '结果未如预期'],
    [/空气变稠了/g, '场景内只剩自然声'],
    [/在听一段有趣的前奏/g, '听着等待音'],
    [/有趣的前奏/g, '等待音'],
    [/被这句话击中/g, '听完这句话后停住'],
    [/被击中/g, '停住'],
    [/视线在([^，。；]+)之间来回移动/g, '先看$1，随后停住'],
    [/视线来回/g, '视线停住'],
    [/手指相互捏着/g, '双手停在身前'],
    [/交叠的手指/g, '停在身前的双手'],
    [/手指绞在一起/g, '双手停在身前'],
    [/攥得更紧/g, '没有再动'],
    [/呼吸变浅/g, '停了一拍'],
    [/呼出的气流在阳光下可见白雾/g, ''],
    [/白雾/g, ''],
    [/咬住自己的指关节/g, '把手放回身侧'],
    [/咬手指/g, '把手放回身侧'],
    [/手按在胸口/g, '手停在身前'],
    [/手按胸口/g, '手停在身前'],
    [/抓住他的袖口/g, '站在原地'],
    [/冷笑加深/g, '没有接话'],
    [/冷笑不变/g, '没有接话'],
    [/眉头/g, '视线'],[/皱眉/g, '停住'],[/震惊地/g, '停住后'],[/震惊/g, '停住'],[/表情凝重/g, '动作放慢'],[/眼神复杂/g, '视线停住'],[/复杂/g, '停住'],[/凝重/g, '放慢'],[/压迫感/g, '距离感'],[/仪式感/g, '停顿'],[/像是/g, ''],[/仿佛/g, ''],[/似乎/g, '']
  ];
  for (const [re, to] of replacements) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim();
}
const PLACEHOLDER_RE = /(当前关系位|台词从这个动作状态里自然说出|听者停住当前动作|把注意力落到说话者身上|旁边人物停在原地|承接上一句台词后的安静|人物关系在当前落点停住|准备接入下一段|画面中没有人物开口|焦点落在听到声音的人和手机上|手机或手部细节作为过渡|补足关系位|模板句|听者保持当前状态|动作未完成|环境声低底噪|环境声保持低底噪|面向对手，把台词说出来|重心随台词节奏轻微移动|下颌肌肉随台词微微抽动|日光在瞳孔里反射出一道冷白光|人物在日光里投下清晰的影子|身体随台词内容有轻微起伏|日光在侧脸切出明暗分界线|人物在日光里投下影子)/g;

// 清理△/▲符号及后续无用文本
function stripDirectingMarks(text) {
  return String(text || '')
    .replace(/[△▲]\s*(特写|近景|中景|全景|远景|Insert|INSERT)?\s*/g, '')
    .replace(/[△▲]/g, '')
    .trim();
}

function cleanTemplateText(text) {
  return sanitizePerformanceText(stripDirectingMarks(String(text || '')).replace(PLACEHOLDER_RE, '').replace(/\s+/g, ' ').trim());
}

function previousConcreteLine(shot) {
  const lines = shot.dialogueLines || [];
  return lines[0] || null;
}

function concreteReaction(shot) {
  const ctx = analyzeShot(shot);
  const { isPhone, isVO, emotion, index, isAlternating } = ctx;
  if (!ctx.text) return '';
  // 电话/VO/OS 通用反应 — 按说话者/场景内容细分
  if (isPhone || isVO) {
    const castCount = (shot.covers || []).length;
    const hasOther = castCount > 1;

    if (emotion === 'shock' || /乱套|愣|呆/.test(ctx.text)) {
      if (hasOther) {
        return isAlternating
          ? '所有人同时僵住，尘埃在光束里静止了一瞬。'
          : '所有人的表情同时僵住，有人手捂到嘴边。';
      }
      return isAlternating
        ? '他僵在原地，嘴张了张没出声。'
        : '他手抬到一半停住，指尖微微发颤。';
    }
    if (emotion === 'alert') {
      return isAlternating
        ? '他手抬到一半停住，向后退半步。'
        : '他下意识往后退了一步，身体绷紧。';
    }
    if (emotion === 'doubt' || /无人接听|忙音/.test(ctx.text)) {
      return hasOther
        ? '旁边的人刷手机的手指停了一下，往这边抬头看了一眼。'
        : '他没有立刻说话，只把屏幕转向自己确认。';
    }
    if (emotion === 'reveal' || /接通|专线/.test(ctx.text)) {
      return hasOther
        ? '他往说话者身边靠了半步，注意力集中在听筒上。'
        : '他的肩膀先绷住，随后身体往前压了一点。';
    }
    return '他握着手机听完，没有打断。';
  }
  // ---- 实际对话反应：按情绪标签 + 镜号轮询，不绑定角色名 ----
  const reactionByEmotion = {
    doubt:    ['对方脚下往后让了一小步，视线被屏幕挡住。', '对方手停在身前，话收到嘴边停住。'],
    absurd:   ['对方没有接话，注意力停在说话者手里的手机上。', '对方嘴角动了一下，话咽回去。'],
    alert:    ['对方下意识往后退半步，眼神开始往周围扫。', '他身体绷紧，话越说越急。'],
    shock:    ['对方脸色发紧，往旁边挪开半步。', '他话收到嘴边停住，胸口起伏了一下。'],
    reject:   ['对方肩膀往后缩，话越说越快。', '对方没有再接话，视线移开。'],
    probe:    ['对方停住，手从口袋里慢慢抽出来。', '对方抬起手想打断，但没有出声。'],
    command:  ['对方下意识往后退了半步，眼神开始往周围扫。', '他身体往前压，等下一句进来。'],
    reveal:   ['对方微微眯眼，像在消化这个信息。', '他视线落在说话者脸上，停了一拍。'],
    neutral:  ['对方手停在半空，眼神往说话者脸上压。', '对方没有接话，视线落在说话者的手上。']
  };
  const pool = reactionByEmotion[emotion]; reactionByEmotion.neutral;
  return pool[index % pool.length];
}

function groundPhoneAvailableForShot(shot) {
  const text = [shot.task, ...(shot.actionTexts || []), ...(shot.dialogueLines || []).map(x => x.text), ...(shot.dialogueLines || []).map(x => x.originalText)].join(' ');
  if (/地上手机|地面手机|脚边的手机/.test(text)) return true;
  if (/落地|掉在地上|滑落|摔在地面|啪的一声/.test(text)) return true;
  return false;
}
function isPoeticCarryShot(shot) {
  const total = Number(shot.segmentShotCount || 0) || Number(shot.no || 1);
  const idx = Math.max(0, Number(shot.no || 1) - 1);
  return isPoeticCarryIndex(idx, total);
}

function concretePhysicalFeedback(shot) {
  const ctx = analyzeShot(shot);
  const { isPoetic, carry, isAlternating, keywords, emotion, vm } = ctx;
  const text = ctx.allText;
  const shotSize = String(shot?.shotSize || '');
  const isClose = /特写|大特写/.test(shotSize);
  const isMedium = /近景|中近景|中景|过肩/.test(shotSize);
  const sceneName = String(shot?.scene || shot?.sceneName || '');
  const isOutdoor = /外|outdoor/.test(sceneName) || keywords.outdoor;
  const isNight = /夜|深夜|凌晨/.test(sceneName);
  const isKitchen = /厨房|厨/.test(sceneName);

  // 使用 hashCode 让同类场景也有差异
  const hash = Math.abs(hashCode(text + shotSize)) % 4;

  if (isPoetic) {
    if (keywords.drop) return carry ? '手机落地，灰尘被震起一点，屏幕裂纹在光下显形。' : '手机落地，屏幕朝上，碎裂声在安静里格外清楚。';
    if (keywords.video) return '屏幕内容清晰，后景略虚，帧率落差让画面有轻微刺激感。';
    if (keywords.phone && !keywords.drop) return '手机光在掌心，冷白光在指缝间隙透出细线。';
    if (ctx.isFirstShot && carry) return '逆光穿过门框，发丝边缘发亮，脸部暗侧细节保留。';
    return carry ? '背景柔和虚化，人物轮廓清晰，呼吸让衬衫领口轻微起伏。' : '光线在侧脸切出明暗线，鼻梁阴影清晰。';
  }

  // 手机/电话场景
  if (keywords.drop) return '手机落地，屏幕朝上，摔裂的玻璃在地面反光。';
  if (keywords.video) return '屏幕像素颗粒在推进中变明显，帧光照亮手持者的指节。';
  if (/拨|按键/.test(text)) return '拇指在屏幕上留下细密指纹印，指腹与玻璃摩擦时轻微发白。';
  if (keywords.sound || vm === 'phone') {
    const variants = [
      '忙音在安静里格外清楚，握手机的指节微微泛白。',
      '额头有细密汗珠，屏幕冷白光在下颌切出明暗线。',
      '手机壳边缘留下汗渍，指尖在壳面无意识地摩挲。',
      '手机贴耳时肩膀不自觉绷紧，呼吸浅且快。'
    ];
    return variants[hash];
  }

  // 情绪物理反馈
  if (emotion === 'shock' || /愣|呆|僵|石化/.test(text)) {
    const variants = [
      '身体僵住，眨眼频率骤降，手臂停在半空。',
      '呼吸在胸口短暂停住，布料一动不动。',
      '汗珠从鬓角滑下，在耳垂悬了一下才落。',
      '手指微微张开又合上，像在确认自己还有知觉。'
    ];
    return variants[hash];
  }
  if (emotion === 'alert' || /慌|急|赶紧/.test(text)) {
    const variants = [
      '呼吸加快，衬衫领口随之快速起伏。',
      '额头汗珠从发际线滑下，在眉弓处短暂停留。',
      '手臂肌肉绷紧，指节在身侧微微发白。',
      '脚跟轻微踮起又落下，重心不稳。'
    ];
    return variants[hash];
  }
  if (emotion === 'doubt' || emotion === 'absurd') {
    const variants = [
      '侧脸明暗分界清晰，鼻梁阴影微微移动。',
      '眼底有光反射，瞳孔在思考时轻微收缩。',
      '嘴唇微抿，嘴角肌肉在抑制某个表情。',
      '眉头拧紧，眉间竖纹在顶灯下投出阴影。'
    ];
    return variants[hash];
  }
  if (/笑|开心|高兴|好耶/.test(text)) {
    const variants = [
      '嘴角肌肉上扬，苹果肌微微隆起，日光在牙齿上反光。',
      '眼角挤出细纹，虹膜反光点随笑意移动。',
      '肩线放松，衣物褶皱在放松后自然重布。',
      '笑时呼气，衬衫胸口处随之轻微起伏。'
    ];
    return variants[hash];
  }
  if (/生气|怒|愤怒|不耐烦/.test(text)) {
    const variants = [
      '咬紧后槽牙，颞肌在侧脸鼓出细小轮廓。',
      '鼻翼扩张，呼气时气流让鼻梁侧面细毛微动。',
      '手指在身侧缓缓攥紧，指节依次泛白。',
      '肩膀上提，让整个身体轮廓变得更宽。'
    ];
    return variants[hash];
  }
  if (/汗/.test(text)) return isAlternating ? '汗珠从发际线滑到鼻梁侧面，在鼻翼折痕处积聚。' : '汗珠从鼻翼滚落，在下巴尖悬住，随说话抖落。';

  // 根据场景环境生成细节
  if (isKitchen) {
    const variants = [
      '油烟灯光从上方打下，人物头顶发亮，面部有暖橙色顶光。',
      '灶台火光在人物侧脸投下跳动的暖光，随火苗大小变化。',
      '厨房蒸汽轻薄地在身后流动，让背景略微漫射。',
      '案板上的水渍在灯光下反光，成为视觉锚点。'
    ];
    return variants[hash];
  }
  if (isOutdoor) {
    const timeVariants = isNight
      ? ['路灯从斜上方打来，在人物肩膀留下硬边阴影。', '夜风让衣物边缘轻微抖动，发梢随之微动。']
      : ['傍晚斜光从侧后方照来，在人物肩线切出金边。', '外景风将衣物吹起一角，布料纹理在逆光里可见。'];
    return timeVariants[hash % 2];
  }

  // 通用 fallback — 根据景别生成差异化物理细节
  if (isClose) {
    const variants = [
      '侧脸明暗线清晰，虹膜里有光源反光点。',
      '皮肤毛孔在强光下隐约可见，鼻尖有细密反光。',
      '呼吸让嘴唇微微湿润，下唇边缘有细小光点。',
      '眼角下方有极轻微的肌肉抽动，不易察觉但存在。'
    ];
    return variants[hash];
  }
  if (isMedium) {
    const variants = [
      '衣物褶皱在动作后自然重布，布料纤维在光下有细微光泽。',
      '呼吸让衬衫领口轻微起伏，锁骨阴影随之变化。',
      '手指在身侧自然放松，指尖在顶灯下有轻微反光。',
      '站定后身体有轻微的重心调整，鞋底在地面有极轻的摩擦。'
    ];
    return variants[hash];
  }
  // 中景/全景
  const wideVariants = [
    '人物投影在地面清晰，随动作实时变形。',
    '背景虚化形成色块，人物轮廓与背景的边界有轻微光晕。',
    '衣物在空间里的比例和质感成为构图要素之一。',
    '环境光在人物侧面补出柔和的轮廓光。'
  ];
  return wideVariants[hash];
}


function isSoundLike(text) {
  return /声音|声|音|听筒|忙音|等待音|提示音|电话|杂音|风声|脚步|衣料|落地|原声|BGM|配乐|静音|留白|抽空|压低/.test(String(text || ''));
}

function concreteSoundDesign(shot) {
  const ctx = analyzeShot(shot);
  const { vm, isPhone, isVO, keywords, emotion, isAlternating } = ctx;
  const text = ctx.allText;
  const shotSize = String(shot?.shotSize || '');
  const isClose = /特写|大特写/.test(shotSize);
  const sceneName = String(shot?.scene || shot?.sceneName || '');
  const isOutdoor = /外|outdoor/.test(sceneName) || keywords.outdoor;
  const isNight = /夜|深夜|凌晨/.test(sceneName);
  const isKitchen = /厨房|厨/.test(sceneName);

  const hash = Math.abs(hashCode(text + (shot?.no || ''))) % 4;

  // 电话/VO类场景
  if (isPhone) {
    if (/忙音|无人接听|系统提示/.test(text)) {
      const v = ['忙音贴近听筒，每声间隔0.5秒，环境声压成底层。',
                 '听筒忙音"嘟—嘟—"，指尖在手机壳上无意识敲击。',
                 '机械系统声清晰，环境底噪被听筒收音压低。',
                 '忙音节奏规律，和紧张的呼吸声形成对比。'];
      return v[hash];
    }
    if (/等待音|接通/.test(text)) return '等待音后接通，声音带电话压缩感，环境声退到底层。';
    const v = ['电话声从场景传出，环境声作底层。',
               '通话声带轻微压缩，户外底噪从缝隙透入。',
               '手机扬声器声音压扁，高频轻微失真。',
               '听筒贴耳，声音定向传出，其他环境声变远。'];
    return v[hash];
  }

  // 旁白/OS
  if (isVO) {
    const v = ['环境声压低，人声旁白盖住底噪，只留轻微室外底层。',
               '画外音沉稳清晰，现场声被压到极低。',
               'VO声音层叠在沉默的画面上，环境声作底。',
               '旁白声平静而清晰，背景声退到意识边缘。'];
    return v[hash];
  }

  // 落地/打击
  if (keywords.drop) {
    const v = ['落地声短促清脆，余响极短，空气随即静止。',
               '重物落地声低沉，碎裂声紧随其后，环境底噪短暂抬起。',
               '落地的撞击声清晰，玻璃微碎声之后是短暂的寂静。',
               '物件碰地的钝响，在安静的场景里格外清楚。'];
    return v[hash];
  }

  // 视频/短视频
  if (keywords.video) {
    return isAlternating
      ? '手机短视频原声压低作底，画面声音呈现混沌感。'
      : '短视频原声微弱，人物说话声覆盖其上。';
  }

  // 拨号/按键
  if (/拨|按键/.test(text)) {
    return isAlternating
      ? '指尖划过屏幕的细微声，接通后呼吸声被压住。'
      : '按键声短促轻柔，手机贴近时环境声收窄。';
  }

  // 厨房场景
  if (isKitchen) {
    const v = ['菜刀剁在案板上的钝响，随后是安静和呼吸声。',
               '炉火低鸣，锅内汤汁轻微翻滚声，人声压在上面。',
               '厨房金属碰撞声清脆，背景有水流声持续。',
               '案板上的操作声实，厨房底噪延绵不断。'];
    return v[hash];
  }

  // 室外/傍晚/夜晚
  if (isOutdoor) {
    if (isNight) {
      const v = ['夜风声低沉持续，远处偶有虫鸣，人声清晰在上层。',
                 '夜晚环境底噪低沉，风声间歇性加强，说话声贴近。',
                 '路灯下虫声和远处车流混合，人声从中透出。',
                 '夜间环境音密集，低频风声包裹人物说话声。'];
      return v[hash];
    }
    const v = ['傍晚风声贴底层，人声按需透出，鸟鸣偶尔从远处掠过。',
               '外景环境音宽广，说话声在风声中清晰定位。',
               '户外底噪包含远处交通声，风声在人物说话时退后。',
               '外景光线变化伴随轻微风声，衣料随风摩擦声轻微可闻。'];
    return v[hash];
  }

  // 情绪对话场景
  if (emotion === 'doubt' || emotion === 'absurd') {
    return isAlternating
      ? '台词压过环境底噪，尾字后有半拍安静。'
      : '室内底噪持续低鸣，人声清晰，尾音后短暂留白。';
  }
  if (emotion === 'command' || emotion === 'reveal') {
    const v = ['人声压住环境底噪，室内反射轻微加重声音质感。',
               '说话声定向清晰，室内空间让人声有轻微混响。',
               '台词声量提高，环境声被人声覆盖。',
               '人声中气十足，室内底噪退至最低层。'];
    return v[hash];
  }
  if (emotion === 'reject') {
    return isAlternating
      ? '台词加快，环境声被情绪化的语速压低。'
      : '说话声紧促，尾字截断，环境底噪短暂浮现。';
  }

  // 按景别定制默认 sound
  if (isClose) {
    const v = ['近距离呼吸声轻微可闻，衣料细微摩擦声在底层。',
               '极近景别下，咽口水声、唇音都略可辨。',
               '特写录音偏近，环境声被压到背景最深处。',
               '人物呼吸声轻微，被环境底噪包裹但清晰。'];
    return v[hash];
  }

  // 通用 fallback — 四种声音描述轮换，不重复
  const defaults = [
    '人声压住室内底噪，脚步声轻微保留。',
    '衣料摩擦声随动作起伏，室内环境低鸣持续。',
    '室内空气音持续，说话声落在空间里有轻微混响。',
    '环境底噪贴底层，人声和动作声分层清晰。'
  ];
  return defaults[hash];
}

function concreteDialogueVisual(line, shot) {
  if (!line) return '';
  const speaker = String(line.speaker || '角色');
  const text = String(line.text || '');
  const vm = line.voiceMode;
  const shotSize = String(shot?.shotSize || '');
  const isClose = /特写|大特写/.test(shotSize);
  const isMedium = /近景|中近景|中景|过肩/.test(shotSize);

  // ① 打电话场景（phone）
  if (vm === 'phone') {
    if (/忙音|无人接听|系统提示/.test(text)) {
      return isClose
        ? `${speaker}听筒紧贴耳朵，指节因握力泛白，屏幕冷白光在下颌切出明暗线。`
        : `${speaker}手握手机停在耳边，身体微微前倾，屏幕反光在脸侧晃动。`;
    }
    return isClose
      ? `${speaker}手机贴耳，嘴唇微动，屏幕冷白光从指缝间渗出。`
      : `${speaker}把手机贴在耳边，一边听一边无意识地用脚尖点地。`;
  }

  // ② VO/OS（画面无人开口）
  if (vm === 'vo' || vm === 'os') {
    if (/内心独白|OS/.test(text)) {
      return isClose
        ? `${speaker}嘴唇紧闭，视线投向虚空某点，面部肌肉随VO内容微微变化。`
        : `${speaker}站在原地，目光落在远处，身体随VO节奏有轻微呼吸起伏。`;
    }
    return isClose
      ? `${speaker}嘴唇微张又合上，日光在虹膜上打出一圈光斑。`
      : `${speaker}站在原地，衣服被风吹动一角，画面中无人开口。`;
  }

  // ③ 根据台词情绪生成 UNIQUE 动作描述（不用万能模板）
  // ③-1 震惊 / 不敢相信
  if (/震惊|不敢相信|天哪|怎么会|完了|乱套/.test(text)) {
    return isClose
      ? `${speaker}瞳孔骤然放大，嘴微张，舌尖抵住上颚停住。`
      : `${speaker}身体僵住，肩部线条突然绷紧，重心往后挪了半步。`;
  }

  // ③-2 愤怒 / 激动
  if (/不可能|怎么.*怎么会|傻子|荒唐|玩笑|假|骗|生气|愤怒|怒|混蛋|该死/.test(text)) {
    return isClose
      ? `${speaker}咬一下后槽牙，眉间挤出一道竖纹，鼻孔微微张大。`
      : `${speaker}一只手在空中挥了一下，身体重心往前压，声音提高。`;
  }

  // ③-3 焦急 / 催促
  if (/赶紧|快|立刻|马上|快点/.test(text)) {
    return isClose
      ? `${speaker}语速加快，喉结上下滚动一次，空闲的手在腿侧攥紧。`
      : `${speaker}身体前倾，手势跟着台词节奏加强，肩膀微微抬起。`;
  }

  // ③-4 恐惧 / 犹豫
  if (/怕|害怕|不敢|犹豫|担心|忧/.test(text)) {
    return isClose
      ? `${speaker}视线往下躲了一下，舔一下嘴唇，下颌肌肉绷紧。`
      : `${speaker}重心往后移了半步，一只手无意识地摸向手臂。`;
  }

  // ③-5 开心 / 轻松
  if (/好耶|哈哈|开心|高兴|谢/.test(text)) {
    return isClose
      ? `${speaker}嘴角肌肉上扬，眼角挤出细纹，日光在牙齿上反光。`
      : `${speaker}肩膀放松下来，一只手自然地在身侧比划一下。`;
  }

  // ③-6  generic 台词——根据景别生成有差异的描述（不再用万能句）
  if (isClose) {
    // 特写：聚焦面部微表情 + 光线在脸上的变化
    const actions = [
      `${speaker}嘴唇张开，下颌线条随台词微微绷紧。`,
      `${speaker}眨眼频率降低，目光锁定对手，下颌肌肉抽动。`,
      `${speaker}舌尖顶一下后槽牙，喉结上下滚动。`,
      `${speaker}鼻翼微微扩张，吸一口气再开口。`
    ];
    return actions[Math.abs(hashCode(speaker + text)) % actions.length];
  }

  if (isMedium) {
    // 近景/中近景：身体动作 + 重心变化
    const actions = [
      `${speaker}身体随台词内容微微前倾，重心从一只脚换到另一只。`,
      `${speaker}一只手在空中比划，配合台词节奏，衣服随动作起皱。`,
      `${speaker}说完后嘴角抿一下，视线从对手脸上移到别处半秒。`,
      `${speaker}脚跟微微踮起又落下，身体跟着台词节奏有起伏。`
    ];
    return actions[Math.abs(hashCode(speaker + text)) % actions.length];
  }

  // ③-7 全景/远景：整体姿态
  return `${speaker}站在${shot?.position || '画面中央'}，重心随台词节奏轻微移动，衣服在风中或呼吸中微微鼓动。`;
}

// 简单的字符串哈希函数（用于从字符串生成稳定随机数）
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}

function concreteActionVisual(actionText, shot) {
  const text = String(actionText || '').trim();
  if (!text) return '';

  const shotSize = String(shot?.shotSize || '');
  const lens = String(shot?.lens || '');
  const movement = String(shot?.movement || '');
  const isClose = /特写|大特写/.test(shotSize);
  const isMedium = /近景|中近景|中景|过肩/.test(shotSize);
  const isWide = /全景|远景|大远景/.test(shotSize);

  // 根据动作文本中的关键词，生成有差异的视觉描述
  // 用简单哈希让同一类的不同输入也有差异
  const hash = Math.abs(hashCode(text + (shot?.position || ''))) % 3;

  // 1. 使用手机 / 打电话
  if (/手机|电话|听筒|按键|拨号|短信|消息/.test(text)) {
    const variants = [
      `掏出手机，屏幕亮起，冷白光从指缝间渗出来，`,
      `拇指在屏幕上滑动，指甲在玻璃表面发出极轻的摩擦声，`,
      `把手机贴在耳边，肩膀微微绷紧，听筒紧贴耳廓，`
    ];
    let desc = variants[hash];
    if (/忙音|无人接听/.test(text)) desc += `听筒里传来机械女声"您拨打的电话暂时无人接听"，`;
    if (isClose) desc += `指节因握力泛白，屏幕反光在下颌切出一道冷白光痕。`;
    else desc += `身体重心随通话内容轻微前后移动。`;
    return desc;
  }

  // 2. 行走 / 移动
  if (/走|前进|跟|追|跑|冲/.test(text)) {
    const variants = [
      `前脚掌先落地，身体重心往前压，衣物随步伐轻微鼓动，`,
      `步幅加快，鞋底在地面发出急促的摩擦声，视线锁定前方某点，`,
      `身体前倾，手臂自然摆动，衣服褶皱随动作实时变化，`
    ];
    return variants[hash] + (isClose ? `汗珠从鬓角滑下，在日光里反光。` : `背影在日光里逐渐拉长。`);
  }
  if (/退|后退|躲|缩/.test(text)) {
    const variants = [
      `脚后跟先落地，身体重心往后移，视线始终盯住前方，`,
      `后退时背部肌肉绷紧，一只手在身侧微微张开保持平衡，`,
      `退到墙边停住，肩胛骨抵住墙面， breathing 加快，`
    ];
    return variants[hash];
  }

  // 3. 转身 / 改变朝向
  if (/转身|转头|回头|扭/.test(text)) {
    const variants = [
      `以脊柱为轴转动肩线，下巴先动，视线随转身方向扫过，`,
      `颈部肌肉先绷紧，头部转动时带动肩膀微微跟进，`,
      `鞋底在地面碾转半圈，膝盖随之微调方向，`
    ];
    return variants[hash] + (isClose ? `瞳孔随转身方向快速移动。` : `衣物下摆随转身甩出一道弧线。`);
  }

  // 4. 站立 / 静止但有机
  if (/站|立|停|定格/.test(text)) {
    const variants = [
      `重心落在一只脚上，另一只脚尖微微点地，身体有极轻的前后晃动，`,
      `站在原地，呼吸让衬衫领口有细微起伏，视线落在前方某点，`,
      `身体定格，但手指在身侧有极轻微的开合动作，`
    ];
    return variants[hash] + (isClose ? `虹膜在日光里微微收缩。` : `衣服在微风里轻轻鼓动。`);
  }

  // 5. 坐下 / 起立
  if (/坐|蹲|跪|趴/.test(text)) {
    return `膝盖先弯，重心下移，布料在关节处挤出褶皱，坐实后身体微微弹了一下适应。`;
  }
  if (/起|站起|起来/.test(text)) {
    return `腿部肌肉发力，重心从臀部转移到双脚，上身先起，头部最后跟上。`;
  }

  // 6. 手持物件 / 操作物件
  if (/拿|握|持|抓|捏|提|举/.test(text)) {
    const variants = [
      `手指收紧物件表面，指节因握力微微泛白，`,
      `拇指在物件表面摩挲一下，感受材质纹理，`,
      `物件在掌心转正，反光在表面流动，`
    ];
    return variants[hash] + (isClose ? `指甲盖在强光下有微弱反光。` : `物件在画面里成为视觉锚点。`);
  }

  // 7. 情绪动作（愣/僵/笑/哭）
  if (/愣|呆|僵|呆住|怔|石化/.test(text)) {
    return isClose
      ? `瞳孔骤然放大，眨眼频率骤降，嘴微张，舌尖抵住上颚。`
      : `身体像被钉在原地，手臂停在半空，指尖微微发颤。`;
  }
  if (/笑|微笑|嘴角|乐/.test(text)) {
    return isClose
      ? `嘴角肌肉上扬，眼角挤出细纹，日光在牙齿上反光。`
      : `肩线放松，身体姿态打开，重心从一只脚换到另一只。`;
  }
  if (/哭|泪|泣|抽泣/.test(text)) {
    return isClose
      ? `眼眶迅速泛红，一滴泪从眼角滑下，在下巴边缘悬停。`
      : `肩膀微微抽动，呼吸变得短促，手臂抬起到脸部附近又放下。`;
  }

  // 8. 通用 fallback：根据镜头参数生成有差异的描述
  const fallbacks = [
    `${text}，身体随动作有轻微重心转移，衣物褶皱实时变化，`,
    `${text}，动作完成后在画面里短暂停顿，等待下一指令，`,
    `${text}，镜头捕捉到动作过程中的肌肉张力和释放，`
  ];
  let desc = fallbacks[hash];
  if (isClose) desc += `背景虚化成色块，焦平面锁定在眼部。`;
  else if (isMedium) desc += `人物占画面一半，背景细节依稀可辨。`;
  else if (isWide) desc += `人物在画面中成为叙事元素之一，环境给出足够的上下文。`;
  if (/推进|推镜/.test(movement)) desc += `镜前推进时焦平面逐渐收紧。`;
  if (/手持/.test(movement)) desc += `呼吸造成轻微画面抖动。`;
  return desc;
}

// 语义 fallback 生成器 — 用上下文语义推断，不硬编码具体场景
// 策略：从台词内容、情绪、场景类型三个维度推断，生成1句具体动作描述
function buildSemanticFallback(shot, reason) {
  const ctx = analyzeShot(shot);
  const { emotion, keywords, isPhone, isVO, allText } = ctx;
  const firstLine = (shot.dialogueLines || [])[0];
  const lineText = firstLine ? String(firstLine.text || '') : '';
  const speaker = firstLine ? String(firstLine.speaker || '角色') : '角色';

  // 第一层：从台词情绪推断身体反应
  if (/不可能|怎么.*怎么会|荒唐|玩笑|假/.test(lineText)) {
    return `${speaker}话到嘴边又咽回去，声音发虚。`;
  }
  if (/不可能|怎么可能|怎么/.test(lineText)) {
    return `${speaker}身体略绷，不自觉地往后退了半步。`;
  }
  if (/震惊|不敢相信|天哪|怎么会|完了/.test(lineText)) {
    return `${speaker}身体僵住，嘴张了张没出声。`;
  }
  if (/赶紧|快|立刻|马上/.test(lineText)) {
    return `${speaker}身体前倾，话越说越急。`;
  }
  if (/忙音|无人接听|系统提示/.test(lineText)) {
    return `${speaker}手握手机停在耳边，身体僵住。`;
  }

  // 第二层：从情绪标签推断
  if (emotion === 'shock') return `${speaker}身体僵在原地，视线停在虚空中某处。`;
  if (emotion === 'alert') return `${speaker}身体重心前移，话说到一半突然停住。`;
  if (emotion === 'command') return `${speaker}手掌张开向下压，身体站得更直。`;

  // 第三层：从场景关键词推断
  if (keywords.phone) return `${speaker}把手机从耳边放下，屏幕光暗下去。`;
  if (keywords.video) return `${speaker}视线落在手机屏幕上，指尖悬在屏幕上方。`;

  // 第四层：通用 fallback — 描述画面构图而非模板动作
  if (reason === 'empty') {
    return `${speaker}站在画面中，视线随台词内容自然转向。`;
  }
  return `${speaker}面向镜头，身体随台词内容有自然的起伏变化。`;
}

function concreteFillerVisual(shot) {
  // 已迁移到 buildSemanticFallback，保留空壳避免其他调用方报错
  return buildSemanticFallback(shot, 'empty');
}

function fallbackVisual(shot) {
  const action = (shot.actionTexts || []).filter(Boolean).join(' ');
  const line = (shot.dialogueLines || [])[0];
  if (action) return concreteActionVisual(action, shot);
  if (line) return concreteDialogueVisual(line, shot);
  if (/听者独立反应|关键物件|手部INSERT|INSERT|余震|接棒/.test(shot.task || '')) return concreteFillerVisual(shot);
  if (shot.task && !/台词承载|动作承载/.test(shot.task)) return cleanTemplateText(shot.task);
  return '人物在画面中自然站立，日光从侧前方打来，等待下一步动作指令。';
}
function fallbackListenerReaction(shot) {
  if (!Array.isArray(shot.covers) || !shot.covers.length) return '';
  return concreteReaction(shot);
}
function fallbackSpeakerAction(shot) { return ''; }
function fallbackPhysicalFeedback(shot) { return concretePhysicalFeedback(shot); }
function fallbackSound(shot) { return concreteSoundDesign(shot); }
function mergeWithSkeleton(modelObj, skeleton) {
  const obj = modelObj && typeof modelObj === 'object' ? modelObj : {};
  const modelShots = Array.isArray(obj.shots) ? obj.shots : [];
  const byNo = new Map(modelShots.map(st => [Number(st.no), st]));
  const mergedShots = skeleton.shots.map((fixed, idx) => {
    const model = byNo.get(Number(fixed.no)) || modelShots[idx] || {};
    const fixedWithFirstFrame = idx === 0 ? applyFirstFrameDirectivesToFirstShot(fixed, skeleton.startingState) : fixed;
    const rawVisual = cleanTemplateText(model.visual || fallbackVisual(fixedWithFirstFrame));
    return {
      ...fixedWithFirstFrame,
      visual: cleanupChinesePunctuation(cleanTemplateText(rawVisual)),
      speakerAction: cleanupChinesePunctuation(cleanTemplateText(model.speakerAction || fallbackSpeakerAction(fixedWithFirstFrame))),
      listenerReaction: cleanupChinesePunctuation(cleanTemplateText(model.listenerReaction || fallbackListenerReaction(fixedWithFirstFrame))),
      physicalFeedback: cleanupChinesePunctuation(cleanTemplateText(model.physicalFeedback || fallbackPhysicalFeedback(fixedWithFirstFrame))),
      sound: cleanupChinesePunctuation(cleanTemplateText(model.sound || fallbackSound(fixedWithFirstFrame)))
    };
  });
  return { ...skeleton, title: skeleton.title, sceneFeeling: skeleton.sceneFeeling, soundDesign: skeleton.soundDesign, restrictions: E_FIXED.slice(), shots: mergedShots };
}

function extractSceneKeywords(scene, segment) {
  const header = String(scene.header || '');
  const texts = [
    ...(scene.dialogues || []).filter(d => (segment.dialogueIds || []).includes(d.id)).map(d => d.text + ' ' + (d.state || '')),
    ...(scene.actions || []).filter(a => (segment.actionIds || []).includes(a.id)).map(a => a.text),
    String(segment.reason || '')
  ].join(' ');
  const emotion = [];
  const objects = [];
  const atmosphere = [];
  const location = [];
  // 情绪基调
  if (/愤怒|怒|爆发|冲突/.test(texts)) emotion.push('愤怒冲突');
  else if (/悲伤|哭|痛/.test(texts)) emotion.push('悲痛压抑');
  else if (/震惊|呆|僵|不敢相信/.test(texts)) emotion.push('震惊冲击');
  else if (/质疑|反问|怎么可能/.test(texts)) emotion.push('质疑防御');
  else if (/温柔|安慰|关心/.test(texts)) emotion.push('温柔克制');
  else if (/紧张|危急|快|赶紧/.test(texts)) emotion.push('紧张急迫');
  // 关键物件
  if (/手机|屏幕|通话|电话/.test(texts)) objects.push('手机');
  if (/文件|合同|证据|照片/.test(texts)) objects.push('文件/证据');
  if (/枪|刀|武器/.test(texts)) objects.push('武器');
  // 地点
  if (/院子|院落|祖宅|旧宅/.test(header)) location.push('院落旧宅');
  else if (/室内|房间|客厅/.test(header)) location.push('室内');
  else if (/户外|街道|广场/.test(header)) location.push('户外');
  // 氛围
  if (/日|白天/.test(header)) atmosphere.push('白天自然光');
  else if (/夜|晚/.test(header)) atmosphere.push('夜间');
  else if (/黄昏|傍晚/.test(header)) atmosphere.push('黄昏');
  return { emotion, objects, atmosphere, location };
}

function buildSegmentJsonUser({ manifest, scene, segment, annotatedScript = '', costumeCard = '', forbiddenTerms = [], visualStyle = 'plain' }) {
  const skeleton = createSegmentSkeleton(scene, segment, costumeCard, visualStyle);
  const allowed = [];
  for (const id of segment.actionIds || []) {
    const a = (scene.actions || []).find(x => x.id === id);
    if (a) allowed.push(`${a.id} 动作：${a.text}`);
  }
  for (const id of segment.dialogueIds || []) {
    const d = (scene.dialogues || []).find(x => x.id === id);
    if (d) allowed.push(`${d.id} 台词：${d.speaker}${d.state ? '（' + d.state + '）' : ''}：${d.text}`);
  }
  // 提取场景关键词
  const keywords = extractSceneKeywords(scene, segment);
  const keywordHint = keywords.emotion.length || keywords.objects.length || keywords.atmosphere.length
    ? `\n【场景关键词参考】${keywords.emotion.length ? '情绪基调：' + keywords.emotion.join('→') + '。' : ''}${keywords.objects.length ? '关键物件：' + keywords.objects.join('、') + '。' : ''}${keywords.atmosphere.length ? '氛围：' + keywords.atmosphere.join('、') + '。' : ''}${keywords.location.length ? '地点：' + keywords.location.join('、') + '。' : ''}`
    : '';
  return [
    '【AGENT_C v3.1.3-recut参考质量模式】只输出合法JSON对象，不要Markdown。',
    '程序已经锁定片段、镜头数、台词、说话人、A画面物理系统和E限制。',
    '你只能为每个镜头填写 visual、listenerReaction、physicalFeedback、sound；不要写台词原文，不要写D编号，不要新增剧情。',
    '正式输出会由程序从台词账本插入台词，因此你的visual里严禁出现任何引号台词。' + keywordHint,
    '【当前片段唯一允许素材】',
    allowed.join('\n') || '无台词动作段',
    '【固定骨架】',
    safeJsonStringify({ ...skeleton, shots: skeleton.shots.map(editableFieldsFromShot), debugCoverage: undefined }),
    '【视觉写作规范——参考质量标准】\n' +
    '写作前先理解本镜上下文：①谁在说话？情绪是什么（从台词语气/标点判断）？②听者是谁？和说话人是什么关系（权力/亲密/对立）？③本镜发生了什么变化（不要重复上一镜的动作）？\n' +
    '每个镜头按以下规则写visual（合并式：有台词时visual+台词合并成一句）：\n' +
    '【有台词的镜】visual原则：先写1-2个具体身体细节或物件细节（紧扣本镜情绪，不要套用其他镜的动作），再写"开口/说出下一句"。禁止写情绪形容词（紧张、愤怒、悲伤），只写外部可见动作。例如：\n' +
    '  好："他攥紧手指，指甲陷进掌心，嘴张了张，没声，接着开口"\n' +
    '  好："她把手机从耳边拿下来，屏幕还亮着，视线移开又回来，喉结滚动，开口"\n' +
    '  坏："主角紧张地打完电话"（太概括，禁止）\n' +
    '  坏："听者保持当前状态"（模板句，禁止）\n' +
    '【无台词的镜】visual原则：写动作引发的状态变化，要有因果（不要只写静止状态）。每镜动作必须不同，反映本镜独有的事件。例如：\n' +
    '  好："手机从掌心滑落，在空中翻转半圈，屏幕朝下砸向地面，灰尘被震起"\n' +
    '  好："他站在原地，视线从地面移到门框，肩膀微微抬起"\n' +
    '  坏："人物状态压抑"（空洞描述，禁止）\n' +
    '【physicalFeedback规范】只写本镜头可见的物理细节（布料褶皱、光线变化、汗液、指纹等），与visual的动作描写区分开。例如：\n' +
    '  好："汗珠沿太阳穴滑到下颌，在下颌尖悬了一瞬"\n' +
    '  好："日光从他身后照过来，头发丝边缘发亮"\n' +
    '  好："手机落地，屏幕没碎，光照出他指节上的旧伤疤"\n' +
    '  好："推进时能看到他毛孔和胡茬的质感"\n' +
    '【sound规范】只写当前镜头声音，紧扣画面动作，不要复用同一句声音描写。例如：\n' +
    '  好："忙音嘟——嘟——，一声比一声干涩"\n' +
    '  好："按键声急促密集，指甲敲在玻璃屏幕上发出轻脆声响"\n' +
    '  好："呼吸声加重，喉结滚动的声音在安静里格外清楚"\n' +
    '  好："风声从院墙外灌进来，穿过树叶沙沙响"\n' +
    '  坏："环境声低底噪"（禁止模板句）\n' +
    '【listenerReaction规范】写对方具体反应（微表情、微动作、身体姿态变化），不能只写"看向"或"停住"。反应要符合本镜情绪和人物关系。例如：\n' +
    '  好："旁边的人捂住嘴，另一个人在画面边缘瞪大眼睛手机差点掉"\n' +
    '  好："对方话到嘴边又咽回去，胸口起伏了一下"\n' +
    '  坏："听者保持当前状态，动作未完成"（禁止）\n' +
    '【禁止项】严禁"听者保持当前状态"、"动作未完成"、"环境声低底噪"、"环境声保持低底噪"、"环境声低底噪，衣料和脚步声按动作轻保留"等模板句；禁止空洞描述如"人物状态紧张"、"气氛压抑"；禁止超出A物理系统范围的光影描写；不得输出analysis、scene_plan、规划表。\n\n' +
    '【C括号声音规则】正式输出中每镜括号只放 sound：只写当前镜头声音设计，例如电话声、忙音、提示音、物件音、脚步、衣料、风声、短视频原声、短暂静音、声场远近或压低处理。禁止在括号里写视觉补充、表演解释；禁止每镜复读同一句声音模板；禁止写"环境声低底噪"、"环境声保持低底噪"、"环境声低底噪，衣料和脚步声按动作轻保留"等通用模板句。\n\n【禁止】不得使用当前片段以外的台词或动作；不得输出analysis、scene_plan、规划表、模板句；不得在visual/listenerReaction字段中使用"听者保持当前状态"、"动作未完成"等禁止句。'
  ].join('\n\n');
}

function flattenStrings(obj) {
  const out = [];
  (function walk(x) { if (x == null) return; if (typeof x === 'string') out.push(x); else if (Array.isArray(x)) x.forEach(walk); else if (typeof x === 'object') Object.values(x).forEach(walk); })(obj);
  return out.join('\n');
}
function findDialogueLineForCover(shot, coverId) {
  return (shot.dialogueLines || []).find(x => x.coverId === coverId) || null;
}
function validateSegmentJson(scene, segment, obj, opts = {}) {
  const expected = expectedPartsForSegment(scene, segment);
  const errors = { parseErrors: [], missingCovers: [], duplicateCovers: [], speakerErrors: [], lineErrors: [], voErrors: [], soundPictureErrors: [], listenerErrors: [], expressionErrors: [], sourceErrors: [], motionErrors: [], focalErrors: [], eErrors: [] };
  if (!obj || typeof obj !== 'object') { errors.parseErrors.push('不是JSON对象'); return { ok: false, errors }; }
  const shots = Array.isArray(obj.shots) ? obj.shots : [];
  if (!shots.length) errors.parseErrors.push('shots为空');
  const coverMap = new Map();
  for (const shot of shots) {
    const covers = Array.isArray(shot.covers) ? shot.covers : [];
    for (const id of covers) coverMap.set(id, [...(coverMap.get(id) || []), shot]);
    if (!shot.lens || !/^\d+mm$/.test(String(shot.lens))) errors.focalErrors.push(`镜${shot.no || '?'}缺少合格lens`);
    if (!shot.movement) errors.motionErrors.push(`镜${shot.no || '?'}缺movement`);
    if (covers.length) {
      if (!String(shot.listenerReaction || '').trim()) errors.listenerErrors.push(`镜${shot.no || '?'}有台词/VO但缺listenerReaction`);
      if (!String(shot.speakerAction || '').trim() && String(shot.audioMode || '') !== 'voice_only') errors.listenerErrors.push(`镜${shot.no || '?'}有角色台词但缺speakerAction`);
    }
  }
  for (const p of expected) {
    const hits = coverMap.get(p.id) || [];
    if (!hits.length) errors.missingCovers.push({ id: p.id, speaker: p.speaker, text: p.text });
    if (hits.length > 1) errors.duplicateCovers.push({ id: p.id, count: hits.length });
    for (const shot of hits) {
      const dl = findDialogueLineForCover(shot, p.id) || shot;
      const speaker = String(dl.speaker || shot.speaker || '').trim();
      const line = String(dl.text || shot.line || '').trim();
      if (speaker && norm(speaker) !== norm(p.speaker) && !(p.voiceMode === 'vo' || p.voiceMode === 'phone' || p.voiceMode === 'os')) errors.speakerErrors.push({ id: p.id, expected: p.speaker, got: speaker });
      if (!includesLoose(line, p.text)) errors.lineErrors.push({ id: p.id, expected: p.text, got: line });
      if (p.voiceMode === 'vo' || p.voiceMode === 'phone' || p.voiceMode === 'os') {
        const textAround = [shot.visual, shot.speakerAction, shot.listenerReaction].join('\n');
        if (dl.mouthSync === true) errors.voErrors.push({ id: p.id, reason: 'VO/电话/OS被标记为需要对嘴' });
        if (/开口说|画内对嘴|对嘴/.test(textAround)) errors.voErrors.push({ id: p.id, reason: 'VO/电话/OS被写成画内对嘴/角色开口' });
      }
      if (p.mustUseAudioVisualSplit && !shot.audioVisualSplit && !/spoken_split|声画/.test(String(shot.audioMode || ''))) errors.soundPictureErrors.push({ id: p.id, reason: '要求声画分离但shot未标记' });
    }
  }
  const allText = flattenStrings(obj);
  for (const term of [...EXPRESSION_BLACKLIST, ...(opts.expressionBlacklist || [])]) {
    const re = new RegExp(term, 'g');
    const count = (allText.match(re) || []).length;
    if (count) errors.expressionErrors.push(`${term}×${count}`);
  }
  for (const term of [...HARD_SOURCE_BLACKLIST, ...(opts.forbiddenTerms || [])].filter(Boolean)) {
    const re = new RegExp(escapeRegExp(term), 'g');
    const count = (allText.match(re) || []).length;
    if (count) errors.sourceErrors.push(`${term}×${count}`);
  }
  if (PLACEHOLDER_RE.test(allText)) errors.sourceErrors.push('正式输出含模板占位句');
  PLACEHOLDER_RE.lastIndex = 0;
  if (/日/.test(scene.header || '') && /黄昏|暮色|夜色/.test(allText)) errors.sourceErrors.push('原文日外被改成黄昏/暮色/夜色');
  const restrictions = Array.isArray(obj.restrictions) ? obj.restrictions.join('\n') : String(obj.restrictions || '');
  for (const e of E_FIXED) if (!restrictions.includes(e)) errors.eErrors.push(`缺E固定项：${e}`);
  const fatalKeys = ['parseErrors', 'missingCovers', 'duplicateCovers', 'speakerErrors', 'lineErrors', 'voErrors', 'sourceErrors'];
  const warningKeys = ['soundPictureErrors', 'listenerErrors', 'expressionErrors', 'motionErrors', 'focalErrors', 'eErrors'];
  const fatalCount = fatalKeys.reduce((n, k) => n + ((errors[k] || []).length), 0);
  const warningCount = warningKeys.reduce((n, k) => n + ((errors[k] || []).length), 0);
  return { ok: fatalCount === 0, errors, fatalCount, warningCount, fatalKeys, warningKeys };
}
function summarizeStructuredReport(report) {
  const e = report.errors || report;
  const fatal = [];
  const warn = [];
  const fatalMap = [['parseErrors','JSON结构错误'],['missingCovers','漏台词承载'],['duplicateCovers','重复承载'],['speakerErrors','说话者错配'],['lineErrors','台词文本错配'],['voErrors','VO/电话/OS错配'],['sourceErrors','来源越界']];
  const warnMap = [['soundPictureErrors','声画分离待优化'],['listenerErrors','演员互动待优化'],['expressionErrors','形容词/分析腔待优化'],['motionErrors','运镜待优化'],['focalErrors','焦段待优化'],['eErrors','E限制已由渲染器兜底']];
  for (const [k, label] of fatalMap) if (e[k] && e[k].length) fatal.push(label + e[k].length);
  for (const [k, label] of warnMap) if (e[k] && e[k].length) warn.push(label + e[k].length);
  if (fatal.length) return fatal.join(' / ') + (warn.length ? '（另有警告：' + warn.join(' / ') + '）' : '');
  if (warn.length) return '可用，警告：' + warn.join(' / ');
  return '通过';
}
function cleanPhysicsClause(text) {
  let s = String(text || '').trim();
  s = s.replace(/Fernel/g, 'Fresnel');
  s = s.replace(/\[补充\]/g, '');
  s = s.replace(/刘秘书话落瞬间环境音真空0\.5秒[，。·；]*/g, '');
  s = s.replace(/听觉压迫转化为视觉的静帧张力[，。·；]*/g, '');
  s = s.replace(/音效式留白作为氛围感核心来源[，。·；]*/g, '');
  s = s.split(/[·；;。]/).map(x => x.trim()).filter(x => x && !x.includes('…') && !/"[^"]*$/.test(x)).join('·');
  s = s.replace(/\s+/g, '');
  return s;
}
function pickClauses(text, maxChars) {
  const cleaned = cleanPhysicsClause(text);
  const parts = cleaned.split(/[·；;]/).map(x => x.trim()).filter(Boolean);
  const out = [];
  let n = 0;
  for (const part of parts) {
    const add = (out.length ? 1 : 0) + part.length;
    if (n + add > maxChars) continue;
    out.push(part);
    n += add;
  }
  if (out.length) return out.join('·');
  const sent = cleaned.split(/[。；;]/).map(x => x.trim()).find(x => x && x.length <= maxChars);
  if (sent) return sent;
  return cleaned.slice(0, Math.max(10, maxChars)).replace(/[，、：:；;。]*$/g, '');
}
function renderPhysics(physics, visualStyle = 'plain') {
  if (!physics) return renderPhysics(defaultPhysics({ header: '日 外' }, '', visualStyle), visualStyle);
  if (typeof physics === 'string') return cleanPhysicsClause(physics);
  const styleMode = physics.visualStyle || visualStyle || 'plain';
  const isPoetic = styleMode === 'poetic';
  const style = pickClauses(physics.style || (isPoetic ? '电影级唯美写实·根据环境设计精美光影·强调空气感、人物轮廓光和柔焦层次' : '现实短剧写实·末世灾变前兆·旧宅日外压迫感'), isPoetic ? 95 : 65);
  const texture = pickClauses(physics.texture || (isPoetic ? '数字电影机模拟胶片·轻中颗粒·浅景深·人物面部和关键物件清晰·背景柔和虚化·亮部有克制胶片晕光' : '数字拍摄模拟16mm胶片·中轻颗粒·中浅景深·人物面部与手机屏幕优先清晰'), isPoetic ? 115 : 80);
  const material = pickClauses(physics.material || (isPoetic ? '手机玻璃冷白高反射并带Fresnel和指纹油渍·墙地面保留粗糙纹理和AO·衣料、发丝、皮肤在逆光下有柔和边缘高光·皮肤有毛孔与轻微SSS' : '手机玻璃冷白高反射并带指纹油渍·灰砖院墙高粗糙度·青石地面低光泽·旧木门漆面剥落·人物皮肤保留毛孔和轻微油光'), isPoetic ? 155 : 125);
  const light = pickClauses(physics.light || (isPoetic ? '根据场景光源设计主光方向、色温与光比·优先使用侧逆光、逆光、轮廓光、反射补光和暗部层次·手机屏幕提供冷白底光形成冷暖对比' : '左前上方日光为主光·色温约5200K·光比约1:3.5·手机屏幕提供冷白底光·地面少量漫反射·门框与脚边AO加重'), isPoetic ? 160 : 150);
  const atmosphere = pickClauses(physics.atmosphere || (isPoetic ? '空气介质依据环境选择浮尘、水汽、薄雾、烟或树影光束·逆光照亮空气颗粒·背景被光雾和浅景深软化·暗部带少量冷调' : '空气干燥微尘·背景压暗虚化·暗部带青灰冷调·焦平面在人物面部与手机屏幕之间切换'), isPoetic ? 140 : 105);
  const render = pickClauses(physics.render || (isPoetic ? '电影化HDR/类ACES·高光柔滚降·适度halation·轻微bloom·轻中胶片颗粒·极轻色差·禁止塑料皮肤、CG感、过饱和和无来源强炫光' : '电影化HDR/类ACES·高光柔滚降·轻颗粒·极轻晕光·禁止塑料感、CG感、动漫化和无来源强炫光'), isPoetic ? 130 : 105);
  return [`画风：${style}`, `影像质感：${texture}`, `材质：${material}`, `光：${light}`, `氛围：${atmosphere}`, `渲染：${render}`].join('\n');
}

function formatValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(formatValue).filter(Boolean).join('；');
  if (typeof v === 'object') return Object.entries(v).map(([k, val]) => `${k}：${formatValue(val)}`).join('，');
  return String(v);
}
function renderStartingState(st) {
  if (!st) return '空间：场景空间。\n人物位置：按剧本人物关系站位。';
  if (typeof st === 'string') return st;
  const lines = [];
  if (st.space) lines.push(`空间：${formatValue(st.space)}`);
  if (st.previousLastFrame) lines.push(`上一片段末帧：${formatValue(st.previousLastFrame)}`);
  if (st.firstFramePlan) lines.push(`本片段首帧计划：${formatValue(st.firstFramePlan)}`);
  if (Array.isArray(st.positions) && st.positions.length) lines.push('人物位置：\n' + st.positions.map(x => `├─ ${formatValue(x)}`).join('\n'));
  return lines.join('\n') || formatValue(st);
}
function renderDialogueLine(dl) {
  const line = String(dl.text || '').trim();
  if (!line) return '';
  const speaker = stripDirectingMarks(String(dl.speaker || '').trim());
  if (dl.voiceMode === 'phone') return `电话里传来${/刘秘书/.test(speaker) ? '刘秘书的声音' : '声音'}："${line}"`;
  if (dl.voiceMode === 'vo' || dl.voiceMode === 'os') return `画面中无人开口，${speaker || '声音'}传来："${line}"`;
  if (dl.voiceMode === 'spoken_split') return `${speaker || '角色'}："${line}"`;
  return `${speaker || '角色'}："${line}"`;
}
// 合并式镜头渲染 — 参考质量标准：
// 有台词的镜：视觉+台词合并成一句流畅描述，物理/声音进括号
// 无台词的镜：纯视觉动作，物理/声音进括号
// 核心原则：模板句过滤 + 语义 fallback，不硬编码具体场景
function buildShotVisual(shot) {
  const rawVisual = cleanTemplateText(String(shot.visual || '').replace(/["\"].+?["\"]/g, '').trim());
  const speakerAction = cleanTemplateText(String(shot.speakerAction || '').trim());
  const dialogueLines = (shot.dialogueLines || []).map(renderDialogueLine).filter(Boolean);
  const hasDialogue = dialogueLines.length > 0;

  if (!rawVisual && !speakerAction && !hasDialogue) {
    // 镜号完全空白 → 用语义分析生成接棒描述
    return { main: buildSemanticFallback(shot, 'empty'), merged: false };
  }

  if (hasDialogue) {
    // 合并式：visual + speakerAction + dialogue → 一句
    const dlRaw = shot.dialogueLines[0];
    const speaker = stripDirectingMarks(String(dlRaw?.speaker || '').trim());
    const lineText = String(dlRaw?.text || '').trim();
    const vm = dlRaw?.voiceMode;

    // VO / OS / phone：spoken 本身已含画面说明，不再挂空洞 visual
    if (vm === 'vo' || vm === 'os') {
      const spoken = `画面中无人开口，${speaker || '声音'}传来："${lineText}"`;
      return { main: cleanupChinesePunctuation(spoken), merged: true, meta: dlRaw.originalText || lineText };
    }

    let spoken = null;
    let meta = null;
    if (vm === 'phone') {
      spoken = `电话里传来${/刘秘书/.test(speaker) ? '刘秘书的声音' : '声音'}："${lineText}"`;
      meta = dlRaw.originalText || lineText;
    } else if (speakerAction) {
      spoken = `${speaker || '角色'}${speakerAction.includes('开口') || speakerAction.includes('说') || speakerAction.includes('问') ? '' : '开口'}${speakerAction.includes('说') || speakerAction.includes('问') ? '' : '说'}："${lineText}"`;
      meta = null;
    } else {
      spoken = `${speaker || '角色'}："${lineText}"`;
      meta = null;
    }

    // rawVisual 是模板句 → 丢弃，用语义 fallback 替代
    const visualPart = (rawVisual && !isVisualTemplateText(rawVisual))
      ? rawVisual
      : buildSemanticFallback(shot, 'visual');

    const merged = `${visualPart}，${spoken}`;
    return { main: cleanupChinesePunctuation(merged), merged: true, meta };
  }

  // 无台词：纯视觉；visual 是模板句 → 丢弃，用语义 fallback
  let main = (rawVisual && !isVisualTemplateText(rawVisual))
    ? rawVisual
    : buildSemanticFallback(shot, 'visual');
  return { main: cleanupChinesePunctuation(main), merged: false };
}

function buildShotParenthetical(shot) {
  // 物理细节 + 声音
  let phys = cleanTemplateText(String(shot.physicalFeedback || '').trim());
  let sound = cleanTemplateText(String(shot.sound || '').trim());
  if (!sound && phys && isSoundLike(phys)) { sound = phys; phys = ''; }
  if (!sound) sound = concreteSoundDesign(shot);
  sound = sound.replace(/[（）]/g, '').replace(/不加入情绪化音效。?/g, '').replace(/无背景音乐。?/g, '无BGM。').trim();
  const parts = [];
  if (phys && !isSoundLike(phys)) parts.push(phys);
  if (sound) parts.push(`声音：${sound}`);
  if (!parts.length) return '';
  return cleanupChinesePunctuation('（' + parts.join('；') + '）');
}

function buildShotListenerLine(shot) {
  const raw = cleanTemplateText(String(shot.listenerReaction || '').trim());
  if (!raw) return '';
  return cleanupChinesePunctuation(raw);
}

function renderShotLine(shot) {
  const duration = shot.duration || '2s';
  const size = shot.shotSize || '中景';
  const movement = shot.movement || '停住见证';
  const lens = shot.lens || '50mm';
  const { main: visualLine, merged } = buildShotVisual(shot);
  const parenthetical = buildShotParenthetical(shot);
  const listenerLine = buildShotListenerLine(shot);
  const hasDialogue = (shot.dialogueLines || []).length > 0;
  const lines = [];
  if (visualLine) lines.push(visualLine);
  if (merged && parenthetical) {
    lines[lines.length - 1] = lines[lines.length - 1] + '\n' + parenthetical;
  } else if (!merged && parenthetical) {
    lines.push(parenthetical);
  }
  if (!merged && listenerLine) lines.push(listenerLine);
  const body = lines.join('\n');
  return cleanupChinesePunctuation(`镜${shot.no || ''}  ${duration} · [${size}] ${movement}  焦段${lens}\n${body}`);
}
function diversifySound(sound, shot, idx, prev) {
  let s = String(sound || '').trim();
  if (!s || s !== prev) return s;
  const ctx = analyzeShot(shot);
  const { isPhone, keywords, emotion, isAlternating } = ctx;
  if (isPhone || keywords.sound) {
    if (emotion === 'alert' || emotion === 'shock') return isAlternating ? '电话声发闷，杂音断续，户外风声被压低。' : '关键词落下后，环境声短暂抽空半拍。';
    return isAlternating ? '提示声尾音断开，户外风声短暂露出。' : '忙音贴近听筒，系统提示声清晰。';
  }
  if (keywords.video) return isAlternating ? '短视频原声压低，远处混乱声作底。' : '手机外放很低，只留下画面里的嘈杂底噪。';
  if (/拨|按键|通讯录/.test(ctx.allText)) return isAlternating ? '指尖滑屏声清晰，按键声很轻。' : '按键声短促，户外风声回到底层。';
  if (emotion === 'doubt' || emotion === 'absurd') return isAlternating ? '台词压过环境底噪，尾字后留半拍安静。' : '手机握持摩擦很轻，环境声贴在底层。';
  return isAlternating ? '环境风声保持低底噪。' : '衣料和脚步声按动作轻保留。';
}

function buildMustAppearTargets(shots) {
  const targets = [];
  for (const shot of shots) {
    const lines = (shot.dialogueLines || []);
    const covers = shot.covers || [];
    for (const dl of lines) {
      if (dl.originalText) {
        const key = dl.originalText.slice(0, 12);
        targets.push(`"${key}"：出现了`);
      }
    }
  }
  if (!targets.length) return '';
  return targets.slice(0, 5).join('\n');
}

function buildDirectorProhibition(shots) {
  // 导演禁止项应由上游AGENT_B的scene.card.directive提供，此处仅作空壳
  return '';
}

function buildTailFrame(shots) {
  if (!shots.length) return '';
  const last = shots[shots.length - 1];
  const dl = (last.dialogueLines || [])[0];
  const speaker = dl ? String(dl.speaker || '').trim() : '';
  const line = dl ? String(dl.text || '').trim() : '';
  const size = last.shotSize || '中景';
  const position = /侧面/.test(size) ? '侧面' : /正面/.test(size) ? '正面' : '';
  let content = '';
  if (speaker && line) {
    content = `${speaker}：${size}${position ? '·' + position : ''}`;
  } else {
    const task = String(last.task || '');
    content = `${task || '最后镜头'}：${size}${position ? '·' + position : ''}`;
  }
  return content;
}

function buildVisualHandoff(shots) {
  if (!shots.length) return '';
  const last = shots[shots.length - 1];
  const dl = (last.dialogueLines || [])[0];
  if (!dl) return '';
  const speaker = String(dl.speaker || '').trim();
  const line = String(dl.text || '').trim();
  const size = last.shotSize || '中景';
  const position = /侧面/.test(size) ? '侧面' : /正面/.test(size) ? '正面' : '中景';
  return `传出"${speaker}${size}·${position}"→下一片段接`;
}

function renderSegment(obj) {
  const chars = obj.charactersLine || '@角色A @角色B @角色C @角色D';
  const sceneLabel = obj.sceneHeader ? `@场景 ${obj.sceneHeader}` : '';
  const title = obj.title || obj.segmentId || '片段';
  const shots = Array.isArray(obj.shots) ? obj.shots : [];
  const eShort = '严禁字幕、文字标题、角标、水印、Logo；严禁BGM；保留真实环境音、物件音、电话声、脚步声、手机提示音和屏幕原声；禁止新增地点、角色、灾难奇观；禁止自创台词。';
  let prevSound = '';
  const renderedShots = shots.map((shot, idx) => {
    const copy = { ...shot };
    copy.sound = diversifySound(copy.sound, copy, idx, prevSound);
    prevSound = String(copy.sound || '').trim();
    return renderShotLine(copy);
  });
  const mustAppear = buildMustAppearTargets(shots);
  const directorProh = buildDirectorProhibition(shots);
  const tailFrame = buildTailFrame(shots);
  const visualHandoff = buildVisualHandoff(shots);
  // 按顺序构建数据块：A→B→C→D→E→F→G
  const parts = [sceneLabel, chars];
  if (sceneLabel) parts.push('');
  // 【A】画面物理系统
  const segmentLabel = `【片段${obj.segmentId || title}】${obj.title || ''}`;
  parts.push(segmentLabel + (obj.sceneFeeling ? `\n（场景感受：${obj.sceneFeeling}）` : ''), '', '【A】画面物理系统：', renderPhysics(obj.physics, obj.visualStyle || obj.physics?.visualStyle || 'plain'));
  // 【B】起始状态
  parts.push('', '【B】起始状态：', renderStartingState(obj.startingState));
  // 【C】镜头序列
  parts.push('', '【C】镜头序列：', '', renderedShots.join('\n\n'));
  // 【D】尾帧
  parts.push('', '【D】尾帧：');
  if (tailFrame) parts.push(tailFrame);
  if (visualHandoff) parts.push(`视觉接棒：${visualHandoff}`);
  // 【E】限制指令（放在D之后F之前）
  parts.push('', '【E】限制指令：', eShort);
  // 【F】必现目标
  if (mustAppear) {
    parts.push('', '【F】必现目标：', mustAppear);
  }
  // 【G】导演禁止项
  if (directorProh) {
    parts.push('', '【G】导演禁止项：' + directorProh);
  }
  // 组装完整文本
  let output = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // 字数超限处理：≤1800字，超限时依次删除F→D→G
  const MAX_CHARS = 1800;
  if (output.length > MAX_CHARS) {
    // 第1步：删除【F】必现目标
    output = output.replace(/\n*【F】必现目标：[\s\S]*?(?=\n*【G】|\n*$)/, '');
    output = output.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (output.length > MAX_CHARS) {
    // 第2步：删除【D】尾帧
    output = output.replace(/\n*【D】尾帧：[\s\S]*?(?=\n*【E】)/, '');
    output = output.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (output.length > MAX_CHARS) {
    // 第3步：删除【G】导演禁止项
    output = output.replace(/\n*【G】导演禁止项：[\s\S]*?(?=\n*$)/, '');
    output = output.replace(/\n{3,}/g, '\n\n').trim();
  }
  return output;
}
// ============================================================
// Batch Enrich — 片段级AI增强（替代硬编码fallback）
// 调用时机: validateSegmentJson 之后，renderSegment 之前
// 策略: 片段内所有shots打包为1次AI调用，避免逐shot调用的性能问题
// ============================================================

function buildBatchEnrichPrompt({ scene, segment, parsed, costumeCard, prevSegmentEnd }) {
  const shots = Array.isArray(parsed.shots) ? parsed.shots : [];
  const cast = scene.cast && scene.cast.length ? scene.cast.join('、') : '角色A、角色B、角色C';
  const visualStyle = parsed.visualStyle || 'plain';
  const feeling = parsed.sceneFeeling || '中性叙事';

  // 构建服化道摘要（来自 AGENT_B）
  let costumeSummary = '';
  if (costumeCard && typeof costumeCard === 'string' && costumeCard.trim()) {
    // 取前800字，避免 prompt 过长
    costumeSummary = `\n【服化道参考（AGENT_B输出）】\n${costumeCard.trim().slice(0, 800)}`;
  }
  // 也尝试从 parsed.casts 取（createSegmentSkeleton 会写入）
  if (Array.isArray(parsed.casts) && parsed.casts.length) {
    costumeSummary += `\n【角色视觉描述（来自服化道卡）】\n${parsed.casts.join('\n')}`;
  }

  // 构建场景物理系统摘要
  const physics = parsed.physics || {};
  const camera = physics.camera || '';
  const light = physics.light || '';
  const surface = physics.surface || '';
  const soundDesign = physics.soundDesign || '';

  // 构建每个shot的摘要（用于AI参考）—— 包含足够细节让AI生成有质感的输出
  const shotSummaries = shots.map((shot, idx) => {
    const dl = (shot.dialogueLines || [])[0] || {};
    const speaker = String(dl.speaker || '').trim();
    const line = String(dl.text || '').trim();
    const state = String(dl.state || '').trim();
    const voiceMode = String(dl.voiceMode || '').trim();
    const actions = (shot.actionTexts || []).join('；');
    const currentVisual = String(shot.visual || '').trim();
    const currentPhys = String(shot.physicalFeedback || '').trim();
    const currentSound = String(shot.sound || '').trim();
    const size = shot.shotSize || '中景';
    const movement = shot.movement || '';
    const lens = shot.lens || '50mm';
    const duration = shot.duration || '2s';
    const task = String(shot.task || '').trim();

    // 根据景别和焦段，提示AI该生成什么级别的细节
    let detailHint = '';
    if (/特写|大特写/.test(size) || /100|135|200/.test(lens)) {
      detailHint = '【细节提示：特写/长焦 → 必须包含：汗珠/反光/指节/瞳孔/嘴角抽动等微细节】';
    } else if (/中近景|近景/.test(size) || /85/.test(lens)) {
      detailHint = '【细节提示：中近景/85mm → 必须包含：下巴/喉结/手腕/衣服褶皱等中等细节】';
    } else {
      detailHint = '【细节提示：全景/中景/广角 → 必须包含：身体姿态/动作趋势/环境互动】';
    }

    // 根据摄影机运动，提示光线/阴影变化
    let movementHint = '';
    if (/推进|推进|前推/.test(movement)) {
      movementHint = '【运动提示：镜头推进 → 焦平面会从整体移到局部，必须描述这个过程中光线/阴影/反光的细微变化】';
    } else if (/拉远|拉开/.test(movement)) {
      movementHint = '【运动提示：镜头拉远 → 环境逐渐露出，必须描述人物在环境中的位置关系】';
    } else if (/横移|跟拍/.test(movement)) {
      movementHint = '【运动提示：横移/跟拍 → 侧光/背光会不断变化，必须描述光线在脸上的移动】';
    }

    let typeTag = '';
    if (voiceMode === 'vo' || voiceMode === 'os') typeTag = '【VO旁白】';
    else if (voiceMode === 'phone') typeTag = '【电话】';
    else if (actions && !line) typeTag = '【纯动作】';
    else if (!actions && line) typeTag = '【纯台词】';
    else typeTag = '【动作+台词】';

    return `--- 镜${idx + 1} ${typeTag} ---
镜头规格：${size} / ${lens} / ${duration} / ${movement}
${detailHint}
${movementHint}
拍摄任务：${task || '无'}
当前visual：${currentVisual || '（空）'}
当前physicalFeedback：${currentPhys || '（空）'}
当前sound：${currentSound || '（空）'}
${speaker ? `说话人：${speaker}` : ''}${line ? `\n台词：${line}` : ''}${state ? `\n状态说明：${state}` : ''}${actions ? `\n动作：${actions}` : ''}`;
  }).join('\n\n');

  const prevEndStr = prevSegmentEnd
    ? `【上一片段末帧】
${prevSegmentEnd}`
    : '（无上一片段，作为片段序列的首段）';

  return `你是视频分镜导演。请根据以下上下文，为每个镜头补充具体的视觉细节、声音设计和表演指导。

【重要】输出格式要求：
在第一条【场景信息】之前，先单独输出一行本片段的诗意标题（4-8字，用·分隔前后两段），格式如下：
segmentTitle: 电话忙音·期待落空
（标题必须贴合本片段情绪和核心动作，禁止泛化词，禁止照抄当前片段标题）

【场景信息】
场景ID：${scene.id || ''}
场景头：${scene.header || ''}
演员：${cast}
当前片段标题：${segment.title || segment.id || ''}
片段叙事目标：${segment.reason || feeling}
${costumeSummary}

【场景物理系统】
摄影机运动基调：${camera || '手持/稳定器随机应变'}
光线：${light || '自然光'}
表面材质：${surface || '日常材质'}
声音设计：${soundDesign || '无特殊声音系统'}

${prevEndStr}

【当前片段镜头骨架】
${shotSummaries}

---

【优质输出示例】— 必须严格参考这种细节水平！

以下两个镜头的输出包含：具体动作+光线/阴影/反光细节+声音来源特征。
请严格按照这种风格和质量输出。
注意：示例中的"角色A/角色B"要替换成你当前场景的实际角色名！

## 镜1（单人紧张打电话）
visual: 角色A手指收紧手机边缘，指节因用力而泛白，屏幕光照亮他下颌的明暗分界线
speakerAction: 喉结上下滚动一次，舌尖顶一下后槽牙
listenerReaction: 无（单人镜头）
physicalFeedback: 汗珠从角色A鬓角滑下，在鼻翼侧面反光；手机壳边缘有细碎汗渍
sound: 手机听筒忙音"嘟—嘟—"每声0.5秒，空调低沉嗡鸣声填充满房间

## 镜3（两人对话，说话人+听话人）
visual: 角色A视线从手机屏幕移到地面又弹回屏幕，开口时嘴角肌肉微微抽动
speakerAction: 下巴微抬，舌尖顶一下后槽牙，左手无名指在裤缝处轻敲两下
listenerReaction: 角色B眉头微不可察地皱了一下，视线从角色A脸上移到手机再移回
physicalFeedback: 角色A敲击的指尖在顶灯光下反光，手机壳边缘有极细的微震
sound: 指尖敲击手机壳发出细密"嗒嗒"声，背景有极远的车流低鸣

---

【完整镜头示例 — 展示"有细节" vs "空洞"的差别】

❌ 空洞（禁止输出这种）：
visual: 角色A紧张地打电话
speakerAction: 他生气地说
physicalFeedback: 气氛很压抑
sound: 环境声低底噪

✅ 有细节（必须输出这种）：
visual: 角色A手指收紧手机边缘，听筒紧贴耳朵，屏幕亮着通话界面
speakerAction: 下巴微抬，舌尖顶一下后槽牙
physicalFeedback: 指节因握力泛白，手机塑料壳在掌心留下汗渍印
sound: 听筒忙音"嘟—嘟—"，空调低沉嗡鸣

---

【重要：细节从哪里来？】
必须结合当前镜头信息生成细节：
1. 从 shotSize（景别）、lens（焦段）推断：特写能看到汗珠/反光，中景能看到身体动作
2. 从 movement（摄影机运动）推断：推进时焦平面变化，光线在脸上移动
3. 从任务描述推断：打电话就有手机反光，紧张就有汗珠/指节泛白
4. 从时间段推断：正午日光有锐利明暗线，夜晚有反光/阴影
5. 从场景物理系统推断：材质反光/阴影/声音特征

---

【反面示例 — 禁止生成这种空洞内容】

## 镜X
visual: 角色A紧张地打电话（❌ 空洞！没有具体动作）
speakerAction: 他生气地说（❌ 这是语气，不是身体动作）
listenerReaction: 角色B感到害怕（❌ 这是情绪，不是可见动作）
physicalFeedback: 气氛很压抑（❌ 这不是物理现象）
sound: 环境声低底噪（❌ 空话，没有声音来源和特征）
sound: 无特殊声音（❌ 禁止输出这种）

---

【输出要求】
你是一个执行者，严格按以下格式输出，不要分析，不要解释：

【强制规则】
- 每个镜头必须输出全部5个字段（visual/speakerAction/listenerReaction/physicalFeedback/sound）
- 少一个字段就等于任务失败！
- 所有字段值不能和示例完全相同，必须根据当前场景角色名生成具体内容
- 禁止输出模板化内容（如"角色A紧张地说话"→要写具体动作）

## 镜1
visual: <主动作描述，必须包含光线/阴影/反光细节，≥15字>
speakerAction: <说话人微动作，可见的身体动作，≥10字> 或 无
listenerReaction: <听话人具体反应动作，≥10字> 或 无
physicalFeedback: <物理现象细节，≥10字> 或 无
sound: <声音来源+特征描述，≥10字> 或 无

## 镜2
...

（按实际镜头数输出，每个镜头占一块，必须输出全部5个字段）

---

【各字段写作细则 — 必须严格遵守】

1. visual（主动作描述）— 最关键的字段！
   ✅ 正确示例：
      "角色A手指收紧手机边缘，听筒紧贴耳朵，屏幕亮着通话界面，侧脸被屏幕光照亮"
      "角色A视线从手机屏幕移到地面又弹回屏幕，开口时嘴角肌肉微微抽动"
   ❌ 错误示例：
      "角色A紧张地打电话" ← 空洞！没有具体动作
      "他显得很焦虑" ← 情绪形容，不是可见动作
   ✅ 必须包含：具体动作 + 物件交互 + 人物状态 + 光线/阴影/反光细节
   ❌ 禁止：纯情绪形容词（紧张、凝重、慌乱、害怕、愤怒）

2. speakerAction（说话人微动作）— 让表演有层次！
   ✅ 正确示例：
      "喉结上下滚动一次，舌尖顶一下后槽牙"
      "攥紧手机，指节泛白，嘴角抽动一下"
      "开口时手腕翻转，手机在掌心转了半圈"
   ❌ 错误示例：
      "他生气地说" ← 这是语气，不是身体动作
      "语气急促" ← 听不出来的，要可见的动作
   ✅ 必须是：可见的身体微动作（喉结滚动、嘴角抽动、指尖发白、舌头顶后槽牙、眉毛微抬）

3. listenerReaction（听话人反应）— 让对话有张力！
   ✅ 正确示例：
      "角色B眉头微皱，视线从角色A脸上移到手机再移回"
      "角色B靠墙，嘴角微微上扬，眼神斜视"
      "角色B瞪大眼睛，手机从手中滑落一寸"
   ❌ 错误示例：
      "她感到害怕" ← 情绪，不是可见动作
      "他显得很担心" ← 太模糊
   ✅ 无听话人时写："无"

4. physicalFeedback（物理细节）— 让画面有质感！
   ✅ 正确示例：
      "指节因握力泛白，手机塑料壳在掌心留下汗渍印"
      "汗珠从鬓角滑下，在鼻翼侧面反光，随头部转动有微弱光影变化"
      "敲击的指尖在顶灯光下反光，壳边缘有极细的微震"
      "呼吸声变浅，衬衫领口随呼吸轻微起伏，锁骨阴影随之变化"
   ❌ 错误示例：
      "气氛很压抑" ← 这不是物理现象
      "光线冷峻" ← 这是光线，不是物理反馈
   ✅ 必须是：汗/肌肉/颤抖/反光/阴影/衣物褶皱等可见物理现象
   ❌ 禁止：光线/氛围/情绪形容

5. sound（声音描述）— 让画面有声音！
   ✅ 正确示例：
      "听筒忙音'嘟—嘟—'每声0.5秒间隔0.3秒，背景有极低的电流杂音"
      "指尖敲击塑料壳发出细密'嗒嗒'声，间隔约0.2秒"
      "空调低沉嗡鸣（约40Hz），背景有极远的车流低鸣"
      "手机屏幕碎裂声清脆（高频），碎片弹到地面发出细碎'噼啪'声"
   ❌ 错误示例：
      "环境声低底噪" ← 空话，没有声音来源
      "气氛压抑" ← 这不是声音
      "无特殊声音" ← 禁止输出这种
   ✅ 必须有：声音来源 + 声音特征（音调/节奏/远近/频率）
   ❌ 禁止："无特殊""暂无""空"

---

【输出质量检查清单】— 输出前必须逐项检查！
输出前，请检查每个镜头：
☑ visual 是否包含具体动作（不是情绪形容）？
☑ visual 是否包含光线/阴影/反光等细节？ ← 重要！
☑ speakerAction 是否是身体微动作（不是语气）？
☑ listenerReaction 是否是可见的反应动作（不是情绪）？
☑ physicalFeedback 是否是物理现象（汗/肌肉/颤抖/反光）？
☑ sound 是否有声音来源和特征（不是"环境声低底噪"）？
☑ 同一片段内相邻镜头的 sound 是否有变化（不重复）？

【硬性细节要求】— 不满足这些要求，输出就是失败的！
1. visual 必须包含：
   - 至少一处光线/阴影/反光描述（如"日光在他侧脸切出明暗线""屏幕光照亮指节"）
   - 至少两处人物动作细节（如"手指收紧→指节泛白→嘴角抽动→下巴微抬"）
   - 至少15个字！少于15字就是失败的

2. speakerAction 必须包含：
   - 可见的身体微动作（如"喉结滚动一次→舌尖顶后槽牙→指节泛白"）
   - 至少10个字！如果确实无动作，写"无"

3. listenerReaction 必须包含：
   - 听话人的具体反应动作（如"眉头微皱→视线下移→嘴唇微张"）
   - 至少10个字！如果无听话人，写"无"

4. physicalFeedback 必须包含：
   - 物理现象（汗/肌肉/颤抖/反光/阴影/衣物褶皱/呼吸起伏）
   - 至少10个字！如果确实无，写"无"

5. sound 必须包含：
   - 声音来源 + 声音特征（音调/节奏/远近/频率描述）
   - 至少10个字！如果确实无特殊声音，写"无"

【强制要求】
- 每个镜头必须输出全部5个字段，少一个字段就是失败！
- 所有字段值不能重复（同一片段内不能出现相同的描述）
- 如果某字段确实无内容，写"无"（不要留空，不要写"空""暂无""无特殊"）

【重要提醒】
- 如果某字段确实无内容，写"无"（不要留空，不要写"空""暂无""无特殊"）
- 严格使用中文，一个字段一行，不要Markdown格式
- 不要输出反引号代码块标记，不要解释你的输出
- 每个字段的值必须达到上述"硬性细节要求"的最小字数，否则输出就是失败的；
`;
}

function parseBatchEnrichResult(rawText, shots) {
  if (!rawText || !shots || !shots.length) return {};
  const result = {};

  // 预处理：提取 segmentTitle（在第一行，格式：segmentTitle: 电话忙音·期待落空）
  {
    const titleMatch = rawText.match(/segmentTitle\s*[:：]\s*(.+)$/m);
    if (titleMatch) {
      let title = titleMatch[1].trim();
      // 去掉可能的【】括号
      title = title.replace(/^[【\[]?\s*|\s*[】\]]?$/g, '');
      if (title.length >= 2 && title.length <= 20) {
        result.segmentTitle = title;
      }
    }
  }

  // 预处理：去掉 markdown 代码块标记
  const clean = rawText
    .replace(/^```(?:json)?\s*/gim, '')
    .replace(/\s*```$/gim, '')
    .trim();

  // 按 ## 镜N 或 ## ShotN 分段：每个镜头占一块（兼容中英文）
  const sections = clean.split(/(?=\n##?\s+(?:Shot|镜)\s*\d+)/gm);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // 匹配镜头编号（兼容中英文）
    const headerMatch = trimmed.match(/^##?\s+(?:Shot|镜)\s*(\d+)/i);
    if (!headerMatch) continue;

    const shotIdx = parseInt(headerMatch[1], 10) - 1;
    if (shotIdx < 0 || shotIdx >= shots.length) continue;

    // 按字段块解析：支持多行值
    const data = {};
    const lines = trimmed.split('\n');
    
    let currentField = null;
    let currentValueLines = [];

    function flushField() {
      if (!currentField || !currentValueLines.length) return;
      let value = currentValueLines.join('\n').trim();
      if (!value) return;
      
      // 过滤无效值
      const invalidVals = ['空', '无', '无特殊', '暂无', '不适用', '无特殊反应', '无特殊动作', '（无）', '（空）'];
      if (invalidVals.includes(value)) return;
      
      // 特殊处理：如果 visual 包含括号细节，尝试提取
      if (currentField === 'visual' && value.includes('（') && value.includes('）')) {
        const parenMatch = value.match(/^(.+?)\s*（(.+?)）\s*$/s);
        if (parenMatch && parenMatch[1].trim().length > 3) {
          data['visual'] = parenMatch[1].trim();
          // 括号内容尝试分配到 physicalFeedback 或 sound
          const parenContent = parenMatch[2].trim();
          if (parenContent && !data['physicalFeedback'] && !data['sound']) {
            // 简单判断：包含"声""音""响"的归入 sound，否则归入 physicalFeedback
            if (/[声声音响]/.test(parenContent)) {
              data['sound'] = parenContent;
            } else {
              data['physicalFeedback'] = parenContent;
            }
          }
          return;
        }
      }
      
      // 质量检查：拒绝太短的内容（可能是截断的）
      if (value.length < 2) return;
      
      data[currentField] = value;
    }

    for (const line of lines) {
      // 检查是否是新字段开始（如 "visual:" 或 "visual："）
      const fieldMatch = line.match(/^(visual|speakerAction|listenerReaction|physicalFeedback|sound)\s*[:：]/i);
      
      if (fieldMatch) {
        // 保存上一个字段
        flushField();
        currentField = fieldMatch[1].toLowerCase();
        // 提取冒号后的值（可能在同一行）
        const rest = line.substring(fieldMatch[0].length).trim();
        currentValueLines = rest ? [rest] : [];
      } else if (currentField) {
        // 继续当前字段的内容（支持多行）
        // 跳过纯空白行，但保留有内容的行
        if (line.trim()) {
          currentValueLines.push(line.trim());
        }
      }
    }
    // 保存最后一个字段
    flushField();

    if (Object.keys(data).length > 0) {
      result[shotIdx] = { ...result[shotIdx], ...data };
    }
  }
  return result;
}

function isQualityContent(value) {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 2) return false;
  // 拒绝空洞值
  const invalid = ['无', '空', '暂无', '不适用', '无特殊', '无特殊反应', '无特殊动作', '（无）', '（空）'];
  if (invalid.includes(v)) return false;
  return true;
}

function isBetterValue(newVal, oldVal) {
  // 如果新值质量不行，拒绝
  if (!isQualityContent(newVal)) return false;
  // 如果旧值不存在，总是接受新值
  if (!oldVal || !oldVal.trim()) return true;
  // 如果新值明显比旧值更具体（更长且包含更多细节），接受
  const newLen = newVal.trim().length;
  const oldLen = oldVal.trim().length;
  if (newLen > oldLen && newLen >= 5) return true;
  // 如果旧值是模板化的（短且通用），接受新值
  const templatePatterns = ['面向对手', '承接上一动作', '动作未完成', '听者保持', '画面中无人开口'];
  if (templatePatterns.some(p => oldVal.includes(p))) return true;
  // 如果新值更长，接受（AI生成的比hardcode更具体）
  if (newLen > oldLen) return true;
  // 如果新值有细节（包含逗号、句号等，说明不是短句），接受
  if (/[，。、；]/.test(newVal) && newLen >= 5) return true;
  // 默认：如果新值质量可以，就接受
  return newLen >= 3;
}

function injectEnrichment(parsed, enrichmentMap) {
  if (!parsed || !parsed.shots || !Array.isArray(parsed.shots)) return parsed;
  const shots = parsed.shots.map((shot, idx) => {
    const enrich = enrichmentMap[idx];
    if (!enrich) return shot;

    const updated = { ...shot };

    // visual: 主视觉描述
    if (isBetterValue(enrich.visual, shot.visual)) {
      updated.visual = enrich.visual.trim();
    }

    // speakerAction: 说话人动作
    if (isBetterValue(enrich.speakeraction, shot.speakerAction)) {
      updated.speakerAction = enrich.speakeraction.trim();
    }

    // listenerReaction: 听话人反应
    if (isBetterValue(enrich.listenerreaction, shot.listenerReaction)) {
      updated.listenerReaction = enrich.listenerreaction.trim();
    }

    // physicalFeedback: 物理细节
    if (isBetterValue(enrich.physicalfeedback, shot.physicalFeedback)) {
      updated.physicalFeedback = enrich.physicalfeedback.trim();
    }

    // sound: 声音描述
    if (isBetterValue(enrich.sound, shot.sound)) {
      updated.sound = enrich.sound.trim();
    }

    return updated;
  });
  return { ...parsed, shots };
}

function enrichLog(msg) {
  const logFile = 'D:\\AI\\project\\test\\debug_enrich.log';
  const ts = new Date().toISOString();
  const line = '[' + ts + '] ' + msg + '\n';
  try { fs.appendFileSync(logFile, line); } catch(e) { console.log('[debug_enrich.log 写入失败]', e.message); }
  console.log(msg);
}

async function enrichSegmentShots({ scene, segment, parsed, costumeCard, config, prevSegmentEnd }) {
  enrichLog(`[BatchEnrich] 函数被调用，segment=${segment?.id}，parsed存在=${!!parsed}，shots=${parsed?.shots?.length}，config存在=${!!config}，apiKey=${config?.apiKey ? '有' : '无'}`);
  if (!parsed || !parsed.shots || !parsed.shots.length) {
    enrichLog('[BatchEnrich] 跳过：无shots');
    return parsed;
  }
  if (!config || !config.apiKey) {
    enrichLog('[BatchEnrich] 跳过：无config或apiKey');
    return parsed;
  }
  enrichLog(`[BatchEnrich] 进入：${segment.id}，shots=${parsed.shots.length}，config.model=${config.model}`);

  const shots = parsed.shots;
  // [方案C验证] 强制始终运行AI Enrich，验证整条链路
  const needsEnrich = true;
  enrichLog(`[BatchEnrich] ${segment.id} needsEnrich=true（强制），shots=${shots.length}`);

  const systemPrompt = '你是一个专业的视频分镜导演，精通画面语言和声音设计。严格按格式输出，不要解释。';
  const userPrompt = buildBatchEnrichPrompt({ scene, segment, parsed, costumeCard, prevSegmentEnd });
  enrichLog(`[BatchEnrich] 准备调用AI，prompt长度=${userPrompt.length}`);

  try {
    const { callModel } = require('./aiClient');
    enrichLog(`[BatchEnrich] 调用callModel，model=${config.model}`);
    const modelResult = await callModel({ config, system: systemPrompt, user: userPrompt, temperature: config.temperature || 0.7, maxTokens: config.maxTokens || 16384 });
    const rawText = typeof modelResult === 'string' ? modelResult : String(modelResult.output || modelResult);
    enrichLog(`[BatchEnrich] AI返回长度=${rawText.length}，前200字：${rawText.slice(0, 200)}`);

    const enrichmentMap = parseBatchEnrichResult(rawText, shots);
    enrichLog(`[BatchEnrich] 解析结果，enrichment镜数=${Object.keys(enrichmentMap).length}：` + JSON.stringify(enrichmentMap));
    if (Object.keys(enrichmentMap).length === 0) {
      enrichLog('[BatchEnrich] 解析结果为空，不注入');
      return parsed;
    }

    const result = injectEnrichment(parsed, enrichmentMap);
    enrichLog(`[BatchEnrich] 注入完成，${segment.id} enrich成功`);
    
    // 写回AI生成的片段标题（segmentTitle）
    if (enrichmentMap && enrichmentMap.segmentTitle) {
      result.title = enrichmentMap.segmentTitle;
      enrichLog(`[BatchEnrich] 已更新标题：${enrichmentMap.segmentTitle}`);
    }
    
    return result;
  } catch (err) {
    enrichLog('[BatchEnrich] AI调用失败，降级到本地fallback: ' + err.message);
    return parsed;
  }
}

function buildStructuredRepairPrompt({ scene, segment, originalJsonText, report }) {
  return ['你要修复上一次JSON草稿。只输出修复后的完整JSON对象，不要解释，不要Markdown，不要```json代码块。', '注意：程序会把你的输出合并回固定骨架；不要新增/删除镜头，不要改no。重点修 visual/speakerAction/listenerReaction/physicalFeedback。', `片段：${segment.id}`, `校验问题：${summarizeStructuredReport(report)}`, '详细错误：', safeJsonStringify(report.errors || report), '修复原则：补齐演员互动；删除形容词/分析腔；删除来源越界；不要改台词原文和说话者。', '原JSON：', originalJsonText].join('\n\n');
}

module.exports = { TOOL_VERSION, E_FIXED, buildSegmentJsonUser, createSegmentSkeleton, mergeWithSkeleton, extractJson, extractJsonDetailed, stripJsonEnvelope, validateSegmentJson, summarizeStructuredReport, renderSegment, buildStructuredRepairPrompt, expectedPartsForSegment, enrichSegmentShots, buildBatchEnrichPrompt, parseBatchEnrichResult, injectEnrichment };
