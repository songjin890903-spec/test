// Test with simplified format (same structure as actual log)
var fieldNames = ['visual', 'speakerAction', 'listenerReaction', 'physicalFeedback', 'sound'];

var rawText = '## Shot1\n' +
'visual: Character A picks up a glass from table\n' +
'speakerAction:\n' +
'listenerReaction:\n' +
'physicalFeedback: Fingerprints on glass, water stains at bottom\n' +
'sound: Glass hitting table, cloth rustling\n' +
'\n' +
'## Shot2\n' +
'visual: Character B stands by window, face lit by sunlight';

console.log('=== Problem: empty field matches everything ===\n');
for (var i = 0; i < fieldNames.length; i++) {
  var field = fieldNames[i];
  // Original regex
  var regex = new RegExp(field + '\\s*[=:]\s*([\\s\\S]+?)(?=\\nShot\\s*\\d+|\\n\\s*\\[|\\s*```|$)', 'i');
  var match = rawText.match(regex);
  console.log('Field [' + field + ']: "' + (match ? match[1].substring(0, 30) : 'null') + '"');
}

console.log('\n=== Fix: require non-whitespace after colon ===\n');
for (var i = 0; i < fieldNames.length; i++) {
  var field = fieldNames[i];
  // Fixed regex: use [^\n]+ instead of [\s\S]+? to avoid matching empty field
  var regex = new RegExp(field + '\\s*[=:]\s*([^\n]+?)(?=\\nShot\\s*\\d+|\\n\\s*\\[|\\s*```|$)', 'i');
  var match = rawText.match(regex);
  console.log('Field [' + field + ']: "' + (match ? match[1].substring(0, 30) : 'null') + '"');
}
