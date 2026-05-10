// 检查 structuredC.js 是否有隐藏换行符
const fs = require('fs');
const buf = fs.readFileSync('D:/AI/project/test/lib/structuredC.js');
const text = buf.toString('utf8');
const lines = text.split('\n');
console.log('总行数(按LF分割):', lines.length);

for (let i = 1720; i <= 1726; i++) {
  const line = lines[i-1];
  console.log('行' + i + ' (len=' + line.length + '):', JSON.stringify(line.substring(0, 80)));
  if (line.includes('\r')) {
    console.log('  ^^ 包含CR字符');
  }
}

const line1723 = lines[1722];
if (line1723.includes('\n')) {
  console.log('!!! 行1723包含嵌入式LF');
  const parts = line1723.split('\n');
  console.log('  第1部分:', JSON.stringify(parts[0]));
  console.log('  第2部分:', JSON.stringify(parts[1]));
}
