// 直接测试 stripMarkdown 函数
function stripMarkdown(text) {
  return text
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^---+\s*$/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/think>/gi, '');

}

const test = '<think>测试内容</think>\n═══════════';
console.log('输入:', JSON.stringify(test));
console.log('输出:', JSON.stringify(stripMarkdown(test)));
console.log('包含<think>:', stripMarkdown(test).includes('<think>'));
