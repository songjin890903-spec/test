try {
  require('./lib/structuredC.js');
  console.log('模块加载成功');
} catch(e) {
  console.error('模块加载失败:', e.message);
  process.exit(1);
}
