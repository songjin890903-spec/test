const http = require('http');

const scriptText = require('fs').readFileSync('C:/Users/Administrator/Downloads/11-1.txt', 'utf8');

const postData = JSON.stringify({
  scriptText: scriptText,
  scenes: [],
  config: {
    apiKey: 'sk-1a5aa3376fb04902a286b15d1ea9330a',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    maxTokens: 8192
  }
});

const options = {
  hostname: 'localhost',
  port: 3006,
  path: '/api/process',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log('发送请求到 /api/process...');
const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('状态码:', res.statusCode);
    console.log('响应:', data);

    try {
      const result = JSON.parse(data);
      if (result.jobId) {
        console.log('\n轮询 job 结果...');
        let attempts = 0;
        const poll = setInterval(() => {
          attempts++;
          const getReq = http.get(`http://localhost:3006/api/results/${result.jobId}`, (getRes) => {
            let getData = '';
            getRes.on('data', chunk => getData += chunk);
            getRes.on('end', () => {
              try {
                const jobResult = JSON.parse(getData);
                console.log(`[${attempts}s] 状态: ${jobResult.status}`);
                if (jobResult.error) {
                  console.log('错误:', jobResult.error);
                  if (jobResult.errorStack) {
                    console.log('堆栈:', jobResult.errorStack);
                  }
                }
                if (jobResult.results && jobResult.results.length > 0) {
                  console.log('结果数量:', jobResult.results.length);
                  console.log('第一条:', jobResult.results[0].sceneId);
                }
                if (jobResult.status === 'done' || jobResult.status === 'error' || attempts > 30) {
                  clearInterval(poll);
                  console.log('\n最终结果:', JSON.stringify(jobResult, null, 2));
                }
              } catch (e) {
                console.log('解析结果失败:', e.message);
                clearInterval(poll);
              }
            });
          });
          getReq.on('error', (e) => {
            console.error('获取结果失败:', e.message);
            clearInterval(poll);
          });
        }, 1000);
      }
    } catch (e) {
      console.error('解析失败:', e.message);
    }
  });
});

req.on('error', (e) => console.error('请求失败:', e.message));
req.write(postData);
req.end();
