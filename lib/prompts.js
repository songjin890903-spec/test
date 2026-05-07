const fs = require('fs');
const path = require('path');
const { manifestToText, dialogueTable, allocateSegments, stripPunctuation } = require('./parser');
const { buildSourceLedger } = require('./sourceLedger');
const { buildPerformancePlan } = require('./performancePlanner');
const { buildShotPlan } = require('./shotPlanner');

const PROMPT_DIR = path.join(__dirname, '..', 'prompts');
function readPrompt(name) {
  return fs.readFileSync(path.join(PROMPT_DIR, name), 'utf8');
}

function originalBlock(title, name) {
  const text = readPrompt(name);
  return `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n【${title}】\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${text}`;
}

function buildAgentASystem({ mode = 'ai' }) {
  const base = readPrompt('agent_a_guard.md');
  const original = mode === 'director' ? 'agent_a_director.original.md' : 'agent_a.original.md';
  return `${base}${originalBlock(mode === 'director' ? '用户AGENT_A导演讲戏完整规则' : '用户AGENT_A无导演完整规则', original)}`;
}

function buildAgentAUser({ manifest, mode = 'ai', directorNotes = '' }) {
  return [
    `模式：${mode === 'director' ? '导演讲戏模式' : 'AI自动分析模式'}`,
    '【锁定剧本】以下剧本行ID不可删除、不可改写：',
    manifestToText(manifest),
    mode === 'director' ? `【导演讲戏文本】\n${directorNotes || '（无）'}` : '',
    '【任务】严格按用户AGENT_A原始完整规则生成输出。若本地自动化需要跳过“等用户确认”，也必须保留AGENT_A原格式：剧魂定位卡/批注剧本/逐行核查/批注摘要。重点写好场景感受、动作线设计、人物内心、禁止项。注意：台词清单由本地parser在你输出后自动追加为权威账本；你可以不自行重写完整台词清单，严禁改写原剧本台词。'
  ].filter(Boolean).join('\n\n');
}

function buildAgentBSystem() {
  return `${readPrompt('agent_b_guard.md')}${originalBlock('用户AGENT_B完整规则', 'agent_b.original.md')}`;
}

function buildAgentBUser({ manifest, annotatedScript, visualStyle = 'plain' }) {
  return [
    '【锁定剧本】',
    manifestToText(manifest),
    '【AGENT_A批注】',
    annotatedScript || '（无）',
    `【视觉风格选择】${visualStyle === 'poetic' ? '唯美：电影级氛围。要求根据具体环境设计精美光影，不等于一律金光；旧宅可用逆光浮尘、门框光束、树影、墙面/地面反射，水边可用水汽与镜面反射，室内可用窗光、尘埃、纱帘或烟雾。必须强调空气介质、人物轮廓光、柔和补光、前后景虚实、材质高光、halation/bloom和电影化高光滚降。禁止写“不追求唯美”“无体积光”“无晕光”“不形成明显发光边缘”“冷感基调”等克制纪实语句。禁止把唯美误解成廉价滤镜、过曝、塑料皮肤或无来源炫光。' : '朴实：克制写实。要求真实可拍、材质和光源明确，避免过度唯美滤镜，但仍要有具体光源、色温、光比、GI/AO、材质反射和渲染约束。'}`,
    '【任务】按 AGENT_B v3.0 视觉设计权威版生成输出：先输出完整视觉资产卡，再输出【给AGENT_C的干净资产卡】。场景部分必须主动生成完整【画面物理系统】A_FULL：画风、影像质感、材质、光、氛围、渲染六行必须具体到审美方向、PBR材质、主光来源/方向/色温/光比、GI/AO、景深、暗部色彩和渲染约束。严禁输出“写实短剧质感”“日外自然光”“手机玻璃有反光”等低信息量A。A_FULL 必须完整短句，禁止出现省略号、截断句、[补充]残留、半截引号。此块是 AGENT_C 的【A】画面物理系统唯一母版，必须具体、可复制、不可省略，但不得混入站位、画幅、镜头偏好、人物调度。人物部分要克制，未确认的五官/身高/服装/车辆/武器/纹身不得写成硬锁定。禁止输出分镜、镜号、重复台词清单、模型自我分析过程。'
  ].join('\n\n');
}

function buildAgentCSystem({ sceneType = 'wenxi' }) {
  // v3.0 hard-lock runtime: do not load the old core/wenxi/wuxi stack into C.
  // The old stack contains analysis/scene_plan/debug instructions that conflict with clean output.
  return [
    readPrompt('agent_c_guard.md'),
    '【AGENT_C v3.1.3-recut-stable-performance-causality硬锁运行时】',
    '只接受程序预填的片段骨架。不得输出analysis、scene_plan、本场规划总览、自检清单。',
    '台词、说话人、重切后的片段边界、镜头数量、15秒总时长、C-A画面物理系统和E限制均由程序锁定。',
    '模型如被调用，只能补低密度画面动作，不得写台词原文，不得新增剧情。禁止补写台词；当片段不够15秒时，只能由程序把后续原剧本台词按顺序前移。若只是略挤，优先前移“转场型尾句”，不得切散当前片段的核心冲突台词。前移后后续片段删除该台词，并同步更新后续B起始状态，下一片段不能重复已完成动作。',
    '正式输出由白名单renderer生成，只保留@角色、片段标题、A、B、C、D、E。'
  ].join('\n');
}

function splitDialogueIntoParts(d) {
  const text = String(d.text || '').trim();
  if (!text) return [];
  const duration = Number(d.duration || 0);
  const isShortSystemVo = (d.channel === 'vo' || /VO|旁白|画外音/.test(String(d.speaker || ''))) && /无人接听|忙音|系统/.test(text) && Array.from(text).length <= 18;
  if (duration <= 3 || isShortSystemVo) return [{ id: d.id, text, mode: '单镜号可承载' }];
  const rawParts = text
    .split(/(?<=[，。！？、；…]|\.\.\.)/)
    .map(x => x.trim())
    .filter(Boolean);
  const targetParts = duration > 8 ? 3 : 2;
  let parts = rawParts.length >= targetParts ? rawParts : [];
  if (!parts.length) {
    const chars = Array.from(text);
    const size = Math.ceil(chars.length / targetParts);
    for (let i = 0; i < chars.length; i += size) parts.push(chars.slice(i, i + size).join(''));
  }
  // Merge into targetParts buckets to avoid too many tiny fragments.
  if (parts.length > targetParts) {
    const buckets = Array.from({ length: targetParts }, () => '');
    parts.forEach((p, i) => { buckets[Math.min(targetParts - 1, i % targetParts)] += p; });
    parts = buckets.filter(Boolean);
  }
  return parts.map((p, i) => ({
    id: `${d.id}-${i + 1}`,
    text: p,
    mode: i === 0 ? '起始镜号' : (duration > 8 && i >= 1 ? '必须声画分离/反打/听者反应' : '切镜/反打/听者反应')
  }));
}

function buildDialogueCarryPlan(scene) {
  const lines = [];
  lines.push('【台词预算与承载表·强制执行】');
  lines.push('规则：先算整片段15秒总预算，再算单句承载时长。除最后一片段外必须填满15秒；片段边界可以按15秒容量重切，但只能使用原剧本台词。禁止补写台词、改写台词、重复台词。当前片段台词不足或表演层导致略挤时，必须从后续剧本中按原始顺序前移尚未使用的原台词；优先前移“转场型尾句”，不要切走当前片段的核心冲突台词。前移后后续片段删除该台词，并同步更新后续B起始状态，下一片段不能重复已完成动作。填满优先给台词镜头和强动作镜头，弱反应/物件/接棒镜最多合并成一个，禁止连续堆空镜。短台词不硬拉长，长台词不塞进2秒镜头；禁止把单个VO或纯反应镜头硬拉到5秒以上。换说话人保留0.3-0.6秒交接拍，但不能把全段拖慢。以下每个子段必须写进C部分镜号，同一长台词拆分后动作必须递进，禁止重复同一动作。');
  for (const d of scene.dialogues) {
    const flag = d.duration > 8 ? '按15秒预算判断是否拆分，拆分后动作递进' : d.duration > 3 ? '可单镜压缩承载或语义拆分' : '单镜号可承载';
    lines.push(`${d.id} ${d.speaker}${d.state ? '（' + d.state + '）' : ''}：“${d.text}” 去标点${d.charCount}字 最短${d.duration}s → ${flag}`);
    const parts = splitDialogueIntoParts(d);
    for (const part of parts) {
      const soundPic = d.duration > 8 && !part.id.endsWith('-1') ? '【声画分离】' : '';
      lines.push(`  └─ ${part.id} ${soundPic}${part.mode}：${part.text}`);
    }
  }
  return lines.join('\n');
}

function buildInteractionRequirements(scene) {
  const cast = scene.cast && scene.cast.length ? scene.cast.join("、") : [...new Set(scene.dialogues.map(d => d.speaker.replace(/[（）]/g, "")))].join("、");
  return [
    "【表演因果层·执行】",
    `本场人物：`,
    "1. 生成镜头前先判断台词/VO/证据的戏剧功能：身份防御、试探质疑、压迫反驳、转场续拨、权力嘲讽、最后底牌、反转消息、否认现实、生存警告、证据公开、现实崩塌、末日命名、解释权接管。",
    "2. 每个有台词/VO/证据的镜头必须形成表演因果链：说话者或声音进入前的状态 → 原台词/原声音 → 被作用对象 → 可见变化。",
    "3. 听者反应不能只写‘看向谁’，要写动作被打断、话收住、手停住、脚退半步、手机停在半空或视线被物件压住。",
    "4. 前景/后景不是装饰，只在有关系功能时使用：赵一铭手机是身份外壳，手机屏幕可压迫范思瑶；地面手机是失败锚点；刀哥手机是公共证据；门框/院门让张玄后景压场并最后接管解释权。",
    "5. 换说话人保留0.3-0.6秒消化拍，避免一人说完另一人马上接；但不要把全段拖慢。15秒略挤时优先前移转场型尾句，不切走当前片段核心冲突。",
    "6. 每镜只保留一个主表演因果和一个可见落点，禁止堆表情、堆心理、堆无意义前后景；禁止汗珠/喉结/瞳孔/手指一根根松开等AI感细节。",
    "",
    "【镜头层次轻量规则】",
    "1. 镜头运动要有戏剧动机：手机压近、人物停住、证据被举起、视线从手机转到张玄。不要为了丰富而滑动/横移。",
    "2. 焦段服务任务：35mm空间/多人；50mm中景关系；85mm近景表演；100mm手机/手指/屏幕INSERT。",
    "3. 高潮句后禁止补弱镜或动作回退镜；需要时长时，把反应并入高潮句所在镜头。"
  ].join("\n");
}

function buildProgramPlan(scene) {
  const segments = allocateSegments(scene);
  const total = scene.dialogues.reduce((sum, d) => Math.round((sum + (d.duration || 0)) * 10) / 10, 0);
  const lines = [];
  lines.push('【v1.0结构固化计划·已确认】');
  lines.push('定位：A是导演理解层，B是视觉资产层，Planner是副导演/表演指导/摄影任务表，C只负责把结构表执行成最终镜头提示词。');
  lines.push(`场景：${scene.id} ${scene.header}`);
  lines.push(`场景类型：${scene.sceneType === 'wuxi' ? '武戏' : '文戏'}；正式台词${scene.formalDialogues.length}条；全部台词${scene.dialogues.length}条；动作行${scene.actions.length}条`);
  lines.push(`全场台词总时长：约${total}s`);
  lines.push(`片段数下限：${segments.length}个`);
  lines.push('');
  lines.push(buildSourceLedger(scene));
  lines.push('');
  lines.push(buildDialogueCarryPlan(scene));
  lines.push('');
  lines.push(buildPerformancePlan(scene));
  lines.push('');
  lines.push(buildShotPlan(scene));
  lines.push('');
  lines.push(buildInteractionRequirements(scene));
  lines.push('');
  lines.push('【程序片段承载表】');
  for (const seg of segments) {
    const ds = seg.dialogueIds.map(id => scene.dialogues.find(x => x.id === id)).filter(Boolean);
    lines.push(`片段${seg.id}：承载 ${ds.map(d => d.id).join('、') || '无台词'}，台词时长约${seg.duration}s；必须按台词预算、表演表、镜头任务表执行，不得临场重分配。`);
  }
  lines.push('');
  lines.push('说明：以上前置计算已视为用户确认。不要再输出【前置计算确认】、规划表或解释，直接输出片段正文。但正文必须严格执行上方结构表。');
  return lines.join('\n');
}
function buildAgentCUser({ manifest, scene, annotatedScript, costumeCard, forbiddenTerms = [] }) {
  return [
    `【当前场景】${scene.id} ${scene.header}`,
    buildProgramPlan(scene),
    '【锁定剧本·事实边界】以下事实不可删除、不可改写；但 C 部分仍需按照用户原始 C 规则做三层缝合镜号，不得写成摘要：',
    manifestToText(manifest, [scene.id]),
    '【台词账本·校验用】所有台词必须逐字覆盖一次；长台词按Dxxx-1/Dxxx-2子段覆盖；C正文中必须使用 台词[Dxxx-1] 角色：“原文片段” 格式：',
    dialogueTable(scene) || '无台词',
    '【AGENT_A清洗输出】C只从这里读取有效批注、场景感受、动作线、人物内心、禁止项和系统parser硬账本；不得读取模型自我分析过程：',
    annotatedScript || '（无）',
    '【AGENT_B清洗资产卡】C只能读取这里的【给AGENT_C的干净资产卡】内容；不得使用B完整长文中的未确认补充：',
    costumeCard || '（无；若无，只能使用锁定剧本中的现实地点与保守现实主义参数，不得新增地点/奇观）',
    forbiddenTerms.length ? `【额外禁用词】${forbiddenTerms.join('、')}` : '',
    '【最终任务】严格按用户原始 C/core/wenxi/wuxi 规则输出本场片段正文。不要输出前置计算、规划、解释、<think>、<analysis>、<scene_plan>。不要简写成[1]镜头表。每个常规文戏片段除最后一段外必须填满15秒；台词不足或表演层略挤时先按原剧本顺序前移后续台词，优先前移转场型尾句，前移后后续片段删除，禁止补写；弱空镜最多合并成一个；镜头必须三层缝合并含（物理反馈）。必须执行“台词预算与承载表”和“表演因果层”。高潮句后禁止再补弱镜或动作回退镜；每个片段【E】必须包含固定禁令：严禁字幕/标题/角标/水印/Logo/平台标识；严禁背景音乐/BGM；保留真实音效；禁止新增未授权内容；禁止自创台词。内部输出必须带台词[Dxxx]标记用于校验，最终即梦版会自动隐藏编号。'
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  readPrompt,
  splitDialogueIntoParts,
  buildDialogueCarryPlan,
  buildAgentASystem,
  buildAgentAUser,
  buildAgentBSystem,
  buildAgentBUser,
  buildAgentCSystem,
  buildAgentCUser
};
