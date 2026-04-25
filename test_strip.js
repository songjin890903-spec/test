// 验证两种正则写法
const test = '<think>开开始\n内容\n</think>\n═══════════\n正文开始</think>\n结束';

// 正确写法: (?:/)? 分组 + 正确闭标签
// 开标签: <(?:/)?think> → 匹配 <think> 或不匹配/的 <think>  (不匹配 </think>)
const r2open = /<(?:[/])?think>/;  // 错误

// 闭标签: <\/(?:think)> → 只匹配 </think>
const r2close = /<\/(?:think)>/;

// 最简单正确的完整regex: 分别匹配开和闭标签
// 开标签只需要 <think>
const rOpen = /<think>/;
const rClose = /<\/think>/;
console.log('rOpen match <think>:', rOpen.test('<think>'));
console.log('rClose match </think>:', rClose.test('</think>'));

// 完整替换
const result = test
  .replace(/<think>[\s\S]*?<\/think>/gi, '')  // 先移除所有开+闭标签对
  .replace(/\n{3,}/g, '\n\n');
console.log('\n结果:', JSON.stringify(result));
console.log('首行:', JSON.stringify(result.split('\n')[0]));
console.log('包含<think>:', result.includes('<think>'));
