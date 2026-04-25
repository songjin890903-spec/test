// 完整测试 MiniMax 批注生成
const https = require('https');

const API_KEY = 'sk-cp-Vtobjz2YtCCgFyJNF4aB6BYqeRhltkqHM1VClGRQsdLT1kBAcXTCWqrP6NHZkfGnu8IwfVkmfopb72rBHOoK9Q0QuqoIjIjzGlt3wK_xHWs7FZT6hZ1tkqo';

const SCENE = {
  id: '11-1',
  header: '日 外 张家祖宅',
  characters: ['张玄', '范思瑶', '赵一铭', '张雨晴', '刀哥', '打手*N', '刘秘书']
};

const SOUL_CARD = `痛点类型：末日突然降临，旧有社会身份（富二代、公子哥）瞬间失效，权力秩序崩塌带来的无助与恐慌。

爽点方向：逆袭——一个原本被小看或边缘化的角色（张玄），在旧秩序崩塌的新世界里，掌握了先机，拥有淡定与信息差，享受他人的崩溃。

主打情绪：痛点为主，爽点为辅（痛在爽前）。观众先代入赵一铭、范思瑶、刀哥的崩溃与恐慌，再被张玄的掌控感与冷笑所吸引。

信任主线：
├─ 表层：张玄面对赵一铭的求助，表现出冷漠、嘲讽甚至幸灾乐祸。
└─ 内核：信任尚未建立，关系处于"旧有身份对立"状态。张玄的冷静并非善意，而是一种看穿棋局后的俯视。信任需要在新世界的残酷考验中，从对立转向依赖。

马斯洛定位：
├─ 主角此刻的需求层级：安全（张玄显然已预知或掌控了安全信息）。
└─ 被踩的是哪一层：安全（所有人都在恐惧下一秒被丧尸杀死，旧体系崩塌带来的生存危机）。

剧魂一句话：当末日打破所有社会阶层，只有掌握生存信息与冷血判断力的人，才能成为新世界的王。

情绪节奏总判断：
├─ 第一场戏的情绪功能：建立痛点与反差。用电话打不通的恐慌，迅速将观众拉入旧身份失效的绝望中，同时用张玄的冷静冷笑，埋下"他是知道什么"的悬念。
├─ 全集的情绪走向：恐慌（打不通电话） → 毁灭性真相（父亲成丧尸） → 视觉冲击（丧尸视频） → 倒吸一口凉气（张玄的欢迎词）。
└─ 留给观众带走的最后一个情绪：强烈的悬念与寒意——"张玄到底知道什么？他在等什么？" 这个钩子驱动观众追下一集。`;

const SCENE_CONTENT = `11-1 日 外 张家祖宅
人物：张玄 范思瑶 赵一铭 张雨晴 刀哥 打手*N 刘秘书
▲电话里传来嘟嘟忙音。
（VO）：您拨打的电话暂时无人接听。
▲赵一铭愣住。
赵一铭：这是赵氏财团的专线电话，24小时有专人待机，怎么会无人接听？
范思瑶（迟疑）：赵少，你是不是打错了？
赵一铭（不耐烦且有些慌乱）：怎么可能？你当我是傻子吗，这种电话也能打错？（略一犹豫）没关系，我还有别的电话。
▲赵一铭又按下另外一个号码。
（VO）：您拨打的电话暂时无人接听。
▲赵一铭脸色难看，额头上隐约有汗珠冒出。
张玄（冷笑）：看来赵氏财团公子哥的身份，也不太好使啊。
赵一铭：还有一个！是直通我爹的私人电话，这个一定能打通！
▲赵一铭再次拨通电话，在短暂等待音效后接通。
刘秘书（颤音，恐慌，VO）：喂，大少爷？
赵一铭（大喜）：赶紧把电话给我爹，我找他有急事！
刘秘书（VO）：董事长他...他...
赵一铭（不安）：我爹他怎么了？
刘秘书（VO）：他成丧尸了！
▲赵一铭大惊，范思瑶、刀哥都脸色陡变。
赵一铭：荒唐！开什么玩笑，你以为拍电影呢？
刘秘书（VO）：大少爷，我没开玩笑，三言两语说不清楚，总之，你赶紧找个安全地方躲起来，这个世界乱套了...
▲刘秘书挂断电话，赵一铭失魂落魄，手机啪的一声掉在地上。
刀哥：你们看，真的有丧尸！
▲刀哥拿手机，屏幕是类似于抖音的短视频界面。
▲大街上，无数带血污、歪着脑袋的丧尸，以极为诡异的姿态在行走。
▲商场里，一只丧尸将一个穿着超短裙的女人扑倒，放肆撕咬。
▲马路上，一辆又一辆的车追尾相撞，有丧尸站在车外，疯狂拍打车窗。
赵一铭：怎么会这样...
范思瑶：这...这是传说中的丧尸末日？
张玄（微笑，伸展双臂）：诸位，欢迎来到新时代。`;

const SYSTEM_PROMPT = `你是剧本批注 JSON 引擎。你不复制剧本原文，不复制讲戏文本，只产出 JSON 批注数据。

输出必须是纯 JSON 对象，从 { 开始到 } 结束。不要任何代码块标记。不要任何解释文字。`;

function buildPrompt() {
  const chars = SCENE.characters.join('、');

  const lines = SCENE_CONTENT.split('\n');
  const items = [];
  let id = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('人物：')) continue;

    if (trimmed.startsWith('▲')) {
      items.push({ id: String.fromCharCode(65 + id++), type: 'action', text: trimmed.slice(1).trim(), original: trimmed });
    } else if (/^[A-Za-z\u4e00-\u9fa5]/.test(trimmed)) {
      const colonIdx = trimmed.indexOf('：');
      const colonIdx2 = trimmed.indexOf(':');
      const cIdx = colonIdx2 > 0 && (colonIdx === -1 || colonIdx2 < colonIdx) ? colonIdx2 : colonIdx;
      if (cIdx > 0 && cIdx < trimmed.length - 1) {
        const charPart = trimmed.slice(0, cIdx);
        const rest = trimmed.slice(cIdx + 1);
        const isVO = charPart.includes('（') || charPart.includes('VO');
        items.push({ id: String.fromCharCode(65 + id++), type: 'dialogue', character: charPart, text: trimmed, original: trimmed });
      }
    }
  }

  console.log('解析的 items 数量:', items.length);
  items.forEach(it => console.log(`  [${it.id}] ${it.type}: ${it.text.slice(0, 40)}`));

  let p = '';
  p += `场景信息：\n`;
  p += `· 场景编号：${SCENE.id}\n`;
  p += `· 场景标题：${SCENE.header}\n`;
  p += `· 人物列表（剧本写法·角色名以此为准）：${chars}\n\n`;

  p += `═══ 本场条目清单（共 ${items.length} 条，需逐条给出批注或状态）═══\n`;
  for (const it of items) {
    const label = it.type === 'action' ? '▲动作' : `台词·${it.character || ''}`;
    p += `[${it.id}] ${label}：${it.text}\n`;
  }
  p += `\n`;

  p += `═══ 工作模式：AI 剧作分析 ═══\n`;
  p += `剧魂定位卡（必须遵循）：\n${SOUL_CARD}\n\n`;
  p += `分析规则：\n`;
  p += `1. 所有批注来源于剧作方法论 + 剧本原文推理，不编造剧本未发生的情节。\n`;
  p += `2. 每条【人物内心】必须同时给心理状态（mental）和身体反应（body）两层·只有心理没有身体的批注无效。\n`;
  p += `3. 重要情绪节点必须标稳帧点（stable_frame）。\n`;
  p += `4. 开场如果缺少"暖"的建立·或世界观未交代·用 cold_open 字段标出。\n\n`;

  p += `═══ 严格 JSON 输出契约 ═══\n`;
  p += `1. 从 { 开始·到 } 结束。不要任何代码块标记。不要任何解释文字。\n`;
  p += `2. annotatable items 全集 = 上方条目清单。你必须为 **每一个 ID** 都在 annotations 里给出条目·一个都不能少。\n`;
  p += `3. annotations[ID] 的"状态"三选一：\n`;
  p += `   · { "status": "annotated", "intent_capture": [...], "inner": {...}, ... } — 该条有批注\n`;
  p += `   · { "status": "no_annotation" } — 纯信息交代，不需要批注\n`;
  p += `   · { "status": "pending" } — 暂无特别批注\n`;
  p += `4. 顶层字段必填：\n`;
  p += `   · scene_feel: 一句话整体情绪任务\n`;
  p += `   · emotion_flow: { "start": "...", "trigger": "...", "end": "..." } — 三节点必须是不同的情绪描述\n`;
  p += `   · audience_takeaway: 观众带走的情绪/问题\n`;
  p += `   · structure_node: 结构节点类型\n`;
  p += `   · action_thread: 数组·每个有名字的角色一条·字段 {character, task, source}\n`;
  p += `   · action_thread_turning_point: 一句话·指向某条 ID·说明情绪拐点处谁的动作线怎么变\n`;
  p += `5. 可选字段：forbidden_global（全场禁止项数组）·cold_open\n`;
  p += `6. annotations[ID] 当 status="annotated" 时的字段：\n`;
  p += `   · intent_capture: 数组·每条是"具体可拍的画面"\n`;
  p += `   · stable_frame: 字符串·"哪一帧·停多久·为什么"\n`;
  p += `   · inner: { "mental": "...", "body": ["...", "..."] }\n`;
  p += `   · forbid: { "what": "...", "why": "..." }\n`;
  p += `   · must_flag: true/false\n`;
  p += `\n`;
  p += `请直接输出 JSON：`;

  return p;
}

async function testMiniMax() {
  const userPrompt = buildPrompt();

  console.log('\n=== 发送的 Prompt 长度:', userPrompt.length, '===\n');

  const body = {
    model: 'MiniMax-M2.7',
    max_completion_tokens: 8000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ]
  };

  const postData = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.minimaxi.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`API Error: ${JSON.stringify(json.error)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Parse Error: ${e.message}. Data: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

testMiniMax()
  .then(result => {
    console.log('\n=== MiniMax 原始返回 ===');
    let content = result.choices[0].message.content;
    console.log('finish_reason:', result.choices[0].finish_reason);
    console.log('内容长度:', content.length);
    console.log('\n原始内容前1500字符:');
    console.log(content.slice(0, 1500));
    console.log('\n...');
    console.log('\n最后800字符:');
    console.log(content.slice(-800));

    // 尝试解析 JSON
    console.log('\n=== 尝试解析 JSON ===');
    let clean = content.replace(/```json|```/g, '').trim();
    clean = clean.replace(/[\n\r]*<\/think>[\s\S]*?<think>[\n\r]*/gi, '\n');
    clean = clean.replace(/<think>[\s\S]*?<\/think>/gi, '');
    clean = clean.trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end >= start) {
      clean = clean.substring(start, end + 1);
      try {
        const parsed = JSON.parse(clean);
        console.log('JSON 解析成功!');
        console.log('scene_feel:', parsed.scene_feel);
        console.log('structure_node:', parsed.structure_node);
        console.log('action_thread 数量:', (parsed.action_thread || []).length);
        console.log('annotations keys:', Object.keys(parsed.annotations || {}).join(', '));

        // 检查禁止项
        const forbidItems = [];
        for (const [key, val] of Object.entries(parsed.annotations || {})) {
          if (val.forbid) forbidItems.push(key);
        }
        console.log('含 forbid 的条目:', forbidItems.join(', '));
        console.log('forbidden_global:', JSON.stringify(parsed.forbidden_global));
      } catch (e) {
        console.log('JSON 解析失败:', e.message);
        console.log('cleaned content:', clean.slice(0, 300));
      }
    } else {
      console.log('无法找到 JSON 边界');
    }
  })
  .catch(err => {
    console.error('错误:', err.message);
  });
