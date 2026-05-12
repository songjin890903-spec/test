// 最小复现：只测 enrichLog 调用
function enrichLog(msg) {
  console.log(msg);
}
async function test() {
  const segment = { id: '0-0A' };
  const parsed = {};
  enrichLog('[BatchEnrich] 函数被调用，segment=' + (segment?.id || '') + '，parsed存在=' + (!!parsed));
}
test().then(() => console.log('OK')).catch(e => console.error(e.message));
