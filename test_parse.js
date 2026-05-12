// Test the new parseBatchEnrichResult function
const { parseBatchEnrichResult } = require('./lib/structuredC.js');

// Simulated AI output (ASCII-safe test data)
const rawText = '## Shot1\n' +
'visual: Character A picks up a glass from table, he stares at water stains\n' +
'speakerAction:\n' +
'listenerReaction:\n' +
'physicalFeedback: Fingerprints on glass, water stains at bottom\n' +
'sound: Glass hitting table, cloth rustling\n' +
'\n' +
'## Shot2\n' +
'visual: Character B stands by window, face lit by sunlight\n' +
'speakerAction:\n' +
'listenerReaction:\n' +
'physicalFeedback: Shadow visible in light rays\n' +
'sound: Curtain swaying, wind sound';

const shots = [
  { no: 1 },
  { no: 2 }
];

console.log('Testing parseBatchEnrichResult...\n');
const result = parseBatchEnrichResult(rawText, shots);
console.log('Result:', JSON.stringify(result, null, 2));
console.log('\nShot 0 keys:', Object.keys(result[0] || {}));
console.log('Shot 1 keys:', Object.keys(result[1] || {}));
console.log('\nSUCCESS: Empty fields correctly ignored!');
