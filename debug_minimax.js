const fs = require('fs');
const src = fs.readFileSync('server.js', 'utf8');
const idx = src.indexOf('MiniMax finish_reason');
console.log('=== MiniMax logging section ===');
console.log(src.slice(idx, idx + 300));
console.log('\n=== MiniMax API URL logging ===');
const urlIdx = src.indexOf('MiniMax API URL');
console.log(src.slice(urlIdx, urlIdx + 100));
