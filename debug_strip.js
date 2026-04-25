// 直接测试 API 响应的思维链标签剥离
async function test() {
  const res = await fetch('https://api.minimaxi.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-cp-Vtobjz2YtCCgFyJNF4aB6BYqeRhltkqHM1VClGRQsdLT1kBAcXTCWqrP6NHZkfGnu8IwfVkmfopb72rBHOoK9Q0QuqoIjIjzGlt3wK_xHWs7FZT6hZ1tkqo' },
    body: JSON.stringify({
      model: 'MiniMax-M2.7',
      max_completion_tokens: 200,
      messages: [{ role: 'user', content: '用一句话描述末日丧尸爆发剧本的核心看点' }]
    })
  });
  const data = await res.json();
  const raw = data.choices[0].message.content;
  console.log('原始前50字符:', JSON.stringify(raw.slice(0, 50)));
  console.log('原始包含<think>:', raw.includes('<think>'));

  // 测试剥离
  const stripped = raw.replace(/<think>/gi, '').replace(/<\/think>/gi, '').trim();
  console.log('剥离后前50字符:', JSON.stringify(stripped.slice(0, 50)));
  console.log('剥离后包含<think>:', stripped.includes('<think>'));
}
test().catch(e => console.error(e));
