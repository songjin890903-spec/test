const https = require('https');

const apiKey = 'sk-cp-Vtobjz2YtCCgFyJNF4aB6BYqeRhltkqHM1VClGRQsdLT1kBAcXTCWqrP6NHZkfGnu8IwfVkmfopb72rBHOoK9Q0QuqoIjIjzGlt3wK_xHWs7FZT6hZ1tkqo';

const body = {
    model: "MiniMax-M2.7",
    max_completion_tokens: 1500,
    messages: [
        { role: "system", content: "你是一个JSON生成器，只输出JSON，不要其他文字。" },
        { role: "user", content: "为以下台词生成JSON批注：\n赵一铭：怎么会这样...\n（导演讲戏：【镜头意图】必须捕捉：赵一铭喃喃自语，眼神失焦】【人物内心】无力与接受现实 → 声音轻如耳语·头低下，肩膀垮塌）" }
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
        console.log('=== MiniMax 返回 ===');
        console.log('finish_reason:', result.choices[0].finish_reason);
        console.log('content:', result.choices[0].message.content);
        console.log('\n=== 过滤后 ===');
        let content = result.choices[0].message.content;
        content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
        content = content.replace(/<\/think>/gi, '');
        content = content.replace(/<think>/gi, '');
        console.log(content);
    });
});

req.on('error', (e) => console.error('Error:', e.message));
req.write(data);
req.end();
