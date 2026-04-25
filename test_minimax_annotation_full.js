// 完整批注测试
const https = require('https');

const apiKey = 'sk-cp-Vtobjz2YtCCgFyJNF4aB6BYqeRhltkqHM1VClGRQsdLT1kBAcXTCWqrP6NHZkfGnu8IwfVkmfopb72rBHOoK9Q0QuqoIjIjzGlt3wK_xHWs7FZT6hZ1tkqo';

// 简化的批注 prompt（模拟实际的 prompt）
const systemPrompt = '你是一个专业的剧本批注引擎。你必须严格输出 JSON，不输出任何其他文字。';

const userPrompt = `你是剧本批注 JSON 引擎。你不复制剧本原文，不复制讲戏文本，只产出 JSON 批注数据。

场景信息：
· 场景编号：11-1
· 场景标题：张家祖宅
· 人物列表：张玄、范思瑶、赵一铭、张雨晴、刀哥、打手*N、刘秘书

═══ 本场条目清单（共 3 条，需逐条给出批注或状态）═══
[D1] 台词·赵一铭：怎么会这样...
[D2] 台词·范思瑶：这...这是传说中的丧尸末日？
[D3] 台词·张玄（微笑，伸展双臂）：诸位，欢迎来到新时代。

═══ 严格 JSON 输出契约 ═══
1. 从 { 开始·到 } 结束。不要任何代码块标记（不写 \`\`\`json）。不要任何解释文字。
2. 你必须为 **每一个 ID** 都在 annotations 里给出条目。
3. 顶层字段必填：
   · scene_feel: 一句话整体情绪任务
   · emotion_flow: { "start": "...", "trigger": "...", "end": "..." }
   · audience_takeaway: 观众带走的情绪/问题
   · structure_node: 结构节点类型
   · action_thread: 数组
   · action_thread_turning_point: 情绪拐点说明
4. annotations 字段：以 ID 为键，如 "D1": { "status": "annotated", ... }

═══ 标准输出示例═══
{
  "scene_feel": "旧世界崩塌，主角宣告新时代",
  "emotion_flow": { "start": "崩溃", "trigger": "丧尸末日确认", "end": "主角宣告" },
  "audience_takeaway": "爽感与好奇",
  "structure_node": "压力铺垫·第一层",
  "action_thread": [
    { "character": "赵一铭", "task": "打电话求助", "source": "剧本原文" },
    { "character": "张玄", "task": "观察赵一铭", "source": "剧本原文" }
  ],
  "action_thread_turning_point": "D1 赵一铭崩溃",
  "annotations": {
    "D1": { "status": "annotated", "intent_capture": ["赵一铭喃喃自语，眼神失焦"], "inner": { "mental": "无力与接受现实", "body": ["声音轻如耳语", "头低下，肩膀垮塌"] } },
    "D2": { "status": "annotated", "intent_capture": ["范思瑶环视周围，声音带颤"], "inner": { "mental": "恐惧但试图理解", "body": ["手抱臂，身体微抖"] } },
    "D3": { "status": "annotated", "intent_capture": ["张玄微笑特写，伸展双臂"], "inner": { "mental": "掌控与宣告主权", "body": ["手臂展开缓慢而稳"] } }
  }
}`;

const body = {
    model: "MiniMax-M2.7",
    max_completion_tokens: 2000,
    messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
    ]
};

const data = JSON.stringify(body);

const options = {
    hostname: 'api.minimaxi.com',
    port: 443,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
    }
};

const req = https.request(options, (res) => {
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
        const result = JSON.parse(rawData);
        console.log('=== MiniMax 返回原始内容 ===');
        let content = result.choices[0].message.content;
        console.log(content);
        console.log('\n=== 过滤后 ===');

        // 过滤思维链
        content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
        content = content.replace(/<\/think>/gi, '');
        content = content.replace(/<think>/gi, '');
        content = content.replace(/```json|```/g, '');
        console.log(content.trim());

        // 尝试解析 JSON
        console.log('\n=== 解析结果 ===');
        try {
            const parsed = JSON.parse(content.trim());
            console.log('✓ JSON 解析成功');
            console.log('scene_feel:', parsed.scene_feel);
            console.log('annotations keys:', Object.keys(parsed.annotations || {}));
        } catch (e) {
            console.log('✗ JSON 解析失败:', e.message);
        }
    });
});

req.on('error', (e) => console.error('Error:', e.message));
req.write(data);
req.end();
