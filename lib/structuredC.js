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
  if (/怎么可能/.test(text) && /傻子/.test(text)) {
    const m = text.match(/^(.*?怎么可能[？?])(.*?打错[？?])(?:s*(.*))?$/);
    if (m) parts = [m[1], m[2], m[3] || ''].map(x => x.trim()).filter(Boolean);
  }
  if (!parts.length && /大少爷，我没开玩笑/.test(text) && /世界乱套/.test(text)) {
    const m = text.match(/^(.*?总之，?)(.*)$/);
    if (m) parts = [m[1], m[2]].map(x => x.trim()).filter(Boolean);
  }
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
      style: '电影级唯美写实·短剧人物关系戏拍成大片光影·旧宅日外空间拥有精致空气感和层次光影·真实可拍但强调人物轮廓光、浅景深、空气介质和柔和高光，拒绝灰扑扑纪实和廉价短剧光',
      texture: '数字电影机模拟胶片·轻中颗粒·浅景深·人物面部、手机屏幕和手部动作清晰·背景院门、树影和外围人物明显虚化·亮部有柔和halation，高光轻微溢出但不爆白·焦外光斑柔软',
      material: baseMaterial || '手机玻璃冷白高反射，带指纹油渍和Fresnel边缘反光·灰砖墙、青石或水泥地面、旧木门保留粗糙纹理、微裂纹、砖缝积尘和接触阴影·衣料、发丝和皮肤在逆光下有柔和边缘高光·皮肤保留毛孔、轻微汗光和柔和SSS，不磨皮',
      light: '根据日外旧宅环境设计侧后方低角度主光，可偏暖也可随环境调整，不固定金光；优先形成逆光/侧逆光和发丝、肩线、衣缘轮廓光·前方由地面、墙面或门框反射柔和补光，面部暗侧被提亮但不打平，光比约1:2.5到1:3·手机屏幕近景提供冷白底光，与环境主光形成冷暖对比',
      atmosphere: '空气中有明显但克制的环境介质：旧宅用浮尘、树影和门框光束，潮湿场景用水汽，室内用窗光尘埃或轻烟·逆光照亮空气颗粒，人物周围形成柔和空气光晕·背景院墙和门廊被薄雾与浅景深轻微软化，暗部带少量青绿色冷调',
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
        style: '电影级唯美写实·短剧人物关系戏拍成大片光影·按旧宅日外环境设计精美光线与空气层次·真实可拍但拒绝灰扑扑纪实和廉价滤镜',
        texture: '数字电影机模拟胶片·轻中颗粒·浅景深·人物面部、手机屏幕和手部动作清晰·背景院门、树影和外围人物柔和虚化·亮部有克制胶片晕光',
        material: '手机玻璃冷白高反射并带指纹油渍和Fresnel边缘反光·灰砖墙、青石地面、旧木门保留粗糙纹理、砖缝积尘和AO·衣料、发丝、皮肤在逆光下有柔和边缘高光·皮肤有毛孔、轻微汗光与SSS透光感',
        light: '根据场景日外光源设计主光，优先使用侧后方或后方暖调日光制造逆光/侧逆光和人物轮廓光·前方由地面、墙面或水面反射柔和补光，面部暗侧有层次但不打平·手机屏幕近景提供冷白底光，与环境主光形成冷暖对比·光比约1:2.5到1:3.5',
        atmosphere: '空气中有与环境匹配的薄介质：旧宅可用浮尘、树影和门框光束，水边可用水汽，室内可用尘埃或香烟雾·逆光照亮空气颗粒，人物周围形成柔和光晕·背景被光雾和浅景深软化，暗部可带少量青绿色冷调',
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
      style: '现实短剧写实·旧宅日外灾变前兆·中高写实，画面强调日常空间被异常电话击穿后的压迫感，而不是通用短剧模板',
      texture: '数字拍摄模拟轻微胶片·中浅景深·人物脸部与手机屏幕优先清晰·院门和外围人物略虚化，保留轻微现场感但不做夸张手持晃动',
      material: '手机玻璃有冷白屏幕反光、指纹油膜和边缘 Fresnel·灰砖院门为高粗糙度哑光表面并有缺口积尘·粗糙水泥地低反光且有细砂颗粒·旧木门框漆面剥落，边角和脚边接触处 AO 加重·人物皮肤保留毛孔和轻微汗渍但不过度油亮',
      light: '画面左前上方日光被院墙和屋檐切割后进入，色温约5200K偏中性冷白；人物受光侧清晰、背光侧进入柔和阴影，光比约1:3.5；手机屏幕在近景中提供局部冷白补光，灰砖地面给下颌和手部少量漫反射，檐下、门框内侧、脚边地面接触处 AO 加重',
      atmosphere: '空气干燥略有尘感，无夸张灾难奇观；焦平面在说话人物面部与手机屏幕之间切换，背景院门压暗并略虚化，暗部带青灰冷调，让电话声和手机屏幕成为异常感来源',
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
    // If the transition tail “没关系，我还有别的电话。” starts this segment,
    // the following script action “又按下另外一个号码” is already carried by that
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
      // recut: 当“你们看，真的有丧尸！”被顺序前移到手机落地段时，
      // 必须先有“刀哥低头看手机并抬起”的接棒动作，再说这句台词，避免动作回退。
      if (/世界乱套|手机落地/.test(String(segment.title || segment.reason || '')) && /真的有丧尸/.test(String(entry.dialogue.text || ''))) {
        groups.push({ type: 'bridge', taskHint: '地面手机到刀哥手机接棒，刀哥低头看见短视频后抬手机', items: [], actionIds: [], actionTexts: [], duration: 2.2, baseIds: new Set(), text: '刀哥低头看见自己手机上的短视频，脸色一变，把手机抬向众人。' });
      }
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
    if (/短视频|大街|商场|马路|车窗/.test(text)) return carry ? '手机证据顶住前景' : '刀哥把手机举给众人';
    if (/手机落地|掉在地上|地面手机|摔在地面/.test(text)) return carry ? '手机坠地后冷光贴地' : '手机掉地成为失败锚点';
    if (/举到胸前|举起|屏幕朝向|真的有丧尸/.test(text)) return carry ? '举起手机把众人视线锁住' : '刀哥举手机变成公共证据';
    if (/欢迎来到|新时代/.test(text)) return carry ? '门框后的张玄接管解释权' : '张玄在院门一侧开口';
    if (/怎么可能/.test(text)) return carry ? '手机冷光闯进两人之间' : '赵一铭把手机顶到范思瑶面前';
    if (/傻子|打错/.test(text)) return carry ? '冷暖光压住两人关系' : '赵一铭收回手机反压范思瑶';
    if (/赵氏财团|专线|无人接听/.test(text)) return index === 0 ? '赵一铭贴耳等专线' : (carry ? '失败提示后冷光托住手机' : '赵一铭举屏确认失败提示');
    if (/按下|拨号|通讯录|号码/.test(text)) return carry ? '掌心冷光接到下一次拨号' : '赵一铭低头续拨下一个号码';
    if (index === 0) return carry ? '逆光尘埃压进首镜' : '从赵一铭与手机进入';
    if (index === total - 1) return carry ? '反应和光线一起压到落点' : '反应留在当前镜头里';
    if (/手机|屏幕|手指|落地|通话/.test(text) || group.type === 'insert') return carry ? '关键物件在柔焦里接棒' : '关键物件接到下一步动作';
    return carry ? '人物被光影和关系同时压住' : '人物动作接到下一句台词';
  }
  if (/短视频|大街|商场|马路|车窗/.test(text)) return '手机屏幕作为证据前景';
  if (/手机落地|掉在地上|地面手机|摔在地面/.test(text)) return '地面手机作为失败锚点';
  if (/举到胸前|举起|屏幕朝向|真的有丧尸/.test(text)) return '举手机成为公共证据';
  if (/欢迎来到|新时代/.test(text)) return '门框后景转为解释权中心';
  if (/怎么可能|傻子|打错/.test(text)) return '手机压入两人关系';
  if (/赵氏财团|专线|无人接听/.test(text)) return '手机失败提示撑住身份防御';
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

function inferPreviousFrame(scene, segment) {
  if (!segment || /A$/.test(segment.id || '')) return '首段无上一片段；赵一铭手机贴在耳边等待接通，范思瑶站在侧后方观察，张玄在院门一侧旁观，刀哥和打手在外围形成压力。';
  const title = String(segment.title || segment.reason || '');
  if (/第二次|最后底牌/.test(title)) return '上一段末帧停在赵一铭低头继续拨号，手机屏幕亮在胸前，范思瑶刚被手机屏幕逼近后向后让开半步。';
  if (/父亲/.test(title)) return '上一段末帧停在赵一铭找到父亲私人号码，拇指按下拨号键，手机重新贴向耳边，张玄仍在院门一侧看着他。';
  if (/世界乱套|手机落地/.test(title)) return '上一段末帧停在赵一铭听到父亲成丧尸后拿开手机，盯着屏幕否认现实，范思瑶和刀哥的注意力都压在那部手机上。';
  if (/短视频|新时代/.test(title)) return '上一段末帧停在刀哥已经把手机举到众人面前，屏幕朝外；赵一铭没有捡地上的手机，视线被刀哥屏幕吸住；范思瑶也转向刀哥手机，张玄仍站在院门一侧。';
  return '上一段末帧的动作和接棒物保持可见，本段从该接棒物的相反景别或角度进入。';
}
function inferFirstFramePlan(scene, segment) {
  const title = String(segment.title || segment.reason || '');
  if (/第一次/.test(title)) return '中景平视从祖宅门前空地进入，赵一铭站在院中央偏前，手机贴耳，忙音先进入画面。';
  if (/第二次/.test(title)) return '近景从赵一铭手部进入，手机屏幕在掌心发亮，拇指已经按向另一个号码，景别由上一段中景改为近景。';
  if (/父亲/.test(title)) return '中近景锁住赵一铭把手机贴回耳边的瞬间，等待音后电话接通，先听见刘秘书声音再看赵一铭向前压。';
  if (/世界乱套|手机落地/.test(title)) return '近景从赵一铭耳侧手机进入，电话声继续，赵一铭不再开口，只听刘秘书把警告说完。';
  if (/短视频|新时代/.test(title)) return '特写从刀哥已经举起的手机屏幕进入，直接展示竖屏短视频内容，景别与上一段中近景错开。';
  return '本片段第一镜从上一段接棒物进入，景别或视角必须和上一段末镜不同。';
}
function inferPositions(scene, segment) {
  const title = String(segment.title || segment.reason || '');
  if (/第一次/.test(title)) return [
    '赵一铭：画面中央偏前，面朝手机，右手把手机贴在耳边',
    '范思瑶：赵一铭侧后方半步，面朝赵一铭和手机',
    '张玄：院门一侧，距离赵一铭数步，没有上前',
    '刀哥：侧边外围位置，手里有自己的手机但尚未举起'
  ];
  if (/第二次|最后底牌/.test(title)) return [
    '赵一铭：画面中央偏前，身体略转向手机屏幕，低头拨另一个号码',
    '范思瑶：赵一铭侧后方，刚退开半步，仍看着赵一铭的手机',
    '张玄：院门一侧保持旁观，面朝赵一铭',
    '刀哥：侧边外围，手机低垂在胸前，暂时没有介入'
  ];
  if (/父亲/.test(title)) return [
    '赵一铭：院中央偏前，手机重新贴在耳边，身体朝前压',
    '范思瑶：赵一铭侧后方，视线落在赵一铭手机上',
    '张玄：院门一侧，站位不变，看着赵一铭最后一通电话',
    '刀哥：侧边位置，手里的手机还在胸前'
  ];
  if (/世界乱套|手机落地/.test(title)) return [
    '赵一铭：院中央偏前，手机从耳边慢慢放下，身体僵在原处',
    '范思瑶：赵一铭侧后方，视线在赵一铭和手机之间移动',
    '刀哥：侧边位置，开始低头看自己的手机',
    '张玄：院门一侧，没有靠近，只看着局面崩塌'
  ];
  if (/短视频|新时代/.test(title)) return [
    '刀哥：画面一侧向前半步，举起自己的手机，屏幕朝向众人',
    '赵一铭：院中央偏前，脚边是摔落的手机，面向刀哥手机屏幕',
    '范思瑶：赵一铭侧后方，先看刀哥手机再看张玄',
    '张玄：院门一侧保持旁观，准备在范思瑶看向他后接管全场'
  ];
  return ['核心说话人：承接上一段接棒物所在位置', '关键听者：保持上一段相对距离，面向核心说话人或物件'];
}
function inferStates(scene, segment) {
  const title = String(segment.title || segment.reason || '');
  if (/第一次/.test(title)) return [
    '赵一铭：右手握手机贴耳，正在等待专线接通',
    '范思瑶：想开口又收住，观察赵一铭的反应',
    '张玄：旁观不介入，等待电话失败的结果',
    '刀哥：外围压场，手机暂未举起'
  ];
  if (/第二次|最后底牌/.test(title)) return [
    '赵一铭：拇指在通讯录和拨号键之间移动，急着证明自己还能联系外界',
    '范思瑶：刚退后的脚还没有完全收回，不再追问',
    '张玄：身体不动，用一句话刺破赵一铭的底气',
    '刀哥：旁观，注意力在赵一铭手机和现场反应之间'
  ];
  if (/父亲/.test(title)) return [
    '赵一铭：把希望压到父亲私人电话上，接通后立刻下命令',
    '范思瑶：听电话反应，身体准备后退',
    '张玄：继续旁观，知道结果会落下',
    '刀哥：手里的手机在胸前，听到异常后准备介入'
  ];
  if (/世界乱套|手机落地/.test(title)) return [
    '赵一铭：听完刘秘书警告，手指松开，手机开始下滑',
    '范思瑶：先看赵一铭的手，再看即将落地的手机',
    '刀哥：低头打开自己的手机，准备展示外部视频',
    '张玄：保持旁观，等待证据出现'
  ];
  if (/短视频|新时代/.test(title)) return [
    '刀哥：把手机举给所有人看，屏幕朝外',
    '赵一铭：没有捡地上的手机，注意力被刀哥屏幕吸走',
    '范思瑶：被视频内容推着后退半步，再转头看张玄',
    '张玄：院门一侧保持旁观，等待众人视线从手机转向自己后接管解释权'
  ];
  return ['核心人物：承接上一段动作结果继续推进', '关键听者：保持可见基线动作，不抢主动作'];
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
  else if (/中景平视|祖宅门前/.test(ff)) directives.movement = '平视稳定推入';
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
    charactersLine: scene.cast && scene.cast.length ? scene.cast.map(x => '@' + x).join(' ') : '@张玄 @范思瑶 @赵一铭 @刀哥',
    title: segment.title || segment.reason || segment.id,
    sceneFeeling: segment.reason || '按可拍事件段推进',
    visualStyle,
    physics: defaultPhysics(scene, costumeCard, visualStyle),
    startingState: {
      space: `${scene.header || '场景'}。祖宅门前空地、灰砖院门、粗糙水泥地和手机作为当前场面调度底图。`,
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
    [/像一个观众在看一段并不意外的小品/g, '安静地看着赵一铭的反应'],
    [/等待旧秩序失效/g, '等待电话里的结果'],
    [/旧秩序失效/g, '电话没有接通'],
    [/空气变稠了/g, '院子里只剩电话等待音'],
    [/在听一段有趣的前奏/g, '听着电话等待音'],
    [/有趣的前奏/g, '电话等待音'],
    [/被这句话击中/g, '听完这句话后停住'],
    [/被击中/g, '停住'],
    [/视线在([^，。；]+)之间来回移动/g, '先看$1，随后停住'],
    [/视线来回/g, '视线停住'],
    [/手指相互捏着/g, '双手停在身前'],
    [/交叠的手指/g, '停在身前的双手'],
    [/手指绞在一起/g, '双手停在身前'],
    [/攥得更紧/g, '没有再动'],
    [/呼吸变浅/g, '停了一拍'],
    [/呼出的气流在阳光下可见白雾/g, '说话声落在院子里'],
    [/白雾/g, ''],
    [/咬住自己的指关节/g, '把手放回身侧'],
    [/咬手指/g, '把手放回身侧'],
    [/手按在胸口/g, '手停在身前'],
    [/手按胸口/g, '手停在身前'],
    [/抓住他的袖口/g, '站在原地'],
    [/抓张玄袖口/g, '站在原地'],
    [/靠到了张玄的手臂上/g, '停在张玄旁边'],
    [/几乎完全靠在张玄身上/g, '停在张玄旁边'],
    [/张玄冷笑加深/g, '张玄没有接话'],
    [/冷笑不变/g, '没有接话'],
    [/眉头/g, '视线'],[/皱眉/g, '停住'],[/震惊地/g, '停住后'],[/震惊/g, '停住'],[/表情凝重/g, '动作放慢'],[/眼神复杂/g, '视线停住'],[/复杂/g, '停住'],[/凝重/g, '放慢'],[/压迫感/g, '距离感'],[/仪式感/g, '停顿'],[/像是/g, ''],[/仿佛/g, ''],[/似乎/g, '']
  ];
  for (const [re, to] of replacements) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim();
}
const PLACEHOLDER_RE = /(当前关系位|台词从这个动作状态里自然说出|听者停住当前动作|把注意力落到说话者身上|旁边人物停在原地|承接上一句台词后的安静|人物关系在当前落点停住|准备接入下一段|画面中没有人物开口|焦点落在听到声音的人和手机上|手机或手部细节作为过渡|补足关系位|模板句)/g;

function cleanTemplateText(text) {
  return sanitizePerformanceText(String(text || '').replace(PLACEHOLDER_RE, '').replace(/\s+/g, ' ').trim());
}

function previousConcreteLine(shot) {
  const lines = shot.dialogueLines || [];
  return lines[0] || null;
}

function concreteActionVisual(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/刀哥拿手机|短视频/.test(t) && /大街|丧尸.*行走/.test(t)) return '刀哥把自己的手机举稳，屏幕朝向众人，竖屏画面里大街上的丧尸歪着头缓慢走动。';
  if (/忙音|嘟嘟/.test(t)) return '赵一铭把手机贴在耳边，听筒里的忙音一声接一声，他握手机的手没有放下。';
  if (/无人接听/.test(t)) return '手机仍贴在赵一铭耳边，系统提示音从听筒里传出，他把手机拿离耳侧看了一眼屏幕。';
  if (/愣住/.test(t)) return '赵一铭举着手机没动，原本要开口的嘴停住，目光落在屏幕上。';
  if (/另外一个号码|按下/.test(t)) return '赵一铭低头划开通讯录，用拇指点下另一个号码，手机屏幕亮在他掌心。';
  if (/脸色难看|汗珠/.test(t)) return '赵一铭把手机从耳边拿下，抬手擦过额角，再低头确认屏幕上的号码。';
  if (/再次拨通|等待音效|接通/.test(t)) return '赵一铭重新按下拨号键，把手机贴回耳边，等待音响了几声后突然接通。';
  if (/大惊|脸色陡变/.test(t)) return '赵一铭听到电话里的话后猛地抬头，握手机的手从耳边滑开。';
  if (/挂断|手机啪|掉在地上|失魂落魄/.test(t)) return '通话断开后赵一铭没有再说话，手机从他手里滑落，啪的一声砸在地面上。';
  if (/刀哥拿手机|短视频/.test(t)) return '刀哥低头看见自己手机上的短视频，脸色一变，把手机抬向众人。';
  if (/大街|丧尸.*行走/.test(t)) return '刀哥手机已经举稳在前景，竖屏画面里大街上的丧尸歪着头缓慢走动；赵一铭和范思瑶虚在屏幕后方，被迫看着这个证据。';
  if (/商场|撕咬/.test(t)) return '刀哥手机仍占前景，竖屏画面切到商场远景，丧尸扑倒路人，画面只保留远处混乱和倒地动作；赵一铭没有去捡脚边的手机。';
  if (/马路|追尾|车窗/.test(t)) return '手机短视频切到马路画面，车辆追尾停成一排，丧尸站在车外拍打车窗；地上的赵一铭手机和刀哥举起的手机一低一高，把失败和证据连在一起。';
  return t;
}

function concreteDialogueVisual(dl) {
  if (!dl) return '';
  const speaker = String(dl.speaker || '角色');
  const text = String(dl.text || '');
  const fullText = String(dl.originalText || text);
  const cueText = fullText || text;
  const vm = dl.voiceMode;
  if (vm === 'phone' || vm === 'vo' || vm === 'os') {
    if (/无人接听/.test(cueText)) return '赵一铭听着手机里的系统提示音，把手机从耳边拿下来，低头确认号码。';
    if (/喂，大少爷/.test(cueText)) return '电话接通的一瞬间，赵一铭把手机压紧到耳边，眼睛立刻抬起来。';
    if (/董事长/.test(cueText)) return '听筒里的声音断断续续，赵一铭握住手机的手指收紧，身体往前倾了一点。';
    if (/成丧尸/.test(cueText)) return '刘秘书的声音从听筒里冲出来，赵一铭原本贴紧耳边的手机滑开一小段，像是手上那点底气被抽走。';
    if (/没开玩笑/.test(text)) return '赵一铭把手机贴在耳边，刚才反驳的气势还没收住，但没有再打断电话。';
    if (/躲起来|世界乱套/.test(text)) return '赵一铭慢慢把手机从耳边放下，听筒声还在画面里持续。';
    if (/世界乱套|躲起来|没开玩笑/.test(cueText)) return '赵一铭举着手机听完刘秘书的警告，另一只手垂在身侧没有动作。';
    return '电话声音从手机听筒里传出，赵一铭把手机贴在耳边听完。';
  }
  if (/赵一铭/.test(speaker)) {
    if (/赵氏财团|专线电话/.test(text)) return '赵一铭把手机从耳边拿下半寸，先盯着失败提示确认自己没有听错；他把手机握回胸前，像是重新撑住赵氏财团这层身份，才抬眼看向范思瑶。';
    if (/24小时|无人接听/.test(text)) return '赵一铭把手机重新贴近耳边，像是要证明这个号码不可能出错。';
    if (/怎么可能/.test(text)) return '赵一铭猛地把手机屏幕推到范思瑶面前，屏幕冷光夹在两人之间。';
    if (/傻子|打错/.test(text)) return '赵一铭把手机收回胸前，没有立刻低头拨号，而是盯着范思瑶，把慌乱压回质问里。';
    if (/没关系|别的电话/.test(text)) return '赵一铭低头划开通讯录，拇指滑到下一个号码，在拨号键前停了半拍。';
    if (/还有一个|私人电话|一定能打通/.test(cueText)) return '赵一铭翻到父亲的私人号码，拇指停在拨号键上；他先看一眼张玄，再抬头强撑着把话说完。';
    if (/赶紧把电话给我爹/.test(cueText)) return '赵一铭听到接通声后像抓回一点底气，身体向前压了一步，握着手机直接下命令。';
    if (/我爹他怎么了/.test(cueText)) return '赵一铭把手机贴得更紧，刚才抬起的下巴落下来，追问听筒里的声音。';
    if (/荒唐|拍电影/.test(cueText)) return '赵一铭把手机从耳边拿开半寸，盯着屏幕反驳，声音还没完全稳住。';
    if (/怎么会这样/.test(cueText)) return '赵一铭看着刀哥举起的手机屏幕，脚边自己的手机还躺在地上，他没有弯腰去捡。';
  }
  if (/范思瑶/.test(speaker)) {
    if (/打错/.test(cueText)) return '范思瑶站在赵一铭侧后方，先看了一眼手机屏幕，再小心地抬眼看向赵一铭。';
    if (/丧尸末日/.test(cueText)) return '范思瑶盯着刀哥手机里的视频，往后退了半步，转头看向张玄。';
  }
  if (/张玄/.test(speaker)) {
    if (/不太好使/.test(cueText)) return '张玄倚在门边没有上前，只抬眼看着赵一铭手里的手机，开口点破他的失势。';
    if (/新时代/.test(cueText)) return '张玄等众人的视线从刀哥手机转到自己身上，才在院门一侧站稳；他双臂缓慢向外展开，面对院子里所有人。';
  }
  if (/刀哥/.test(speaker)) return '刀哥先低头确认自己手机里的短视频，再把手机举到胸前向前伸直，屏幕从个人手机变成众人面前的证据。';
  return `${speaker}转向正在听他说话的人，把这句台词说完。`;
}

function concreteReaction(shot) {
  const dl = previousConcreteLine(shot);
  const text = dl ? String(dl.text || '') : '';
  const cueText = dl ? String(dl.originalText || dl.text || '') : '';
  const speaker = dl ? String(dl.speaker || '') : '';
  const title = String(shot.segmentTitle || '');
  if (!dl) return '';
  if (dl.voiceMode === 'phone' || dl.voiceMode === 'vo' || dl.voiceMode === 'os') {
    if (/无人接听/.test(cueText)) return '赵一铭没有立刻说话，只把屏幕转向自己确认。';
    if (/喂，大少爷/.test(cueText)) return '赵一铭的肩膀先绷住，随后立刻向前压。';
    if (/董事长/.test(cueText)) return '赵一铭追问前先停了一拍，手机还压在耳边。';
    if (/成丧尸/.test(cueText)) return '范思瑶手抬到一半停住，向后退半步；刀哥原本低头看手机，动作也停住。';
    if (/没开玩笑/.test(text)) return '赵一铭握手机的手停在耳侧，眼神从不信转为空住；范思瑶看向那部还在通话的手机。';
    if (/躲起来|世界乱套/.test(text)) return '他低头看着屏幕，手指一点点松开，手机从掌心往下滑。';
    if (/世界乱套|躲起来/.test(cueText)) return '赵一铭听完后手指松开，手机开始从掌心往下滑。';
    return '赵一铭握着手机听完，没有打断。';
  }
  if (/赵一铭/.test(speaker)) {
    if (/赵氏财团|专线电话/.test(text)) return '范思瑶刚要开口，听到后半句时动作停住，视线被压回他手里的手机。';
    if (/24小时|无人接听/.test(text)) return '范思瑶看了一眼手机，又抬眼看向赵一铭。';
    if (/怎么可能/.test(text)) return '范思瑶先被屏幕挡住视线，脚下向后让了一小步。';
    if (/傻子|打错/.test(text)) return '范思瑶刚张口想解释，质问压过来，她的手停在身前，话收住，视线落回手机。';
    if (/没关系|别的电话/.test(text)) return '他按下拨号键，屏幕亮在掌心。';
    if (/私人电话|一定能打通/.test(cueText)) return '张玄没有接话，只看着赵一铭按下拨号键。';
    if (/赶紧把电话给我爹/.test(cueText)) return '电话那头没有立刻回应，赵一铭刚抬起的下巴停住，院子里只剩听筒里的杂音。';
    if (/我爹他怎么了/.test(cueText)) return '范思瑶看向赵一铭的手机，刀哥也停下手里的动作。';
    if (/荒唐|拍电影/.test(cueText)) return '范思瑶和刀哥没有接话，注意力都停在赵一铭手里的手机上。';
    if (/怎么会这样/.test(cueText)) return '范思瑶看向手机屏幕，刀哥把举着的手机稍微放低。';
  }
  if (/范思瑶/.test(speaker)) {
    if (/打错/.test(cueText)) return '赵一铭听完立刻回头，手机还握在手里。';
    if (/丧尸末日/.test(cueText)) return '张玄没有回答，仍站在院门一侧，等范思瑶的视线落到自己身上后才把身体站稳。';
  }
  if (/张玄/.test(speaker)) {
    if (/新时代/.test(cueText)) return '赵一铭站在原地没有再说话，脚边的手机还亮着；范思瑶和刀哥都看向张玄，刀哥手里的手机停在半空。';
    return '赵一铭听到这句话后低头看向手机，重新翻找号码。';
  }
  if (/刀哥/.test(speaker)) return '赵一铭没有去捡地上的手机，视线被刀哥举起的屏幕吸走；范思瑶也转向刀哥手机，现场注意力从地面手机转到证据屏幕。';
  return '';
}

function groundPhoneAvailableForShot(shot) {
  const title = String(shot.segmentTitle || '');
  const text = [shot.task, ...(shot.actionTexts || []), ...(shot.dialogueLines || []).map(x => x.text), ...(shot.dialogueLines || []).map(x => x.originalText)].join(' ');
  if (/地上手机|地面手机|脚边的手机/.test(text)) return true;
  if (/落地|掉在地上|滑落|摔在地面|啪的一声/.test(text)) return true;
  if (/短视频|新时代/.test(title)) return true;
  if (/世界乱套|手机落地/.test(title)) return Number(shot.no || 0) >= 3;
  return false;
}
function isPoeticCarryShot(shot) {
  const total = Number(shot.segmentShotCount || 0) || Number(shot.no || 1);
  const idx = Math.max(0, Number(shot.no || 1) - 1);
  return isPoeticCarryIndex(idx, total);
}

function concretePhysicalFeedback(shot) {
  const currentText = [shot.task, shot.audioMode, ...(shot.actionTexts || []), ...(shot.dialogueLines || []).map(x => x.text), ...(shot.dialogueLines || []).map(x => x.originalText)].join(' ');
  const text = [currentText, shot.segmentTitle].join(' ');
  const isPoetic = shot.visualStyle === 'poetic';
  const carry = isPoetic && isPoeticCarryShot(shot);
  const groundPhoneReady = groundPhoneAvailableForShot(shot);
  if (isPoetic) {
    if (/赵氏财团|专线|无人接听/.test(text)) return carry ? '手机冷白光照在手指和下颌，后方空气光雾把肩线轻轻托住。' : '手机冷白光贴在手指和下颌边缘。';
    if (/打错|赵少/.test(text)) return carry ? '手机和肩膀压在前景边缘，人物侧脸被轮廓光勾出来。' : '手机停在两人之间，前后景层次被拉开。';
    if (/怎么可能/.test(text)) return carry ? '手机冷光夹在两人之间，后方逆光勾出发丝和衣缘。' : '手机屏幕顶到前景，两人之间只剩一块冷白屏幕。';
    if (/傻子|这种电话也能打错/.test(text)) return carry ? '环境主光从肩后漫开，面部暗侧被地面反射光柔和托住。' : '环境主光落在肩后，手机还握在胸前。';
    if (/掉在地上|落地|裂/.test(currentText)) return carry ? '手机落地后冷白反光贴着灰尘，粗糙地面被后景光雾轻轻托开。' : '手机落地后屏幕朝上，冷白反光贴着粗糙地面。';
    if (/短视频|大街|商场|马路|车窗/.test(text)) {
      if (groundPhoneReady && carry) return '地面那部失效手机贴着灰尘发冷光，前景屏幕和后景人物被光雾分开。';
      return carry ? '手机屏幕作为清晰前景，后景人物被浅景深和空气光雾包住。' : '屏幕内容保持清晰，后景人物略虚。';
    }
    if (/新时代|丧尸末日|怎么会这样/.test(text)) {
      if (groundPhoneReady) return carry ? '门框后的光把张玄从后景托出来，脚边那部手机留在冷白反光里。' : '脚边那部手机没有人去捡，众人视线被前景屏幕压住。';
      return carry ? '门框后的光把张玄从后景托出来，前景手机把众人视线锁在同一条线上。' : '众人视线从前景屏幕转向张玄。';
    }
    if (/拨|号码|屏幕|手机/.test(text)) return carry ? '手机冷光亮在掌心，背景化成柔软光斑和细小浮尘。' : '手机冷光亮在掌心。';
    if (Number(shot.no) === 1 && carry) return '逆光穿过门框和树影，空气里的细微尘埃在人物发丝和肩线边缘发亮。';
    return carry ? '背景被轻微光雾软化，人物轮廓和关键物件都保持清楚。' : '';
  }
  if (/掉在地上|落地|裂/.test(currentText)) return '手机屏幕朝上停在粗糙地面，冷白反光贴着地面灰尘。';
  if (/短视频|大街|商场|马路|车窗/.test(text)) return '手机屏幕冷光只照到持机人的手指边缘。';
  if (/拨|号码|屏幕|手机/.test(text)) return '手机屏幕冷白反光贴着手指边缘。';
  return '';
}


function isSoundLike(text) {
  return /声音|声|音|听筒|忙音|等待音|提示音|电话|杂音|风声|脚步|衣料|落地|原声|BGM|配乐|静音|留白|抽空|压低/.test(String(text || ''));
}

function concreteSoundDesign(shot) {
  const text = [shot.task, shot.audioMode, shot.segmentTitle, ...(shot.actionTexts || []), ...(shot.dialogueLines || []).map(x => x.text), ...(shot.dialogueLines || []).map(x => x.originalText)].join(' ');
  if (/无人接听|忙音|系统提示/.test(text)) return '忙音贴近听筒，系统提示声清晰，院子风声压低。';
  if (/喂，大少爷|等待音|接通/.test(text)) return '等待音几声后接通，刘秘书声音带电话压缩感。';
  if (/董事长他|他成丧尸了|没开玩笑|躲起来|世界乱套/.test(text)) return '电话杂音断续，刘秘书声音发闷；关键词后环境声短暂抽空半拍。';
  if (/落地|掉在地上|啪/.test(text)) return '手机落地声清晰短促，余响很短，不加夸张冲击音。';
  if (/短视频|大街|商场|马路|车窗|真的有丧尸/.test(text)) return '手机短视频原声压低，只保留远处混乱声作底。';
  if (/按下|拨号|通讯录|号码/.test(text)) return '按键声和屏幕轻触声清晰，院子风声保持低底噪。';
  if (/怎么可能|傻子|打错|赵氏财团|私人电话|赶紧把电话给我爹|荒唐/.test(text)) return '人物台词压住环境底噪，手机握持摩擦很轻。';
  if (/新时代|丧尸末日|怎么会这样/.test(text)) return '手机视频原声压低，院子风声留在底层，无BGM。';
  return '环境风声低底噪，衣料和脚步声按动作轻保留。';
}

function concreteFillerVisual(shot) {
  const title = String(shot.segmentTitle || '');
  const no = Number(shot.no || 0);
  const task = String(shot.task || '');
  if (/世界乱套|手机落地/.test(title)) {
    return '手机落地后屏幕朝上亮着，范思瑶先看赵一铭垂下的手；刀哥站在侧边，低头看见自己手机上的短视频，脸色一变，把手机抬向众人。';
  }
  if (/第二次失败|最后底牌/.test(title)) {
    if (/INSERT|关键物件/.test(task)) return '赵一铭的拇指停在父亲私人号码上方，按下前先停了一拍。';
    return '赵一铭按下拨号键，把手机重新贴回耳边；院子里安静下来，只剩短暂等待音。';
  }
  if (/第一次/.test(title)) {
    if (/INSERT|关键物件/.test(task)) return '手机屏幕停在通讯录页面，赵一铭的拇指滑到下一组号码。';
    return '范思瑶退开的动作停住，赵一铭低头继续拨号，把下一通电话接到画面里。';
  }
  if (/短视频/.test(title)) {
    if (/INSERT|关键物件/.test(task)) return '刀哥手机屏幕被举在众人面前，竖屏画面继续播放，进度条和界面不显示任何可读文字。';
    return '众人的视线停在刀哥手机屏幕上，张玄保持站直，不再重复起身动作。';
  }
  if (/父亲成丧尸/.test(title)) return '赵一铭握着手机的手停在耳边，听筒里只剩短促的杂音。';
  return '手机、人物动作和下一句台词之间形成清楚的接棒。';
}

function fallbackVisual(shot) {
  const action = (shot.actionTexts || []).filter(Boolean).join(' ');
  const line = (shot.dialogueLines || [])[0];
  if (action) return concreteActionVisual(action);
  if (line) return concreteDialogueVisual(line);
  if (/听者独立反应|关键物件|手部INSERT|INSERT|余震|接棒/.test(shot.task || '')) return concreteFillerVisual(shot);
  if (shot.task && !/台词承载|动作承载/.test(shot.task)) return cleanTemplateText(shot.task);
  return '人物完成上一动作后停在画面里，手机或屏幕成为下一步动作的接棒物。';
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
  return [
    '【AGENT_C v3.1.3-recut最小空间连续模式】只输出合法JSON对象，不要Markdown。',
    '程序已经锁定片段、镜头数、台词、说话人、A画面物理系统和E限制。',
    '你只能为每个镜头填写 visual、listenerReaction、physicalFeedback、sound；不要写台词原文，不要写D编号，不要新增剧情。physicalFeedback只写必要视觉物理补充；sound只写当前镜头声音设计。',
    '正式输出会由程序从台词账本插入台词，因此你的visual里严禁出现任何引号台词。',
    '【当前片段唯一允许素材】',
    allowed.join('\n') || '无台词动作段',
    '【固定骨架】',
    safeJsonStringify({ ...skeleton, shots: skeleton.shots.map(editableFieldsFromShot), debugCoverage: undefined }),
    '【表演因果要求】只写具体可拍动作。每个有台词/VO/证据的镜头必须写清：说话者或声音进入前的状态、原台词作用到谁、画面里发生什么可见变化。台词不是凭空念出来，要从手机失败、身份防御、质疑、证据、门框后景等状态里出来。听者反应不能只写看向谁，要写动作被打断、话收住、手停住、脚退半步、手机停在半空或视线被物件压住。前景/后景只在有关系功能时使用：手机屏幕压迫人物或成为证据，地面手机是失败锚点，门框/院门让张玄后景压场并最后接管解释权。换说话人保留0.3-0.6秒消化拍，但不整体拖慢；15秒略挤时前移转场型尾句，不切核心冲突。唯美模式下每个片段只允许3-4个镜头显性写光影/空气承载，其余镜头把风格隐含在动作、物件和前后景关系里，禁止每镜复读逆光、浮尘、光雾、冷暖对比。镜头movement必须写成具体动作标题，例如“赵一铭把手机顶到范思瑶面前”“刀哥举手机变成公共证据”，禁止抽象标题如“人物状态进入光影层次”“光影落点并入反应”。物件必须遵守状态连续性：没掉地前不能写地面手机，没举起前不能写屏幕朝向众人。禁止汗珠/捏袖口/手指一根根松开/空气变稠/旧秩序失效；严禁“当前关系位”等模板句。第一镜必须承接固定骨架startingState.firstFramePlan的景别和动作方向，但严禁原文复制startingState.firstFramePlan；必须转译成具体可拍动作句。',
    '【C括号声音规则】正式输出中每镜括号只放 sound：只写当前镜头声音设计，例如电话声、忙音、提示音、物件音、脚步、衣料、风声、短视频原声、短暂静音、声场远近或压低处理。禁止在括号里写视觉补充、表演解释、重复限制；禁止每镜复读同一句声音模板。\n\n【禁止】不得使用当前片段以外的台词或动作；不得输出analysis、scene_plan、规划表、模板句。'
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
  s = s.split(/[·；;。]/).map(x => x.trim()).filter(x => x && !x.includes('…') && !/“[^”]*$/.test(x)).join('·');
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
  if (!st) return '空间：张家祖宅日外院落。\n人物位置：按剧本人物关系站位。';
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
  const speaker = String(dl.speaker || '').trim();
  if (dl.voiceMode === 'phone') return `电话里传来${/刘秘书/.test(speaker) ? '刘秘书的声音' : '声音'}：“${line}”`;
  if (dl.voiceMode === 'vo' || dl.voiceMode === 'os') return `画面中无人开口，${speaker || '声音'}传来：“${line}”`;
  if (dl.voiceMode === 'spoken_split') return `${speaker || '角色'}：“${line}”`;
  return `${speaker || '角色'}：“${line}”`;
}
function renderShotLine(shot) {
  const duration = shot.duration || '2s';
  const size = shot.shotSize || '中景';
  const movement = shot.movement || '停住见证';
  const lens = shot.lens || '50mm';
  const visual = cleanupChinesePunctuation(cleanTemplateText(String(shot.visual || '').replace(/[“\"].+?[”\"]/g, '').trim()));
  const actions = (shot.actionTexts || []).map(t => cleanupChinesePunctuation(cleanTemplateText(concreteActionVisual(t)))).filter(Boolean).join('\n');
  const dialogue = (shot.dialogueLines || []).map(renderDialogueLine).filter(Boolean).join('\n');
  const listener = cleanupChinesePunctuation(cleanTemplateText(String(shot.listenerReaction || '').trim()));
  const speakerAction = cleanupChinesePunctuation(cleanTemplateText(String(shot.speakerAction || '').trim()));
  let phys = cleanupChinesePunctuation(cleanTemplateText(String(shot.physicalFeedback || '').trim()));
  let sound = cleanupChinesePunctuation(cleanTemplateText(String(shot.sound || '').trim()));
  if (!sound && phys && isSoundLike(phys)) { sound = phys; phys = ''; }
  if (!sound) sound = concreteSoundDesign(shot);
  sound = sound.replace(/[（）]/g, '').replace(/不加入情绪化音效。?/g, '').replace(/无背景音乐。?/g, '无BGM。').trim();
  const parts = [];
  if (visual) parts.push(visual);
  if (!visual && actions) parts.push(actions);
  if (speakerAction) parts.push(speakerAction);
  if (phys && !isSoundLike(phys)) parts.push(phys);
  if (dialogue) parts.push(dialogue);
  if (listener) parts.push(listener);
  let body = cleanupChinesePunctuation(parts.filter(Boolean).join('\n'));
  if (sound) body += `${body ? '\n' : ''}（声音：${sound}）`;
  return cleanupChinesePunctuation(`镜${shot.no || ''}  ${duration} · [${size}] ${movement}  焦段${lens}\n${body}`);
}
function diversifySound(sound, shot, idx, prev) {
  let s = String(sound || '').trim();
  if (!s || s !== prev) return s;
  const text = [shot.segmentTitle, shot.task, ...(shot.actionTexts || []), ...(shot.dialogueLines || []).map(x => x.text)].join(' ');
  if (/无人接听|忙音|系统提示/.test(text)) return idx % 2 ? '提示声尾音断开，院子风声短暂露出。' : '忙音贴近听筒，系统提示声清晰。';
  if (/短视频|大街|商场|马路|车窗|真的有丧尸/.test(text)) return idx % 2 ? '短视频原声压低，远处混乱声作底。' : '手机外放很低，只留下画面里的嘈杂底噪。';
  if (/董事长他|他成丧尸了|没开玩笑|躲起来|世界乱套/.test(text)) return idx % 2 ? '电话声发闷，杂音断续，院子风声被压低。' : '关键词落下后，环境声短暂抽空半拍。';
  if (/按下|拨号|通讯录|号码/.test(text)) return idx % 2 ? '指尖滑屏声清晰，按键声很轻。' : '按键声短促，院子风声回到底层。';
  if (/怎么可能|傻子|打错|赵氏财团|私人电话|赶紧把电话给我爹|荒唐/.test(text)) return idx % 2 ? '台词压过环境底噪，尾字后留半拍安静。' : '手机握持摩擦很轻，环境声贴在底层。';
  return idx % 2 ? '环境风声保持低底噪。' : '衣料和脚步声按动作轻保留。';
}

function renderSegment(obj) {
  const chars = obj.charactersLine || '@张玄 @范思瑶 @赵一铭 @刀哥 @张家祖宅';
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
  return [chars, '', `【${title.startsWith('片段') ? title : '片段' + title}】${obj.sceneFeeling ? `\n（场景感受：${obj.sceneFeeling}）` : ''}`, '', '【A】画面物理系统：', renderPhysics(obj.physics, obj.visualStyle || obj.physics?.visualStyle || 'plain'), '', '【B】起始状态：', renderStartingState(obj.startingState), '', '【C】镜头序列：', '', renderedShots.join('\n\n'), '', '【E】限制指令：', eShort].join('\n').trim();
}
function buildStructuredRepairPrompt({ scene, segment, originalJsonText, report }) {
  return ['你要修复上一次JSON草稿。只输出修复后的完整JSON对象，不要解释，不要Markdown，不要```json代码块。', '注意：程序会把你的输出合并回固定骨架；不要新增/删除镜头，不要改no。重点修 visual/speakerAction/listenerReaction/physicalFeedback。', `片段：${segment.id}`, `校验问题：${summarizeStructuredReport(report)}`, '详细错误：', safeJsonStringify(report.errors || report), '修复原则：补齐演员互动；删除形容词/分析腔；删除来源越界；不要改台词原文和说话者。', '原JSON：', originalJsonText].join('\n\n');
}

module.exports = { TOOL_VERSION, E_FIXED, buildSegmentJsonUser, createSegmentSkeleton, mergeWithSkeleton, extractJson, extractJsonDetailed, stripJsonEnvelope, validateSegmentJson, summarizeStructuredReport, renderSegment, buildStructuredRepairPrompt, expectedPartsForSegment };
