// 修复 structuredC.js 中的问题字符串
const fs = require('fs');
const path = 'D:/AI/project/test/lib/structuredC.js';
let content = fs.readFileSync(path, 'utf8');

console.log('修复前检查...');
const lines = content.split('\n');
console.log('第1717行:', JSON.stringify(lines[1716]));
console.log('第1723行:', JSON.stringify(lines[1722]));

// 检查是否有问题字符串
if (lines[1716].indexOf("msg + '") >= 0) {
  console.log('找到 msg + 问题');
}

// 最关键：检查整个enrichLog函数
const enrichLogStart = content.indexOf('function enrichLog');
const enrichLogEnd = content.indexOf('async function enrichSegmentShots');
console.log('\nenrichLog函数区域:');
console.log(content.substring(enrichLogStart, enrichLogStart + 300));
console.log('\n检查完成，文件写入...');
fs.writeFileSync(path, content, 'utf8');
