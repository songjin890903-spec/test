// 测试字符类 [/t] 的行为
const str = '<think>测试内容</think>';

// 错误regex: [/?] 是字符类，匹配 / 或 t
const r1 = /<[/?]think>/;
console.log('r1 matches 开标签:', r1.test('<think>'));
console.log('r1 matches 闭标签:', r1.test('</think>'));

// 正确regex: <\/think>
const r2 = /<\/think>/;
console.log('r2 matches 闭标签:', r2.test('</think>'));

// 测试完整替换
const result = str
  .replace(/<think>/gi, '')   // remove opening tags
  .replace(/<\/think>/gi, ''); // remove closing tags
console.log('\n替换结果:', JSON.stringify(result));
console.log('包含<think>:', result.includes('<think>'));
console.log('包含</think>:', result.includes('</think>'));
