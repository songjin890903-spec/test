const annotationV7 = require('./annotation_v7');
const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3006;

const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const jobs = new Map();
const agentAJobs = new Map(); // 提前声明，与 jobs 同级，避免顶部 TTL 清理用 global 绕行

// ============================================================
// Job TTL 清理：避免 jobs / agentAJobs 两个 Map 无界增长
// 每 10 分钟扫一次，清掉 done/error 且超过 1 小时的任务
// ============================================================
const JOB_TTL_MS = 60 * 60 * 1000; // 1 小时
setInterval(() => {
  const now = Date.now();
  for (const map of [jobs, agentAJobs]) {
    for (const [id, job] of map) {
      if ((job.status === 'done' || job.status === 'error') && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
        map.delete(id);
      }
      // 没有 finishedAt 的老任务：按 jobId 时间戳兜底
      else if ((job.status === 'done' || job.status === 'error') && !job.finishedAt) {
        const m = id.match(/(\d{10,})/);
        if (m && now - parseInt(m[1]) > JOB_TTL_MS) map.delete(id);
      }
    }
  }
}, 10 * 60 * 1000).unref?.();

// 场景类型对应的镜头数规则（集中定义，validatePlan 只接收 limits 对象）
// 新判断逻辑：只有纯武戏才走 wuxi 规则，其他（含混合场景）全部走 wenxi 规则
const SCENE_RULES = {
  wuxi:  { minShots: 3, maxShots: 6 }, // 武戏：少镜大冲击，每镜2-4秒
  wenxi: { minShots: 5, maxShots: 8 }, // 文戏：默认 7 镜号（允许 5-8）·单镜 ≤3 秒·4 秒绝对不允许
  mixed: { minShots: 5, maxShots: 8 } // 混合：走文戏规则（detectSceneType 不再返回 mixed，这里只作兜底）
};

// 台词核验用的引号剥离正则（统一维护，避免各处不一致）
const QUOTE_STRIP_RE = /[""「」『』"']/g;

// 台词"分配完整性"检测用的归一化正则·去除拆句符号和空白
// 原因：LLM 有时把一条台词拆到两个镜号，中间加 ——、…、空白或换行，
// 导致裸的 String.includes 匹配断裂·validator 误报遗漏·forceInject 重复注入。
// 归一化后的字符串仅用于 includes 检测，不用于输出。
const DIALOGUE_MATCH_NORM_RE = /[""「」『』"'——─—…\s]+/g;

// 剥离台词里的演员指导（中文或英文括号包围的内容）
// 例："赵一铭（不耐烦且有些慌乱）：怎么可能？（略一犹豫）没关系..."
//      → "赵一铭：怎么可能？没关系..."
// LLM 写进 plan 的台词不会保留这些括号注释，如果匹配时不剥离，锚点就会
// 包含 "（略一犹豫）" 这种 plan 里根本不存在的文字，导致 validator 误报遗漏。
const DIRECTOR_NOTE_RE = /[（(][^）)]*[）)]/g;
function stripDirectorNote(s) {
  return (s || '').replace(DIRECTOR_NOTE_RE, '');
}

function normalizeDialogueForMatch(s) {
  return (s || '').replace(DIALOGUE_MATCH_NORM_RE, '');
}

// ============================================================
// 大运动动词词库（武戏判定 / 片段二次校验共用）
// 预编译为单个 /a|b|c/g 正则，避免每次 new RegExp
// ⚠️ 只用二字以上词·单字词（砍/劈/刺/斩）会误伤（"冲刺""讽刺""砍价"等），禁止加入
// ============================================================
const BIG_MOVEMENT_VERBS = [
  // 兵器交互动词（全部二字以上）
  '挥刀', '挥剑', '抽刀', '抽剑', '拔刀', '拔剑', '举刀', '劈砍', '斩向', '刺向', '砍向',
  // 肢体冲击
  '出拳', '踢飞', '格挡', '闪避', '弹开', '震飞', '扼住', '掐住', '撞飞', '砸向',
  // 大运动位移
  '扑向', '猛冲', '暴起', '突围', '围攻', '厮杀', '追逐', '逃窜',
  // 特殊能力与气场类
  '利爪', '精气', '掀飞', '抽干', '炸开', '跺脚', '腾空', '飞跃',
  // 武戏专属术语
  '武戏', '武打', '升格', '五段式'
];
// 按长度倒序，避免 '刀' 把 '挥刀' 吃掉（虽然这里没有单字词，保险起见）
const BIG_MOVEMENT_RE = new RegExp(
  BIG_MOVEMENT_VERBS.slice().sort((a, b) => b.length - a.length).join('|'),
  'g'
);
// 片段二次校验用的子集（不含武戏术语，因为规划 JSON 里不该出现这些元词）
const SEG_CHECK_VERBS = BIG_MOVEMENT_VERBS.filter(
  w => !['武戏', '武打', '升格', '五段式'].includes(w)
);
const SEG_CHECK_RE = new RegExp(
  SEG_CHECK_VERBS.slice().sort((a, b) => b.length - a.length).join('|'),
  'g'
);

function countBigMovement(text, re = BIG_MOVEMENT_RE) {
  if (!text) return 0;
  re.lastIndex = 0;
  const m = text.match(re);
  return m ? m.length : 0;
}

// 正则特殊字符转义（normalizeCharNames 用）
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// 提示词加载
// ============================================================
const _promptCache = {};
function loadPrompt(filename) {
  if (_promptCache[filename] !== undefined) return _promptCache[filename];
  const filepath = path.join(__dirname, 'prompts', filename);
  try {
    _promptCache[filename] = fs.readFileSync(filepath, 'utf-8');
    return _promptCache[filename];
  } catch {
    console.warn(`⚠️ 提示词文件未找到: ${filename}`);
    _promptCache[filename] = '';
    return '';
  }
}

// ✨ 规划阶段专用：只加载 core.txt 的前半部分（到 PLAN_CUT 标记为止）
// 目的：规划阶段不需要写作铁律·模板填写铁律·文戏 34 条等内容·截掉它们能让规划 API 输入减少约 80%
// 规划速度预计提升 2-3 倍·写作质量不受影响（写作阶段仍加载完整 core.txt）
const _planCoreCache = {};
function loadCoreForPlan() {
  if (_planCoreCache.content !== undefined) return _planCoreCache.content;
  const fullCore = loadPrompt('core.txt');
  const PLAN_CUT_MARKER = '<!-- PLAN_CUT';
  const cutIndex = fullCore.indexOf(PLAN_CUT_MARKER);
  if (cutIndex === -1) {
    // 兜底：找不到标记就加载完整 core·避免规划阶段崩溃
    console.warn('⚠️ core.txt 未找到 PLAN_CUT 标记·规划阶段退回完整加载');
    _planCoreCache.content = fullCore;
    return fullCore;
  }
  // 截取到标记之前·加一个提示告诉 AI 这是规划阶段的精简版
  const planCore = fullCore.substring(0, cutIndex).trim()
    + '\n\n<!-- 本次为规划阶段·只输出 scene_plan + analysis 块·完整写作规则见写作阶段 system prompt -->\n';
  _planCoreCache.content = planCore;
  const fullLen = fullCore.length;
  const planLen = planCore.length;
  console.log(`✨ 规划阶段 core 精简加载：${fullLen} → ${planLen} 字符（减少 ${Math.round((1 - planLen/fullLen) * 100)}%）`);
  return planCore;
}

function buildSystemPrompt(sceneType, options = {}) {
  // ✨ 加载现有真实文件（core.txt / wenxi.txt / wuxi.txt）
  // 注意：原代码加载的 core_v7.txt / wenxi_core_v7.txt / wuxi_v7.txt 均不存在，
  // 导致 system prompt 为空，写作规则全部靠 user message 里重复注入，token 浪费严重。
  const core = loadPrompt('core.txt');
  if (sceneType === 'wuxi') return core + '\n\n' + loadPrompt('wuxi.txt');

  // 文戏/混合：加载 wenxi.txt（含铁律 34 条 + 声画分离补充铁律 + 范例）
  let prompt = core + '\n\n' + loadPrompt('wenxi.txt');
  return prompt;
}

// ============================================================
// 导演讲戏块处理（平衡括号匹配，支持嵌套）
// ============================================================
// 正则 /（导演讲戏：[\s\S]*?）/ 无法处理内层嵌套括号（如"角色（愤怒）冲出"），
// 会在第一个）处提前截断，导致剩余文本泄漏。改用平衡括号匹配。
function processDirectorNotes(text, replacer) {
  const marker = '（导演讲戏：';
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(marker, cursor);
    if (start === -1) { result += text.substring(cursor); break; }
    result += text.substring(cursor, start);
    // 从 marker 的 （ 开始计数深度
    let depth = 1;
    let pos = start + 1; // 跳过开头的 （
    while (pos < text.length && depth > 0) {
      if (text[pos] === '（') depth++;
      else if (text[pos] === '）') depth--;
      pos++;
    }
    if (depth === 0) {
      const fullMatch = text.substring(start, pos);
      const inner = text.substring(start + marker.length, pos - 1);
      result += replacer(fullMatch, inner);
    } else {
      // 未闭合，原样保留
      result += text.substring(start, pos);
    }
    cursor = pos;
  }
  return result;
}

// stripDirectorNotes：processDirectorNotes(x, () => '') 的带缓存版本
// 同一场景在 extractDialogues/detectSceneType/validateAnnotation 等处会被反复 strip，
// 用 Map 缓存避免重复的字符级扫描。上限 200 条，超出时清一半。
const _stripCache = new Map();
function stripDirectorNotes(text) {
  if (!text) return '';
  const cached = _stripCache.get(text);
  if (cached !== undefined) return cached;
  const stripped = processDirectorNotes(text, () => '');
  if (_stripCache.size >= 200) {
    // 粗暴清一半，避免无界增长
    const keys = Array.from(_stripCache.keys()).slice(0, 100);
    for (const k of keys) _stripCache.delete(k);
  }
  _stripCache.set(text, stripped);
  return stripped;
}

// ============================================================
// 台词提取 / 核验 / 补写
// ============================================================
function extractDialogues(sceneContent) {
  const stripped = stripDirectorNotes(sceneContent);
  const excludePrefixes = ['场景', '人物', '▲', '【', '（'];
  const excludeKeywords = [
    '必须捕捉', '稳帧点', '镜头意图', '人物内心', '场景感受', '禁止',
    '节点缺口', '补充方案', '身体反应', '心理状态', '情绪走向', '观众带走',
    '结构节点', '优先级', '作用', '补充', '内容', '方法论', '导演'
  ];
  const dialogues = [];
  for (const line of stripped.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '【无特殊批注】') continue;
    if (!trimmed.includes('：')) continue;
    if (excludePrefixes.some(p => trimmed.startsWith(p))) {
      // 豁免（旁白）和（画外音）——它们是有效的OS台词行
      if (!trimmed.startsWith('（旁白）') && !trimmed.startsWith('（画外音）')) continue;
    }
    const colonIdx = trimmed.indexOf('：');
    const charPart = trimmed.substring(0, colonIdx);
    const contentPart = trimmed.substring(colonIdx + 1).trim();
    if (charPart.length > 15 || !contentPart || contentPart.length < 2) continue;
    // excludeKeywords 只检查角色名部分，不污染台词内容
    // 避免误过滤含"禁止""知道""内容"等词的正常台词
    if (excludeKeywords.some(kw => charPart.includes(kw))) continue;
    dialogues.push(trimmed);
  }
  return dialogues;
}

function verifyDialogues(dialogues, output) {
  // 先剥离analysis块：台词分配表在analysis里不算C部分已落实
  const cleanOutput = output.replace(/<analysis>[\s\S]*?<\/analysis>/g, '');
  // 归一化整个输出（同 validatePlan / forceInjectMissingDialogues 标准）
  // 防止 LLM 在最终输出里把台词拆到多个镜号中间加 ——、省略号、换行导致锚点断裂
  const cleanOutputNorm = normalizeDialogueForMatch(cleanOutput);
  // ─── 已知极端 case（不做特殊处理）───
  // 台词整句被拆到两个镜号·中间插入过渡文本（"XXX继续说："之类）。
  // 归一化去 ——\n 仍然解决不了"中间有新文字"。
  // 但这种拆法在 forceInject 修复后出现概率极低·且加算法会引入更多误报风险·
  // 故保持现状·依赖 forceInject 本身不再产生重复台词。
  const missing = [];
  for (const d of dialogues) {
    const colonIdx = d.indexOf('：');
    // ⚠️ 不跳过无冒号项：seg.shots[].dialogue 是纯内容（无"角色："前缀），也需要核验
    // 同时剥离演员指导括号（略一犹豫）·防止锚点里带 LLM 最终输出里不会保留的文字
    const contentPart = stripDirectorNote(
      (colonIdx >= 0 ? d.substring(colonIdx + 1) : d)
    ).trim().replace(QUOTE_STRIP_RE, '');
    if (!contentPart) continue;

    // ── 多锚点检查（防吞句）──────────────────────────────────
    // 台词很短（≤8字）时直接用前字锚点，不做 split 开销
    let isMissing;
    if (contentPart.length <= 8) {
      const anchor = normalizeDialogueForMatch(contentPart.slice(0, 6));
      isMissing = !!(anchor && !cleanOutputNorm.includes(anchor));
    } else {
      // 按句末标点拆子句，每句取前10字做锚点，任一缺失=整条台词遗漏
      const clauses = contentPart.split(/(?<=[？！。])/g)
        .map(s => s.trim()).filter(s => s.length >= 4);
      if (clauses.length > 1) {
        isMissing = clauses.some(c => {
          const anchor = normalizeDialogueForMatch(c.slice(0, 10));
          return anchor && !cleanOutputNorm.includes(anchor);
        });
      } else {
        // 单句：进一步用逗号拆分细粒度子锚点
        const subClauses = contentPart.split(/[，,、]/g)
          .map(s => s.trim()).filter(s => s.length >= 2);
        if (subClauses.length > 1) {
          isMissing = subClauses.some(c => {
            const anchor = normalizeDialogueForMatch(c.slice(0, 6));
            return anchor.length >= 2 && !cleanOutputNorm.includes(anchor);
          });
        } else {
          // 真·短句：用前10字归一化后做锚点
          const coreText = normalizeDialogueForMatch(contentPart.slice(0, 10));
          isMissing = !!(coreText && !cleanOutputNorm.includes(coreText));
        }
      }
    }
    if (isMissing) missing.push(d);
  }
  return missing;
}

// 从一条台词中提取在 cleanOutput 里真正缺失的子句列表
function getMissingClauses(d, cleanOutput) {
  const colonIdx = d.indexOf('：');
  // 剥离演员指导括号 + 归一化输出·保持与 verifyDialogues 标准一致
  const contentPart = stripDirectorNote(
    (colonIdx >= 0 ? d.substring(colonIdx + 1) : d)
  ).trim().replace(QUOTE_STRIP_RE, '');
  const cleanOutputNorm = normalizeDialogueForMatch(cleanOutput);
  const clauses = contentPart.split(/(?<=[？！。])/g)
    .map(s => s.trim()).filter(s => s.length >= 4);
  return clauses.filter(c => {
    const anchor = normalizeDialogueForMatch(c.slice(0, 10));
    return anchor && !cleanOutputNorm.includes(anchor);
  });
}

async function repairMissingDialogues(missing, existingOutput, systemPrompt, config) {
  console.log(`⚠️ 发现 ${missing.length} 条台词遗漏，自动补写中...`);
  const cleanExisting = existingOutput.replace(/<analysis>[\s\S]*?<\/analysis>/g, '');
  let repairMsg = `以下台词或OS独白在刚才的输出中被遗漏，必须补写进对应片段的C部分镜号叙事里。\n`;
  repairMsg += `请在原输出基础上找到对应片段，将遗漏台词以"角色OS：引号原文"或"角色（状态）：引号原文"格式写进对应镜号叙事正文，输出补写后的完整内容。\n\n`;
  repairMsg += `【遗漏台词清单】\n`;
  missing.forEach((d, i) => {
    const colonIdx = d.indexOf('：');
    const charPrefix = colonIdx >= 0 ? d.substring(0, colonIdx + 1) : '';
    const missingClauses = getMissingClauses(d, cleanExisting);
    if (missingClauses.length > 0 && missingClauses.length < d.split(/(?<=[？！。])/g).filter(s => s.trim().length >= 4).length) {
      // 部分子句缺失：只报告缺失的那几句，避免模型把已有部分重复写入
      repairMsg += `遗漏${i + 1}：${charPrefix}${missingClauses.join('')}（注：此台词其余句已存在，只需补入这几句）\n`;
    } else {
      repairMsg += `遗漏${i + 1}：${d}\n`;
    }
  });
  repairMsg += `\n【原输出】\n${existingOutput}\n\n`;
  repairMsg += `请直接输出补全后的完整提示词，格式与原输出完全一致，不要任何解释。`;
  return await callAPI(systemPrompt, repairMsg, config);
}

// ============================================================
// 场景类型识别
// ============================================================
function detectSceneType(sceneContent) {
  // 大运动动词见顶部 BIG_MOVEMENT_VERBS，这里只做短吼识别和分类判断

  // 短吼识别——≤5字的冒号台词行不算正式台词
  function isShortShout(line) {
    const match = line.match(/^[^\s▲【（].+?：(.+)$/);
    if (!match) return false;
    const content = match[1].trim().replace(/[""「」『』"'！？。，.,!?\s]/g, '');
    return content.length <= 5;
  }

  const content = sceneContent;
  const bigMovementCount = countBigMovement(content);

  // 统计真正的台词行（排除导演讲戏内的冒号行和短吼）
  const strippedForCount = stripDirectorNotes(sceneContent);
  const allDialogueLines = strippedForCount.match(/^[^\s▲【（].+：.+$/gm) || [];
  const realDialogueLines = allDialogueLines.filter(line => !isShortShout(line));
  const dialogueCount = realDialogueLines.length;

  console.log(`   场景分类：大运动动词${bigMovementCount}个·真实台词${dialogueCount}条·短吼${allDialogueLines.length - dialogueCount}条`);

  // ======== 新判断逻辑 ========
  // 核心原则：3+ 条真实台词 → 一定按文戏写（哪怕有武戏节拍·混合场景默认走文戏规则）
  // 只有 ≤2 条真实台词 + 大运动动词 ≥ 3 才判纯武戏
  // 其他情况默认文戏

  if (dialogueCount >= 3) {
    // 3条以上台词——无论有多少大运动都按文戏写
    // 这包括两种情况：
    //   A) 纯文戏（3+条台词，无大运动）
    //   B) 混合场景（3+条台词 + 大运动）→ 按文戏规则写整个片段
    //      混合场景里的武戏动作当作"大幅度的情绪驱动肢体"来写
    if (bigMovementCount >= 1) {
      console.log(`   → 判为 wenxi（混合场景·3+条台词·按文戏规则写整个片段，武戏动作当大幅度情绪肢体）`);
    } else {
      console.log(`   → 判为 wenxi（纯文戏）`);
    }
    return 'wenxi';
  }

  // 台词数 ≤ 2（含 0-2 条正式台词·可能有短吼）
  if (bigMovementCount >= 3) {
    console.log(`   → 判为 wuxi（纯武戏·大运动${bigMovementCount}个·台词${dialogueCount}条）`);
    return 'wuxi';
  }

  if (bigMovementCount >= 1 && dialogueCount <= 1) {
    // 短吼+大动作的动作戏
    console.log(`   → 判为 wuxi（动作戏·大运动${bigMovementCount}个·台词${dialogueCount}条）`);
    return 'wuxi';
  }

  // 兜底：没有大运动的场景一律文戏
  console.log(`   → 判为 wenxi（默认·大运动${bigMovementCount}个·台词${dialogueCount}条）`);
  return 'wenxi';
}

// ============================================================
// 脚本解析
// ============================================================
function detectEpisode(text) {
  const patterns = [/第\s*(\d+)\s*[集话]/, /EP\s*0*(\d+)/i, /E\s*0*(\d+)\b/i];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].padStart(2, '0');
  }
  return null;
}

function parseScript(text) {
  const scenes = [];
  const copyMatch = text.match(/===复制区开始===([\s\S]*?)===复制区结束===/);
  const workText = copyMatch ? copyMatch[1].trim() : text;
  const episodeMatch = workText.match(/【批注剧本】(.+)/);
  const episodeInfo = episodeMatch ? episodeMatch[1].trim() : '本集';
  const normalized = workText
    .replace(/[─━—\-═]{8,}/g, '\n<<<SEP>>>\n') // 含 ═ 匹配 Agent A 输出
    .replace(/\*{8,}/g, '\n<<<SEP>>>\n');
  const rawParts = normalized.split('<<<SEP>>>');

  // ═══场景标题═══ 双分隔线格式会把标题和内容拆成两个块
  // 修复：如果一个块只有场景标题（≤5行），把它和下一个内容块合并
  const parts = [];
  const sceneHeaderRe = /(?:^|\n)\s*(?:\*{0,3})(?:场景\S+|第\S+[场幕]|\d+[-–]\d+)/;
  for (let i = 0; i < rawParts.length; i++) {
    const t = rawParts[i].trim();
    if (!t) continue;
    const nonEmptyLines = t.split('\n').filter(l => l.trim()).length;
    if (sceneHeaderRe.test(t) && nonEmptyLines <= 5) {
      // 标题块：找下一个非空块合并
      let j = i + 1;
      while (j < rawParts.length && !rawParts[j].trim()) j++;
      if (j < rawParts.length) {
        parts.push(t + '\n\n' + rawParts[j].trim());
        i = j;
      } else {
        parts.push(t);
      }
    } else {
      parts.push(t);
    }
  }

  let currentEpisode = detectEpisode(workText.slice(0, 500)) || '01';

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const ep = detectEpisode(trimmed.slice(0, 200));
    if (ep) currentEpisode = ep;
    let sceneId = null, fullHeader = null;

    // Agent A 输出可能带 markdown 粗体标记（**场景1-1 ...**），先剥离再匹配
    // 对每行剥离行首 **、行尾 **、行首 ### 等 markdown 格式，用于场景标题匹配
    const stripMd = (s) => s.replace(/^\*{1,3}\s*|\s*\*{1,3}$/gm, '').replace(/^#{1,6}\s*/gm, '');
    const stripped = stripMd(trimmed);

    const fmt1 = stripped.match(/^场景(\S+)\s+([^\n]+)/m);
    if (fmt1) { sceneId = fmt1[1]; fullHeader = fmt1[2].trim().replace(/\*+/g, ''); }
    if (!sceneId) {
      const fmt2 = stripped.match(/^(\d+[-–]\d+[A-Za-z]?)\s+([^\n*]+)/m);
      if (fmt2) { sceneId = fmt2[1]; fullHeader = fmt2[2].trim().replace(/\*+/g, ''); }
    }
    if (!sceneId) {
      const fmt3 = stripped.match(/^第(\S+)[场幕]\s*([^\n]*)/m);
      if (fmt3) { sceneId = fmt3[1]; fullHeader = (fmt3[2].trim() || `第${fmt3[1]}场`).replace(/\*+/g, ''); }
    }
    if (!sceneId) {
      const fmt4 = stripped.match(/^【([^】]{1,20})】\s*([^\n]*)/m);
      if (fmt4 && /\d/.test(fmt4[1])) { sceneId = fmt4[1]; fullHeader = (fmt4[2].trim() || fmt4[1]).replace(/\*+/g, ''); }
    }
    if (!sceneId) continue;

    const locationMatch = fullHeader.match(/[内外]\s+(.+)$/) || fullHeader.match(/(?:外|内)\s*(.+)/);
    const location = locationMatch ? locationMatch[1].trim() : fullHeader;
    // 人物行也可能带 markdown 粗体
    const charMatch = trimmed.match(/\*{0,2}人物[：:]\*{0,2}\s*(.+)/);
    const characters = charMatch
      ? charMatch[1].replace(/\*+/g, '').split(/[·，,、\s]+/).map(c => c.trim()).filter(Boolean)
      : [];

    scenes.push({
      id: sceneId, header: fullHeader, location, characters,
      content: trimmed, episode: currentEpisode, episodeInfo,
      sceneType: detectSceneType(trimmed)
    });
  }

  const episodeMap = {};
  for (const s of scenes) {
    if (!episodeMap[s.episode]) episodeMap[s.episode] = [];
    episodeMap[s.episode].push(s);
  }
  return { scenes, episodeInfo, episodeMap };
}

// ============================================================
// API 调用（支持续跑）
// ============================================================
// 统一超时：每次 fetch 新建 AbortController，不复用（retry 时 signal 可能已死）
const TIMEOUT_MS = 5 * 60 * 1000; // 5分钟，防止永久挂起

async function callAPI(systemPrompt, userMessage, config) {
  const { apiKey, apiType, apiUrl, model } = config;
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [5000, 15000, 30000]; // 重试等待
  const MAX_CONTINUATIONS = 5; // 续跑上限

  let fullText = '';
  let messages = [{ role: 'user', content: userMessage }];
  let retries = 0;
  let continuations = 0;

  // ── 主循环：续跑（截断重写）和重试（429/网络错误）都在这里 ──
  while (true) {
    // 每次请求都新建 AbortController（复用会导致 retry 时 signal 已死）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let stopReason = null; // null=成功/stop, 'length'=需续跑

    try {
      let responseData = null;

      if (apiType === 'anthropic') {
        let anthropicEndpoint = 'https://api.anthropic.com/v1/messages';
        if (apiUrl) {
          anthropicEndpoint = /\/v1\/messages\/?$/.test(apiUrl)
            ? apiUrl
            : apiUrl.replace(/\/+$/, '') + '/v1/messages';
        }
        const res = await fetch(anthropicEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: model || 'claude-sonnet-4-6',
            max_tokens: 8192,
            system: systemPrompt,
            messages
          }),
          signal: controller.signal
        });
        if (res.status === 429) {
          clearTimeout(timeout);
          if (retries >= MAX_RETRIES) throw new Error(`API 限速，已重试 ${MAX_RETRIES} 次`);
          const wait = RETRY_DELAYS[retries++];
          console.log(`⚠️ 限速 429，${wait / 1000}s后重试（第${retries}次）...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) {
          const errBody = await res.text().catch(() => '(无响应体)');
          throw new Error(`API HTTP ${res.status}: ${errBody.slice(0, 200)}`);
        }
        responseData = await res.json();
        if (responseData.error) throw new Error(responseData.error.message);
        if (!responseData.content?.[0]?.text) throw new Error('API 返回了空内容');
        retries = 0;
        const chunk = responseData.content[0].text;
        fullText += chunk;
        stopReason = responseData.stop_reason === 'max_tokens' ? 'length' : null;

      } else if (apiType === 'gemini') {
        const geminiModel = model || 'gemini-2.5-pro';
        const geminiBase = (apiUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
        const geminiEndpoint = /:generateContent/.test(geminiBase)
          ? geminiBase
          : `${geminiBase}/v1beta/models/${geminiModel}:generateContent`;
        const contents = messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }));
        const res = await fetch(geminiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { maxOutputTokens: 8192 }
          }),
          signal: controller.signal
        });
        if (res.status === 429) {
          clearTimeout(timeout);
          if (retries >= MAX_RETRIES) throw new Error(`API 限速，已重试 ${MAX_RETRIES} 次`);
          const wait = RETRY_DELAYS[retries++];
          console.log(`⚠️ 限速 429，${wait / 1000}s后重试（第${retries}次）...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) {
          const errBody = await res.text().catch(() => '(无响应体)');
          throw new Error(`API HTTP ${res.status}: ${errBody.slice(0, 200)}`);
        }
        responseData = await res.json();
        const candidate = responseData.candidates?.[0];
        if (!candidate) throw new Error('Gemini 返回了空内容（无 candidates）');
        const chunkText = candidate.content?.parts?.map(p => p.text || '').join('') || '';
        if (!chunkText) throw new Error('Gemini 返回了空内容（parts 为空）');
        retries = 0;
        fullText += chunkText;
        stopReason = candidate.finishReason === 'MAX_TOKENS' ? 'length' : null;

      } else {
        // DeepSeek / MiniMax / 其他 OpenAI 兼容 API
        const endpoint = apiUrl || (apiType === 'minimax'
          ? 'https://api.minimaxi.com/v1/chat/completions'
          : 'https://api.deepseek.com/v1/chat/completions');
        const bodyObj = apiType === 'minimax'
          ? {
              // MiniMax OpenAI 兼容接口
              model: model || 'MiniMax-M2.7',
              max_completion_tokens: config.maxTokens || 8192,
              messages: [{ role: 'system', content: systemPrompt }, ...messages]
            }
          : {
              model: model || 'deepseek-chat',
              max_tokens: 8192,
              messages: [{ role: 'system', content: systemPrompt }, ...messages]
            };
        if (config.jsonMode) {
          bodyObj.response_format = { type: 'json_object' };
        }
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify(bodyObj),
          signal: controller.signal
        });
        if (res.status === 429) {
          clearTimeout(timeout);
          if (retries >= MAX_RETRIES) throw new Error(`API 限速，已重试 ${MAX_RETRIES} 次`);
          const wait = RETRY_DELAYS[retries++];
          console.log(`⚠️ 限速 429，${wait / 1000}s后重试（第${retries}次）...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) {
          const errBody = await res.text().catch(() => '(无响应体)');
          throw new Error(`API HTTP ${res.status}: ${errBody.slice(0, 200)}`);
        }
        responseData = await res.json();
        if (responseData.usage?.prompt_cache_hit_tokens) {
          console.log(`   💾 缓存命中 ${responseData.usage.prompt_cache_hit_tokens} tokens（总 ${responseData.usage.prompt_tokens}）`);
        }
        if (responseData.error) throw new Error(responseData.error.message || JSON.stringify(responseData.error));
        if (!responseData.choices?.[0]?.message?.content) throw new Error('API 返回了空内容');
        retries = 0;
        let chunk = responseData.choices[0].message.content;
        // MiniMax-M2.7 等模型可能包含 <think> 思维链标签，需要过滤掉
        chunk = chunk.replace(/<think>/gi, '').replace(/<\/think>/gi, '').trim();
        fullText += chunk;
        // MiniMax 的 finish_reason 可能不准确，只信任 'length'（max_tokens 触顶）
        // finish_reason === 'stop' 表示模型已正常结束，不应强制续跑
        const rawFinishReason = responseData.choices[0].finish_reason;
        if (apiType === 'minimax') {
          console.log(`   MiniMax finish_reason: ${rawFinishReason}, chunkLen: ${chunk.length}, totalLen: ${fullText.length}`);
        }
        stopReason = (rawFinishReason === 'length') ? 'length' : null;
      }

      // ── 成功：判断是否需要续跑 ──
      clearTimeout(timeout);
      if (stopReason === 'length') {
        if (++continuations >= MAX_CONTINUATIONS) {
          console.warn(`⚠️ 续跑已达${MAX_CONTINUATIONS}次上限，截断返回`);
          break;
        }
        messages = [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: fullText },
          { role: 'user', content: '请继续从截断处继续输出，不要重复已有内容，直接接着写。' }
        ];
        console.log(`⚠️ 输出被截断，自动续跑（第${continuations}次）...`);
        continue;
      }
      break; // 正常完成，退出循环

    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error(`API 请求超时（${TIMEOUT_MS / 1000}秒无响应），请检查网络或尝试换用更快的 API 节点`);
      }
      // 判断是否网络错误（可重试）
      const isRetryable = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|ENETUNREACH|ETIMEDOUT|CLIENT|fetch failed|socket hang up/i.test(err.message || '');
      if (isRetryable) {
        if (retries >= MAX_RETRIES) {
          throw new Error(`API 网络失败，已重试 ${MAX_RETRIES} 次：${err.message}`);
        }
        const wait = RETRY_DELAYS[retries++];
        console.log(`⚠️ 网络错误 (${apiType}) ${wait / 1000}s后重试（第${retries}次）: ${err.message.slice(0, 100)}`);
        if (apiType === 'minimax') {
          console.log(`   MiniMax API URL: ${endpoint}`);
        }
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err; // 非重试错误，直接上抛
    }
  }

  return fullText;
}

// ============================================================
// 多步处理：台词预算 / 规划 / 逐片段写作
// ============================================================

// 程序层计算台词最短时长
function calcMinDuration(dialogueLine) {
  const colonIdx = dialogueLine.indexOf('：');
  let content = colonIdx >= 0
    ? dialogueLine.substring(colonIdx + 1).trim()
    : dialogueLine.trim();
  // 剥离台词中的舞台指示（括号内的动作描写不是念出来的）
  content = content.replace(/（[^）]*）/g, '');
  const isOS = dialogueLine.includes('OS：') || dialogueLine.includes('OS:')
    || dialogueLine.includes('（旁白）：') || dialogueLine.includes('（画外音）：');
  // 去除标点、书名号计字数（《》不念）
  const charCount = content.replace(/[，。！？、""「」『』《》\s\.]/g, '').length;
  // OS独白2字/秒，普通台词4字/秒（保守估算）
  const speed = isOS ? 2 : 4;
  // 停顿：逗号0.4秒，句末标点0.7秒
  const commas = (content.match(/[，、]/g) || []).length;
  const stops = (content.match(/[。！？]/g) || []).length;
  const pause = commas * 0.4 + stops * 0.7;
  return Math.round((charCount / speed + pause) * 10) / 10;
}

// 从导演讲戏批注中提取镜头指令清单
function extractDirectorShots(sceneContent) {
  const shots = [];
  processDirectorNotes(sceneContent, (match, inner) => {
    for (const line of inner.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('【镜头意图') || trimmed.startsWith('【人物内心')) {
        const isMust = trimmed.includes('⚠️必须') || trimmed.includes('⚠️');
        const isShot = trimmed.startsWith('【镜头意图'); // 只有镜头意图才算独立镜号
        shots.push({ text: trimmed, isShot, isMust });
      }
    }
    return match;
  });
  return shots;
}

// 从导演批注中动态提取关键动作词，用于写作后验证
function extractDirectorKeywords(sceneContent) {
  const keywords = new Set();
  processDirectorNotes(sceneContent, (match, inner) => {
    for (const line of inner.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('【镜头意图') && !trimmed.startsWith('【人物内心')) continue;

      // 提取有画面价值的名词/动词短语（2-4字的中文词）
      // 镜头类：焦段+运镜
      const cameraWords = trimmed.match(/(?:特写|全景|中景|近景|远景|俯拍|仰拍|航拍|穿越机|长焦|广角|贴地|升格|跟拍|环绕|推进|拉开|甩镜|主观视角|第一视角)/g) || [];
      cameraWords.forEach(w => keywords.add(w));

      // 动作类：导演强调的具体动作（⚠️标记的行提取更多）
      if (trimmed.includes('⚠️')) {
        // 必须标记的行，提取关键动词
        const actionWords = trimmed.match(/(?:漂移|甩尾|碾过|撕咬|踹飞|踩着|踉跄|吐血|咳血|整理衣服|挂挡|油门|转场|重生|睁眼|跪地|冲上去|拉短裙)/g) || [];
        actionWords.forEach(w => keywords.add(w));
      }

      // 通用：导演给的镜头描述中出现的关键场景元素
      const sceneWords = trimmed.match(/(?:丧尸|尸潮|铁网|迈巴赫|篮球场|码表)/g) || [];
      sceneWords.forEach(w => keywords.add(w));
    }
    return match;
  });
  return [...keywords];
}

// 构建规划阶段的 prompt（只用 core.txt，不加 wenxi/wuxi，减少 token 压力）
function buildPlanPrompt(scene, costumeCard, dialogues) {
  const budgetLines = dialogues.map((d, i) => {
    const min = calcMinDuration(d);
    let tag = '';
    if (min > 15) tag = '  ⚠️必须切镜+声画分离+可跨片段';
    else if (min > 8) tag = '  ⚠️必须切镜+含声画分离';
    else if (min > 3) tag = '  ⚠️必须切镜（多镜号覆盖）';
    return `[台词${i + 1}] ${d}  →  最短${min}秒${tag}`;
  }).join('\n');

  // 检测导演讲戏模式：提取导演指定的镜头清单
  const directorShots = extractDirectorShots(scene.content);
  const hasDirectorShots = directorShots.length > 0;

  let p = `你是分镜规划专员，只做规划，不写叙事散文。\n\n`;
  p += `⛔ 规划铁律：\n`;
  p += `1. 除最后一个片段外，每个片段镜号时长之和必须=15秒。\n`;
  if (hasDirectorShots) {
    p += `2. 导演讲戏模式：每片段镜头数5-10个，单镜 ≤3 秒·4 秒绝对不允许。\n`;
  } else {
    p += `2. 文戏/混合场景每片段默认 7 个镜号（允许 5-8）·单镜 ≤3 秒·4 秒绝对不允许；武戏每片段3-6个，每镜2-4秒，冲击感优先。\n`;
  }
  p += `3. 台词镜号规则（两层）：\n`;
  p += `   · ≤3秒台词：一个镜号拍完，不用切。\n`;
  p += `   · >3秒台词：必须拆成多个镜号——起始镜号放dialogue，后续镜号task写切镜方式（换角度/反打听者/INSERT细节/声画分离），禁止单个镜号对着一个人说话超过3秒。\n`;
  p += `   · >8秒台词/OS独白：多镜号中必须包含至少一个声画分离镜号（task写"声画分离：XX台词继续，画面切XXX"），把镜头交出去看别的。\n`;
  p += `   · >15秒台词/OS独白：声画分离镜号可以跨片段，声音不断画面跨片段过渡。\n`;
  p += `4. ⚠️【强制】剧本中每一条台词都必须出现在某个镜号的dialogue字段里，一条都不能漏。规划前先数清共有几条台词，规划后逐条确认每条台词都有对应的dialogue字段，否则程序验证会失败并强制重新规划。\n`;
  p += `5. 导演讲戏中标注"必须补"或"⚠️必须"的内容必须出现在某个镜号的task里。\n`;
  p += `6. 台词之间的反应镜头（呼吸感）：\n`;
  p += `   · 角色A说完台词后，不要直接让角色B接台词。中间插一个反应镜号（1-2s）：听者表情变化/沉默/身体反应\n`;
  p += `   · 反应镜号task写"反应：XX听到后的表情/动作"，不放dialogue\n`;
  p += `   · 情绪越重的台词，后面的反应镜号越长（2-3s），让情绪落地\n`;
  p += `7. 连续调度不拆片段：\n`;
  p += `   · 导演描述了一段连贯的走位调度（如"范思瑶边走边说→赵一铭上前两步→范思瑶挽手摸胸口→说台词"），整段调度放在同一个片段，不拆开\n`;
  p += `   · 导演指定了转场设计（如"眼睛到眼睛转场"），转场必须在最后一个片段的最后一镜完成\n`;
  p += `8. 动作线规划（文戏/混合场景）：\n`;
  p += `   · 动作线分两层：第一层"道具任务型"（吃饭/擦刀）来源是 AGENT_A 批注的【动作线设计】块或剧本原文，不能自行编造；第二层"情绪驱动肢体"（往前走一步/转身/撑桌子/后退）是人说话时自然的身体行为，必须写\n`;
  p += `   · 优先从 AGENT_A 批注的【动作线设计】块里读取每个角色的物理任务，没有【动作线设计】或写了"无道具任务"时，第一层留空，全部依赖第二层撑场面\n`;
  p += `   · 有第一层时：action_threads 写角色的物理任务，情绪拐点镜号的 task 标注任务变化\n`;
  p += `   · 无第一层时：action_threads 写"无道具任务·写情绪肢体"，规划中仍须包含说话人肢体动作和听者身体反应的镜号\n`;
  p += `   · 说话人不能连续占两个以上镜号——说完就切到听者身体反应\n`;

  // 武戏宏观弧线规划
  if (scene.sceneType === 'wuxi') {
    p += `\n⛔ 武戏整场弧线规划（强制）：\n`;
    p += `一场完整武戏拆成多个15秒片段时，每个片段在整场弧线上扮演不同角色，强度不同：\n`;
    p += `  · 开端·格局建立（强度：低）→ 交代谁和谁打、空间格局，五段式用蓄势+启动\n`;
    p += `  · 第一回合·一方压制（强度：中）→ A方攻势占优，B方被动对抗，五段式用启动+爆发\n`;
    p += `  · 战斗间隙·蓄力（强度：骤降）→ 情绪梳理、发现破绽、蓄力，五段式用余震→蓄势\n`;
    p += `  · 第二回合·反击（强度：高）→ B方接招反击，势均力敌或逆转，五段式用蓄势→爆发\n`;
    p += `  · 终极回合·全力释放（强度：最高）→ 双方底牌释放，最高强度，五段式用爆发+收尾+余震\n`;
    p += `  · 余震落幕（强度：骤降）→ 见证结果，身体回响\n`;
    p += `强度曲线：低→中→骤降→高→最高→落，不是直线冲上去的。\n`;
    p += `⚠️ 每个片段必须填arc_position和intensity字段，标注该片段在弧线上的位置和强度。\n`;
    p += `⚠️ 上一个片段的余震就是下一个片段的蓄势——片段之间情绪不能断线。\n`;
    p += `⚠️ 没有"战斗间隙·蓄力"的武戏就没有层次——至少在一个片段的开头或末尾安排喘息段。\n\n`;
  }

  // 导演讲戏模式：镜头清单约束
  if (hasDirectorShots) {
    const shotCount = directorShots.filter(d => d.isShot).length; // 镜头意图条数
    const innerCount = directorShots.length - shotCount; // 人物内心条数
    const mustCount = directorShots.filter(d => d.isMust).length;
    const estimatedByTime = Math.ceil(shotCount * 2.5 / 15); // 每条镜头意图≈2.5秒
    const estimatedByChars = Math.ceil(directorShots.length / 8); // 每片段最多8条指令
    // 加上台词的时长需求
    const dialogueDuration = dialogues.reduce((sum, d) => sum + calcMinDuration(d), 0);
    const estimatedByDialogue = dialogues.length > 0 ? Math.ceil(dialogueDuration / 12) : 0;
    const estimatedSegments = Math.max(estimatedByTime, estimatedByChars, estimatedByDialogue, 1);

    p += `\n⛔ 导演镜头清单约束（必须全部覆盖）：\n`;
    p += `导演指定了 ${shotCount} 条镜头意图 + ${innerCount} 条人物内心。\n`;
    if (mustCount > 0) p += `其中 ${mustCount} 条标注了⚠️必须，绝对不能省略。\n`;
    if (dialogues.length > 0) p += `台词共 ${dialogues.length} 条，总时长约 ${Math.round(dialogueDuration)}秒。\n`;
    p += `\n`;
    p += `⛔ 最少 ${estimatedSegments} 个片段（硬性下限）：\n`;
    p += `  按镜头估算：${estimatedByTime}个（${shotCount}条镜头意图×2.5秒÷15秒）\n`;
    p += `  按容量估算：${estimatedByChars}个（${directorShots.length}条指令÷8条/片段）\n`;
    if (dialogues.length > 0) p += `  按台词估算：${estimatedByDialogue}个（台词${Math.round(dialogueDuration)}秒÷12秒/片段）\n`;
    p += `  取最大值 = ${estimatedSegments}个片段\n`;
    p += `\n`;
    p += `不得省略、合并或丢弃任何一条导演镜头指令。镜头多就多分片段。\n`;
    p += `⚠️ 导演描述的具体动作不能改——"漂移甩尾"不能改成"直冲"。\n\n`;
    p += `【导演镜头清单（${directorShots.length}条）】\n`;
    directorShots.forEach((s, i) => {
      p += `[导演${s.isShot ? '镜头' : '内心'}${i + 1}] ${s.isMust ? '⚠️' : ''} ${s.text}\n`;
    });
    p += `\n`;
  }
  p += `\n`;

  if (dialogues.length > 0) {
    p += `【台词清单（规划前逐条对照，每条必须进入某个镜号的dialogue字段）】\n`;
    dialogues.forEach((d, i) => {
      p += `台词${i + 1}：${d}\n`;
    });
    p += `⚠️ 共 ${dialogues.length} 条台词，规划完成后逐条确认是否全部出现在dialogue字段。有遗漏=验证失败=强制重新规划。\n\n`;
    p += `【程序预算：本场台词最短时长】\n${budgetLines}\n\n`;
  }

  p += `请严格按以下JSON格式输出，不要任何其他文字或代码块标记：\n`;
  p += `{"segments":[{"id":"${scene.id}A","title":"片段标题","duration":15,`;
  p += `"action_threads":{"角色A":"正在做的物理任务","角色B":"正在做的物理任务"},`;
  if (scene.sceneType === 'wuxi') {
    p += `"arc_position":"弧线位置（如：开端·格局建立 / 第一回合·压制 / 战斗间隙·蓄力 / 第二回合·反击 / 终极回合·全力释放 / 余震落幕）","intensity":"低/中/高/最高",`;
  }
  p += `"shots":[\n`;

  if (scene.sceneType === 'wuxi') {
    // 武戏 JSON 模板：3-6 个镜号，五段式
    p += `  {"num":1,"duration":2,"shot_type":"[全景 (Full Shot)]","task":"建立空间格局/格局建立","dialogue":"","five_stage":"蓄势"},\n`;
    p += `  {"num":2,"duration":2,"shot_type":"[中景 (Medium Shot)]","task":"启动·攻势开始","dialogue":"","five_stage":"启动"},\n`;
    p += `  {"num":3,"duration":2.5,"shot_type":"[大特写 (Extreme Close-up)]","task":"爆发·撞击/重击瞬间","dialogue":"","five_stage":"爆发"},\n`;
    p += `  {"num":4,"duration":2,"shot_type":"[近景 (Close-up)]","task":"收尾·结果","dialogue":"","five_stage":"收尾"},\n`;
    p += `  {"num":5,"duration":2.5,"shot_type":"[中近景 (Medium Close-up)]","task":"余震·身体回响","dialogue":"","five_stage":"余震"}\n`;
  } else {
    // 文戏 JSON 模板：7 个镜号·按 wenxi.txt 范例三（一对多苏清寒）规格
    // 每个镜号都是 [景别] + 复合运镜·单镜 ≤3 秒·三层缝合
    // 视线路径必须在 task 里体现·听者基线动作必须在 task 里体现
    p += `  {"num":1,"duration":2.5,"shot_type":"[中近景] 横移扫过环境，接停稳在说话人侧面","task":"建立空间格局+第一句台词·说话者视线路径(看A→转头看B→落在B脸上)","dialogue":"第一句台词原文，无台词留空字符串"},\n`;
    p += `  {"num":2,"duration":2.5,"shot_type":"[近景] 仰角推进半步，接焦平面收紧","task":"重量台词·说话者视线路径(从B移开→垂到桌面→抬眼转头看C)·三拍结构(组织+说+消化)","dialogue":"重量台词原文"},\n`;
    p += `  {"num":3,"duration":2,"shot_type":"[近景] 硬切到听者正面，静止等待","task":"听者反应·基线动作(低头→猛抬头又低下去)+可见大动作(抓衣服/扶桌)·不写微动作","dialogue":""},\n`;
    p += `  {"num":4,"duration":2.5,"shot_type":"[过肩] 前景听者虚焦后脑肩膀，后景说话者中近景，焦点从前景猛地后拉到后景","task":"说话者继续台词+听者反应(往后退半步+撞到椅子等可见动作)·焦点后拉揭示","dialogue":"第二句重量台词"},\n`;
    p += `  {"num":5,"duration":1.5,"shot_type":"[中近景] 硬切到说话者正面，接目光抬起闭环回起点","task":"说话者视线闭环(越过听者回到最初看的目标)+动作收束","dialogue":""},\n`;
    p += `  {"num":6,"duration":2,"shot_type":"[特写] 硬切到环境/物件INSERT，接缓慢前推","task":"环境呼应或纯反馈镜号·无台词留白","dialogue":""},\n`;
    p += `  {"num":7,"duration":2,"shot_type":"[过肩] 前景说话者衣领/肩线虚焦(不给头)，后景听者中近景实焦，手持轻微呼吸抖动","task":"听者回应台词·镜头方向铁律(说话者在场但只虚焦身体轮廓·避免听者对空气说话)","dialogue":"听者回应台词原文"}\n`;
  }
  p += `],"tailFrame":"出场景别和视角"}]}\n`;
  p += `⚠️ ${scene.sceneType === 'wuxi' ? '武戏每片段3-6个镜号，每镜2-4秒，冲击感优先' : '文戏每片段默认 7 个镜号（允许 5-8）·单镜 ≤3 秒·4 秒绝对不允许，参考 wenxi.txt 范例三/四/五的规格'}。\n`;
  p += `⚠️ >3秒台词必须拆成多个镜号（起始+切镜/声画分离），禁止把长台词塞进单个镜号。\n`;
  if (scene.sceneType === 'wuxi') {
    p += `⚠️ 武戏shot_type景别选择必须灵活——禁止每个片段都用相同的景别序列，参考wuxi.txt基础循环单元的景别组合变化技巧。\n`;
    p += `⚠️ 武戏每个镜号必须填five_stage字段（蓄势/启动/爆发/收尾/余震），标注当前镜号属于五段式的哪个阶段。\n`;
  }
  p += `\n`;

  p += `【场景信息】\n`;
  p += `场景编号：${scene.id}\n`;
  p += `场景地点：${scene.location || '见剧本'}\n`;
  p += `出场角色：${scene.characters.join('、') || '见剧本'}\n\n`;

  if (hasDirectorShots) {
    // 导演讲戏模式：规划器需要看到完整内容来正确分配镜头
    p += `═══ AGENT_A 批注剧本（含导演镜头设计·规划器必须全部覆盖）═══\n${scene.content}\n\n`;
  } else {
    // AI分析模式：精简导演讲戏，只保留"必须补"行
    const strippedContent = processDirectorNotes(scene.content, (match, inner) => {
      const mustKeep = inner.split('\n').filter(line => line.includes('必须补'));
      if (mustKeep.length > 0) {
        return `（导演讲戏：[精简]\n${mustKeep.join('\n')}\n）`;
      }
      return '（导演讲戏：[已省略]）';
    });
    p += `═══ AGENT_A 批注剧本（规划精简版）═══\n${strippedContent}\n\n`;
  }

  if (costumeCard && costumeCard.trim()) {
    p += `═══ AGENT_B 服化道卡 ═══\n${costumeCard}\n\n`;
  }
  p += `请直接输出JSON规划：`;
  return p;
}

// 解析规划 JSON
function parsePlan(planText) {
  try {
    const clean = planText.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    return JSON.parse(clean.substring(start, end + 1));
  } catch (e) {
    console.error('规划JSON解析失败:', e.message);
    return null;
  }
}

// 程序层验证规划
// relaxed=true 用于第二次尝试：片段数不足降为警告（不阻断），只有台词遗漏还是硬错误。
// 理由：re-plan 时模型常常能修好台词但把片段数压低，与其降级到单次模式（更差），
// 不如用片段数略少但台词完整的规划继续，质量远胜单次。
function validatePlan(plan, dialogues, limits, minSegments, relaxed = false) {
  const errors = [];
  const warnings = [];
  const isDirectorMode = minSegments && minSegments > 1;
  if (!plan?.segments?.length) return ['规划格式错误，无法解析segments'];

  // 片段数量下限检查（导演讲戏模式）
  if (isDirectorMode && plan.segments.length < minSegments) {
    const msg = `片段数量${plan.segments.length}个，导演指令量需要至少${minSegments}个片段`;
    if (relaxed) {
      warnings.push(msg); // 第二次尝试：片段数不足仅警告，不阻断
    } else {
      errors.push(msg);
    }
  }

  for (let i = 0; i < plan.segments.length; i++) {
    const seg = plan.segments[i];
    const isLast = i === plan.segments.length - 1;
    const shots = seg.shots || [];

    // 镜头数检查
    const effectiveMin = (isLast && seg.duration && seg.duration < 15) ? 1 : limits.minShots;
    if (shots.length < effectiveMin || shots.length > limits.maxShots) {
      errors.push(`${seg.id}：镜头数${shots.length}个，要求${effectiveMin}-${limits.maxShots}个`);
    }
    // 总时长检查
    const total = shots.reduce((s, sh) => s + (sh.duration || 0), 0);
    if (!isLast && Math.abs(total - 15) > 0.5) {
      errors.push(`${seg.id}：总时长${total}秒，要求15秒`);
    }
    if (isLast && total > 15.5) {
      errors.push(`${seg.id}：末片段总时长${total}秒，超过15秒上限，必须拆分`);
    }
    // 单镜号时长上限
    // 导演模式5秒（导演可能要求长镜头），武戏4秒，文戏/混合3秒
    const shotMaxDur = isDirectorMode ? 5 : (limits === SCENE_RULES.wuxi) ? 4 : 3;
    for (const shot of shots) {
      if (shot.duration > shotMaxDur) {
        errors.push(`${seg.id} 镜${shot.num}：单镜${shot.duration}秒超上限${shotMaxDur}秒`);
      }
    }
    // 含台词镜号时长检查
    for (const shot of shots) {
      if (shot.dialogue && shot.dialogue.trim()) {
        const minDur = calcMinDuration(shot.dialogue);
        if (minDur <= 3 && shot.duration < minDur - 0.5) {
          if (isDirectorMode) {
            // 导演模式：台词时长不足降级为警告（规划器已经很难同时满足所有约束）
            warnings.push(`${seg.id} 镜${shot.num}：台词需≥${minDur}秒，规划给了${shot.duration}秒`);
          } else {
            errors.push(`${seg.id} 镜${shot.num}：台词需≥${minDur}秒，规划给了${shot.duration}秒`);
          }
        }
      }
    }
  }

  // 台词分配完整性
  const allPlanned = plan.segments
    .flatMap(s => s.shots || [])
    .map(s => (s.dialogue || '').replace(QUOTE_STRIP_RE, ''))
    .filter(Boolean);
  // 拼成一个大字符串，一次 includes 代替嵌套 some
  // 并归一化（去破折号/省略号/空白/换行）：防止 LLM 把一条台词拆到两个镜号时
  // 中间的 "——\n" 把锚点字符串断成两半，导致本函数误报遗漏·forceInject 重复注入
  const plannedConcat = normalizeDialogueForMatch(allPlanned.join('\n'));

  for (const d of dialogues) {
    const colonIdx = d.indexOf('：');
    // 先剥离演员指导括号（validator 和 forceInject 必须用一致的标准）
    const contentFull = stripDirectorNote(
      (colonIdx >= 0 ? d.substring(colonIdx + 1) : d)
    ).trim().replace(QUOTE_STRIP_RE, '');

    // 多锚点：长台词按子句分别检查，防止只有头部被分配而后续子句遗漏
    const clauses = contentFull.split(/(?<=[？！。])/g)
      .map(s => s.trim()).filter(s => s.length >= 4);
    let missingClause = null;
    if (clauses.length > 1) {
      missingClause = clauses.find(c => {
        const anchor = normalizeDialogueForMatch(c.slice(0, 10));
        return anchor && !plannedConcat.includes(anchor);
      });
    } else {
      const core = normalizeDialogueForMatch(contentFull.slice(0, 12));
      if (core && !plannedConcat.includes(core)) missingClause = d;
    }

    if (missingClause) {
      // 台词遗漏在任何模式下都是硬错误：导演模式片段多、约束复杂，更不能让未分配台词
      // 悄悄通过——会导致4条台词全部堆到最后一个片段补写，破坏叙事连贯性。
      // 错误信息附上完整台词原文，让 re-plan prompt 里模型能看清楚要分配哪条。
      errors.push(`台词未被分配到任何镜号（必须加入某个镜号的dialogue字段）：${d}`);
    }
  }

  // 打印警告（不阻止通过）
  if (warnings.length > 0) {
    console.log(`   ⚠️ 规划警告（${warnings.length}条，不阻止通过）：`);
    warnings.forEach(w => console.log(`     · ${w}`));
  }

  return errors;
}

// ── 程序强制注入遗漏台词 ──────────────────────────────────────────────────────
// 在 parsePlan 之后立刻调用，确保规划里每条台词都有对应的 dialogue 字段。
// 台词分配是程序能 100% 保证的事，不应进入"验证→重试"流程。
// 检测逻辑与 validatePlan 完全一致（多锚点），避免两者标准不同导致注入后仍报错。
function forceInjectMissingDialogues(plan, dialogues) {
  if (!plan?.segments?.length || !dialogues?.length) return plan;

  // 1. 建立 dialogue_index → segmentIndex 映射（按最先出现的片段记录）
  const segForDialogue = new Map();
  // 归一化（去破折号/省略号/空白/换行）：防止 LLM 把台词拆到两个镜号时
  // 中间的"——\n"把锚点断成两半，导致本函数误判台词未分配
  const plannedConcat = normalizeDialogueForMatch(plan.segments
    .flatMap(s => s.shots || [])
    .map(s => (s.dialogue || '').replace(QUOTE_STRIP_RE, ''))
    .join('\n'));

  for (let segIdx = 0; segIdx < plan.segments.length; segIdx++) {
    const seg = plan.segments[segIdx];
    const shotTexts = normalizeDialogueForMatch((seg.shots || []).map(s => (s.dialogue || '').replace(QUOTE_STRIP_RE, '')).join('\n'));
    for (let dIdx = 0; dIdx < dialogues.length; dIdx++) {
      if (segForDialogue.has(dIdx)) continue;
      const d = dialogues[dIdx];
      const colonIdx = d.indexOf('：');
      // 剥离演员指导括号，保证与 validatePlan 匹配标准一致
      const content = stripDirectorNote(
        (colonIdx >= 0 ? d.substring(colonIdx + 1) : d)
      ).trim().replace(QUOTE_STRIP_RE, '');
      // 用多锚点检测：所有子句都出现才算"已分配"
      const clauses = content.split(/(?<=[？！。])/g).map(s => s.trim()).filter(s => s.length >= 4);
      const allPresent = clauses.length > 1
        ? clauses.every(c => { const a = normalizeDialogueForMatch(c.slice(0, 10)); return a && plannedConcat.includes(a); })
        : plannedConcat.includes(normalizeDialogueForMatch(content.slice(0, 12)));
      if (allPresent && shotTexts.includes(normalizeDialogueForMatch(content.slice(0, 10)))) {
        segForDialogue.set(dIdx, segIdx);
      }
    }
  }

  // 2. 找出遗漏台词——使用与 validatePlan 完全相同的多锚点 + 归一化逻辑
  const missingIndices = [];
  for (let dIdx = 0; dIdx < dialogues.length; dIdx++) {
    const d = dialogues[dIdx];
    const colonIdx = d.indexOf('：');
    const contentFull = stripDirectorNote(
      (colonIdx >= 0 ? d.substring(colonIdx + 1) : d)
    ).trim().replace(QUOTE_STRIP_RE, '');
    const clauses = contentFull.split(/(?<=[？！。])/g).map(s => s.trim()).filter(s => s.length >= 4);
    let isMissing;
    if (clauses.length > 1) {
      isMissing = clauses.some(c => { const a = normalizeDialogueForMatch(c.slice(0, 10)); return a && !plannedConcat.includes(a); });
    } else {
      const core = normalizeDialogueForMatch(contentFull.slice(0, 12));
      isMissing = core && !plannedConcat.includes(core);
    }
    if (isMissing) missingIndices.push(dIdx);
  }

  if (missingIndices.length === 0) return plan;
  console.log(`📌 程序强制注入 ${missingIndices.length} 条遗漏台词...`);

  // 3. 对每条遗漏台词，找最近邻已分配台词所在片段，追加新镜号
  for (const dIdx of missingIndices) {
    let targetSegIdx = -1;
    for (let i = dIdx - 1; i >= 0; i--) {
      if (segForDialogue.has(i)) { targetSegIdx = segForDialogue.get(i); break; }
    }
    if (targetSegIdx === -1) {
      for (let i = dIdx + 1; i < dialogues.length; i++) {
        if (segForDialogue.has(i)) { targetSegIdx = segForDialogue.get(i); break; }
      }
    }
    if (targetSegIdx === -1) targetSegIdx = plan.segments.length - 1;

    const d = dialogues[dIdx];
    const colonIdx = d.indexOf('：');
    const charName = colonIdx >= 0 ? d.substring(0, colonIdx) : '';
    const content = (colonIdx >= 0 ? d.substring(colonIdx + 1) : d).trim();

    // ─── 防重复兜底：注入前在全 plan 再扫一遍，如果已在任意片段出现就跳过 ───
    // 这是第二道保险（第一道是上面的归一化检测）。只要 LLM 把台词写成任何
    // 认得出来的形式——完整句/拆句/加破折号/换行——就不会重复注入。
    // 匹配前先剥离演员指导括号，保证与 validatePlan 标准一致
    const contentNorm = normalizeDialogueForMatch(stripDirectorNote(content));
    const anchor = contentNorm.slice(0, 10);
    if (anchor && plannedConcat.includes(anchor)) {
      // 已经在 plan 里了·说明这条其实没遗漏·跳过注入
      console.log(`   ⊘ 台词${dIdx + 1} 已在 plan 中（跳过重复注入）：${d.slice(0, 40)}`);
      continue;
    }

    const minDur = Math.min(Math.max(calcMinDuration(d), 2), 5);
    const seg = plan.segments[targetSegIdx];
    if (!seg.shots) seg.shots = [];
    seg.shots.push({
      num: seg.shots.length + 1,
      duration: minDur,
      shot_type: '[中近景]',
      task: `${charName ? charName + '说台词' : '台词'}·听者基线反应`,
      dialogue: content
    });
    segForDialogue.set(dIdx, targetSegIdx);
    console.log(`   → 台词${dIdx + 1} 注入到 ${seg.id}：${d.slice(0, 40)}`);
  }

  return plan;
}

// 构建单片段写作 prompt
// ⚠️ 本函数的拼接顺序为 DeepSeek 前缀缓存优化过——
//    同一场景内多个片段调用共享完全相同的"稳定前缀"（规则+剧本+服化道卡），
//    变化部分（本次片段规划、上片段末帧、首末片段特判）放在最后，
//    这样从第二个片段起 DeepSeek 磁盘缓存能直接命中,首 token 延迟大幅降低。
//    改顺序时务必保持"稳定前缀"完全字节级一致,任何不经意的 seg.id / segIndex
//    泄漏到前缀都会让缓存失效。
function buildSegmentPrompt(scene, segPlan, costumeCard, prevTailFrame, segIndex, totalSegs, refA, allDialogues = []) {
  // ✨ 片段级判类型：如果 segPlan 上挂了独立的 sceneType（来自片段级校验覆写），
  // 则使用 segPlan.sceneType 覆写本次调用的 scene.sceneType，这样规则块按片段类型注入。
  // 用浅拷贝避免污染原 scene 对象（scene 被所有片段共享）。
  if (segPlan.sceneType && segPlan.sceneType !== scene.sceneType) {
    scene = Object.assign({}, scene, { sceneType: segPlan.sceneType });
  }

  const segDialogues = (segPlan.shots || []).map(s => s.dialogue).filter(Boolean);
  const isLast = segIndex === totalSegs - 1;
  const directorShots = extractDirectorShots(scene.content);

  // ══════════════════════════════════════════════════════════
  // ── 稳定前缀开始（所有片段共享，不得引用 seg.id / segIndex）──
  // ══════════════════════════════════════════════════════════
  let p = `你将为同一个场景分片段写完整视频提示词（@+A+B+C+D+E+F六个部分）。本次任务只写一个片段，片段规划和需求在最后给出，先阅读以下共享上下文和写作规则。\n\n`;

  p += `⛔⛔⛔ 硬性字数限制（违反即整条输出作废·比任何规则都优先）：\n`;
  p += `@+A+B+C+D+E+F 全部内容合计 ≤ 1800字（含标点），超出即梦/Sora会截断导致后半段镜号丢失。\n`;
  p += `字数预算（严格执行）：\n`;
  p += `   · A部分 ≤180字：精简参数·每行关键词·禁止展开说明\n`;
  p += `   · B部分 ≤200字：人物状态只写姿态和位置·不写服化道\n`;
  p += `   · C部分 ≤1000字（7 镜号场景每镜 ≤140 字·6 镜号每镜 ≤160 字·5 镜号每镜 ≤200 字）\n`;
  p += `   · D+E+F ≤300字：尾帧简洁·限制指令不超3条·必现目标不超3条\n\n`;

  p += `⛔ C 部分压字数铁律（减少字数的同时保留铁律效果）：\n`;
  p += `1. 每个镜号的叙事结构强制压缩为 3 段：\n`;
  p += `   ① 镜号头部一行（景别+运镜+焦段）\n`;
  p += `   ② 画面正文 2-3 句话：写谁在做什么·说什么·看哪里（每句 ≤25 字）\n`;
  p += `   ③ （）物理反馈 1-2 组：具体物理现象（每组 ≤30 字）\n`;
  p += `2. 禁止写以下文学化修辞（这些全部是字数杀手·且不是画面）：\n`;
  p += `   ✗ "勾勒出他如铁塔般沉稳的轮廓"（比喻·不是画面）\n`;
  p += `   ✗ "裂开了一丝缝隙·流露出深藏其下的心疼与温柔"（心理描述）\n`;
  p += `   ✗ "那种拼尽全力的姿态·让一瘸一拐的跑动充满了悲壮感"（作者评论）\n`;
  p += `   ✗ "眼神如冰冷的刀锋·逐一扫过那些尚未入画的敌人"（诗化语言）\n`;
  p += `   ✗ "她的视线穿透镜头·死死锁住画面外的张玄"（心理描述·不是画面）\n`;
  p += `3. 只写可拍到的物理事实：\n`;
  p += `   ✓ "张玄侧脸·眼睛从平视缓慢转向下方"（物理动作）\n`;
  p += `   ✓ "张雨晴撑地的手指节发白·右腿站起来时颤抖一下"（物理细节）\n`;
  p += `4. 视线路径·听者反应·声画分离"嘴唇开合"等铁律仍要执行·但用最短的词写：\n`;
  p += `   ✓ "视线从大屏移到研究员 N·头转向左侧"（8 字写完视线路径）\n`;
  p += `   ✗ "她先是看着大屏上的张玄监控画面·然后缓缓把头转过来看向站在左边的研究员 N"（30 字·太啰嗦）\n`;
  p += `5. 【B】人物状态禁止写："←AGENT_B 服化道锁定词"这类元说明·直接写具体姿态（"站立不动·双手垂落"）\n`;
  p += `6. 【D】尾帧只写 2 行：空间变化一行·主要角色状态一行·传出接棒物一行·不展开\n`;
  p += `7. 【E】限制指令最多 3 条·【F】必现目标最多 3 条·每条一行\n\n`;

  // 导演指令优先级 + ⚠️强调清单（场景级共享）
  if (directorShots.length > 0) {
    p += `⛔ 导演指令优先级高于自行判断：\n`;
    p += `1. 导演批注里描述的具体动作不能改——"漂移甩尾"不能改成"直冲"，"三个视角"不能合成一个。\n`;
    p += `2. 本片段规划的task如果引用了导演指令，C部分叙事必须按导演描述的方式写，不能自行替换。\n`;
    p += `3. 导演标注了⚠️的内容，必须在C部分叙事中明确体现：\n`;
    p += `   · "台词一定要重音" → 叙事写"在「XX」上刻意加重咬字"\n`;
    p += `   · "一定要注重" → 叙事里必须有详细动作描写\n`;
    p += `   · "一定要大声" → 叙事写"大声/提高音量"\n`;
    p += `4. A部分格式统一：不加方括号，参数用·分隔。\n\n`;

    const mustItems = [];
    processDirectorNotes(scene.content, (match, inner) => {
      for (const line of inner.split('\n')) {
        if (line.includes('⚠️') || line.includes('一定要') || line.includes('必须')) {
          mustItems.push(line.trim());
        }
      }
      return match;
    });
    if (mustItems.length > 0) {
      p += `【导演⚠️强调清单（写完C部分后逐条检查是否落实）】\n`;
      mustItems.forEach((item, i) => { p += `[强调${i + 1}] ${item}\n`; });
      p += `\n`;
    }
  }

  p += `⛔⛔⛔ 最优先铁律·防止指令泄漏（违反即整条输出作废）：\n`;
  p += `以下所有规则是对你输出的【约束】，不是 C 部分的【内容】。\n`;
  p += `禁止把任何规则文字、格式要求，元说明、"每个段落必须 XX"、"⚠️ XX 必须 YY"、"（⚠️ XX）"这类祈使句或括号元说明·写进最终输出里。\n`;
  p += `C 部分只写画面叙事——摄影机运动 + 人物动作 + 台词 + （物理反馈）。\n`;
  p += `不要在镜号之前或 C 部分开头加任何"格式声明"、"写法要求"、"规则说明"。\n`;
  p += `不要用"（⚠️ ...）"或"（注：...）"或"（说明：...）"在 C 部分正文里出现。\n`;
  p += `如果你想提醒自己某个规则，放在脑子里·不要写进输出。\n`;
  p += `✗ 错误示范（规则泄漏到输出里）：\n`;
  p += `  【C】镜头序列：\n`;
  p += `  （⚠️ 每个段落以 [景别] 开头·武戏用英文[景别 (English)]·文戏用中文[景别]·后接复合运镜指令·三层缝合在同一句话里推进）\n`;
  p += `  （⚠️ 武戏段落必须包含（）内的物理特效描述，文戏台词格式：动作状态+冒号+引号）\n`;
  p += `  镜1  3s · [特写 (Extreme Close-up)]...\n`;
  p += `✓ 正确示范（直接从镜1 开始·无任何元说明）：\n`;
  p += `  【C】镜头序列：\n`;
  p += `  镜1  3s · [特写 (Extreme Close-up)] 俯视锁定张玄右脚与地面接触点，接地面石板微震  焦段100mm\n`;
  p += `  ...\n\n`;

  p += `⛔ 通用写作规则（所有片段共享）：\n`;
  p += `1. C部分镜号数量、时长必须与规划完全一致，不得增删。\n`;
  p += `1a. 每个段落以 [景别] 开头：${scene.sceneType === 'wuxi' ? '武戏用英文如 [大特写 (Extreme Close-up)]' : '文戏用中文如 [近景]·[中近景]·[过肩]'}，后接复合运镜指令，焦段写在镜号头部或描述里。\n`;
  p += `1b. ⚠️ 每个镜号必须三层缝合：第一层叙事+第二层摄影机运动（有情绪/力的理由）+第三层（）物理反馈，缺一不可。空壳镜号（只有说话没有运镜没有物理反馈）禁止输出。\n`;
  p += `2. 含台词的镜号必须在叙事正文里写出台词原文（动作状态+冒号+引号）。\n`;
  p += `3. OS独白必须以"角色OS：「引号原文」"格式写进对应镜号叙事正文。\n`;
  p += `3b. 声画分离镜号（task含"声画分离"）：写纯画面叙事，开头注明"【声画分离】XX的OS/台词继续"，不重复写台词原文。画面按【文戏专项规则】规则十-补的三层优先级选择（①听者反应 ②说话者细节 ③空景环境）。\n`;
  p += `3d. 反应镜号（task含"反应"）：纯画面·写听者的表情变化、身体反应、沉默。不写台词。让对话有呼吸感，不要从一句台词直接跳到下一句。\n`;
  p += `4. C部分第一段第一句锚定入场景别和视角。\n`;
  p += `5. 最后一段最后一句锚定出场景别和视角，并标注接棒物。\n\n`;

  // ── 武戏专属规则 ──
  if (scene.sceneType === 'wuxi') {
    p += `\n【武戏专项规则】\n`;
    p += `武1. 武戏三层缝合：第一层叙事+第二层镜头作为物理参与者（被力裹着走）+第三层（）材质物理反馈。（）内只写材质世界的物理反应——力从哪来·打到什么上·材质怎么形变·形变怎么扩散，不写情绪不写心理。\n`;
    p += `武2. 武戏镜头允许大幅度运动——大特写到大全景、撞击式变焦、360度环绕、贴地疾驰、俯冲压下。镜头被动作的力拽着走。\n`;
    p += `武3. 武戏五段式（蓄势→启动→爆发→收尾→余震）：每个镜号必须服务于五段式中的一个阶段，参考规划里 five_stage 字段。\n`;
    p += `武4. 武戏（）写宏大物理破坏——金属交响·震荡波·材质粉碎·地面塌陷·血雾轨迹。\n`;
  }

  // ── 文戏专属规则 ──
  if (scene.sceneType !== 'wuxi') {
    p += `\n【文戏专项规则】（必须和 wenxi.txt 铁律 30 条 + 范例三/四/五对齐）\n`;
    p += `文1. ⚠️ 动作线两层：第一层"道具任务"（吃饭/擦刀）来源是 AGENT_A 批注的【动作线设计】块或剧本原文；第二层"情绪驱动肢体"（往前走一步/转身/撑桌子/后退）是说话/听话时身体自然会做的事，必须写。批注的【动作线设计】里写"无道具任务"或没有该批注时，第一层不编，全靠第二层撑场面。\n`;
    p += `文2. ⚠️ 听者身体反应：说话人说完立刻切走拍听者。听者是身体先动不是脸先动——上半身往后靠/手悬空/肩膀缩/笔掉了。说话人不能连续占两个以上镜号。\n`;
    p += `文3. ⚠️ 台词三拍结构（重量台词必用）：情绪拐点句/决绝句/摊牌句/底牌句/情感爆发句必须写成三拍——拍一组织动作（台词前的物理动作·必须从情绪基线派生·决策者用"视线从 A 移到 B"·犹豫者才用"捏鼻梁/摸下巴"）+ 拍二伴随动作（说台词时的身体动作·一句话内有 2-3 个视线落点·中途换气）+ 拍三消化动作（台词后的物理反应·嘴唇抿紧/视线落下去/手放下）。⛔ 禁止"张嘴念完就闭嘴"的零拍台词——AI 视频模型看到零拍台词会生成成播音员念稿。\n`;
    p += `文4. ⚠️ 动作情绪基线派生：每个动作必须从角色的情绪基线派生——决策者的动作偏硬精准有指令感（敲桌·视线锁定目标），犹豫者的动作偏软有拖拽感（捏鼻梁·摸下巴），承压方的动作内收退缩（肩缩·手扶桌借力）。禁止套通用模板"捏鼻梁=思考/搓手=紧张/握拳=愤怒"——这些对任何同类角色都成立，套到谁身上都不出戏。动笔前先回答：这个角色是谁？此刻在情绪基线的哪个位置？权力关系是施压还是承压？\n`;
    p += `文5. ⚠️ 镜头运动克制：文戏镜头必须克制·单镜号内的空间跨度不能大·禁止武戏式的"大特写→大全景"戏剧性机位变化·禁止"极速拉远变焦"等大幅度运动。文戏镜头是低调的——推进半步·焦平面收紧·侧向平移·手持轻微抖动·停住见证。单镜号内允许硬切但节制（一般 2-3 个画面），切是为了让情绪落地，不是炫技。\n`;
    p += `文6. ⚠️ 文戏默认 7 镜号：每个 15 秒文戏片段默认 7 个镜号（允许 5-8）·单镜 ≤3 秒·4 秒绝对不允许·3.5 秒也不允许，参考 wenxi.txt 范例三/四/五的规格。镜号头部格式："镜X  Xs · [景别] 复合运镜指令  焦段XXmm"。\n`;
    p += `文7. ⚠️ 混合场景写法（本片段如果既有台词又有武戏动作）：按文戏规则写整个片段——武戏动作当作"大幅度的情绪驱动肢体"来写，镜头运动保持文戏克制（不做大特写→大全景），（）物理反馈可以偏武戏尺度（写刀锋冷光·格挡震动·衣料被气流带动）但不写宏大破坏。\n`;
    p += `文8. ⚠️ 说话者视线路径（有台词镜号强制）：一句话内部必须有 2-3 个视线/头部落点——整句话盯着一个点说完会让 AI 生成表情冻住。\n`;
    p += `     · 一对多场景：每句话看一个具体的听者·视线路径是"锁定目标"的弧线·最后闭环\n`;
    p += `     · 一对一场景：80/30 配比（施压方 80% 锁定·承压方 30% 看对方 70% 躲避）\n`;
    p += `     · 独白场景：视线必须有具体替身（大屏影像/墓碑/照片/窗外某点/镜子里的自己）不是虚空\n`;
    p += `文9. ⚠️ 听者基线动作（双人同框镜号强制）：听者不能罚站·从镜1 第一秒起就有可见基线动作·反应必须是可见大动作。\n`;
    p += `     · 基线动作范围：身体姿势可自编（扶桌·背手·插口袋·交叠手臂）；基线道具必须来自剧本或 B 服化道卡·不能瞎编\n`;
    p += `     · 反应动作标准：抬头/扭头/低头/甩手/往后退半步/把手拿开/换重心/扶住某处借力（可见大动作）\n`;
    p += `     · ⛔ 严禁微动作：喉结动/眉毛动/瞳孔变化/肌肉绷紧——AI 拍不出来观众看不见\n`;
    p += `文10. ⚠️ 镜头方向铁律·同框对戏（双人/多人场景强制）：\n`;
    p += `     · 两人对戏时听者必须在画面里以某种形式在场·禁止"对空气说话"\n`;
    p += `     · 推荐构图（AI 友好）：说话者实焦·听者过肩虚焦给肩膀/衣服/衣领（不给头）\n`;
    p += `     · ⛔ 禁止构图：说话者在前景虚焦不给头（AI 会混淆要不要对嘴·容易把台词处理成画外音）\n`;
    p += `文11. ⚠️ 声画分离铁律（含台词镜号强制）：\n`;
    p += `     · 声画分离 ≠ 画外音广播——角色永远在演"正在说话"这件事·即使画面焦点不在嘴上·身体也要有说话状态的外显表现\n`;
    p += `     · 虚焦镜号的叙事必须写"嘴唇在虚焦里持续开合着"或"侧脸下颌线随说话节奏轻微起伏"或"肩膀随说话的呼吸节奏起伏着"\n`;
    p += `     · 画面给到嘴 = 嘴和声音必须完全同步·禁止延迟对嘴\n`;
    p += `     · ⛔ 禁止写法："【声画分离】XX 的声音从画外继续"——AI 会理解成角色像广播一样发声·身体静止\n`;
    p += `     · ✓ 正确写法："【声画分离·画面聚焦 XX】前景角色在剪影里嘴唇持续开合着，侧脸下颌线随说话节奏轻微起伏，声音从前景传出：'台词原文'"\n`;
    p += `     · 声画分离段结束后必须有 1.5 秒无台词缓冲镜号·让 AI 退出"画外音模式"\n`;
  }

  p += `\n⚠️ C部分禁止出现"导演""Agent""批注""强调"等内部术语。直接描写画面，不要说"导演强调的XX"。\n\n`;

  // 场景信息（稳定）
  p += `═══ 场景信息 ═══\n`;
  p += `@${scene.characters.join(' @')} @${scene.location || '场景地点'}\n`;
  p += `场景编号：${scene.id}\n`;
  p += `场景标题：${scene.header || ''}\n`;
  p += `本场共${totalSegs}个片段。\n\n`;

  // 剧本原文（稳定，通常最大的一块）
  p += `═══ AGENT_A 批注剧本（按规划施工，参考导演讲戏细节）═══\n${scene.content}\n\n`;

  // 服化道卡（稳定）
  if (costumeCard && costumeCard.trim()) {
    p += `═══ AGENT_B 服化道卡 ═══\n${costumeCard}\n\n`;
  }

  // 参考 A 部分参数（稳定，场景级一次生成，所有片段共享）
  if (refA) {
    p += `═══ 【A部分参数（必须原样使用，不得修改）】═══\n${refA}\n\n`;
  }

  // ══════════════════════════════════════════════════════════
  // ── 稳定前缀结束。以下内容每片段不同，不会进入共享缓存。──
  // ══════════════════════════════════════════════════════════
  p += `═══════════════════════════════════════\n`;
  p += `以上为共享上下文。以下为本次具体任务。\n`;
  p += `═══════════════════════════════════════\n\n`;

  p += `【本次写作任务】\n`;
  p += `请为【片段 ${segPlan.id}】写完整提示词（@+A+B+C+D+E+F六个部分）。当前是本场第 ${segIndex + 1} 个片段（共 ${totalSegs} 个）。\n\n`;

  p += `【片段位置特定规则】\n`;
  if (segIndex === 0) {
    p += `6. 这是第一个片段，无上一片段接棒，【片段衔接核对】写"无上一片段"。\n`;
  } else {
    p += `6. 上一片段末帧：${prevTailFrame || '（规划未指定，请根据剧本推断合理衔接）'}，本片段首镜景别/视角必须与之至少一个维度不同。\n`;
  }
  if (isLast) {
    const hasTransition = scene.content.includes('转场') || scene.content.includes('无缝衔接');
    p += `7. 这是最后一个片段，【D】视觉接棒写"本场结束，无接棒"。\n`;
    if (hasTransition) {
      p += `   ⚠️ 导演指定了转场方式（见批注中"转场"相关内容），最后一镜的最后一帧必须完成转场设计，不能截断。如果导演说"眼睛到眼睛转场"，最后一帧必须写到眼睛恢复正常并为下一场接入做好准备。\n`;
    }
  } else {
    p += `7. 这不是最后一个片段，【D】必须写出接棒物。\n`;
  }
  if (segIndex > 0) {
    p += `⚠️ A部分必须与第一个片段完全一致——同一场景、同一地点、同一时间，物理参数不变。直接复制第一个片段的A部分。\n`;
  }
  p += `\n`;

  p += `【镜号规划（严格执行）】\n`;
  p += `片段：${segPlan.id}  ${segPlan.title}  总时长：${segPlan.duration}秒`;
  if (segPlan.arc_position) p += `  弧线位置：${segPlan.arc_position}  强度：${segPlan.intensity || ''}`;
  p += `\n`;
  for (const shot of (segPlan.shots || [])) {
    const shotType = shot.shot_type || shot.focal || '';
    p += `镜${shot.num}  ${shot.duration}s · ${shotType}  `;
    p += `任务：${shot.task}`;
    if (shot.five_stage) p += `  [五段式：${shot.five_stage}]`;
    if (shot.dialogue) p += `  ★台词：${shot.dialogue}`;
    p += `\n`;
  }
  p += `\n`;

  if (segDialogues.length > 0) {
    p += `【本片段台词清单（★标注台词全部必须逐字出现在C部分正文，不得遗漏）】\n`;
    segDialogues.forEach((d, i) => { p += `★[台词${i + 1}] ${d}\n`; });
    p += `⚠️ 共${segDialogues.length}条台词，写完C部分后逐条核对，有遗漏禁止输出。\n\n`;
  }

  // ── 场景全部台词背景参考（防止因上下文遗忘导致前几步内容缺失）──
  // 把本场所有台词都传入，让模型在生成时保持对剧本全貌的感知
  if (refA && allDialogues && allDialogues.length > segDialogues.length) {
    const otherDialogues = allDialogues.filter(d => !segDialogues.includes(d));
    if (otherDialogues.length > 0) {
      p += `【场景其余台词（背景参考·本片段不写，但不要忘记它们的存在和上下文）】\n`;
      otherDialogues.forEach((d, i) => { p += `[参考${i + 1}] ${d}\n`; });
      p += `\n`;
    }
  }

  p += `请直接输出【${segPlan.id}】的完整提示词，包含@声明、【片段标题】、【A】【B】【C】【D】【E】【F】六个部分。不要输出其他片段。`;
  return p;
}

// 从规划对象生成 <scene_plan> 块（供前端规划卡和片段核对使用）
function generateScenePlanBlock(plan, scene, dialogues) {
  const typeLabel = scene.sceneType === 'wuxi' ? '武戏' : '文戏';
  const sceneDuration = plan.segments.reduce((sum, s) => sum + (s.duration || 0), 0);
  const dialogueDuration = dialogues.reduce((sum, d) => sum + calcMinDuration(d), 0);

  let text = `场景：[${scene.id}] · [${scene.location || scene.header}] · [${typeLabel}]\n`;
  text += `台词总时长：约${Math.round(dialogueDuration * 10) / 10}秒（场景共${sceneDuration}秒）\n`;
  text += `片段规划：\n`;

  for (const seg of plan.segments) {
    const segDls = (seg.shots || []).map(s => s.dialogue).filter(Boolean);
    const dlSummary = segDls.length > 0 ? `承载${segDls.length}条台词` : '无台词';
    text += `片段${seg.id}：${dlSummary}，时长约${seg.duration}秒\n`;
  }

  text += `合计：${plan.segments.length}个片段，约${sceneDuration}秒`;
  return `<scene_plan>\n${text}\n</scene_plan>`;
}

// ── 场景进度辅助：携带子步骤供前端渲染进度条 ──────────────────
// steps 固定四项：规划 / A参数 / 写作 / 验证
// doneCount = 已完成数量（0-4）；当前 active = doneCount 那一项
function setSceneProgress(job, idx, sceneId, status, message, doneCount = 0) {
  const STEP_NAMES = ['规划', 'A参数', '写作', '验证'];
  const now = Date.now();
  if (!job.progress[idx]) {
    job.progress[idx] = { sceneId, status, message, steps: [] };
  }
  if (!job.progress[idx].steps || job.progress[idx].steps.length === 0) {
    job.progress[idx].steps = STEP_NAMES.map((name, i) => ({
      name,
      done: false,
      active: false,
      startTime: null,
      endTime: null
    }));
  }
  for (let i = 0; i < STEP_NAMES.length; i++) {
    const step = job.progress[idx].steps[i];
    if (i < doneCount) {
      step.done = true;
      step.active = false;
      if (!step.endTime) step.endTime = now;
    } else if (i === doneCount && status === 'processing') {
      step.done = false;
      step.active = true;
      if (!step.startTime) step.startTime = now;
    } else {
      step.done = false;
      step.active = false;
    }
  }
  job.progress[idx].sceneId = sceneId;
  job.progress[idx].status = message;
  job.progress[idx].message = message;
}

// 多步处理一个场景：规划 → 逐片段写作
async function processSceneMultiStep(scene, costumeCard, config, job, sceneIndex) {
  const dialogues = extractDialogues(scene.content);
  const systemPrompt = buildSystemPrompt(scene.sceneType, { sceneContent: scene.content, dialogueCount: dialogues.length, characterCount: scene.characters.length, hasLongOS: /OS[：:]/.test(scene.content) && scene.content.length > 400 });
  const planSystemPrompt = loadCoreForPlan(); // ✨ 规划阶段精简加载·比完整 core 少 80% 字符

  // ── 第一步：规划 ─────────────────────────────────────────
  setSceneProgress(job, sceneIndex, scene.id, 'processing', '规划中...（最长5分钟，超时自动报错）', 0);

  let plan = null;
  const directorShots = extractDirectorShots(scene.content);
  const hasDirectorShots = directorShots.length > 0;

  // 导演讲戏模式：放宽镜头数限制 + 计算最少片段数
  const limits = hasDirectorShots
    ? { minShots: 5, maxShots: 10 }
    : (SCENE_RULES[scene.sceneType] || SCENE_RULES.mixed);

  let minSegments = 1;
  if (hasDirectorShots) {
    const shotCount = directorShots.filter(d => d.isShot).length;
    const byTime = Math.ceil(shotCount * 2.5 / 15);
    const byChars = Math.ceil(directorShots.length / 8);
    const dialogueDur = dialogues.reduce((sum, d) => sum + calcMinDuration(d), 0);
    const byDialogue = dialogues.length > 0 ? Math.ceil(dialogueDur / 12) : 0;
    minSegments = Math.max(byTime, byChars, byDialogue, 1);
    console.log(`   导演讲戏模式：${shotCount}条镜头+${directorShots.length - shotCount}条内心·最少${minSegments}个片段（3-10镜/片段）`);
  }

  // ── 第一次尝试 ───────────────────────────────────────────
  // 拿到规划后立刻注入遗漏台词：台词分配由程序保证，不走"验证→重试"流程。
  // 后续 validatePlan 只处理结构性问题（时长/镜号数/片段数）。
  const planText1 = await callAPI(planSystemPrompt, buildPlanPrompt(scene, costumeCard, dialogues), config);
  let plan1 = parsePlan(planText1);
  if (plan1) plan1 = forceInjectMissingDialogues(plan1, dialogues);

  if (!plan1) {
    console.log(`⚠️ ${scene.id} 规划JSON解析失败`);
  } else {
    const errors1 = validatePlan(plan1, dialogues, limits, minSegments);
    if (errors1.length === 0) {
      console.log(`✓ ${scene.id} 规划通过，共${plan1.segments.length}个片段`);
      plan = plan1;
    } else {
      // ── 结构性错误 → 带错误信息重新规划 ────────────────────
      console.log(`⚠️ ${scene.id} 规划有结构问题，修正中：\n${errors1.join('\n')}`);
      const fixPrompt = buildPlanPrompt(scene, costumeCard, dialogues)
        + `\n\n上次规划有以下结构错误，请修正后重新输出JSON：\n`
        + errors1.map(e => `- ${e}`).join('\n');
      const planText2 = await callAPI(planSystemPrompt, fixPrompt, config);
      let plan2 = parsePlan(planText2);
      if (plan2) plan2 = forceInjectMissingDialogues(plan2, dialogues);

      if (!plan2) {
        console.log(`⚠️ ${scene.id} 修正规划JSON解析失败，使用plan1继续`);
        plan = plan1; // plan1 台词已注入，结构略差但可用
      } else {
        // 第二次验证放宽片段数（relaxed=true）
        const errors2 = validatePlan(plan2, dialogues, limits, minSegments, true);
        if (errors2.length === 0) {
          console.log(`✓ ${scene.id} 修正规划通过，共${plan2.segments.length}个片段`);
          plan = plan2;
        } else {
          // 两次规划都有结构问题：选片段数更多的那个继续（台词都已注入，不再降级单次）
          console.log(`⚠️ ${scene.id} 两次规划均有结构问题，取较优规划继续：\n${errors2.join('\n')}`);
          plan = plan2.segments.length >= plan1.segments.length ? plan2 : plan1;
          console.log(`   → 使用 ${plan === plan2 ? 'plan2' : 'plan1'}（${plan.segments.length}个片段）`);
        }
      }
    }
  }

  // 规划彻底失败则降级为单次生成
  if (!plan) {
    console.log(`⚠️ ${scene.id} 规划失败，降级为单次生成`);
    return await processSceneSingleShot(scene, costumeCard, config, job, sceneIndex, systemPrompt, dialogues);
  }

  // ── C方案·片段级节拍二次校验（不阻断流程，只输出警告日志）─────
  // 用于监控场景级判类型在片段层面是否准确
  // 用顶部预编译的 SEG_CHECK_RE（与 detectSceneType 的词库保持一致）
  // ✨ 片段级判类型：推断出的类型会覆写该片段的 sceneType·写作时使用片段级类型注入规则
  for (const seg of plan.segments) {
    const segText = (seg.shots || []).map(s => `${s.task || ''} ${s.dialogue || ''}`).join(' ');
    const segMovementCount = countBigMovement(segText, SEG_CHECK_RE);
    // 真实台词数（≤5字短吼不算）
    const segDialogues = (seg.shots || []).map(s => s.dialogue).filter(Boolean);
    const segRealDialogues = segDialogues.filter(d => {
      const stripped = d.replace(/[""「」『』"'！？。，.,!?\s]/g, '');
      return stripped.length > 5;
    });
    const segDlCount = segRealDialogues.length;

    // 推断这个片段实际应该是什么类型
    // ⚠️ 收紧标准·避免把文戏误判为武戏：
    // - 真实台词 ≥2 条 → 一定是 wenxi（对话场景）
    // - 完全没有台词 + 大运动 ≥3 个 → wuxi（纯动作场景）
    // - 完全没有台词 + 大运动 ≥2 个 → wuxi（轻度动作场景）
    // - 其他情况全部 wenxi（包括有台词但少·或者只有 1 个大运动动词的情况）
    let inferredType;
    if (segDlCount >= 2) inferredType = 'wenxi';
    else if (segDlCount === 0 && segMovementCount >= 3) inferredType = 'wuxi';
    else if (segDlCount === 0 && segMovementCount >= 2) inferredType = 'wuxi';
    else inferredType = 'wenxi';

    // 默认继承场景级类型
    seg.sceneType = scene.sceneType;

    // 如果推断类型和场景级不一致·覆写为片段级类型
    if (inferredType !== scene.sceneType) {
      seg.sceneType = inferredType;
      console.log(`✨ ${scene.id} 片段${seg.id} 类型覆写：场景级 ${scene.sceneType} → 片段级 ${inferredType}（大运动${segMovementCount}个·真实台词${segDlCount}条）`);
      console.log(`   → 这个片段会按 ${inferredType} 规则写·允许大跨度镜头和 4s 大镜`);
    }
  }

  // ── 第二步：确定A部分参数（只生成一次），再并行写所有片段 ───────

  // 提取A部分的辅助函数
  function extractASection(text) {
    const match = text.match(/【A】画面物理系统[：:]?\n?([\s\S]*?)(?=\n【B】)/);
    return match ? match[0].trim() : null;
  }

  // 尝试从服化道卡提取A部分（Agent B 路径）
  let referenceA = null;
  if (costumeCard && costumeCard.trim()) {
    // B的服化道卡里应该有【画面物理系统】
    const fromB = costumeCard.match(/【画面物理系统】\n?([\s\S]*?)(?=\n【|$)/);
    if (fromB) {
      referenceA = '【A】画面物理系统：\n' + fromB[1].trim();
      console.log(`✓ ${scene.id} A部分来源：Agent B 服化道卡（${referenceA.length}字）`);
    }
  }

  // ✨ 性能优化：没有B卡时，不再单独调一次 API 生成 A 部分（避免串行阻塞）。
  // 策略：让第一个片段自行生成 A 部分，写作完成后从输出中提取，
  // 后续所有片段写作前等待 referenceA 就绪，复用第一个片段的 A 部分。
  // 相比原来"先生成A再并行写片段"，节省了一次完整 API 调用的等待时间。
  let referenceAPromise = null;
  let referenceAResolve = null;
  if (!referenceA) {
    // 创建一个 promise，首片段写完后 resolve
    referenceAPromise = new Promise(resolve => { referenceAResolve = resolve; });
    setSceneProgress(job, sceneIndex, scene.id, 'processing', '并行写作中...（最长5分钟，超时自动报错）', 1);
  }

  // 单片段写作+验证的通用流程
  async function writeAndVerifySegment(seg, si, refA) {
    const prevTailFrame = si === 0 ? '' : (plan.segments[si - 1].tailFrame || '');
    // refA 作为参数传入 buildSegmentPrompt，会被放进稳定前缀，参与 DeepSeek 前缀缓存命中
    const segPrompt = buildSegmentPrompt(
      scene, seg, costumeCard, prevTailFrame, si, plan.segments.length, refA, dialogues
    );

    // ✨ 片段级判类型：如果 seg 有独立 sceneType（被 C 方案校验覆写过），
    // 用片段级类型加载 system prompt·这样该片段拿到的是 wuxi.txt 而不是场景级的 wenxi.txt
    const effectiveSystemPrompt = (seg.sceneType && seg.sceneType !== scene.sceneType)
      ? buildSystemPrompt(seg.sceneType, { sceneContent: scene.content, dialogueCount: dialogues.length, characterCount: scene.characters.length, hasLongOS: /OS[：:]/.test(scene.content) && scene.content.length > 400 })
      : systemPrompt;

    let segOutput = await callAPI(effectiveSystemPrompt, segPrompt, config);

    // 台词核验 + 补写
    const segDialogues = (seg.shots || []).map(s => s.dialogue).filter(Boolean);
    if (segDialogues.length > 0) {
      const missing = verifyDialogues(segDialogues, segOutput);
      if (missing.length > 0) {
        segOutput = await repairMissingDialogues(missing, segOutput, effectiveSystemPrompt, config);
        console.log(`✓ ${seg.id} 台词补写完成`);
      } else {
        console.log(`✓ ${seg.id} 台词核验通过`);
      }
    }
    // ─── v7 字数 Cascade：先砍 F → 再砍 D → 最后才去 API 压缩 ───
    let charCount = segOutput.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;
    if (charCount > 1800) {
      console.warn(`⚠️ ${seg.id} 字数 ${charCount}·启动 Cascade 压缩...`);

      // 第一级：regex 砍 F（必现目标）——0 API 调用
      const afterCutF = segOutput.replace(/【F】必现目标[：:]?[^【]*?(?=\n【|$)/, '').trim();
      const c1 = afterCutF.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;

      if (c1 <= 1800) {
        segOutput = afterCutF;
        charCount = c1;
        console.log(`✓ ${seg.id} Cascade 级1·砍 F 后 ${c1} 字`);
      } else {
        // 第二级：再砍 D（尾帧）——0 API 调用
        const afterCutDF = afterCutF.replace(/【D】尾帧[：:]?[^【]*?(?=\n【|$)/, '').trim();
        const c2 = afterCutDF.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;

        if (c2 <= 1800) {
          segOutput = afterCutDF;
          charCount = c2;
          console.log(`✓ ${seg.id} Cascade 级2·砍 D+F 后 ${c2} 字`);
        } else {
          // 第三级：API 压缩 C 修辞（最后手段·+1 次调用）
          console.warn(`⚠️ ${seg.id} 级2 后仍 ${c2} 字·API 压缩 C...`);
          try {
            const compressPrompt =
              `以下片段字数 ${c2}·超 1800·请只压缩 C 部分的形容词和修辞·不得删除任何镜号、台词、（）物理反馈。D 和 F 已经被砍过·不用再碰。\n\n原片段：\n${afterCutDF}\n\n直接输出压缩后的完整片段。`;
            const compressed = await callAPI(effectiveSystemPrompt, compressPrompt, config);
            const c3 = compressed.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;
            if (c3 < c2 && c3 <= 2000) {
              segOutput = compressed;
              charCount = c3;
              console.log(`✓ ${seg.id} 级3·API 压缩后 ${c3} 字`);
            } else {
              segOutput = afterCutDF;
              charCount = c2;
              console.warn(`⚠️ ${seg.id} API 压缩无效·保留级2（${c2} 字）`);
            }
          } catch (err) {
            segOutput = afterCutDF;
            charCount = c2;
            console.warn(`⚠️ ${seg.id} API 压缩失败·保留级2: ${err.message}`);
          }
        }
      }
    } else {
      console.log(`✓ ${seg.id} 字数 ${charCount}·合格`);
    }
    // 时长验证
    // 三档逻辑：
    //   1. actualTotal > 15.5s         → 铁律红线·必须警告
    //   2. actualTotal < plannedTotal  → 合理情况·末尾片段常有余震/收尾留白·不警告
    //   3. actualTotal > plannedTotal 且差 >2s 但 ≤15s → 轻微超时·提示即可
    const SHOT_DUR_RE = /镜\d+\s+(\d+(?:\.\d+)?)\s*s/g;
    const actualTotal = Array.from(segOutput.matchAll(SHOT_DUR_RE), m => parseFloat(m[1]))
      .reduce((sum, d) => sum + d, 0);
    const plannedTotal = (seg.shots || []).reduce((s, sh) => s + (sh.duration || 0), 0);
    if (actualTotal > 0 && actualTotal > 15.5) {
      console.warn(`⚠️ ${seg.id} 实际总时长 ${actualTotal}s 超过15秒铁律上限`);
    } else if (actualTotal > 0 && actualTotal > plannedTotal + 2) {
      // 只警告"实际比规划长"的情况·"短于规划"视为正常（末尾收尾/余震）
      console.warn(`⚠️ ${seg.id} 实际总时长 ${actualTotal}s 超过规划 ${plannedTotal}s（超${(actualTotal - plannedTotal).toFixed(1)}s）`);
    } else if (actualTotal > 0) {
      console.log(`✓ ${seg.id} 时长 ${actualTotal}s，合格`);
    }

    // ✨ 首片段完成后提取 A 部分，广播给后续所有片段
    if (si === 0 && referenceAResolve) {
      const extractedA = extractASection(segOutput);
      if (extractedA) {
        referenceA = extractedA;
        console.log(`✓ ${scene.id} A部分从首片段提取（${referenceA.length}字）`);
      } else {
        console.warn(`⚠️ ${scene.id} 首片段未找到A部分，后续片段自行生成`);
      }
      referenceAResolve(referenceA); // 无论是否提取成功都 resolve，不阻塞后续片段
      referenceAResolve = null;
    }

    return segOutput;
  }

  // 并行写所有片段（全部带参考A部分）
  setSceneProgress(job, sceneIndex, scene.id, 'processing', `并行写作 ${plan.segments.length} 个片段...`, 2);

  // ── 片段级自动重试：DeepSeek 在高峰期偶发 600s 超时·重试 2 次兜底 ──
  // 只对 timeout/network 类错误重试·内容类错误（JSON 解析失败等）不重试避免死循环
  async function writeWithRetry(seg, si, refA) {
    const MAX_RETRIES = 2;
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await writeAndVerifySegment(seg, si, refA);
      } catch (err) {
        lastErr = err;
        const msg = err.message || '';
        const isRetryable = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|fetch failed|socket hang up|600-second/i.test(msg);
        if (!isRetryable || attempt === MAX_RETRIES) {
          console.error(`❌ ${seg.id} 写作失败（尝试 ${attempt + 1}/${MAX_RETRIES + 1}）: ${msg}`);
          throw err;
        }
        const waitMs = 2000 * (attempt + 1); // 2s, 4s
        console.warn(`⚠️ ${seg.id} 网络/超时失败（尝试 ${attempt + 1}/${MAX_RETRIES + 1}），${waitMs / 1000}s 后重试: ${msg.slice(0, 80)}`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    throw lastErr;
  }

  // ✨ 并行策略：si=0 先用 null（自行生成A），si>0 等待 referenceAPromise resolve 后再拿 A 部分复用
  const segmentPromises = plan.segments.map((seg, si) => {
    const getRefA = si === 0
      ? Promise.resolve(null)
      : (referenceAPromise || Promise.resolve(referenceA));
    return getRefA.then(resolvedA =>
      writeWithRetry(seg, si, resolvedA !== null ? resolvedA : referenceA)
        .catch(err => {
          // 如果首片段失败，resolve promise 避免其他片段永久等待
          if (si === 0 && referenceAResolve) {
            referenceAResolve(null);
            referenceAResolve = null;
          }
          console.error(`❌ ${seg.id} 最终失败: ${err.message}`);
          return `[${seg.id} 生成失败: ${err.message}]`;
        })
    );
  });
  const segResults = await Promise.allSettled(segmentPromises);
  const outputs = segResults.map((result, si) => {
    if (result.status === 'fulfilled') return result.value;
    return `[${plan.segments[si].id} 生成失败]`;
  });

  // 生成 scene_plan 块，供前端规划卡和片段核对使用
  const scenePlanBlock = generateScenePlanBlock(plan, scene, dialogues);

  // ── 全场景台词总检 + 补写 ─────────────────────────────────
  // 所有片段拼合后，用完整台词表再查一遍，防止跨片段遗漏
  setSceneProgress(job, sceneIndex, scene.id, 'processing', '台词总检...', 3);
  if (dialogues.length > 0) {
    const finalMissing = verifyDialogues(dialogues, outputs.join('\n'));
    if (finalMissing.length > 0) {
      console.warn(`⚠️ ${scene.id} 全场景台词总检：${finalMissing.length} 条台词遗漏，智能定位补写...`);
      finalMissing.forEach((d, i) => console.warn(`   遗漏${i + 1}：${d.slice(0, 40)}...`));

      // ─── ✨ 性能优化：预建台词→片段索引（避免 O(N×M×K) 嵌套循环）────────
      // 构建 Map：台词文本 → 该台词在哪个片段
      const dialogueSegMap = new Map();
      for (let segIdx = 0; segIdx < outputs.length; segIdx++) {
        if (outputs[segIdx].startsWith('[')) continue; // 跳过失败片段
        for (const dlg of dialogues) {
          if (verifyDialogues([dlg], outputs[segIdx]).length === 0) {
            dialogueSegMap.set(dlg, segIdx);
          }
        }
      }

      // ─── 智能定位：根据台词在剧本中的位置·找到它应该落在哪个片段 ───
      // 方法：用每条遗漏台词前一条已分配台词的所在片段作为目标
      // 如果都找不到·再退回到"最后一个片段"
      const repairTasks = []; // 收集所有补写任务
      for (const missingDlg of finalMissing) {
        const mIdx = dialogues.indexOf(missingDlg);
        if (mIdx < 0) continue;

        // 向前找最近一条"已分配"的台词·它在哪个片段
        let targetSegIdx = -1;
        for (let i = mIdx - 1; i >= 0; i--) {
          const prevD = dialogues[i];
          if (dialogueSegMap.has(prevD)) {
            targetSegIdx = dialogueSegMap.get(prevD);
            break;
          }
        }

        // 向前找不到·向后找
        if (targetSegIdx < 0) {
          for (let i = mIdx + 1; i < dialogues.length; i++) {
            const nextD = dialogues[i];
            if (dialogueSegMap.has(nextD)) {
              targetSegIdx = dialogueSegMap.get(nextD);
              break;
            }
          }
        }

        // 都找不到·退回最后一个有效片段
        if (targetSegIdx < 0) {
          targetSegIdx = outputs.length - 1;
          while (targetSegIdx >= 0 && outputs[targetSegIdx].startsWith('[')) targetSegIdx--;
        }

        if (targetSegIdx < 0) {
          console.warn(`⚠️ 台词 "${missingDlg.slice(0, 20)}..." 无法定位·跳过补写`);
          continue;
        }

        console.log(`   📍 台词 "${missingDlg.slice(0, 25)}..." 定位到片段 ${targetSegIdx + 1}/${outputs.length}`);
        repairTasks.push({ missingDlg, targetSegIdx });
      }

      // ─── ✨ 核心优化：并行补写 + 写入冲突处理 ───────────────────────
      // 同一片段可能收到多条遗漏台词，合并后一次调用 API
      const segRepairMap = new Map(); // segIdx → [missingDialogues]
      for (const task of repairTasks) {
        if (!segRepairMap.has(task.targetSegIdx)) {
          segRepairMap.set(task.targetSegIdx, []);
        }
        segRepairMap.get(task.targetSegIdx).push(task.missingDlg);
      }

      // 并行执行所有补写
      const repairPromises = Array.from(segRepairMap.entries()).map(async ([segIdx, missingDlgs]) => {
        try {
          const newOutput = await repairMissingDialogues(missingDlgs, outputs[segIdx], systemPrompt, config);
          return { segIdx, newOutput, success: true };
        } catch (err) {
          console.warn(`⚠️ 片段 ${segIdx + 1} 补写失败：${err.message}`);
          return { segIdx, newOutput: outputs[segIdx], success: false };
        }
      });

      const repairResults = await Promise.all(repairPromises);

      // 合并结果（只更新成功的）
      for (const result of repairResults) {
        if (result.success) {
          outputs[result.segIdx] = result.newOutput;
        }
      }

      // 整体再验一次
      const finalMissing2 = verifyDialogues(dialogues, outputs.join('\n'));
      if (finalMissing2.length > 0) {
        console.warn(`⚠️ ${scene.id} 智能补写后仍有 ${finalMissing2.length} 条遗漏·最后兜底到末尾片段`);
        // 最后的最后·还漏的再全塞到末尾
        const lastIdx = outputs.findLastIndex((o, i) => !o.startsWith('[') && i === outputs.length - 1);
        const fallbackIdx = lastIdx >= 0 ? lastIdx : outputs.length - 1;
        if (fallbackIdx >= 0 && !outputs[fallbackIdx].startsWith('[')) {
          try {
            outputs[fallbackIdx] = await repairMissingDialogues(finalMissing2, outputs[fallbackIdx], systemPrompt, config);
          } catch (err) {
            console.warn(`⚠️ 兜底补写失败：${err.message}`);
          }
        }
      } else {
        console.log(`✓ ${scene.id} 智能补写完成·${dialogues.length} 条台词全部落实`);
      }
    } else {
      console.log(`✓ ${scene.id} 全场景台词总检通过，${dialogues.length} 条台词全部落实`);
    }
  }

  // 重新生成 finalOutput（补写可能修改了 outputs）
  const finalOutput = scenePlanBlock + '\n\n' + outputs.join('\n\n');

  // ── 全场景导演指令核验 ─────────────────────────────────
  // 检查导演的关键动作词是否出现在最终输出中
  const dirKeywords = extractDirectorKeywords(scene.content);
  if (dirKeywords.length > 0) {
    const allOutput = outputs.join('\n');
    const missingKw = dirKeywords.filter(kw => !allOutput.includes(kw));
    if (missingKw.length > 0) {
      console.warn(`⚠️ ${scene.id} 导演指令核验：${missingKw.length} 个关键词未在输出中找到：${missingKw.join('、')}`);
    } else {
      console.log(`✓ ${scene.id} 导演指令核验通过，${dirKeywords.length} 个关键词全部落实`);
    }
  }

  return finalOutput;
}

// 降级方案：单次生成（规划彻底失败时使用）
async function processSceneSingleShot(scene, costumeCard, config, job, sceneIndex, systemPrompt, dialogues) {
  job.progress[sceneIndex] = {
    sceneId: scene.id, status: 'processing', message: '生成中（单次模式，最长5分钟）...'
  };

  let userMsg = `请为以下场景生成完整的视频提示词。\n\n`;
  userMsg += `【场景信息】\n场景编号：${scene.id}\n场景地点：${scene.location || '见剧本'}\n`;
  userMsg += `出场角色：${scene.characters.join('、') || '见剧本'}\n`;
  userMsg += `⚠️ @声明必须填入实际内容：@${scene.characters.join(' @')} @${scene.location || '场景地点'}\n\n`;

  // 台词时长预算：程序算好直接给模型，不需要模型自己算
  if (dialogues.length > 0) {
    userMsg += `⛔ 程序预算：本场台词最短时长（含台词的镜号时长必须≥对应值）\n`;
    dialogues.forEach((d, i) => {
      const min = calcMinDuration(d);
      userMsg += `[台词${i + 1}] ${d}  →  最短${min}秒\n`;
    });
    userMsg += `\n`;
  }

  userMsg += `⛔⛔⛔ 最优先铁律·防止指令泄漏（违反即整条输出作废）：\n`;
  userMsg += `以下所有规则是对你输出的【约束】，不是 C 部分的【内容】。\n`;
  userMsg += `禁止把任何规则文字、格式要求、元说明、"⚠️ XX 必须 YY"、"（⚠️ XX）"这类祈使句或括号元说明·写进最终输出里。\n`;
  userMsg += `C 部分只写画面叙事——摄影机运动 + 人物动作 + 台词 + （物理反馈）。\n`;
  userMsg += `不要在镜号之前或 C 部分开头加任何"格式声明"、"写法要求"、"规则说明"。\n`;
  userMsg += `不要用"（⚠️ ...）"或"（注：...）"或"（说明：...）"在 C 部分正文里出现。\n\n`;

  userMsg += `⛔ 强制执行规则（逐条执行，不得跳过）：\n`;
  userMsg += `1. C部分所有内容必须100%来自剧本原文，禁止自创任何动作、对话或场景。\n`;
  userMsg += `2. 剧本中▲开头的每一个动作必须在C部分对应镜号里出现，不得跳过或合并。\n`;
  userMsg += `3. 所有台词必须是剧本原文，一字不得改动，禁止自行创作台词。\n`;
  userMsg += `4. （导演讲戏：...）括号内优先级标注"必须补"或"⚠️必须"的内容，必须生成对应的独立镜号或片段。\n`;
  userMsg += `5. 如果导演讲戏里有Cold Open或特殊开场指令且标注"必须补"，必须作为第一个片段的前置镜号输出。\n`;
  userMsg += `6. 【镜头意图】稳帧点要求的每一帧，必须在对应镜号叙事里明确写出停帧时长。\n`;
  userMsg += `7. 【镜头意图】INSERT要求的特写画面，必须作为独立镜号出现在C部分，不得合并进其他镜号。\n`;
  userMsg += `8. 动笔写任何片段的C部分之前，必须先在analysis块【台词分配表】里逐条列出本片段所有台词和OS独白（包括原文），标注计划写入哪个镜号；写完后逐句回标"已在镜X使用"，有遗漏禁止输出。\n`;
  userMsg += `9. OS独白必须以"角色OS：引号原文"格式写进对应镜号叙事正文，不能只写画面描述而省略OS文字。\n`;
  userMsg += `10. ⚠️ 每个片段镜号时长之和不得超过15秒。台词多/导演指令多时增加片段数量，不要硬塞。\n`;
  userMsg += `11. ⚠️ 台词之间必须有反应镜头（1-2秒）：角色A说完后，不要直接接角色B的台词。中间插一个听者反应的镜号。反应镜头也占时间，装不下就多分一个片段。\n`;
  userMsg += `12. 导演批注里描述的具体动作不能改——"漂移甩尾"不能改成"直冲"。\n`;
  userMsg += `13. ⚠️ 每片段字数预算（超1800字即梦会截断）：A≤200字·B≤200字·C≤1000字·D+E+F≤400字。\n`;
  userMsg += `14. A部分格式统一：所有片段的A部分用相同格式，不加方括号，参数用·分隔。\n`;
  userMsg += `15. 导演标注了⚠️/一定要/必须的内容，C部分叙事中必须明确体现（如"重音"→写"刻意加重咬字"）。\n`;
  userMsg += `16. 导演描述的连贯走位调度放在同一个片段，不拆开。\n`;
  userMsg += `17. ⚠️ 镜号格式铁律：每个镜号以 [景别] 开头·后接复合运镜指令·焦段写在镜号头部或描述里。${scene.sceneType === 'wuxi' ? '武戏用英文景别如 [大特写 (Extreme Close-up)]' : '文戏用中文景别如 [近景]·[中近景]·[过肩]'}。\n`;
  userMsg += `18. ⚠️ 三层缝合：第一层叙事+第二层摄影机运动（有情绪/力的理由）+第三层（）物理反馈，缺一不可。空壳镜号禁止输出。\n`;

  // ── 武戏专属规则 ──
  if (scene.sceneType === 'wuxi') {
    userMsg += `\n【武戏专项规则】\n`;
    userMsg += `武1. 武戏（）写宏大物理破坏——金属交响·震荡波·材质粉碎·地面塌陷·血雾轨迹，不写情绪不写心理。\n`;
    userMsg += `武2. 武戏镜头允许大幅度运动——大特写到大全景、撞击式变焦、360度环绕、贴地疾驰、俯冲压下。\n`;
    userMsg += `武3. 武戏五段式（蓄势→启动→爆发→收尾→余震）：每个镜号必须服务于五段式中的一个阶段。\n`;
    userMsg += `武4. 武戏每片段3-6个镜号，每镜2-4秒，冲击感优先。\n`;
  }

  // ── 文戏专属规则（含混合场景）──
  if (scene.sceneType !== 'wuxi') {
    userMsg += `\n【文戏专项规则】（必须和 wenxi.txt 铁律 30 条 + 范例三/四/五对齐）\n`;
    userMsg += `文1. ⚠️ 动作线两层：第一层"道具任务"（吃饭/擦刀）来源是 AGENT_A 批注的【动作线设计】块或剧本原文，不编；第二层"情绪驱动肢体"（往前走一步/转身/撑桌子）是人说话时身体自然会做的事，必须写。优先从【动作线设计】批注块提取每个角色的物理任务，没有该批注或写"无"时第一层留空。\n`;
    userMsg += `文2. ⚠️ 听者身体反应：说话人说完立刻切走拍听者身体反应（上半身后靠/手停了/肩缩了），不是只拍脸。说话人不能连续占两个以上镜号。\n`;
    userMsg += `文3. ⚠️ 台词三拍结构（重量台词必用）：情绪拐点句/决绝句/摊牌句必须写三拍——拍一组织动作（必须从情绪基线派生·决策者用"视线从 A 移到 B"·犹豫者才用"捏鼻梁/摸下巴"）+ 拍二说台词（含伴随动作·一句话 2-3 个视线落点）+ 拍三消化动作。⛔ 禁止"张嘴念完就闭嘴"的零拍台词。\n`;
    userMsg += `文4. ⚠️ 动作情绪基线派生：每个动作从角色情绪基线派生，不套通用模板。决策者用敲桌不用捏鼻梁，承压方用扶桌借力不用握拳。\n`;
    userMsg += `文5. ⚠️ 镜头运动克制：禁止大跨度镜头（大特写→大全景），文戏镜头是低调的——推进半步·焦平面收紧·侧向平移·手持轻微抖动。单镜号内允许硬切但节制。\n`;
    userMsg += `文6. ⚠️ 文戏默认 7 镜号：每片段默认 7 个镜号（允许 5-8）·单镜 ≤3 秒·4 秒绝对不允许·3.5 秒也不允许，参考 wenxi.txt 范例三/四/五的规格。\n`;
    userMsg += `文7. ⚠️ 混合场景写法（本片段如果既有台词又有武戏动作）：按文戏规则写整个片段——武戏动作当作"大幅度的情绪驱动肢体"来写，镜头运动保持文戏克制，（）物理反馈可以偏武戏尺度（写刀锋冷光·格挡震动·衣料被气流带动）但不写宏大破坏。\n`;
    userMsg += `文8. ⚠️ 说话者视线路径（有台词镜号强制）：一句话内部必须有 2-3 个视线/头部落点——整句话盯着一个点说完会让 AI 生成表情冻住。一对多场景=每句话看一个具体听者形成锁定弧线最后闭环；一对一=80/30 配比（施压方 80% 锁定·承压方 30% 看对方）；独白=视线必须有具体替身（大屏/墓碑/照片）不是虚空。\n`;
    userMsg += `文9. ⚠️ 听者基线动作（双人同框镜号强制）：听者不能罚站·从镜1 第一秒起就有可见基线动作（扶桌/扶柜/手插口袋/交叠手臂）·基线道具必须来自剧本或 B 服化道卡不能瞎编·反应必须是可见大动作（抬头/扭头/低头/扶桌/往后退半步）·⛔ 严禁微动作（喉结动/眉毛动/瞳孔变化）。\n`;
    userMsg += `文10. ⚠️ 镜头方向铁律·同框对戏：两人对戏时听者必须在画面里（说话者实焦+听者过肩虚焦给肩膀/衣服不给头 = AI 友好构图）·⛔ 禁止单人特写拍说话者完全没有听者暗示（对空气说话）·⛔ 禁止说话者在前景虚焦不给头（AI 会混淆要不要对嘴）。\n`;
    userMsg += `文11. ⚠️ 声画分离铁律：声画分离 ≠ 画外音·角色永远在演"正在说话"·虚焦镜号叙事必须写"嘴唇在虚焦里持续开合着"或"侧脸下颌线随说话节奏轻微起伏"·画面给到嘴 = 嘴和声音必须完全同步禁止延迟对嘴·声画分离段结束后必须有 1.5s 无台词缓冲镜号+短台词测试对嘴模式恢复·⛔ 禁止写"【声画分离】XX 的声音从画外继续"（AI 会让角色身体静止）·✓ 正确写"【声画分离·画面聚焦 XX】前景角色嘴唇持续开合着...声音从前景传出：'台词原文'"。\n`;
  }

  // 检测转场指令
  if (scene.content.includes('转场') || scene.content.includes('无缝衔接')) {
    userMsg += `\n⚠️ 导演指定了转场方式，最后一个片段的最后一镜必须完成转场设计，不能截断。\n`;
  }
  userMsg += `\n`;

  // 提取⚠️强调清单
  const mustItemsSS = [];
  processDirectorNotes(scene.content, (match, inner) => {
    for (const line of inner.split('\n')) {
      if (line.includes('⚠️') || line.includes('一定要') || line.includes('必须')) {
        mustItemsSS.push(line.trim());
      }
    }
    return match;
  });
  if (mustItemsSS.length > 0) {
    userMsg += `【导演⚠️强调清单（写完后逐条检查是否落实）】\n`;
    mustItemsSS.forEach((item, i) => { userMsg += `[强调${i + 1}] ${item}\n`; });
    userMsg += `\n`;
  }

  userMsg += `═══ AGENT_A 批注剧本 ═══\n${scene.content}\n\n`;
  if (costumeCard && costumeCard.trim()) {
    userMsg += `═══ AGENT_B 服化道卡 ═══\n${costumeCard}\n\n`;
  }
  userMsg += `请直接输出所有15秒片段的完整提示词，台词多时自动拆分，全部片段一次性输出。`;

  let result = await callAPI(systemPrompt, userMsg, config);

  if (dialogues.length > 0) {
    const missing = verifyDialogues(dialogues, result);
    if (missing.length > 0) {
      result = await repairMissingDialogues(missing, result, systemPrompt, config);
    }
    // 补写后再检一次
    const finalMissing = verifyDialogues(dialogues, result);
    if (finalMissing.length > 0) {
      console.warn(`⚠️ ${scene.id} 单次模式台词总检：补写后仍有 ${finalMissing.length} 条遗漏：`);
      finalMissing.forEach((d, i) => console.warn(`   遗漏${i + 1}：${d.slice(0, 40)}...`));
    } else {
      console.log(`✓ ${scene.id} 单次模式台词总检通过，${dialogues.length} 条台词全部落实`);
    }
  }

  // 单次模式15秒/片段检查（警告，不阻断）
  const segDurMatches = result.match(/【片段\S+】[\s\S]*?(?=【片段|$)/g) || [result];
  const SHOT_DUR_RE_SS = /镜\d+\s+(\d+(?:\.\d+)?)\s*s/g;
  for (let si = 0; si < segDurMatches.length; si++) {
    const segText = segDurMatches[si];
    const segTotal = Array.from(segText.matchAll(SHOT_DUR_RE_SS), m => parseFloat(m[1]))
      .reduce((sum, d) => sum + d, 0);
    if (segTotal > 15.5) {
      console.warn(`⚠️ ${scene.id} 单次模式片段${si + 1}：总时长 ${segTotal}s 超过15秒铁律上限`);
    } else if (segTotal > 0) {
      console.log(`✓ ${scene.id} 单次模式片段${si + 1}：时长 ${segTotal}s，合格`);
    }
  }

  return result;
}

// ============================================================
// 路由
// ============================================================

// Railway 健康检查端点（/ → 区分活跃/空闲，Railway 10s 超时）
app.get('/', (req, res) => {
  const activeJobs = jobs.size + agentAJobs.size;
  const activeList = [];
  for (const [id, job] of jobs) {
    if (job.status === 'running') activeList.push({ id: id.slice(0, 12), scenes: job.total });
  }
  console.log(`[健康检查] jobs=${jobs.size} agentA=${agentAJobs.size} 活跃=${activeJobs} ${activeList.length > 0 ? '→ ' + activeList.map(j => j.id).join(',') : '(空闲)'}`);
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeJobs,
    activeJobList: activeList,
    ts: new Date().toISOString()
  });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: '未收到上传文件，请选择文件后重试。' });
    let text = '';
    try {
      if (file.originalname.toLowerCase().endsWith('.docx')) {
        const result = await mammoth.extractRawText({ path: file.path });
        text = result.value;
      } else {
        text = fs.readFileSync(file.path, 'utf-8');
      }
    } finally {
      // 无论成功还是失败都清理 temp 文件，避免 uploads/ 目录泄漏
      try { fs.unlinkSync(file.path); } catch {}
    }
    const { scenes, episodeInfo, episodeMap } = parseScript(text);
    if (scenes.length === 0) {
      return res.status(400).json({ error: '未识别到场景。请确认文件包含"场景X-X"格式的场景标题。' });
    }
    res.json({ scenes, episodeInfo, episodeMap });
  } catch (err) {
    res.status(500).json({ error: `文件解析失败：${err.message}` });
  }
});

app.post('/api/process', async (req, res) => {
  const { scenes, costumeCard, config } = req.body;
  if (!config?.apiKey) return res.status(400).json({ error: '请填写 API Key' });
  if (!scenes?.length) return res.status(400).json({ error: '没有场景数据' });

  const jobId = `job_${Date.now()}`;
  jobs.set(jobId, {
    status: 'running',
    progress: scenes.map(s => ({ sceneId: s.id, status: 'pending', message: '等待中' })),
    results: new Array(scenes.length).fill(null),
    total: scenes.length,
    completed: 0
  });

  res.json({ jobId });

  const CONCURRENCY = 6; // DeepSeek 不限流，并发 4 在非高峰时段接近线性提速；高峰期靠内置 429 退避兜底
  const job = jobs.get(jobId);
  let index = 0;

  async function runNext() {
    if (index >= scenes.length) return;
    const i = index++;
    const scene = scenes[i];

    try {
      const result = await processSceneMultiStep(scene, costumeCard, config, job, i);
      setSceneProgress(job, i, scene.id, 'done', '完成 ✓', 4);
      job.results[i] = {
        sceneId: scene.id, sceneHeader: scene.header,
        sceneType: scene.sceneType, episode: scene.episode, content: result
      };
    } catch (err) {
      setSceneProgress(job, i, scene.id, 'error', `错误: ${err.message}`, 0);
      job.results[i] = {
        sceneId: scene.id, sceneHeader: scene.header,
        sceneType: scene.sceneType, episode: scene.episode,
        content: `[生成失败: ${err.message}]`
      };
    }

    job.completed++;
    await runNext();
  }

  const workers = Array(Math.min(CONCURRENCY, scenes.length)).fill(null).map(() => runNext());
  Promise.all(workers)
    .then(() => { job.status = 'done'; job.finishedAt = Date.now(); })
    .catch(err => { console.error(err); job.status = 'error'; job.finishedAt = Date.now(); });
});

app.get('/api/progress/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // iv 必须先赋 null，避免首次同步调用 send() 时 job 已结束而触发 TDZ ReferenceError
  let iv = null;
  const send = () => {
    const job = jobs.get(req.params.jobId);
    if (!job) { res.write(`data: {"error":"not found"}\n\n`); res.end(); return; }
    res.write(`data: ${JSON.stringify({
      status: job.status, progress: job.progress,
      completed: job.completed, total: job.total
    })}\n\n`);
    if (job.status === 'done' || job.status === 'error') { clearInterval(iv); res.end(); }
  };
  send();
  iv = setInterval(send, 800);
  req.on('close', () => clearInterval(iv));
});

app.get('/api/results/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json({ results: job.results.filter(Boolean), status: job.status });
});

app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  let content = `视频提示词输出\n生成时间：${new Date().toLocaleString('zh-CN')}\n\n`;
  for (const r of job.results.filter(Boolean)) {
    const typeLabel = r.sceneType === 'wuxi' ? '[武戏]' : r.sceneType === 'wenxi' ? '[文戏]' : '[混合]';
    content += `${'═'.repeat(60)}\n场景 ${r.sceneId}  ${r.sceneHeader}  ${typeLabel}\n${'═'.repeat(60)}\n\n`;
    content += r.content + '\n\n';
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''video-prompts-${Date.now()}.txt`);
  res.send(content);
});

app.get('/api/download-prompts/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  let content = `视频提示词输出（纯提示词版）\n生成时间：${new Date().toLocaleString('zh-CN')}\n\n`;
  for (const r of job.results.filter(Boolean)) {
    const typeLabel = r.sceneType === 'wuxi' ? '[武戏]' : r.sceneType === 'wenxi' ? '[文戏]' : '[混合]';
    content += `${'═'.repeat(60)}\n场景 ${r.sceneId}  ${r.sceneHeader}  ${typeLabel}\n${'═'.repeat(60)}\n\n`;
    const clean = r.content
      .replace(/<scene_plan>[\s\S]*?<\/scene_plan>/g, '')
      .replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
      .replace(/\n{3,}/g, '\n\n').trim();
    content += clean + '\n\n';
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''video-prompts-clean-${Date.now()}.txt`);
  res.send(content);
});

app.post('/api/reload-prompts', (req, res) => {
  for (const key of Object.keys(_promptCache)) delete _promptCache[key];
  delete _planCoreCache.content;
  res.json({
    message: '提示词缓存已清空，下次处理时重新读取',
    prompts: [
      'core.txt', 'wenxi.txt', 'wuxi.txt',
      'agent_a.md', 'agent_a_director.md',
      'agent_b.md',
      'A无导版本前面ins.txt', 'A有导版本前面ins.txt', 'C-core版本前面ins.txt'
    ]
  });
});


// ============================================================
// Agent A v6：规划 → 验证 → 执行 → 验证（与 Agent C 同级架构）
// ============================================================

function stripMarkdown(text) {
  return text
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^---+\s*$/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/```[\s\S]*?```/g, m => m.replace(/^```\w*\n?/, '').replace(/\n?```$/, ''))
    .replace(/<think>/gi, '').replace(/<\/think>/gi, '') // 清理 MiniMax/M2.7 思维链标签
    .replace(/\n{3,}/g, '\n\n');
}

function parseRawScript(text) {
  const scenes = [], lines = text.split('\n');
  let cur = null, ep = '01';
  for (const line of lines) {
    const t = line.trim();
    const epM = t.match(/第\s*(\d+)\s*[集话]/);
    if (epM) ep = epM[1].padStart(2, '0');
    let sid = null, hdr = null;
    const f1 = t.match(/^(?:场景)?(\d+[-–]\d+[A-Za-z]?)\s+((?:日|夜|晨|黄昏|傍晚|清晨)\s+(?:内|外|内外)\s+.+)/);
    if (f1) { sid = f1[1]; hdr = f1[2].trim(); }
    if (!sid) { const f2 = t.match(/^场景(\S+)\s+(.+)/); if (f2) { sid = f2[1]; hdr = f2[2].trim(); } }
    if (!sid) { const f3 = t.match(/^第(\S+)[场幕]\s*(.*)/); if (f3) { sid = f3[1]; hdr = f3[2].trim() || '第' + f3[1] + '场'; } }
    if (sid) {
      if (cur) scenes.push(cur);
      const lm = hdr.match(/[内外]\s+(.+)$/) || hdr.match(/(?:外|内)\s*(.+)/);
      cur = { id: sid, header: hdr, location: lm ? lm[1].trim() : hdr, content: t, characters: [], episode: ep };
    } else if (cur) {
      cur.content += '\n' + line;
      const cm = t.match(/^人物[：:]\s*(.+)/);
      if (cm) cur.characters = cm[1].split(/[·，,、\s]+/).map(c => c.trim()).filter(Boolean);
    }
  }
  if (cur) scenes.push(cur);
  return { scenes, rawText: text };
}

function extractRawDialogues(sc) {
  const skip = ['场景','人物','▲','【','（','二、','第'];
  const dl = [];
  for (const line of sc.split('\n')) {
    const t = line.trim();
    if (!t || !t.includes('：')) continue;
    if (skip.some(p => t.startsWith(p)) && !t.startsWith('（旁白）') && !t.startsWith('（画外音）') && !t.startsWith('（VO）')) continue;
    const ci = t.indexOf('：'), cp = t.substring(0, ci), co = t.substring(ci + 1).trim();
    if (cp.length > 15 || !co || co.length < 2) continue;
    dl.push(t);
  }
  return dl;
}

// ── 规划阶段 ──────────────────────────────────────────────

function buildAnnotationPlanPrompt(scene, allScenes, soulCard, prevFeel) {
  const origDL = extractRawDialogues(scene.content);
  const origAct = scene.content.match(/^▲.+$/gm) || [];
  const sceneList = allScenes.map(s => s.id + ' ' + s.header).join('\n');

  let p = '你是批注规划专员，只做规划，不写批注正文。\n\n';
  p += '请分析以下场景，为每一行标注需要哪些批注类型，输出 JSON。\n';
  p += '⚠️ 只输出 JSON，不要任何其他文字或代码块标记。\n\n';
  p += '批注类型代码：\n';
  p += '  intent = 【镜头意图】必须捕捉\n';
  p += '  stable = 【镜头意图】稳帧点\n';
  p += '  gap = 【镜头意图·节点缺口】+ 导演补充方案\n';
  p += '  inner = 【人物内心】\n';
  p += '  forbid = 【禁止】\n';
  p += '  none = 无特殊批注\n\n';
  p += '规划规则：\n';
  p += '1. 台词行（type=dialogue）必须标注 inner，除非是纯信息交代\n';
  p += '2. 有情绪意义的▲动作行必须标注 intent 和/或 inner\n';
  p += '3. 关键负面节点（背叛/死亡/羞辱/爆发）必须标注 forbid\n';
  p += '4. 开场如果缺少"暖"的建立，标注 gap + cold_open\n';
  p += '5. 情绪转折点必须标注 stable（稳帧点）\n';
  p += '6. dialogue_count 和 action_count 必须与以下程序计数一致\n';
  p += '7. ⚠️ action_thread_design 字段必填——为本场景每个有名字的角色规划"道具任务型动作线"：\n';
  p += '   优先级①：剧本原文写了角色在做什么物理任务（"▲他坐桌边吃面"）→ 直接提取\n';
  p += '   优先级②：剧本未写但场景上下文强暗示（吃饭场景/兵器房/办公室等）→ 推断合理任务\n';
  p += '   优先级③：剧本完全没暗示（如临时指挥部里的对话）→ 写"无道具任务·依赖第二层情绪驱动肢体"\n';
  p += '   ⚠️ 第三种情况不要硬编一个任务出来，写"无道具任务"即可，Agent C 会用第二层撑场面\n\n';
  p += '程序计数（铁律，不可改）：\n';
  p += '  台词行：' + origDL.length + ' 条\n';
  p += '  动作行：' + origAct.length + ' 条\n\n';

  if (prevFeel) p += '上一场情绪落点：' + prevFeel + '\n\n';
  p += '═══ 剧魂定位卡 ═══\n' + soulCard + '\n\n';
  p += '═══ 全剧场景列表 ═══\n' + sceneList + '\n\n';
  p += '═══ 场景' + scene.id + ' 原文 ═══\n' + scene.content + '\n\n';

  p += 'JSON 格式：\n';
  p += '{"scene_id":"' + scene.id + '","scene_feel":"一句话","emotion_flow":"A→B→C",';
  p += '"structure_node":"节点类型","cold_open":false,';
  p += '"action_thread_design":[{"character":"角色名","task":"物理任务或无道具任务","source":"剧本原文/上下文推断/无"}],';
  p += '"action_thread_turning_point":"情绪拐点处的动作线变化·一句话",';
  p += '"lines":[{"num":1,"type":"info/action/dialogue","text":"原文前20字","needs":["intent","inner"]}],';
  p += '"dialogue_count":' + origDL.length + ',"action_count":' + origAct.length + '}\n';
  return p;
}

function parseAnnotationPlan(text) {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    return JSON.parse(clean.substring(start, end + 1));
  } catch (e) { console.error('批注规划JSON解析失败:', e.message); return null; }
}

function validateAnnotationPlan(plan, originalContent) {
  const errors = [];
  if (!plan) return ['规划格式错误，无法解析JSON'];
  if (!plan.scene_feel) errors.push('缺少 scene_feel');
  if (!plan.emotion_flow) errors.push('缺少 emotion_flow');
  if (!plan.action_thread_design || !Array.isArray(plan.action_thread_design) || plan.action_thread_design.length === 0) {
    errors.push('缺少 action_thread_design（场景级强制·每个有名字的角色一条·没有道具任务时写"无道具任务"）');
  }

  const origDL = extractRawDialogues(originalContent);
  const origAct = originalContent.match(/^▲.+$/gm) || [];
  if (plan.dialogue_count !== origDL.length) errors.push('dialogue_count=' + plan.dialogue_count + '，程序计数=' + origDL.length);
  if (plan.action_count !== origAct.length) errors.push('action_count=' + plan.action_count + '，程序计数=' + origAct.length);

  // 检查台词行是否都有 inner
  const dlLines = (plan.lines || []).filter(l => l.type === 'dialogue');
  const dlNoInner = dlLines.filter(l => !l.needs || (!l.needs.includes('inner') && !l.needs.includes('none')));
  if (dlNoInner.length > 0) errors.push(dlNoInner.length + '条台词行缺少 inner 标注');

  // 至少有一个 intent
  const hasIntent = (plan.lines || []).some(l => l.needs && l.needs.includes('intent'));
  if (!hasIntent) errors.push('无任何 intent 标注，缺少镜头意图');

  return errors;
}

// ── 执行阶段 ──────────────────────────────────────────────

function buildAnnotationExecutePrompt(scene, plan, allScenes, soulCard, prevFeel) {
  const sceneList = allScenes.map(s => s.id + ' ' + s.header + ' [人物：' + (s.characters.join('、') || '见内容') + ']').join('\n');

  let msg = '请按照以下批注规划，为场景' + scene.id + '写完整批注。\n';
  msg += '⚠️ 纯文本，禁止 Markdown。按系统提示词中的格式模板输出。\n';
  msg += '⚠️ 台词和▲动作行必须原样保留一字不改，只在后面加（导演讲戏：...）批注块。\n';
  msg += '⚠️ 严格按规划执行：规划标注 inner 的行必须写【人物内心】，标注 intent 的行必须写【镜头意图】，标注 none 的行写【无特殊批注】。\n\n';

  // 规划摘要
  msg += '═══ 批注规划（严格执行）═══\n';
  msg += '场景感受：' + (plan.scene_feel || '') + '\n';
  msg += '情绪走向：' + (plan.emotion_flow || '') + '\n';
  msg += '结构节点：' + (plan.structure_node || '') + '\n';
  if (plan.cold_open) msg += 'Cold Open：需要（必须补）\n';
  if (plan.action_thread_design && plan.action_thread_design.length > 0) {
    msg += '动作线设计（场景级强制·必须写入场景标题行的批注块）：\n';
    for (const a of plan.action_thread_design) {
      msg += '  ' + (a.character || '?') + '：' + (a.task || '?') + '（来源：' + (a.source || '?') + '）\n';
    }
    if (plan.action_thread_turning_point) {
      msg += '  情绪拐点处的动作线变化：' + plan.action_thread_turning_point + '\n';
    }
  }
  msg += '逐行批注任务：\n';
  for (const l of (plan.lines || [])) {
    msg += '  行' + l.num + ' [' + l.type + '] ' + (l.text || '').slice(0, 25) + ' → ' + (l.needs && l.needs.length ? l.needs.join('+') : 'none') + '\n';
  }
  msg += '\n';

  if (prevFeel) msg += '上一场情绪落点（衔接参考）：' + prevFeel + '\n\n';
  msg += '═══ 剧魂定位卡 ═══\n' + soulCard + '\n\n';
  msg += '═══ 全剧场景列表 ═══\n' + sceneList + '\n\n';
  msg += '═══ 场景' + scene.id + ' 原文 ═══\n' + scene.content + '\n\n';
  msg += '请输出场景' + scene.id + '的完整批注（含═══分隔线、标题、人物、逐行批注）。只输出这一个场景。';
  return msg;
}

// ── 验证 ──────────────────────────────────────────────

function validateAnnotation(originalContent, annotatedContent) {
  const errors = [];
  if (!(annotatedContent.match(/（导演讲戏：/g) || []).length) errors.push('缺少（导演讲戏：）批注块');
  if (!annotatedContent.includes('【场景感受】')) errors.push('缺少【场景感受】');
  if (!annotatedContent.includes('【动作线设计】')) errors.push('缺少【动作线设计】（场景级强制批注·每个角色一条物理任务或"无道具任务"）');

  // （导演讲戏：）括号闭合检查
  let openCount = 0;
  const marker = '（导演讲戏：';
  let pos = 0;
  while ((pos = annotatedContent.indexOf(marker, pos)) !== -1) {
    openCount++;
    let depth = 1, p = pos + 1;
    while (p < annotatedContent.length && depth > 0) {
      if (annotatedContent[p] === '（') depth++;
      else if (annotatedContent[p] === '）') depth--;
      p++;
    }
    if (depth !== 0) errors.push('第' + openCount + '个（导演讲戏：）块括号未闭合');
    pos = p;
  }

  const origDL = extractRawDialogues(originalContent);
  for (const d of origDL) {
    const ci = d.indexOf('：');
    const core = d.substring(ci + 1).trim().replace(/[""「」『』"']/g, '').slice(0, 15);
    if (core && !annotatedContent.includes(core)) errors.push('台词遗漏：' + d.slice(0, 35) + '...');
  }
  for (const a of (originalContent.match(/^▲.+$/gm) || [])) {
    const core = a.slice(1, 20).trim();
    if (core && !annotatedContent.includes(core)) errors.push('动作行遗漏：' + a.slice(0, 35) + '...');
  }
  const strippedAnno = stripDirectorNotes(annotatedContent);
  for (const ad of extractRawDialogues(strippedAnno)) {
    const ci = ad.indexOf('：');
    const core = ad.substring(ci + 1).trim().replace(/[""「」『』"']/g, '').slice(0, 15);
    if (core && !originalContent.includes(core)) errors.push('疑似自创台词：' + ad.slice(0, 35) + '...');
  }
  const innerN = (annotatedContent.match(/【人物内心】/g) || []).length;
  if (origDL.length > 0 && innerN < origDL.length * 0.4) errors.push('【人物内心】覆盖不足：台词' + origDL.length + '条，批注仅' + innerN + '条');
  return errors;
}

function getAnnotationStats(originalContent, annotatedContent) {
  const origDL = extractRawDialogues(originalContent);
  const origActions = originalContent.match(/^▲.+$/gm) || [];
  let dlHit = 0;
  for (const d of origDL) { const ci = d.indexOf('：'); const core = d.substring(ci+1).trim().replace(/[""「」『』"']/g,'').slice(0,15); if (core && annotatedContent.includes(core)) dlHit++; }
  let actHit = 0;
  for (const a of origActions) { if (annotatedContent.includes(a.slice(1,20).trim())) actHit++; }
  const strippedAnno = stripDirectorNotes(annotatedContent);
  let fakeCount = 0;
  for (const ad of extractRawDialogues(strippedAnno)) { const ci = ad.indexOf('：'); const core = ad.substring(ci+1).trim().replace(/[""「」『』"']/g,'').slice(0,15); if (core && !originalContent.includes(core)) fakeCount++; }
  return {
    dlTotal: origDL.length, dlHit, actTotal: origActions.length, actHit, fakeCount,
    hasFeel: annotatedContent.includes('【场景感受】'),
    innerCount: (annotatedContent.match(/【人物内心】/g)||[]).length,
    intentCount: (annotatedContent.match(/【镜头意图】/g)||[]).length,
    forbidCount: (annotatedContent.match(/【禁止】/g)||[]).length,
    dnCount: (annotatedContent.match(/（导演讲戏：/g)||[]).length
  };
}

// ── 路由 ──────────────────────────────────────────────

app.post('/api/agent-a/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: '未收到上传文件' });
    let text = '';
    try {
      if (file.originalname.toLowerCase().endsWith('.docx')) { const r = await mammoth.extractRawText({path:file.path}); text = r.value; }
      else text = fs.readFileSync(file.path, 'utf-8');
    } finally {
      // 无论成功还是失败都清理 temp 文件，避免 uploads/ 目录泄漏
      try { fs.unlinkSync(file.path); } catch {}
    }
    if (!text.trim()) return res.status(400).json({ error: '文件内容为空' });
    const { scenes } = parseRawScript(text);
    console.log('📄 原始剧本上传：' + text.length + '字，' + scenes.length + '个场景');
    res.json({ scriptText: text, charCount: text.length, sceneCount: scenes.length,
      scenes: scenes.map(s => ({ id:s.id, header:s.header, characters:s.characters, episode:s.episode })) });
  } catch (err) { res.status(500).json({ error: '文件解析失败：' + err.message }); }
});

app.post('/api/agent-a/soul-card', async (req, res) => {
  const { scriptText, config } = req.body;
  if (!config?.apiKey) return res.status(400).json({ error: '请填写 API Key' });
  if (!scriptText?.trim()) return res.status(400).json({ error: '缺少剧本内容' });
  try {
    const agentAPrompt = loadPrompt('agent_a.md');
    if (!agentAPrompt) return res.status(500).json({ error: 'Agent A 提示词文件未找到' });
    console.log('\n📖 Agent A 第一步：生成剧魂定位卡（' + scriptText.length + '字）');
    const userMsg = '请执行第一步：通读以下剧本原文，输出【剧魂定位卡】。等待我确认后再进行下一步。\n⚠️ 纯文本，禁止 Markdown。\n\n═══ 剧本原文 ═══\n' + scriptText;
    const soulCard = stripMarkdown(await callAPI(agentAPrompt, userMsg, config));
    console.log('✓ 剧魂定位卡完成（' + soulCard.length + '字）');
    res.json({ soulCard });
  } catch (err) { console.error('❌ 剧魂定位卡失败:', err.message); res.status(500).json({ error: '生成失败：' + err.message }); }
});

// ── 导演讲戏模式辅助函数 ──────────────────────────────────

// 映射切分：把杂乱的导演讲戏文本切成语义段落，标注每段对应哪个场景
function buildDirectorMapPrompt(scenes, directorNotes) {
  const sceneList = scenes.map(s => {
    // 给AI更多定位线索：场景ID + 标题 + 人物 + 前几条台词/动作
    const dialogues = extractRawDialogues(s.content).slice(0, 3).map(d => '  台词：' + d.slice(0, 40)).join('\n');
    const actions = (s.content.match(/^▲.+$/gm) || []).slice(0, 2).map(a => '  动作：' + a.slice(0, 40)).join('\n');
    let info = s.id + '  ' + s.header + '  [人物：' + (s.characters.join('、') || '见内容') + ']';
    if (dialogues) info += '\n' + dialogues;
    if (actions) info += '\n' + actions;
    return info;
  }).join('\n\n');

  let p = '你是导演讲戏文本分析专员。\n\n';
  p += '任务：将导演讲戏文本（录音转文字，口语化、杂乱、可能跳跃）切分为语义段落，\n';
  p += '并标注每段对应剧本中的哪个场景。\n\n';

  p += '切分规则：\n';
  p += '1. 按语义切分，不是按换行。一个完整的指令/观点/情绪描述为一段。\n';
  p += '2. 导演的"嗯""啊""就是说"等口语填充词不要单独成段，合并到前后语义段。\n';
  p += '3. 如果导演连续讲同一场景的不同方面（先说情绪再说镜头），拆成多段分别标注类型。\n';
  p += '4. 如果一段讲戏同时涉及多个场景且无法拆分，sceneId填主要场景，extra里列其他场景。\n\n';

  p += '定位方法（按优先级）：\n';
  p += '1. 导演明确说了场景编号（"1-3那场"） → 直接匹配 → confidence: high\n';
  p += '2. 导演提到了角色名+具体动作/台词片段 → 在剧本中搜索匹配 → confidence: high\n';
  p += '3. 导演提到了角色名但没有具体行 → 看该角色出现在哪些场景 → confidence: medium\n';
  p += '4. 导演用模糊指代（"那个地方""后面那场"） → 结合上下文推断 → confidence: low\n';
  p += '5. 完全无法定位 → sceneId: null → confidence: low\n';
  p += '6. 全局性指令（"整部戏都要…""所有场景…"） → sceneId: "global" → confidence: high\n\n';

  p += '类型识别：\n';
  p += '  feel = 场景级感受（整场戏的氛围/节奏/情绪）\n';
  p += '  intent = 镜头级意图（具体动作/瞬间/运镜方式）\n';
  p += '  inner = 人物情绪挖掘（解释人物内心/表演方向）\n';
  p += '  forbid = 禁止项（明确说不要什么）\n';
  p += '  global = 全局性指令（适用所有场景）\n\n';

  p += '═══ 剧本场景列表（含定位线索）═══\n' + sceneList + '\n\n';
  p += '═══ 导演讲戏文本 ═══\n' + directorNotes + '\n\n';

  p += '请严格按以下JSON格式输出，不要任何其他文字或代码块标记：\n';
  p += '{"segments":[\n';
  p += '  {"id":1,"text":"导演原文（保留原话，可精简口语填充词）","sceneId":"1-1","type":"feel","confidence":"high","reason":"导演提到了角色XX在YY的动作"},\n';
  p += '  {"id":2,"text":"那个打斗要慢一点","sceneId":null,"candidates":["2-1","2-3"],"type":"intent","confidence":"low","reason":"提到打斗但未指明场景，2-1和2-3都有打斗"},\n';
  p += '  {"id":3,"text":"整部戏不要太亮","sceneId":"global","type":"global","confidence":"high","reason":"全局性视觉指令"}\n';
  p += '],\n';
  p += '"summary":{"total":3,"mapped":1,"uncertain":1,"global":1,"unmapped":0}}\n\n';
  p += '⚠️ text字段保留导演原话关键词，不要替换成你的概括。';
  return p;
}

function parseDirectorMap(text) {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    return JSON.parse(clean.substring(start, end + 1));
  } catch (e) { console.error('映射JSON解析失败:', e.message); return null; }
}

// 把确认后的映射结果按场景分组
function groupMappedSegments(segments) {
  const byScene = {};
  const globals = [];
  for (const seg of segments) {
    if (!seg.sceneId || seg.sceneId === 'null') continue;
    if (seg.sceneId === 'global') {
      globals.push(seg);
    } else {
      if (!byScene[seg.sceneId]) byScene[seg.sceneId] = [];
      byScene[seg.sceneId].push(seg);
    }
  }
  return { byScene, globals };
}

// 构建单场景的批注prompt（只给该场景对应的讲戏段落）
function buildDirectorAnnotatePrompt(scene, allScenes, sceneSegments, globalSegments, prevFeel) {
  let msg = '请根据以下已确认的导演讲戏内容，为场景' + scene.id + '写完整批注。\n\n';

  msg += '⛔ 格式铁律（最高优先级）：\n';
  msg += '1. 所有批注必须包在（导演讲戏：...）括号里——这是 Agent C 提取批注的唯一入口，没有这层壳 C 会忽略。\n';
  msg += '2. 剧本原文（▲动作行、台词行）必须独立成行，不能包在（导演讲戏：）里。\n';
  msg += '3. 纯文本，禁止 Markdown。\n';
  msg += '4. 【待补充】和【无特殊批注】不包在（导演讲戏：）里。\n';
  msg += '5. ⚠️ 角色名以剧本为准，不要用导演口误的版本。剧本人物列表：' + (scene.characters.join('、') || '见剧本') + '。导演录音中如果叫错名字（如同音字不同），一律修正为剧本里的写法。\n\n';

  msg += '⛔ 内容处理规则：\n';
  msg += '1. 去口水，保内容——去掉"然后呢""啊""就是说""嗯""那个"等口语填充词，保留全部视觉指令和表演要求。\n';
  msg += '2. 不要人为压缩——导演讲了6个镜头就写6个镜头，用 · 分隔不同节拍。剧本一行可能对应导演一分钟的视觉设计，全部保留。\n';
  msg += '3. 多方案分条写——导演说"或者是..."时，分成【镜头意图·方案A】【镜头意图·方案B】。\n';
  msg += '4. 导演强调的重点标注 ⚠️必须——"这个一定要注重""一定要大声"等。\n';
  msg += '5. 批注内容不要用（）小括号，会和外层（导演讲戏：）括号冲突。\n\n';

  msg += '⛔ 分配铁律——不堆积（最容易犯的错误）：\n';
  msg += '导演连续讲的一段话可能跨了多个剧本行。你必须按内容拆开，挂到对应的行上。\n';
  msg += '判断方法：这段导演指令的画面主体是谁在做什么？和哪个▲行/台词行最接近就挂到哪行。\n';
  msg += '✗ 全堆在第一个匹配的▲行上（后面的▲行变成无批注）\n';
  msg += '✓ 按画面内容拆开分别挂到对应的▲行上\n';
  msg += '写完后回头检查：有没有某个▲行堆了太多批注，而紧邻的▲行却空着？如果有，重新分配。\n\n';

  msg += '⛔ 场景感受不能空：\n';
  msg += '即使导演没有明确说"这场戏的情绪是什么"，也要从他讲的全部内容中归纳提炼一句场景感受。\n\n';

  msg += '格式示范：\n';
  msg += '▲[剧本原文动作行]\n';
  msg += '（导演讲戏：\n';
  msg += '【镜头意图】全景从轮胎特写拉开·穿过篮球场铁网·铁网后有丧尸抓网·打破车震的平静\n';
  msg += '【镜头意图·方案B】丧尸抓铁网特写拉开·再交代晃动的车·先惊吓后荒诞\n';
  msg += '）\n\n';

  // 该场景对应的讲戏段落
  if (sceneSegments && sceneSegments.length > 0) {
    msg += '═══ 本场景对应的导演讲戏（' + sceneSegments.length + '条，已经用户确认映射关系）═══\n';
    for (const seg of sceneSegments) {
      const typeLabel = { feel: '场景感受', intent: '镜头意图', inner: '人物内心', forbid: '禁止项' }[seg.type] || seg.type;
      msg += '[' + typeLabel + '] ' + seg.text + '\n';
    }
    msg += '\n';
  } else {
    msg += '⚠️ 本场景没有对应的导演讲戏内容，所有行标注【待补充】。\n\n';
  }

  // 全局指令
  if (globalSegments && globalSegments.length > 0) {
    msg += '═══ 全局导演指令（适用所有场景）═══\n';
    for (const seg of globalSegments) {
      msg += '· ' + seg.text + '\n';
    }
    msg += '\n';
  }

  if (prevFeel) msg += '上一场情绪落点（衔接参考）：' + prevFeel + '\n\n';
  msg += '═══ 场景' + scene.id + ' 剧本原文 ═══\n' + scene.content + '\n\n';
  msg += '请输出场景' + scene.id + '的完整批注。只输出这一个场景。';
  return msg;
}

function validateDirectorAnnotation(originalContent, annotatedContent) {
  const errors = [];

  // （导演讲戏：）括号格式检查——这是 Agent C 识别批注的唯一入口
  const dnCount = (annotatedContent.match(/（导演讲戏：/g) || []).length;
  const hasTagsOutsideDN = /^【(?:镜头意图|人物内心|场景感受|禁止)】/m.test(
    // 剥离（导演讲戏：）块后，看是否还有裸露的标签
    stripDirectorNotes(annotatedContent)
  );
  if (dnCount === 0 && !annotatedContent.includes('【待补充】')) {
    errors.push('缺少（导演讲戏：）括号包裹——Agent C 无法识别裸露的批注标签');
  }
  if (hasTagsOutsideDN) {
    errors.push('有批注标签未包在（导演讲戏：）括号里——【镜头意图】【人物内心】等必须在括号内');
  }

  // （导演讲戏：）括号闭合检查
  const marker = '（导演讲戏：';
  let pos = 0, openIdx = 0;
  while ((pos = annotatedContent.indexOf(marker, pos)) !== -1) {
    openIdx++;
    let depth = 1, p = pos + 1;
    while (p < annotatedContent.length && depth > 0) {
      if (annotatedContent[p] === '（') depth++;
      else if (annotatedContent[p] === '）') depth--;
      p++;
    }
    if (depth !== 0) errors.push('第' + openIdx + '个（导演讲戏：）块括号未闭合');
    pos = p;
  }

  // 台词完整性检查
  const origDL = extractRawDialogues(originalContent);
  for (const d of origDL) {
    const ci = d.indexOf('：');
    const core = d.substring(ci + 1).trim().replace(/[""「」『』"']/g, '').slice(0, 15);
    if (core && !annotatedContent.includes(core)) errors.push('台词遗漏：' + d.slice(0, 35) + '...');
  }

  // 动作行完整性检查
  for (const a of (originalContent.match(/^▲.+$/gm) || [])) {
    const core = a.slice(1, 20).trim();
    if (core && !annotatedContent.includes(core)) errors.push('动作行遗漏：' + a.slice(0, 35) + '...');
  }

  // 自创台词检查
  const strippedAnno = stripDirectorNotes(annotatedContent);
  for (const ad of extractRawDialogues(strippedAnno)) {
    const ci = ad.indexOf('：');
    const core = ad.substring(ci + 1).trim().replace(/[""「」『』"']/g, '').slice(0, 15);
    if (core && !originalContent.includes(core)) errors.push('疑似自创台词：' + ad.slice(0, 35) + '...');
  }

  // 场景感受检查：必须有，且必须在（导演讲戏：）括号内
  if (!annotatedContent.includes('【场景感受】')) {
    errors.push('缺少【场景感受】——即使导演没明说也要从讲戏内容归纳');
  } else {
    // 检查场景感受是否在括号内
    let feelInBracket = false;
    processDirectorNotes(annotatedContent, (match, inner) => {
      if (inner.includes('【场景感受】')) feelInBracket = true;
      return match;
    });
    if (!feelInBracket) {
      errors.push('【场景感受】不在（导演讲戏：）括号内——Agent C 会读不到');
    }
  }

  // 堆积检查：如果某个▲行后面紧跟着大量批注，而下一个▲行完全没有批注，可能是堆积
  const origActions = originalContent.match(/^▲.+$/gm) || [];
  if (origActions.length >= 2) {
    const lastAction = origActions[origActions.length - 1].slice(1, 25).trim();
    // 检查最后一个▲行后面是否有批注
    const lastActionPos = annotatedContent.lastIndexOf(lastAction);
    if (lastActionPos !== -1) {
      const afterLastAction = annotatedContent.substring(lastActionPos);
      const hasDNAfterLast = afterLastAction.includes('（导演讲戏：');
      const hasOnlyNone = /【无特殊批注】|【待补充】/.test(afterLastAction) && !hasDNAfterLast;
      if (hasOnlyNone) {
        // 检查前一个▲行是不是批注特别多
        const prevAction = origActions[origActions.length - 2].slice(1, 25).trim();
        const prevPos = annotatedContent.lastIndexOf(prevAction);
        if (prevPos !== -1) {
          const betweenSection = annotatedContent.substring(prevPos, lastActionPos);
          const dnCountBetween = (betweenSection.match(/（导演讲戏：/g) || []).length;
          if (dnCountBetween >= 3) {
            errors.push('可能存在批注堆积：倒数第二个▲行有' + dnCountBetween + '个批注块，最后一个▲行却无批注——请检查是否有批注应该挂到最后一行');
          }
        }
      }
    }
  }

  return errors;
}

function getDirectorAnnotationStats(originalContent, annotatedContent) {
  const origDL = extractRawDialogues(originalContent);
  const origActions = originalContent.match(/^▲.+$/gm) || [];
  let dlHit = 0;
  for (const d of origDL) { const ci = d.indexOf('：'); const core = d.substring(ci+1).trim().replace(/[""「」『』"']/g,'').slice(0,15); if (core && annotatedContent.includes(core)) dlHit++; }
  let actHit = 0;
  for (const a of origActions) { if (annotatedContent.includes(a.slice(1,20).trim())) actHit++; }
  const strippedAnno = stripDirectorNotes(annotatedContent);
  let fakeCount = 0;
  for (const ad of extractRawDialogues(strippedAnno)) { const ci = ad.indexOf('：'); const core = ad.substring(ci+1).trim().replace(/[""「」『』"']/g,'').slice(0,15); if (core && !originalContent.includes(core)) fakeCount++; }
  return {
    dlTotal: origDL.length, dlHit, actTotal: origActions.length, actHit, fakeCount,
    hasFeel: annotatedContent.includes('【场景感受】'),
    innerCount: (annotatedContent.match(/【人物内心】/g)||[]).length,
    intentCount: (annotatedContent.match(/【镜头意图】/g)||[]).length,
    forbidCount: (annotatedContent.match(/【禁止】/g)||[]).length,
    pendingCount: (annotatedContent.match(/【待补充】/g)||[]).length,
    dnCount: (annotatedContent.match(/（导演讲戏：/g)||[]).length
  };
}

// ── 导演讲戏映射路由 ──────────────────────────────────

// 角色名修正：导演口误的同音字替换为剧本正确写法
function normalizeCharNames(text, canonicalNames) {
  if (!canonicalNames || canonicalNames.length === 0) return text;
  let result = text;
  // 汉字边界：前后必须不是汉字（避免把 "李五一" 里的 "李五" 替换掉）
  const HAN = '[\\u4e00-\\u9fff]';
  for (const canonical of canonicalNames) {
    if (canonical.length < 2) continue;
    const surname = canonical[0];
    const nameLen = canonical.length;
    // (?<!汉字) 姓 + (nameLen-1) 个汉字 (?!汉字)
    const pattern = `(?<!${HAN})${escapeRegExp(surname)}${HAN}{${nameLen - 1}}(?!${HAN})`;
    let regex;
    try {
      regex = new RegExp(pattern, 'g');
    } catch (e) {
      // 老 Node 不支持 lookbehind 时降级为无边界版本
      regex = new RegExp(escapeRegExp(surname) + HAN + '{' + (nameLen - 1) + '}', 'g');
    }
    const matches = result.match(regex) || [];
    const seen = new Set();
    for (const found of matches) {
      if (found === canonical || seen.has(found)) continue;
      seen.add(found);
      let diffCount = 0;
      for (let i = 0; i < nameLen; i++) {
        if (found[i] !== canonical[i]) diffCount++;
      }
      if (diffCount === 1) {
        console.log(`   角色名修正：${found} → ${canonical}`);
        // 用带边界的 regex 替换，不用 split/join（避免误伤子串）
        const replaceRe = new RegExp(
          `(?<!${HAN})${escapeRegExp(found)}(?!${HAN})`,
          'g'
        );
        try {
          result = result.replace(replaceRe, canonical);
        } catch (e) {
          // 降级：退回朴素替换
          result = result.split(found).join(canonical);
        }
      }
    }
  }
  return result;
}

app.post('/api/agent-a/director-map', async (req, res) => {
  const { scriptText, directorNotes, config } = req.body;
  if (!config?.apiKey) return res.status(400).json({ error: '请填写 API Key' });
  if (!scriptText?.trim()) return res.status(400).json({ error: '缺少剧本内容' });
  if (!directorNotes?.trim()) return res.status(400).json({ error: '缺少导演讲戏文本' });

  const { scenes } = parseRawScript(scriptText);
  if (!scenes.length) return res.status(400).json({ error: '未识别到场景' });

  try {
    console.log('\n🎬 导演讲戏映射切分：' + directorNotes.length + '字 → ' + scenes.length + '个场景');
    const mapSystemPrompt = '你是导演讲戏文本分析专员。只做文本切分和场景映射，不写批注。严格输出JSON。';
    const mapPrompt = buildDirectorMapPrompt(scenes, directorNotes);
    const mapResult = await callAPI(mapSystemPrompt, mapPrompt, config);
    let mapped = parseDirectorMap(mapResult);

    if (!mapped) {
      console.log('⚠️ 映射JSON解析失败，重试...');
      const retryResult = await callAPI(mapSystemPrompt, mapPrompt + '\n\n⚠️ 上次输出的JSON格式有误，请严格输出合法JSON，不要有任何多余文字。', config);
      mapped = parseDirectorMap(retryResult);
    }

    if (!mapped?.segments?.length) {
      return res.status(500).json({ error: '映射解析失败，AI未能输出有效JSON' });
    }

    // 把场景列表也返回，供前端下拉选择
    const sceneOptions = scenes.map(s => ({ id: s.id, header: s.header, characters: s.characters }));
    console.log('✓ 映射完成：' + mapped.segments.length + '段，' +
      (mapped.summary?.mapped || '?') + '已映射，' +
      (mapped.summary?.uncertain || '?') + '待确认，' +
      (mapped.summary?.global || '?') + '全局');
    res.json({ segments: mapped.segments, summary: mapped.summary, sceneOptions });
  } catch (err) {
    console.error('❌ 映射失败:', err.message);
    res.status(500).json({ error: '映射失败：' + err.message });
  }
});

// 第二步：逐场景 规划→验证→执行→验证（支持AI模式和导演讲戏模式）
app.post('/api/agent-a/annotate', async (req, res) => {
  const { scriptText, soulCard, config, mode, mappedSegments } = req.body;
  if (!config?.apiKey) return res.status(400).json({ error: '请填写 API Key' });
  if (!scriptText?.trim()) return res.status(400).json({ error: '缺少剧本内容' });

  const isDirectorMode = mode === 'director';
  if (isDirectorMode) {
    if (!mappedSegments?.length) return res.status(400).json({ error: '导演讲戏模式需要已确认的映射数据' });
  } else {
    if (!soulCard?.trim()) return res.status(400).json({ error: '缺少剧魂定位卡' });
  }

  const { scenes } = parseRawScript(scriptText);
  if (!scenes.length) return res.status(400).json({ error: '未识别到场景' });

  const jobId = 'agentA_' + Date.now();
  agentAJobs.set(jobId, {
    status: 'running',
    progress: scenes.map(s => ({ sceneId: s.id, status: 'pending', message: '等待中' })),
    results: new Array(scenes.length).fill(null),
    validations: new Array(scenes.length).fill(null),
    total: scenes.length, completed: 0, finalResult: null,
    mode: isDirectorMode ? 'director' : 'ai'
  });
  res.json({ jobId, sceneCount: scenes.length });

  // 导演模式时·预分组讲戏
  const { byScene: segsByScene, globals: globalSegs } = isDirectorMode
    ? groupMappedSegments(mappedSegments)
    : { byScene: {}, globals: [] };

  (async () => {
    const job = agentAJobs.get(jobId);
    const systemPromptPath = isDirectorMode ? 'agent_a_director.md' : 'agent_a.md';
    const systemPrompt = loadPrompt(systemPromptPath);
    if (!systemPrompt) {
      job.status = 'error'; job.finishedAt = Date.now();
      console.error(`❌ 提示词文件 ${systemPromptPath} 未找到`);
      return;
    }

    const CONCURRENCY = 6;
    let index = 0;
    const sceneFeels = new Array(scenes.length).fill(null);
    const sceneDataList = new Array(scenes.length).fill(null);

    console.log(`\n🎬 Agent A v7 启动（${isDirectorMode ? '导演讲戏' : 'AI 分析'}模式）·${scenes.length} 个场景·并发 ${CONCURRENCY}`);

    async function runNext() {
      if (index >= scenes.length) return;
      const i = index++;
      const scene = scenes[i];

      try {
        job.progress[i] = { sceneId: scene.id, status: 'processing', message: '批注中...' };

        // 第一步：解析 items
        const items = annotationV7.parseSceneItemsV7(scene.content);

        // 第二步：构建 prompt
        const prevFeel = i > 0 ? sceneFeels[i - 1] : null;
        const options = isDirectorMode
          ? {
            sceneSegments: segsByScene[scene.id] || [],
            globalSegments: globalSegs,
            prevFeel
          }
          : {
            soulCard,
            prevFeel
          };
        const userPrompt = annotationV7.buildAnnotationPromptV7(scene, items, isDirectorMode ? 'director' : 'ai', options);

        // 第三步：调用 API（启用 JSON mode）
        const jsonConfig = Object.assign({}, config, { jsonMode: true });
        let jsonText = await callAPI(systemPrompt, userPrompt, jsonConfig);
        let data = annotationV7.parseAnnotationJSON(jsonText);

        // 第四步：验证·必要时重试一次
        const sceneSegs = segsByScene[scene.id] || [];
        let errors = data ? annotationV7.validateAnnotationV7(data, items, sceneSegs) : ['JSON 解析失败'];

        if (errors.length > 0) {
          console.log(`⚠️ 场景${scene.id} 第一次验证 ${errors.length} 条问题·重试...`);
          job.progress[i].message = `验证失败(${errors.length}条)·重试...`;
          const retryPrompt = userPrompt + `\n\n⚠️ 上次 JSON 有以下问题·请修正后重新输出：\n` + errors.map(e => `- ${e}`).join('\n');
          jsonText = await callAPI(systemPrompt, retryPrompt, jsonConfig);
          const data2 = annotationV7.parseAnnotationJSON(jsonText);
          if (data2) {
            const errors2 = annotationV7.validateAnnotationV7(data2, items, sceneSegs);
            if (errors2.length === 0) {
              data = data2;
              errors = [];
              console.log(`✓ 场景${scene.id} 重试后通过`);
            } else {
              data = data2; // 用重试版·但打警告
              errors = errors2;
              console.warn(`⚠️ 场景${scene.id} 重试后仍 ${errors2.length} 条警告·继续`);
            }
          }
        } else {
          console.log(`✓ 场景${scene.id} 首次验证通过`);
        }

        if (!data) {
          throw new Error('JSON 解析两次均失败');
        }

        // 第五步：代码组装批注版剧本
        let annotatedText = annotationV7.assembleAnnotationV7(scene, items, data);

        // 第六步：角色名修正（导演模式的口误修正）
        if (isDirectorMode && scene.characters?.length) {
          annotatedText = normalizeCharNames(annotatedText, scene.characters);
        }

        // 第七步：保存结果
        sceneFeels[i] = data.scene_feel || '';
        sceneDataList[i] = data;
        job.results[i] = annotatedText;
        job.validations[i] = {
          sceneId: scene.id,
          stats: annotationV7.getAnnotationStatsV7(items, data),
          errors: errors || []
        };
        job.progress[i] = {
          sceneId: scene.id,
          status: 'done',
          message: errors.length > 0 ? `完成（${errors.length}条警告）` : '完成 ✓'
        };
      } catch (err) {
        console.error(`❌ 场景${scene.id} 失败:`, err.message);
        job.progress[i] = { sceneId: scene.id, status: 'error', message: '失败: ' + err.message };
        job.results[i] = `[场景${scene.id} 批注失败: ${err.message}]`;
      }
      job.completed++;
      await runNext();
    }

    const workers = Array(Math.min(CONCURRENCY, scenes.length)).fill(null).map(() => runNext());
    await Promise.all(workers).catch(console.error);

    // 代码生成摘要（不走 API）
    const allAnnotations = job.results.filter(r => r && !r.startsWith('[')).join('\n\n');
    try {
      const summary = annotationV7.generateSummaryV7(scenes, job.results, sceneDataList, job.validations);
      job.finalResult = allAnnotations + '\n\n' + summary;
    } catch (err) {
      job.finalResult = allAnnotations + `\n\n[摘要生成失败: ${err.message}]`;
    }

    job.status = 'done';
    job.finishedAt = Date.now();
    console.log(`✓ Agent A v7 完成·${scenes.length} 个场景`);
  })();
});
app.get('/api/agent-a/progress/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // iv 必须先赋 null，避免首次同步调用 send() 时 job 已结束而触发 TDZ ReferenceError
  let iv = null;
  const send = () => {
    const job = agentAJobs.get(req.params.jobId);
    if (!job) { res.write('data: {"error":"not found"}\n\n'); res.end(); return; }
    res.write('data: ' + JSON.stringify({ status: job.status, progress: job.progress, completed: job.completed, total: job.total }) + '\n\n');
    if (job.status === 'done' || job.status === 'error') { clearInterval(iv); res.end(); }
  };
  send();
  iv = setInterval(send, 1000);
  req.on('close', () => clearInterval(iv));
});

app.get('/api/agent-a/results/:jobId', (req, res) => {
  const job = agentAJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json({ result: job.finalResult, status: job.status, validations: job.validations });
});

app.post('/api/parse-text', (req, res) => {
  let { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: '缺少文本内容' });
  try {
    // 剥离批注摘要——摘要不是剧本，parseScript 会误识别为场景
    const summaryMarkers = ['【批注摘要】', '═══ 全部批注 ═══'];
    for (const marker of summaryMarkers) {
      const idx = text.indexOf(marker);
      if (idx !== -1) {
        console.log('✂️ 剥离摘要/重复段落：从"' + marker + '"处截断（丢弃' + (text.length - idx) + '字）');
        text = text.substring(0, idx).trim();
      }
    }
    const { scenes, episodeInfo, episodeMap } = parseScript(text);
    if (!scenes.length) return res.status(400).json({ error: '未识别到场景' });
    console.log('✓ 文本解析：' + scenes.length + '个场景');
    res.json({ scenes, episodeInfo, episodeMap });
  } catch (err) { res.status(500).json({ error: '解析失败：' + err.message }); }
});

app.get('/api/agent-a/download/:jobId', (req, res) => {
  const job = agentAJobs.get(req.params.jobId);
  if (!job?.finalResult) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'annotated-script-' + Date.now() + '.txt');
  res.send('Agent A 批注版剧本\n生成时间：' + new Date().toLocaleString('zh-CN') + '\n\n' + job.finalResult);
});

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('prompts')) fs.mkdirSync('prompts');

app.listen(PORT, () => {
  console.log('\n🎬 视频提示词工具 v7 已启动');
  console.log('📍 访问地址：http://localhost:' + PORT);
  console.log('📁 提示词目录：' + path.join(__dirname, 'prompts'));
  console.log('   Agent A v7：JSON 引擎·LLM 只产批注·代码拼装原文');
  console.log('   Agent C v7：字数 Cascade·范例按需注入·DeepSeek JSON mode');
  console.log('   并发：6·缓存命中会在日志打印\n');
});
