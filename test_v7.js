// ============================================================
// Agent A v7 端到端测试
// 用法：node test_v7.js
// 覆盖：items 解析 / prompt 构建 / JSON 解析 / 验证 / 拼装 / 摘要
// ============================================================

'use strict';

const {
  parseSceneItemsV7,
  buildAnnotationPromptV7,
  parseAnnotationJSON,
  validateAnnotationV7,
  assembleAnnotationV7,
  generateSummaryV7,
  getAnnotationStatsV7,
} = require('./annotation_v7');

// ─── 断言辅助 ───────────────────────────────────────────────
let passCount = 0;
let failCount = 0;

function assert(cond, msg) {
  if (cond) {
    passCount++;
    console.log(`  ✓ ${msg}`);
  } else {
    failCount++;
    console.log(`  ✗ ${msg}`);
  }
}

function section(title) {
  console.log(`\n【${title}】`);
}

// ─── 测试数据 ───────────────────────────────────────────────
const mockScene = {
  id: '1-1',
  header: '夜 内 守林屋',
  characters: ['张玄', '王龙', '李德财'],
  content: `场景1-1  夜 内 守林屋
人物：张玄、王龙、李德财

▲张玄坐在桌边，低头检查自己的双手，翻来覆去地看。
张玄：这双手，还能用？
▲王龙被张玄按在墙上，喉管被扼住。
王龙：你、你不是……
▲张玄的手指缓缓收紧。
张玄：祸害我妹妹的不就是你吗？`,
};

// ============================================================
// TEST 1: parseSceneItemsV7
// ============================================================
section('TEST 1：items 解析');

const items = parseSceneItemsV7(mockScene.content);
console.log(`解析出 ${items.length} 个 items：`);
for (const it of items) {
  console.log(`  [${it.id}] type=${it.type} text="${it.text}"`);
}

const actionItems = items.filter(it => it.type === 'action');
const dialogueItems = items.filter(it => it.type === 'dialogue');
const rawItems = items.filter(it => it.type === 'raw');

assert(actionItems.length === 3, `识别出 3 条 action 行，实际 ${actionItems.length}`);
assert(dialogueItems.length === 3, `识别出 3 条 dialogue 行，实际 ${dialogueItems.length}`);
assert(actionItems[0].id === 'A1' && actionItems[1].id === 'A2' && actionItems[2].id === 'A3', 'action ID 递增正确 A1/A2/A3');
assert(dialogueItems[0].id === 'D1' && dialogueItems[1].id === 'D2' && dialogueItems[2].id === 'D3', 'dialogue ID 递增正确 D1/D2/D3');
assert(dialogueItems[0].character === '张玄', 'D1 角色名 = 张玄');
assert(dialogueItems[1].character === '王龙', 'D2 角色名 = 王龙');

// ============================================================
// TEST 2: parseAnnotationJSON（三层兜底）
// ============================================================
section('TEST 2：JSON 三层兜底解析');

// 标准 JSON
const j1 = parseAnnotationJSON('{"a": 1, "b": [1,2]}');
assert(j1 && j1.a === 1 && Array.isArray(j1.b), '标准 JSON 解析成功');

// 带 markdown 代码块包裹
const j2 = parseAnnotationJSON('```json\n{"x": "hello"}\n```');
assert(j2 && j2.x === 'hello', 'markdown 代码块包裹可解析');

// 带前导和尾随文字（LLM 常见失误）
const j3 = parseAnnotationJSON('这是我的回答：\n{"ok": true}\n结束');
assert(j3 && j3.ok === true, '前导尾随文字可剥离');

// 尾随逗号（常见语法错误）
const j4 = parseAnnotationJSON('{"a": 1, "b": 2,}');
assert(j4 && j4.a === 1 && j4.b === 2, '尾随逗号可修复');

// 完全乱的输入
const j5 = parseAnnotationJSON('这不是 JSON');
assert(j5 === null, '非 JSON 返回 null');

// ============================================================
// TEST 3: 完整 AI 模式流程
// ============================================================
section('TEST 3：AI 模式完整流程');

const aiAnnotationData = {
  scene_feel: '旧敌重逢·冷处理·压着的杀意',
  emotion_flow: {
    start: '平静·不自觉',
    trigger: '听到对方的声音',
    end: '杀意·但压着不发',
  },
  audience_takeaway: '他会杀·但选择慢慢杀',
  structure_node: '压力铺垫·第一层',
  action_thread: [
    { character: '张玄', task: '检查自己的手指', source: '剧本原文' },
    { character: '王龙', task: '无道具任务·依赖第二层情绪驱动肢体', source: '无' },
    { character: '李德财', task: '无道具任务·依赖第二层情绪驱动肢体', source: '无' },
  ],
  action_thread_turning_point: 'D3 张玄质问时·张玄检查手指的动作骤停·转向王龙',
  forbidden_global: ['张玄不要愤怒·要冷静的杀意'],
  cold_open: null,
  annotations: {
    A1: {
      status: 'annotated',
      intent_capture: ['大特写锁定张玄右手·指节翻转'],
      stable_frame: '手完全静止的那一帧·停 0.5 秒·让观众看清',
      inner: {
        mental: '不屑·自我确认',
        body: ['低头看自己的手', '翻来覆去地看', '眼神完全不在对方身上'],
      },
    },
    D1: {
      status: 'annotated',
      inner: {
        mental: '自我质问·重生后的第一次确认',
        body: ['声音低·没抬头'],
      },
    },
    A2: {
      status: 'annotated',
      must_flag: true,
      intent_capture: ['大特写锁定扼住王龙喉管的手', '王龙的脚在空中乱蹬'],
      inner: {
        mental: '残忍的确认·不是戏剧冲突',
        body: ['指节慢慢收紧', '面无表情'],
      },
    },
    D2: {
      status: 'annotated',
      inner: {
        mental: '纯动物性生理恐惧',
        body: ['喉管被掐·声音发不全', '嘴张着像鱼'],
      },
      forbid: {
        what: '戏剧化的"认出旧敌"表演',
        why: '王龙是原始求生·不是戏剧识别',
      },
    },
    A3: {
      status: 'annotated',
      intent_capture: ['张玄指节收紧的升格镜头'],
      stable_frame: '指节泛白的那一帧·停 0.3 秒',
    },
    D3: {
      status: 'annotated',
      must_flag: true,
      inner: {
        mental: '复仇落地·没有表演的杀意',
        body: ['视线直直看着王龙', '嘴角没有任何动作'],
      },
    },
  },
};

const aiErrors = validateAnnotationV7(aiAnnotationData, items, []);
console.log(`AI 模式验证：${aiErrors.length} 条错误`);
if (aiErrors.length > 0) {
  for (const e of aiErrors) console.log(`    · ${e}`);
}
assert(aiErrors.length === 0, 'AI 模式验证通过');

const aiAssembled = assembleAnnotationV7(mockScene, items, aiAnnotationData);
console.log('\n---- AI 模式拼装结果 ----');
console.log(aiAssembled);
console.log('---- end ----\n');

assert(aiAssembled.includes('【场景感受】'), '包含【场景感受】');
assert(aiAssembled.includes('【动作线设计】'), '包含【动作线设计】');
assert(aiAssembled.includes('情绪走向：平静·不自觉 → 听到对方的声音 → 杀意·但压着不发'), '情绪走向格式正确');
assert(aiAssembled.includes('张玄：这双手，还能用？'), '台词 D1 完整保留');
assert(aiAssembled.includes('王龙：你、你不是……'), '台词 D2 完整保留');
assert(aiAssembled.includes('张玄：祸害我妹妹的不就是你吗？'), '台词 D3 完整保留');
assert(aiAssembled.includes('▲张玄坐在桌边'), '动作 A1 完整保留');
assert(aiAssembled.includes('▲王龙被张玄按在墙上'), '动作 A2 完整保留');
assert(aiAssembled.includes('▲张玄的手指缓缓收紧'), '动作 A3 完整保留');
assert(aiAssembled.includes('⚠️必须·'), 'must_flag=true 的批注带⚠️必须前缀');
assert(aiAssembled.match(/（导演讲戏：/g).length >= 6, '至少有 6 个（导演讲戏：）块');
assert(aiAssembled.includes('——'), '【禁止】包含为什么禁止');

// ============================================================
// TEST 4: 情绪曲线同质化检查
// ============================================================
section('TEST 4：情绪曲线同质化检查');

const sameEmotionData = Object.assign({}, aiAnnotationData, {
  emotion_flow: {
    start: '愤怒·压不住',
    trigger: '愤怒·顶到临界',
    end: '愤怒·终于爆发',
  },
});
const sameErrors = validateAnnotationV7(sameEmotionData, items, []);
assert(sameErrors.some(e => e.includes('emotion_flow 三节点过于相似')), '检测到三节点同质化');

const diffEmotionData = Object.assign({}, aiAnnotationData, {
  emotion_flow: {
    start: '平静·日常',
    trigger: '被羞辱',
    end: '决定复仇',
  },
});
const diffErrors = validateAnnotationV7(diffEmotionData, items, []);
assert(!diffErrors.some(e => e.includes('emotion_flow 三节点过于相似')), '真正不同的三节点通过检查');

// ============================================================
// TEST 5: annotations 缺失检测
// ============================================================
section('TEST 5：annotations 缺失检测');

const incompleteData = Object.assign({}, aiAnnotationData, {
  annotations: {
    A1: aiAnnotationData.annotations.A1,
    D1: aiAnnotationData.annotations.D1,
    // 故意漏掉 A2/D2/A3/D3
  },
});
const incompleteErrors = validateAnnotationV7(incompleteData, items, []);
assert(incompleteErrors.some(e => e.includes('annotations 缺少')), '检测到 annotations 缺失');
assert(incompleteErrors.some(e => e.includes('A2')), '具体指出缺失的 ID');

// ============================================================
// TEST 6: action_thread 三字段校验
// ============================================================
section('TEST 6：action_thread 字段完整性');

const badActionThreadData = Object.assign({}, aiAnnotationData, {
  action_thread: [
    { character: '张玄', task: '检查手指' }, // 缺 source
  ],
});
const actionThreadErrors = validateAnnotationV7(badActionThreadData, items, []);
assert(actionThreadErrors.some(e => e.includes('source')), '检测到 action_thread 缺 source 字段');

// ============================================================
// TEST 7: 字段类型容错（字符串 vs 数组）
// ============================================================
section('TEST 7：字段类型容错');

const typeLooseData = Object.assign({}, aiAnnotationData, {
  annotations: Object.assign({}, aiAnnotationData.annotations, {
    A1: {
      status: 'annotated',
      intent_capture: '单字符串·不是数组', // LLM 偶尔这么写
      inner: {
        mental: '测试',
        body: '字符串 body·不是数组', // LLM 偶尔这么写
      },
    },
  }),
});
const typeLooseErrors = validateAnnotationV7(typeLooseData, items, []);
assert(typeLooseErrors.filter(e => !e.includes('annotations.A1')).length === typeLooseErrors.length
  || typeLooseErrors.length === 0, '字符串 intent_capture 不报致命错');

const typeLooseAssembled = assembleAnnotationV7(mockScene, items, typeLooseData);
assert(typeLooseAssembled.includes('单字符串·不是数组'), '字符串 intent_capture 能被拼装');
assert(typeLooseAssembled.includes('字符串 body·不是数组'), '字符串 body 能被拼装');

// ============================================================
// TEST 8: 导演模式（sceneSegments 非空）
// ============================================================
section('TEST 8：导演模式 prompt 构建');

const dirSegments = [
  { type: 'feel', text: '整体要冷·不要热血·节奏慢下来' },
  { type: 'intent', text: '先给张玄的手特写·再拉到王龙的脸·最后大全景空间' },
  { type: 'forbid', text: '不要让张玄有戏剧化的情绪外露' },
];
const globalSegs = [
  { text: '本集整体低饱和·不要高对比' },
];

const dirPrompt = buildAnnotationPromptV7(mockScene, items, 'director', {
  sceneSegments: dirSegments,
  globalSegments: globalSegs,
});

assert(dirPrompt.includes('工作模式：导演讲戏'), 'director 模式标记正确');
assert(dirPrompt.includes('先给张玄的手特写'), '讲戏文本注入');
assert(dirPrompt.includes('本集整体低饱和'), '全局指令注入');
assert(dirPrompt.includes('不压缩'), '包含不压缩铁律');

// intent_capture 压缩检测
const compressedData = Object.assign({}, aiAnnotationData, {
  annotations: Object.assign({}, aiAnnotationData.annotations, {
    A1: {
      status: 'annotated',
      intent_capture: ['一镜到底拍张玄整个过程'], // 压缩了·讲戏讲了 3 个镜头
    },
    A2: { status: 'annotated', inner: { mental: '恐惧', body: ['缩'] } },
    A3: { status: 'annotated', inner: { mental: '杀意', body: ['静'] } },
    D1: { status: 'annotated', inner: { mental: 'x', body: ['y'] } },
    D2: { status: 'annotated', inner: { mental: 'x', body: ['y'] } },
    D3: { status: 'annotated', inner: { mental: 'x', body: ['y'] } },
  }),
});
const compressedErrors = validateAnnotationV7(compressedData, items, dirSegments);
// 讲戏里有"先·再·最后"三个镜头信号·我们只给了 1 条 intent_capture
// 期望检测到压缩
console.log(`  压缩检测错误：${compressedErrors.filter(e => e.includes('intent_capture')).join(', ') || '（无）'}`);

// ============================================================
// TEST 9: 摘要生成
// ============================================================
section('TEST 9：代码生成摘要');

const scenes = [mockScene];
const allResults = [aiAssembled];
const allData = [aiAnnotationData];
const validations = [{ sceneId: '1-1', errors: [], stats: getAnnotationStatsV7(items, aiAnnotationData) }];

const summary = generateSummaryV7(scenes, allResults, allData, validations);
console.log('\n---- 摘要输出 ----');
console.log(summary);
console.log('---- end ----');

assert(summary.includes('批注场景总数：1'), '摘要包含总数');
assert(summary.includes('场景感受覆盖：1/1'), '摘要统计场景感受');
assert(summary.includes('动作线设计覆盖：1/1'), '摘要统计动作线');
assert(summary.includes('压力铺垫'), '摘要包含结构节点');

// ============================================================
// TEST 10: 空场景（无批注）降级
// ============================================================
section('TEST 10：空批注降级处理');

const emptyAnnoData = {
  scene_feel: '无讲戏·占位',
  emotion_flow: { start: '起', trigger: '中', end: '止' },
  audience_takeaway: '无',
  structure_node: '无',
  action_thread: [{ character: '张玄', task: '无道具任务·依赖第二层情绪驱动肢体', source: '无' }],
  action_thread_turning_point: '无',
  annotations: {
    A1: { status: 'pending' },
    A2: { status: 'pending' },
    A3: { status: 'pending' },
    D1: { status: 'pending' },
    D2: { status: 'pending' },
    D3: { status: 'pending' },
  },
};
const emptyAssembled = assembleAnnotationV7(mockScene, items, emptyAnnoData);
const pendingCount = (emptyAssembled.match(/【待补充】/g) || []).length;
assert(pendingCount === 6, `6 条 pending 全部输出【待补充】·实际 ${pendingCount}`);

// ============================================================
// 总结
// ============================================================
console.log('\n' + '='.repeat(60));
console.log(`测试总数：${passCount + failCount}  通过：${passCount}  失败：${failCount}`);
console.log('='.repeat(60));

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('\n✅ 全部通过·引擎可用');
  process.exit(0);
}
