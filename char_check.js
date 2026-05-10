const fs = require('fs');
const sc = fs.readFileSync('D:/AI/project/test/lib/structuredC.js', 'utf8');

// 检查 enrichLog 定义的位置
const enrichLogIdx = sc.indexOf('function enrichLog');
const enrichSegIdx = sc.indexOf('async function enrichSegmentShots');
console.log('function enrichLog 位置:', enrichLogIdx);
console.log('async function enrichSegmentShots 位置:', enrichSegIdx);

// 检查两者之间是否有语法问题
const between = sc.substring(enrichLogIdx, enrichSegIdx);
console.log('\n=== enrichLog到enrichSegmentShots之间 ===');
console.log('内容长度:', between.length);
console.log('内容:', JSON.stringify(between));

// 关键：检查这个区间是否有意外的 }
const closingBraces = (between.match(/\}/g) || []).length;
const openingBraces = (between.match(/\{/g) || []).length;
console.log('\n区间内花括号: 开{' + openingBraces + '} 闭' + closingBraces);

// 最重要: 把 enrichLog + enrichSegmentShots 的前300字符写出来
console.log('\n=== enrichLog区域前200字符 ===');
console.log(JSON.stringify(sc.substring(enrichLogIdx, enrichLogIdx + 200)));

// 检查文件是否有 BOM
const bom = sc.charCodeAt(0);
console.log('\n文件第一个字符代码:', bom, '(应该是102=f，如果正确)');
