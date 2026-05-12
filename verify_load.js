try {
  require('D:/AI/project/test/lib/structuredC.js');
  console.log('OK: structuredC.js 加载成功');
} catch(e) {
  console.log('ERROR: ' + e.message);
  console.log('lineNumber: ' + e.lineNumber);
  console.log('columnNumber: ' + e.columnNumber);
  if (e.lineNumber) {
    const fs = require('fs');
    const lines = fs.readFileSync('D:/AI/project/test/lib/structuredC.js', 'utf8').split('\n');
    for (let i = Math.max(0, e.lineNumber - 4); i <= Math.min(lines.length - 1, e.lineNumber + 2); i++) {
      console.log('file[' + (i+1) + ']: ' + JSON.stringify(lines[i]));
    }
  }
}
