const fs = require('fs');
const code = fs.readFileSync('D:/AI/project/test/server.js', 'utf8');
const lines = code.split('\n');

// Find the VO regex line
for (let i = 380; i < 430; i++) {
  const line = lines[i];
  if (line.includes('isVOOrSimilar') || line.includes('extractDialogues')) {
    console.log(`Line ${i+1}: ${line}`);
    // Check for colon characters in the regex
    const colonMatch = line.match(/\[([^\]]+)\]/g);
    if (colonMatch) {
      colonMatch.forEach(m => {
        const bytes = Buffer.from(m);
        console.log(`  char class: ${m}  hex: ${bytes.toString('hex')}`);
      });
    }
  }
}

// Also test the regex
const line406 = lines[405];
console.log('\nTesting regex on VO lines:');
const regex1 = /^(?:（VO）|（旁白）|（画外音）|（OS）)[：:]/;
const regex2 = /^\(?\s*VO\s*\)?\s*[：:]/;

const testLines = [
  '（VO）：您拨打的电话暂时无人接听。',
  '（VO）：喂，大少爷？',
  '刘秘书（VO）：喂，大少爷？',
];

testLines.forEach(t => {
  const r1 = regex1.test(t);
  const r2 = regex2.test(t);
  console.log(`  "${t}" => regex1:${r1} regex2:${r2}`);
});
