// 测试 MiniMax token 限制
const https = require('https');

const apiKey = 'sk-cp-Vtobjz2YtCCgFyJNF4aB6BYqeRhltkqHM1VClGRQsdLT1kBAcXTCWqrP6NHZkfGnu8IwfVkmfopb72rBHOoK9Q0QuqoIjIjzGlt3wK_xHWs7FZT6hZ1tkqo';

// 模拟实际批注 prompt（更长）
const systemPrompt = '你是一个专业的剧本批注引擎。';

const userPrompt = `你是剧本批注 JSON 引擎。你不复制剧本原文，不复制讲戏文本，只产出 JSON 批注数据。

场景信息：
· 场景编号：11-1
· 场景标题：张家祖宅
· 人物列表：张玄、范思瑶、赵一铭、张雨晴、刀哥、打手*N、刘秘书

═══ 本场条目清单（共 27 条，需逐条给出批注或状态）═══
[D1] 台词·赵一铭：怎么会这样...
[D2] 台词·范思瑶：这...这是传说中的丧尸末日？
[D3] 台词·张玄（微笑，伸展双臂）：诸位，欢迎来到新时代。

═══ 严格 JSON 输出契约 ═══
1. 从 { 开始·到 } 结束。不要任何代码块标记。
2. 你必须为 **每一个 ID** 都在 annotations 里给出条目。
3. 顶层字段必填：scene_feel, emotion_flow, audience_takeaway, structure_node, action_thread, action_thread_turning_point
4. annotations 字段：以 ID 为键，如 "D1": { "status": "annotated", ... }`;

// 测试不同 token 限制
[512, 1024, 2048, 4096].forEach(tokens => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`测试 max_completion_tokens = ${tokens}`);
    console.log('='.repeat(50));
    
    const body = {
        model: "MiniMax-M2.7",
        max_completion_tokens: tokens,
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
            const content = result.choices[0].message.content;
            const finishReason = result.choices[0].finish_reason;
            
            console.log('finish_reason:', finishReason);
            console.log('原始长度:', content.length);
            
            // 过滤思维链
            let clean = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
            clean = clean.replace(/```json|```/g, '');
            
            // 检查是否是有效 JSON
            try {
                const parsed = JSON.parse(clean.trim());
                console.log('✓ JSON 有效');
                console.log('scene_feel:', parsed.scene_feel ? '有' : '无');
                console.log('annotations count:', Object.keys(parsed.annotations || {}).length);
            } catch (e) {
                console.log('✗ JSON 无效:', e.message);
                console.log('前200字符:', clean.trim().substring(0, 200));
            }
        });
    });
    
    req.on('error', (e) => console.error('Error:', e.message));
    req.write(data);
    req.end();
});
