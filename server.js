const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;

const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const jobs = new Map();

// 场景类型对应的镜头数规则（集中定义，validatePlan 只接收 limits 对象）
const SCENE_RULES = {
  wuxi:  { minShots: 1, maxShots: 4 },
  wenxi: { minShots: 5, maxShots: 7 },
  mixed: { minShots: 5, maxShots: 7 },
};

// 台词核验用的引号剥离正则（统一维护，避免各处不一致）
const QUOTE_STRIP_RE = /[""「」『』"']/g;

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

function buildSystemPrompt(sceneType) {
  const core = loadPrompt('core.txt');
  if (sceneType === 'wuxi') return core + '\n\n' + loadPrompt('wuxi.txt');
  if (sceneType === 'wenxi') return core + '\n\n' + loadPrompt('wenxi.txt');
  return core + '\n\n' + loadPrompt('wenxi.txt') + '\n\n' + loadPrompt('wuxi.txt');
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

// ============================================================
// 台词提取 / 核验 / 补写
// ============================================================
function extractDialogues(sceneContent) {
  const stripped = processDirectorNotes(sceneContent, () => '');
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
  const missing = [];
  for (const d of dialogues) {
    const colonIdx = d.indexOf('：');
    if (colonIdx === -1) continue;
    const contentPart = d.substring(colonIdx + 1).trim().replace(QUOTE_STRIP_RE, '');
    const coreText = contentPart.slice(0, 15);
    if (coreText && !cleanOutput.includes(coreText)) missing.push(d);
  }
  return missing;
}

async function repairMissingDialogues(missing, existingOutput, systemPrompt, config) {
  console.log(`⚠️ 发现 ${missing.length} 条台词遗漏，自动补写中...`);
  let repairMsg = `以下台词或OS独白在刚才的输出中被遗漏，必须补写进对应片段的C部分镜号叙事里。\n`;
  repairMsg += `请在原输出基础上找到对应片段，将遗漏台词以"角色OS：引号原文"或"角色（状态）：引号原文"格式写进对应镜号叙事正文，输出补写后的完整内容。\n\n`;
  repairMsg += `【遗漏台词清单】\n`;
  missing.forEach((d, i) => { repairMsg += `遗漏${i + 1}：${d}\n`; });
  repairMsg += `\n【原输出】\n${existingOutput}\n\n`;
  repairMsg += `请直接输出补全后的完整提示词，格式与原输出完全一致，不要任何解释。`;
  return await callAPI(systemPrompt, repairMsg, config);
}

// ============================================================
// 场景类型识别
// ============================================================
function detectSceneType(sceneContent) {
  const wuxiKeywords = [
    '格挡', '撞击', '暴起', '出手', '追逐', '武戏', '冲击', '兵器',
    '戟', '剑', '刀', '枪', '打', '战', '攻', '格斗', '出招', '蓄力',
    '爆发', '围攻', '突围', '厮杀', '交战', '硬切', '升格', '武打',
    '扼住', '利爪', '精气', '僵尸', '人皮', '吸取', '萎缩', '逃窜', '抹杀', '悬空',
    '飞出', '崩口', '拳', '踢', '闪避', '弹开', '震飞', '劈', '刺', '斩'
  ];
  const wenxiKeywords = [
    '台词', '说话', '对话', '情绪', '眼神', '沉默', '旁观',
    '悬疑', '信息', '揭穿', '知道', '秘密', '问话', '回答'
  ];
  const content = sceneContent.toLowerCase();
  let wuxiScore = 0, wenxiScore = 0;
  wuxiKeywords.forEach(kw => { if (content.includes(kw)) wuxiScore++; });
  wenxiKeywords.forEach(kw => { if (content.includes(kw)) wenxiScore++; });
  const hasDialogue = /^[^\s▲【].+：.+$/m.test(sceneContent);
  // 统计台词行数量（排除导演讲戏内的冒号行）
  const strippedForCount = processDirectorNotes(sceneContent, () => '');
  const dialogueLineCount = (strippedForCount.match(/^[^\s▲【（].+：.+$/gm) || []).length;
  if (hasDialogue) {
    if (wuxiScore > 0) {
      wuxiScore += 1;
      wenxiScore += dialogueLineCount >= 5 ? 5 : dialogueLineCount >= 3 ? 3 : 1;
    }
    else { wenxiScore += 3; }
  }

  // 硬判：5条以上台词不可能是纯武戏（1-4个镜号塞不下5条台词），强制mixed
  if (dialogueLineCount >= 5 && wuxiScore > wenxiScore + 2) {
    console.log(`   场景分类：武戏关键词${wuxiScore}个但有${dialogueLineCount}条台词，强制判为mixed`);
    return 'mixed';
  }

  if (wuxiScore > wenxiScore + 2) return 'wuxi';
  if (wenxiScore > wuxiScore) return 'wenxi';
  return 'mixed';
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
    .replace(/[─━—\-─═]{8,}/g, '\n<<<SEP>>>\n')  // 增加 ═ 匹配 Agent A 输出
    .replace(/[────]{4,}/g, '\n<<<SEP>>>\n')
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
async function callAPI(systemPrompt, userMessage, config) {
  const { apiKey, apiType, apiUrl, model } = config;
  let fullText = '';
  let continueLoop = true;
  let messages = [{ role: 'user', content: userMessage }];
  const MAX_RETRIES = 3;
  const MAX_CONTINUATIONS = 5; // 续跑上限，防止死循环
  const RETRY_DELAYS = [5000, 15000, 30000]; // 5s / 15s / 30s
  let retries = 0;
  let continuations = 0;

  while (continueLoop) {
    if (apiType === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model || 'claude-opus-4-5-20251101',
          max_tokens: 8192,
          system: systemPrompt,
          messages
        })
      });
      // 429 限速：退避重试
      if (res.status === 429) {
        if (retries >= MAX_RETRIES) throw new Error(`API 限速，已重试 ${MAX_RETRIES} 次`);
        const wait = RETRY_DELAYS[retries++];
        console.log(`⚠️ 限速 429，${wait / 1000}秒后重试（第${retries}次）...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      // 非 429 HTTP 错误：直接报出状态码和响应体
      if (!res.ok) {
        const errBody = await res.text().catch(() => '(无响应体)');
        throw new Error(`API HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      if (!data.content?.[0]?.text) throw new Error('API 返回了空内容（content为空或无text字段）');
      retries = 0; // 成功响应后重置重试计数
      const chunk = data.content[0].text;
      fullText += chunk;
      if (data.stop_reason === 'max_tokens') {
        if (++continuations >= MAX_CONTINUATIONS) {
          console.warn(`⚠️ 续跑已达${MAX_CONTINUATIONS}次上限，截断返回`);
          continueLoop = false;
        } else {
          messages = [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: fullText },
            { role: 'user', content: '请继续从截断处继续输出，不要重复已有内容，直接接着写。' }
          ];
          console.log(`⚠️ 输出被截断，自动续跑（第${continuations}次）...`);
        }
      } else {
        continueLoop = false;
      }
    } else {
      const endpoint = apiUrl || 'https://api.deepseek.com/v1/chat/completions';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'deepseek-chat',
          max_tokens: 8192,
          messages: [{ role: 'system', content: systemPrompt }, ...messages]
        })
      });
      // 429 限速：退避重试
      if (res.status === 429) {
        if (retries >= MAX_RETRIES) throw new Error(`API 限速，已重试 ${MAX_RETRIES} 次`);
        const wait = RETRY_DELAYS[retries++];
        console.log(`⚠️ 限速 429，${wait / 1000}秒后重试（第${retries}次）...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      // 非 429 HTTP 错误
      if (!res.ok) {
        const errBody = await res.text().catch(() => '(无响应体)');
        throw new Error(`API HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      if (!data.choices?.[0]?.message?.content) throw new Error('API 返回了空内容（choices为空或无content字段）');
      retries = 0; // 成功响应后重置重试计数
      const choice = data.choices[0];
      const chunk = choice.message.content;
      fullText += chunk;
      if (choice.finish_reason === 'length') {
        if (++continuations >= MAX_CONTINUATIONS) {
          console.warn(`⚠️ 续跑已达${MAX_CONTINUATIONS}次上限，截断返回`);
          continueLoop = false;
        } else {
          messages = [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: fullText },
            { role: 'user', content: '请继续从截断处继续输出，不要重复已有内容，直接接着写。' }
          ];
          console.log(`⚠️ 输出被截断，自动续跑（第${continuations}次）...`);
        }
      } else {
        continueLoop = false;
      }
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
    p += `2. 导演讲戏模式：每片段镜头数3-10个（导演指令多需要更多镜头空间）。\n`;
  } else {
    p += `2. 文戏/混合场景每片段镜头数5-7个；武戏≤4个。\n`;
  }
  p += `3. 台词镜号规则（两层）：\n`;
  p += `   · ≤3秒台词：一个镜号拍完，不用切。\n`;
  p += `   · >3秒台词：必须拆成多个镜号——起始镜号放dialogue，后续镜号task写切镜方式（换角度/反打听者/INSERT细节/声画分离），禁止单个镜号对着一个人说话超过3秒。\n`;
  p += `   · >8秒台词/OS独白：多镜号中必须包含至少一个声画分离镜号（task写"声画分离：XX台词继续，画面切XXX"），把镜头交出去看别的。\n`;
  p += `   · >15秒台词/OS独白：声画分离镜号可以跨片段，声音不断画面跨片段过渡。\n`;
  p += `4. 每句台词不得遗漏，不得重复。\n`;
  p += `5. 导演讲戏中标注"必须补"或"⚠️必须"的内容必须出现在某个镜号的task里。\n`;
  p += `6. 武戏+台词混合场景节拍切换规则：\n`;
  p += `   · 先通读剧本，标注每段内容的节拍类型：[武]动作冲击 / [文]台词对话 / [转]动静切换\n`;
  p += `   · [武]节拍：镜号短(1-3s)、冲击感优先，task写具体动作\n`;
  p += `   · [文]节拍：台词>3秒必须切镜，>8秒必须含声画分离\n`;
  p += `   · [转]节拍（最关键）：武→文时插一个"余震/定格"镜号(2-3s)让节奏降下来再接台词；文→武时插一个"蓄力/临界"镜号(1-2s)让爆发有起点\n`;
  p += `   · 同一个片段内可以包含不同节拍类型，但一个片段不要超过两次武↔文切换，太碎就拆到下一片段\n`;
  p += `7. 台词之间的反应镜头（呼吸感）：\n`;
  p += `   · 角色A说完台词后，不要直接让角色B接台词。中间插一个反应镜号（1-2s）：听者表情变化/沉默/身体反应\n`;
  p += `   · 反应镜号task写"反应：XX听到后的表情/动作"，不放dialogue\n`;
  p += `   · 情绪越重的台词，后面的反应镜号越长（2-3s），让情绪落地\n`;
  p += `8. 连续调度不拆片段：\n`;
  p += `   · 导演描述了一段连贯的走位调度（如"范思瑶边走边说→赵一铭上前两步→范思瑶挽手摸胸口→说台词"），整段调度放在同一个片段，不拆开\n`;
  p += `   · 导演指定了转场设计（如"眼睛到眼睛转场"），转场必须在最后一个片段的最后一镜完成\n`;

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
    p += `【程序预算：本场台词最短时长】\n${budgetLines}\n\n`;
  }

  p += `请严格按以下JSON格式输出，不要任何其他文字或代码块标记：\n`;
  p += `{"segments":[{"id":"${scene.id}A","title":"片段标题","duration":15,"shots":[\n`;
  p += `  {"num":1,"duration":3,"focal":"85mm","task":"台词起始：角色开口说话","dialogue":"台词原文放这里，无台词留空字符串"},\n`;
  p += `  {"num":2,"duration":2,"focal":"50mm","task":"切镜：换角度/反打听者反应","dialogue":""},\n`;
  p += `  {"num":3,"duration":3,"focal":"85mm","task":"声画分离：XX的OS/台词继续，画面切王龙恐惧反应","dialogue":""},\n`;
  p += `  {"num":4,"duration":2,"focal":"35mm","task":"声画分离：XX的OS/台词继续，画面切空景环境","dialogue":""}\n`;
  p += `],"tailFrame":"出场景别和视角"}]}\n`;
  p += `⚠️ 注意：>3秒台词必须像示范那样拆成多个镜号（起始+切镜/声画分离），禁止把长台词塞进单个镜号。\n\n`;

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
function validatePlan(plan, dialogues, limits, minSegments) {
  const errors = [];
  const warnings = [];
  const isDirectorMode = minSegments && minSegments > 1;
  if (!plan?.segments?.length) return ['规划格式错误，无法解析segments'];

  // 片段数量下限检查（导演讲戏模式）
  if (isDirectorMode && plan.segments.length < minSegments) {
    errors.push(`片段数量${plan.segments.length}个，导演指令量需要至少${minSegments}个片段`);
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
    // 导演模式放宽到8秒（导演可能要求长镜头/贴地推进），其他模式5秒
    const shotMaxDur = isDirectorMode ? 8 : (limits === SCENE_RULES.wuxi) ? 4 : 5;
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

  for (const d of dialogues) {
    const colonIdx = d.indexOf('：');
    const core = (colonIdx >= 0 ? d.substring(colonIdx + 1) : d)
      .trim().replace(QUOTE_STRIP_RE, '').slice(0, 12);
    if (core && !allPlanned.some(pd => pd.includes(core))) {
      if (isDirectorMode) {
        // 导演模式：台词未分配降级为警告（台词在C部分写作时会由验证器补写）
        warnings.push(`台词未被分配到任何镜号：${d.slice(0, 25)}...`);
      } else {
        errors.push(`台词未被分配到任何镜号：${d.slice(0, 25)}...`);
      }
    }
  }

  // 打印警告（不阻止通过）
  if (warnings.length > 0) {
    console.log(`   ⚠️ 规划警告（${warnings.length}条，不阻止通过）：`);
    warnings.forEach(w => console.log(`     · ${w}`));
  }

  return errors;
}

// 构建单片段写作 prompt
function buildSegmentPrompt(scene, segPlan, costumeCard, prevTailFrame, segIndex, totalSegs) {
  const segDialogues = (segPlan.shots || []).map(s => s.dialogue).filter(Boolean);
  const isLast = segIndex === totalSegs - 1;

  let p = `请为场景${scene.id}的【${segPlan.id}】写完整提示词（@+A+B+C+D+E+F六个部分）。\n\n`;
  p += `⛔ 硬性字数限制：@+A+B+C+D+E+F 全部内容合计 ≤ 1800字（含标点），超出即梦/Sora会截断。字数预算：\n`;
  p += `   · A部分 ≤200字：精简参数，每行只写关键词\n`;
  p += `   · B部分 ≤200字：人物状态只写姿态和位置，不写服化道\n`;
  p += `   · C部分 ≤1000字：每镜号叙事2-3句话（这是主体，但也不能超）\n`;
  p += `   · D+E+F ≤400字：尾帧简洁·限制指令不超5条·必现目标不超5条\n\n`;

  // 导演讲戏模式：提取本片段对应的导演指令
  const directorShots = extractDirectorShots(scene.content);
  if (directorShots.length > 0) {
    p += `⛔ 导演指令优先级高于自行判断：\n`;
    p += `1. 导演批注里描述的具体动作不能改——"漂移甩尾"不能改成"直冲"，"三个视角"不能合成一个。\n`;
    p += `2. 本片段规划的task如果引用了导演指令，C部分叙事必须按导演描述的方式写，不能自行替换。\n`;
    p += `3. 导演标注了⚠️的内容，必须在C部分叙事中明确体现：\n`;
    p += `   · "台词一定要重音" → 叙事写"在「XX」上刻意加重咬字"\n`;
    p += `   · "一定要注重" → 叙事里必须有详细动作描写\n`;
    p += `   · "一定要大声" → 叙事写"大声/提高音量"\n`;
    p += `4. A部分格式统一：不加方括号，参数用·分隔。\n\n`;

    // 提取本场景中所有⚠️必须的导演指令，作为写作清单
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

  p += `⛔ 本次只写这一个片段，严格按以下镜号规划施工：\n`;
  p += `1. C部分镜号数量、时长、焦段必须与规划完全一致，不得增删。\n`;
  p += `2. 含台词的镜号必须在叙事正文里写出台词原文（动作状态+冒号+引号）。\n`;
  p += `3. OS独白必须以"角色OS：「引号原文」"格式写进对应镜号叙事正文。\n`;
  p += `3b. 声画分离镜号（task含"声画分离"）：写纯画面叙事，开头注明"【声画分离】XX的OS/台词继续"，不重复写台词原文。画面按【文戏专项规则】规则十-补的三层优先级选择（①听者反应 ②说话者细节 ③空景环境）。\n`;
  p += `3c. 武文过渡镜号：武→文（task含"余震/定格"）用【武戏专项·余震落幕组合】写法，让冲击的余波在画面里停住再接台词；文→武（task含"蓄力/临界"）用【武戏专项·蓄力爆发组合】的镜1-2写法，身体细节蓄力再接动作爆发。\n`;
  p += `3d. 反应镜号（task含"反应"）：纯画面·写听者的表情变化、身体反应、沉默。不写台词。让对话有呼吸感，不要从一句台词直接跳到下一句。\n`;
  p += `4. C部分第一镜第一句锚定入场景别和视角。\n`;
  p += `5. 最后一镜最后一句锚定出场景别和视角，并标注接棒物。\n`;
  if (segIndex === 0) {
    p += `6. 这是第一个片段，无上一片段接棒，【片段衔接核对】写"无上一片段"。\n`;
  } else {
    p += `6. 上一片段末帧：${prevTailFrame || '（规划未指定，请根据剧本推断合理衔接）'}，本片段首镜景别/视角必须与之至少一个维度不同。\n`;
  }
  if (isLast) {
    // 检查是否有转场指令
    const hasTransition = scene.content.includes('转场') || scene.content.includes('无缝衔接');
    p += `7. 这是最后一个片段，【D】视觉接棒写"本场结束，无接棒"。\n`;
    if (hasTransition) {
      p += `   ⚠️ 导演指定了转场方式（见批注中"转场"相关内容），最后一镜的最后一帧必须完成转场设计，不能截断。如果导演说"眼睛到眼睛转场"，最后一帧必须写到眼睛恢复正常并为下一场接入做好准备。\n`;
    }
  } else {
    p += `7. 这不是最后一个片段，【D】必须写出接棒物。\n`;
  }
  p += `\n`;

  p += `【镜号规划（严格执行）】\n`;
  p += `片段：${segPlan.id}  ${segPlan.title}  总时长：${segPlan.duration}秒\n`;
  for (const shot of (segPlan.shots || [])) {
    p += `镜${shot.num}  ${shot.duration}s · ${shot.focal}  `;
    p += `任务：${shot.task}`;
    if (shot.dialogue) p += `  ★台词：${shot.dialogue}`;
    p += `\n`;
  }
  p += `\n`;

  if (segDialogues.length > 0) {
    p += `【本片段台词清单（全部必须出现在C部分正文）】\n`;
    segDialogues.forEach((d, i) => { p += `[台词${i + 1}] ${d}\n`; });
    p += `\n`;
  }

  p += `【场景信息】\n`;
  p += `@${scene.characters.join(' @')} @${scene.location || '场景地点'}\n\n`;
  p += `═══ AGENT_A 批注剧本（按规划施工，参考导演讲戏细节）═══\n${scene.content}\n\n`;
  if (costumeCard && costumeCard.trim()) {
    p += `═══ AGENT_B 服化道卡 ═══\n${costumeCard}\n\n`;
  }
  p += `请直接输出【${segPlan.id}】的完整提示词，包含@声明、【片段标题】、【A】【B】【C】【D】【E】【F】六个部分。不要输出其他片段。`;
  return p;
}

// 从规划对象生成 <scene_plan> 块（供前端规划卡和片段核对使用）
function generateScenePlanBlock(plan, scene, dialogues) {
  const typeLabel = scene.sceneType === 'wuxi' ? '武戏'
    : scene.sceneType === 'wenxi' ? '文戏' : '混合';
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

// 多步处理一个场景：规划 → 逐片段写作
async function processSceneMultiStep(scene, costumeCard, config, job, sceneIndex) {
  const systemPrompt = buildSystemPrompt(scene.sceneType);
  const planSystemPrompt = loadPrompt('core.txt'); // 规划阶段只用 core
  const dialogues = extractDialogues(scene.content);

  // ── 第一步：规划 ─────────────────────────────────────────
  job.progress[sceneIndex] = {
    sceneId: scene.id, status: 'processing', message: '规划中...'
  };

  let plan = null;
  const directorShots = extractDirectorShots(scene.content);
  const hasDirectorShots = directorShots.length > 0;

  // 导演讲戏模式：放宽镜头数限制 + 计算最少片段数
  const limits = hasDirectorShots
    ? { minShots: 3, maxShots: 10 }
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
  const planText1 = await callAPI(planSystemPrompt, buildPlanPrompt(scene, costumeCard, dialogues), config);
  plan = parsePlan(planText1);

  if (!plan) {
    console.log(`⚠️ ${scene.id} 规划JSON解析失败，降级`);
  } else {
    const errors1 = validatePlan(plan, dialogues, limits, minSegments);
    if (errors1.length === 0) {
      console.log(`✓ ${scene.id} 规划通过，共${plan.segments.length}个片段`);
    } else {
      // ── 第一次失败：带错误重新规划 ────────────────────────
      console.log(`⚠️ ${scene.id} 规划验证失败，修正中：\n${errors1.join('\n')}`);
      const fixPrompt = buildPlanPrompt(scene, costumeCard, dialogues)
        + `\n\n上次规划有以下错误，请修正后重新输出JSON：\n`
        + errors1.map(e => `- ${e}`).join('\n');
      const planText2 = await callAPI(planSystemPrompt, fixPrompt, config);
      plan = parsePlan(planText2);

      if (!plan) {
        console.log(`⚠️ ${scene.id} 修正规划JSON解析失败，降级`);
      } else {
        const errors2 = validatePlan(plan, dialogues, limits, minSegments);
        if (errors2.length === 0) {
          console.log(`✓ ${scene.id} 修正规划通过，共${plan.segments.length}个片段`);
        } else {
          // 两次都有验证错误 → 降级，不带着坏规划继续
          console.log(`⚠️ ${scene.id} 修正规划仍有错误，降级：\n${errors2.join('\n')}`);
          plan = null;
        }
      }
    }
  }

  // 规划彻底失败则降级为单次生成
  if (!plan) {
    console.log(`⚠️ ${scene.id} 规划失败，降级为单次生成`);
    return await processSceneSingleShot(scene, costumeCard, config, job, sceneIndex, systemPrompt, dialogues);
  }

  // ── 第二步：并行写作所有片段 ───────────────────────────────
  // 尾帧从规划的 tailFrame 字段取，无需等待上一片段实际输出
  // 所有片段可以同时开写，速度比串行快 N 倍
  job.progress[sceneIndex] = {
    sceneId: scene.id, status: 'processing',
    message: `并行写作 ${plan.segments.length} 个片段...`
  };

  const segmentPromises = plan.segments.map((seg, si) => {
    // 从规划对象取上一片段尾帧，第一个片段为空
    const prevTailFrame = si === 0 ? '' : (plan.segments[si - 1].tailFrame || '');

    const segPrompt = buildSegmentPrompt(
      scene, seg, costumeCard, prevTailFrame, si, plan.segments.length
    );

    return callAPI(systemPrompt, segPrompt, config).then(async segOutput => {
      // 台词核验 + 补写
      const segDialogues = (seg.shots || []).map(s => s.dialogue).filter(Boolean);
      if (segDialogues.length > 0) {
        const missing = verifyDialogues(segDialogues, segOutput);
        if (missing.length > 0) {
          segOutput = await repairMissingDialogues(missing, segOutput, systemPrompt, config);
          console.log(`✓ ${seg.id} 台词补写完成`);
        } else {
          console.log(`✓ ${seg.id} 台词核验通过`);
        }
      }
      // 字数检查（1800字是即梦/Sora的硬限制）
      const charCount = segOutput.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;
      if (charCount > 1800) {
        console.warn(`⚠️ ${seg.id} 字数 ${charCount}，超出 ${charCount - 1800} 字（需要在规划阶段多分片段）`);
      } else {
        console.log(`✓ ${seg.id} 字数 ${charCount}，合格`);
      }
      // 实际镜号时长验证（从输出中提取"镜X  Xs"格式）
      const shotDurMatches = segOutput.match(/镜\d+\s+(\d+(?:\.\d+)?)\s*s/g) || [];
      const actualTotal = shotDurMatches.reduce((sum, m) => {
        const d = parseFloat(m.match(/(\d+(?:\.\d+)?)\s*s/)[1]);
        return sum + d;
      }, 0);
      const plannedTotal = (seg.shots || []).reduce((s, sh) => s + (sh.duration || 0), 0);
      if (actualTotal > 0 && actualTotal > 15.5) {
        console.warn(`⚠️ ${seg.id} 实际总时长 ${actualTotal}s 超过15秒铁律上限`);
      } else if (actualTotal > 0 && Math.abs(actualTotal - plannedTotal) > 2) {
        console.warn(`⚠️ ${seg.id} 实际总时长 ${actualTotal}s ≠ 规划 ${plannedTotal}s（差${Math.abs(actualTotal - plannedTotal).toFixed(1)}s）`);
      } else if (actualTotal > 0) {
        console.log(`✓ ${seg.id} 时长 ${actualTotal}s，合格`);
      }
      return segOutput;
    });
  });

  // Promise.allSettled：单个片段失败不影响其他片段结果
  const results = await Promise.allSettled(segmentPromises);
  const outputs = results.map((result, si) => {
    if (result.status === 'fulfilled') return result.value;
    const errMsg = result.reason?.message || '未知错误';
    console.error(`❌ ${plan.segments[si].id} 写作失败: ${errMsg}`);
    return `[${plan.segments[si].id} 生成失败: ${errMsg}]`;
  });

  // 生成 scene_plan 块，供前端规划卡和片段核对使用
  const scenePlanBlock = generateScenePlanBlock(plan, scene, dialogues);

  // ── 全场景台词总检 + 补写 ─────────────────────────────────
  // 所有片段拼合后，用完整台词表再查一遍，防止跨片段遗漏
  if (dialogues.length > 0) {
    const finalMissing = verifyDialogues(dialogues, outputs.join('\n'));
    if (finalMissing.length > 0) {
      console.warn(`⚠️ ${scene.id} 全场景台词总检：${finalMissing.length} 条台词遗漏，尝试补写到最后一个片段...`);
      finalMissing.forEach((d, i) => console.warn(`   遗漏${i + 1}：${d.slice(0, 40)}...`));
      // 补写到最后一个片段
      const lastIdx = outputs.length - 1;
      if (lastIdx >= 0 && !outputs[lastIdx].startsWith('[')) {
        try {
          outputs[lastIdx] = await repairMissingDialogues(finalMissing, outputs[lastIdx], systemPrompt, config);
          console.log(`✓ ${scene.id} 全场景台词补写完成`);
          // 再验一次
          const finalMissing2 = verifyDialogues(dialogues, outputs.join('\n'));
          if (finalMissing2.length > 0) {
            console.warn(`⚠️ ${scene.id} 补写后仍有 ${finalMissing2.length} 条遗漏`);
          }
        } catch (err) {
          console.warn(`⚠️ ${scene.id} 全场景台词补写失败：${err.message}`);
        }
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
    sceneId: scene.id, status: 'processing', message: '生成中（单次模式）...'
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

  // 检测转场指令
  if (scene.content.includes('转场') || scene.content.includes('无缝衔接')) {
    userMsg += `17. ⚠️ 导演指定了转场方式，最后一个片段的最后一镜必须完成转场设计，不能截断。\n`;
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
  for (let si = 0; si < segDurMatches.length; si++) {
    const segText = segDurMatches[si];
    const shotDurs = segText.match(/镜\d+\s+(\d+(?:\.\d+)?)\s*s/g) || [];
    const segTotal = shotDurs.reduce((sum, m) => sum + parseFloat(m.match(/(\d+(?:\.\d+)?)\s*s/)[1]), 0);
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

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: '未收到上传文件，请选择文件后重试。' });
    let text = '';
    if (file.originalname.toLowerCase().endsWith('.docx')) {
      const result = await mammoth.extractRawText({ path: file.path });
      text = result.value;
    } else {
      text = fs.readFileSync(file.path, 'utf-8');
    }
    try { fs.unlinkSync(file.path); } catch {}
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

  const CONCURRENCY = 2; // 多步模式每场景5-6次调用，并发2防止触发限速
  const job = jobs.get(jobId);
  let index = 0;

  async function runNext() {
    if (index >= scenes.length) return;
    const i = index++;
    const scene = scenes[i];

    try {
      const result = await processSceneMultiStep(scene, costumeCard, config, job, i);
      job.progress[i] = { sceneId: scene.id, status: 'done', message: '完成 ✓' };
      job.results[i] = {
        sceneId: scene.id, sceneHeader: scene.header,
        sceneType: scene.sceneType, episode: scene.episode, content: result
      };
    } catch (err) {
      job.progress[i] = { sceneId: scene.id, status: 'error', message: `错误: ${err.message}` };
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
  Promise.all(workers).then(() => { job.status = 'done'; }).catch(console.error);
});

app.get('/api/progress/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = () => {
    const job = jobs.get(req.params.jobId);
    if (!job) { res.write(`data: {"error":"not found"}\n\n`); res.end(); return; }
    res.write(`data: ${JSON.stringify({
      status: job.status, progress: job.progress,
      completed: job.completed, total: job.total
    })}\n\n`);
    if (job.status === 'done') { clearInterval(iv); res.end(); }
  };
  send();
  const iv = setInterval(send, 800);
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
  // 清空提示词缓存，下次调用 loadPrompt 时重新读磁盘
  for (const key of Object.keys(_promptCache)) delete _promptCache[key];
  res.json({ message: '提示词缓存已清空，下次处理时重新读取', prompts: ['core.txt', 'wenxi.txt', 'wuxi.txt', 'agent_a.md', 'agent_a_director.md'] });
});


// ============================================================
// Agent A v6：规划 → 验证 → 执行 → 验证（与 Agent C 同级架构）
// ============================================================

const agentAJobs = new Map();

function stripMarkdown(text) {
  return text
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^---+\s*$/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/```[\s\S]*?```/g, m => m.replace(/^```\w*\n?/, '').replace(/\n?```$/, ''))
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
  p += '6. dialogue_count 和 action_count 必须与以下程序计数一致\n\n';
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
  const strippedAnno = processDirectorNotes(annotatedContent, () => '');
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
  const strippedAnno = processDirectorNotes(annotatedContent, () => '');
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
    if (file.originalname.toLowerCase().endsWith('.docx')) { const r = await mammoth.extractRawText({path:file.path}); text = r.value; }
    else text = fs.readFileSync(file.path, 'utf-8');
    try { fs.unlinkSync(file.path); } catch {}
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
    processDirectorNotes(annotatedContent, () => '')
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
  const strippedAnno = processDirectorNotes(annotatedContent, () => '');
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
  const strippedAnno = processDirectorNotes(annotatedContent, () => '');
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
  // 对每个剧本角色名，找文本中相似但不完全相同的变体
  for (const canonical of canonicalNames) {
    if (canonical.length < 2) continue;
    const surname = canonical[0]; // 姓
    // 在文本中找同姓、同长度、但不完全相同的名字（导演口误的同音字）
    const nameLen = canonical.length;
    const regex = new RegExp(surname + '.{' + (nameLen - 1) + '}', 'g');
    const matches = result.match(regex) || [];
    for (const found of matches) {
      if (found === canonical) continue; // 完全一致，跳过
      // 检查是否只差1-2个字（同音字口误）
      let diffCount = 0;
      for (let i = 0; i < nameLen; i++) {
        if (found[i] !== canonical[i]) diffCount++;
      }
      if (diffCount === 1) {
        // 只差一个字，很可能是口误，替换
        // 但不替换出现在台词引号内的（那是剧本原文）
        console.log(`   角色名修正：${found} → ${canonical}`);
        result = result.split(found).join(canonical);
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

  if (isDirectorMode) {
    // ── 导演讲戏模式：按确认后的映射逐场景批注 ──
    const { byScene, globals } = groupMappedSegments(mappedSegments);
    (async () => {
      const job = agentAJobs.get(jobId);
      const directorPrompt = loadPrompt('agent_a_director.md');
      if (!directorPrompt) {
        job.status = 'error';
        console.error('❌ 导演讲戏提示词文件 agent_a_director.md 未找到');
        return;
      }
      const CONCURRENCY = 2;
      let index = 0;
      const sceneFeels = new Array(scenes.length).fill(null);

      console.log('\n🎬 Agent A 导演讲戏批注：' + scenes.length + '个场景（映射已确认）');
      const coveredScenes = Object.keys(byScene);
      console.log('   有讲戏覆盖的场景：' + coveredScenes.join(', '));
      console.log('   全局指令：' + globals.length + '条');

      async function runNext() {
        if (index >= scenes.length) return;
        const i = index++;
        const scene = scenes[i];
        const prevFeel = i > 0 ? sceneFeels[i - 1] : null;
        const sceneSegs = byScene[scene.id] || [];

        try {
          const segCount = sceneSegs.length;
          job.progress[i] = { sceneId: scene.id, status: 'processing',
            message: segCount > 0 ? '批注中（' + segCount + '条讲戏）...' : '标注待补充...' };

          const execPrompt = buildDirectorAnnotatePrompt(scene, scenes, sceneSegs, globals, prevFeel);
          let result = stripMarkdown(await callAPI(directorPrompt, execPrompt, config));

          // 验证
          const errors = validateDirectorAnnotation(scene.content, result);
          if (errors.length > 0) {
            console.log('⚠️ 场景' + scene.id + ' 验证问题' + errors.length + '条，重试...');
            job.progress[i].message = '验证失败(' + errors.length + '条)，重试...';
            const retryPrompt = execPrompt + '\n\n⚠️ 上次批注有以下问题，请修正后重新完整输出：\n' + errors.map(e => '- ' + e).join('\n');
            result = stripMarkdown(await callAPI(directorPrompt, retryPrompt, config));
            const errors2 = validateDirectorAnnotation(scene.content, result);
            if (errors2.length > 0) {
              console.warn('⚠️ 场景' + scene.id + ' 重试后仍有' + errors2.length + '条问题');
              job.progress[i] = { sceneId: scene.id, status: 'done', message: '完成（' + errors2.length + '条警告）' };
            } else {
              job.progress[i] = { sceneId: scene.id, status: 'done', message: '完成 ✓' };
            }
          } else {
            console.log('✓ 场景' + scene.id + ' 批注通过');
            job.progress[i] = { sceneId: scene.id, status: 'done', message: '完成 ✓' };
          }

          const feelMatch = result.match(/【场景感受】\s*([^\n]+)/);
          if (feelMatch) sceneFeels[i] = feelMatch[1].trim();

          // 角色名修正：导演口误的名字替换为剧本里的正确写法
          result = normalizeCharNames(result, scene.characters);

          job.results[i] = result;
          job.validations[i] = { sceneId: scene.id, stats: getDirectorAnnotationStats(scene.content, result) };
        } catch (err) {
          console.error('❌ 场景' + scene.id + ' 失败:', err.message);
          job.progress[i] = { sceneId: scene.id, status: 'error', message: '失败: ' + err.message };
          job.results[i] = '[场景' + scene.id + ' 批注失败: ' + err.message + ']';
        }
        job.completed++;
        await runNext();
      }

      const workers = Array(Math.min(CONCURRENCY, scenes.length)).fill(null).map(() => runNext());
      await Promise.all(workers).catch(console.error);

      const allAnnotations = job.results.filter(Boolean).join('\n\n');
      try {
        job.progress.push({ sceneId: '摘要', status: 'processing', message: '生成批注摘要...' });
        const sumMsg = '以下是已完成的逐场景批注（导演讲戏映射模式）。请输出批注摘要。\n⚠️ 纯文本，禁止 Markdown。\n\n'
          + '摘要格式：\n【批注摘要】\n已批注场景：X场\n场景感受覆盖：X场/共X场\n镜头意图批注：X条\n人物内心批注：X条\n禁止项：X条\n待补充场景：X场\n\n'
          + '═══ 全部批注 ═══\n' + allAnnotations;
        const summary = stripMarkdown(await callAPI(directorPrompt, sumMsg, config));
        job.finalResult = allAnnotations + '\n\n' + summary;
        job.progress[job.progress.length - 1] = { sceneId: '摘要', status: 'done', message: '完成 ✓' };
      } catch (err) {
        job.finalResult = allAnnotations + '\n\n[摘要失败: ' + err.message + ']';
        job.progress[job.progress.length - 1] = { sceneId: '摘要', status: 'error', message: '摘要失败' };
      }
      job.status = 'done';
      console.log('✓ Agent A 导演讲戏模式全部完成：' + scenes.length + '个场景');
    })();
  } else {
  // ── AI自动分析模式（原有逻辑）──
  (async () => {
    const job = agentAJobs.get(jobId);
    const agentAPrompt = loadPrompt('agent_a.md');
    const planSystemPrompt = '你是专业的剧本批注规划专员。只做规划分析，不写批注正文。';
    const CONCURRENCY = 2;
    let index = 0;
    // 存储每场的场景感受，供后续场景衔接参考
    const sceneFeels = new Array(scenes.length).fill(null);

    console.log('\n📝 Agent A v6 逐场景批注：' + scenes.length + '个场景（规划→验证→执行→验证）');

    async function runNext() {
      if (index >= scenes.length) return;
      const i = index++;
      const scene = scenes[i];
      const prevFeel = i > 0 ? sceneFeels[i - 1] : null;

      try {
        // ── 第一步：规划 ──
        job.progress[i] = { sceneId: scene.id, status: 'processing', message: '规划中...' };
        const planPrompt = buildAnnotationPlanPrompt(scene, scenes, soulCard, prevFeel);
        const planText = await callAPI(planSystemPrompt, planPrompt, config);
        let plan = parseAnnotationPlan(planText);

        if (!plan) {
          console.log('⚠️ 场景' + scene.id + ' 规划JSON解析失败，重试...');
          job.progress[i].message = '规划解析失败，重试...';
          const planText2 = await callAPI(planSystemPrompt, planPrompt + '\n\n⚠️ 上次输出的JSON格式有误，请严格输出合法JSON。', config);
          plan = parseAnnotationPlan(planText2);
        }

        if (plan) {
          const planErrors = validateAnnotationPlan(plan, scene.content);
          if (planErrors.length > 0) {
            console.log('⚠️ 场景' + scene.id + ' 规划验证失败：' + planErrors.join(', '));
            job.progress[i].message = '规划验证失败，修正...';
            const fixPrompt = planPrompt + '\n\n⚠️ 上次规划有以下错误，请修正后重新输出JSON：\n' + planErrors.map(e => '- ' + e).join('\n');
            const planText3 = await callAPI(planSystemPrompt, fixPrompt, config);
            const plan2 = parseAnnotationPlan(planText3);
            if (plan2) {
              const planErrors2 = validateAnnotationPlan(plan2, scene.content);
              if (planErrors2.length === 0) { plan = plan2; console.log('✓ 场景' + scene.id + ' 规划修正通过'); }
              else { console.warn('⚠️ 场景' + scene.id + ' 规划修正后仍有问题，用修正版继续'); plan = plan2; }
            }
          } else {
            console.log('✓ 场景' + scene.id + ' 规划验证通过');
          }
          // 保存场景感受供后续场景衔接
          sceneFeels[i] = plan.scene_feel || '';
        } else {
          console.warn('⚠️ 场景' + scene.id + ' 规划彻底失败，降级为无规划执行');
          sceneFeels[i] = '';
        }

        // ── 第二步：执行批注 ──
        job.progress[i].message = '批注中...';
        let execPrompt;
        if (plan) {
          execPrompt = buildAnnotationExecutePrompt(scene, plan, scenes, soulCard, prevFeel);
        } else {
          // 降级：无规划直接批注
          let msg = '请按照第二步执行：只批注场景' + scene.id + '。\n⚠️ 纯文本，禁止 Markdown。台词和▲动作行原样保留。\n\n';
          if (prevFeel) msg += '上一场情绪落点：' + prevFeel + '\n\n';
          msg += '═══ 剧魂定位卡 ═══\n' + soulCard + '\n\n═══ 场景' + scene.id + ' ═══\n' + scene.content + '\n\n请输出完整批注。';
          execPrompt = msg;
        }

        let result = stripMarkdown(await callAPI(agentAPrompt, execPrompt, config));

        // ── 第三步：执行后验证 ──
        const errors = validateAnnotation(scene.content, result);
        if (errors.length > 0) {
          console.log('⚠️ 场景' + scene.id + ' 验证问题' + errors.length + '条，重试...');
          job.progress[i].message = '验证失败(' + errors.length + '条)，重试...';
          const retryPrompt = execPrompt + '\n\n⚠️ 上次批注有以下问题，请修正后重新完整输出：\n' + errors.map(e => '- ' + e).join('\n');
          result = stripMarkdown(await callAPI(agentAPrompt, retryPrompt, config));
          const errors2 = validateAnnotation(scene.content, result);
          if (errors2.length > 0) {
            console.warn('⚠️ 场景' + scene.id + ' 重试后仍有' + errors2.length + '条问题');
            job.progress[i] = { sceneId: scene.id, status: 'done', message: '完成（' + errors2.length + '条警告）' };
          } else {
            console.log('✓ 场景' + scene.id + ' 重试后通过');
            job.progress[i] = { sceneId: scene.id, status: 'done', message: '完成 ✓' };
          }
        } else {
          console.log('✓ 场景' + scene.id + ' 验证通过');
          job.progress[i] = { sceneId: scene.id, status: 'done', message: '完成 ✓' };
        }
        // 更新场景感受（从实际批注中提取，更准确）
        const feelMatch = result.match(/【场景感受】\s*([^\n]+)/);
        if (feelMatch) sceneFeels[i] = feelMatch[1].trim();

        job.results[i] = result;
        job.validations[i] = { sceneId: scene.id, stats: getAnnotationStats(scene.content, result) };
      } catch (err) {
        console.error('❌ 场景' + scene.id + ' 失败:', err.message);
        job.progress[i] = { sceneId: scene.id, status: 'error', message: '失败: ' + err.message };
        job.results[i] = '[场景' + scene.id + ' 批注失败: ' + err.message + ']';
      }
      job.completed++;
      await runNext();
    }

    const workers = Array(Math.min(CONCURRENCY, scenes.length)).fill(null).map(() => runNext());
    await Promise.all(workers).catch(console.error);

    const allAnnotations = job.results.filter(Boolean).join('\n\n');
    try {
      job.progress.push({ sceneId: '摘要', status: 'processing', message: '生成批注摘要...' });
      const sumMsg = '以下是已完成的逐场景批注。请执行第三步逐行核查和第四步批注摘要。\n⚠️ 纯文本，禁止 Markdown。\n\n═══ 剧魂定位卡 ═══\n' + soulCard + '\n\n═══ 全部批注 ═══\n' + allAnnotations + '\n\n请输出核查结果和批注摘要。';
      const summary = stripMarkdown(await callAPI(agentAPrompt, sumMsg, config));
      job.finalResult = allAnnotations + '\n\n' + summary;
      job.progress[job.progress.length - 1] = { sceneId: '摘要', status: 'done', message: '完成 ✓' };
    } catch (err) {
      job.finalResult = allAnnotations + '\n\n[摘要失败: ' + err.message + ']';
      job.progress[job.progress.length - 1] = { sceneId: '摘要', status: 'error', message: '摘要失败' };
    }
    job.status = 'done';
    console.log('✓ Agent A v6 全部完成：' + scenes.length + '个场景');
  })();
  } // end else AI mode
});

app.get('/api/agent-a/progress/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = () => {
    const job = agentAJobs.get(req.params.jobId);
    if (!job) { res.write('data: {"error":"not found"}\n\n'); res.end(); return; }
    res.write('data: ' + JSON.stringify({ status: job.status, progress: job.progress, completed: job.completed, total: job.total }) + '\n\n');
    if (job.status === 'done' || job.status === 'error') { clearInterval(iv); res.end(); }
  };
  send();
  const iv = setInterval(send, 1000);
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
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''annotated-script-" + Date.now() + '.txt');
  res.send('Agent A 批注版剧本\n生成时间：' + new Date().toLocaleString('zh-CN') + '\n\n' + job.finalResult);
});

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('prompts')) fs.mkdirSync('prompts');

app.listen(PORT, () => {
  console.log('\n🎬 视频提示词工具 v6 已启动');
  console.log('📍 访问地址：http://localhost:' + PORT);
  console.log('📁 提示词目录：' + path.join(__dirname, 'prompts'));
  console.log('   Agent A v6：规划→验证→执行→验证（与Agent C同级）');
  console.log('   Agent A 导演讲戏模式：直接映射（无规划步骤）');
  console.log('   Agent C：批注剧本 → 规划 → 逐片段写作（多步）\n');
});
