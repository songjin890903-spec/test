// 清除模块缓存后重新测试
delete require.cache[require.resolve('D:/AI/project/test/lib/structuredC.js')];

try {
  const mod = require('D:/AI/project/test/lib/structuredC.js');
  console.log('OK: structuredC.js 加载成功, enrichSegmentShots:', typeof mod.enrichSegmentShots);
} catch(e) {
  console.log('ERROR: ' + e.message);
  console.log('stack:', e.stack ? e.stack.split('\n').slice(0,5).join('\n') : 'none');
}
