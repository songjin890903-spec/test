/**
 * 测试 3006 项目的 structuredC API 端点
 */
const http = require('http');

const TEST_SCRIPT = `场景1-1 日 内 废弃工厂
赵一铭：（VO）这是专线电话。
范思瑶：打错了？
张玄：新时代来了。

场景1-2 日 外 废弃工厂外
赵一铭：确认位置。
范思瑶：我看到信号了。
张玄：准备行动。`;

const CONFIG = {
  apiKey: process.env.DEEPSEEK_KEY || 'sk-your-api-key',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  maxTokens: 16384
};

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.path || '/', `http://${options.hostname}:${options.port || 3006}`);
    const reqOptions = {
      hostname: options.hostname || 'localhost',
      port: options.port || 3006,
      path: options.path || '/',
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function testStructuredC() {
  console.log('=== 测试 3006 structuredC API ===\n');

  // 1. 创建任务
  console.log('1. 创建 structuredC 任务...');
  const body = JSON.stringify({
    scriptText: TEST_SCRIPT,
    costumeCard: '',
    config: CONFIG,
    options: {
      visualStyle: 'plain'
    }
  });

  try {
    const res = await httpRequest({
      hostname: 'localhost',
      port: 3006,
      path: '/api/structured-c',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, body);

    if (res.status !== 200) {
      console.log(`   ❌ 创建失败: ${JSON.stringify(res.data)}`);
      return;
    }

    console.log(`   ✅ 任务已创建: ${res.data.jobId}`);
    const jobId = res.data.jobId;

    // 2. 轮询结果
    console.log('\n2. 轮询结果...');
    let maxWait = 60; // 最多等60秒
    for (let i = 0; i < maxWait; i++) {
      await new Promise(r => setTimeout(r, 1000));
      process.stdout.write(`\r   等待 ${i + 1}s...`);

      const pollRes = await httpRequest({
        hostname: 'localhost',
        port: 3006,
        path: `/api/structured-c/${jobId}/result`,
        method: 'GET'
      });

      if (pollRes.data.status === 'done') {
        console.log('\n\n   ✅ 任务完成！');
        console.log('\n=== 输出预览 ===');
        if (pollRes.data.result?.agentC?.output) {
          console.log(pollRes.data.result.agentC.output.substring(0, 2000));
          console.log('\n...(内容已截断)...');
        } else {
          console.log(JSON.stringify(pollRes.data.result, null, 2));
        }
        return;
      }
      if (pollRes.data.status === 'error') {
        console.log(`\n\n   ❌ 任务失败: ${pollRes.data.error}`);
        return;
      }
    }
    console.log('\n   ⏰ 超时');
  } catch (err) {
    console.error('   ❌ 请求失败:', err.message);
  }
}

testStructuredC();
