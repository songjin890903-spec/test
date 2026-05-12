// Debug parseBatchEnrichResult regex
var fieldNames = ['visual', 'speakerAction', 'listenerReaction', 'physicalFeedback', 'sound'];

// Simulated AI output
var rawText = '## Shot1\n' +
'visual: Character A picks up a glass from the table\n' +
'speakerAction:\n' +
'listenerReaction:\n' +
'physicalFeedback: Fingerprints on glass, water stains at bottom\n' +
'sound: Glass hitting table, cloth rustling\n' +
'\n' +
'## Shot2\n' +
'visual: Character B stands by window, face lit by sunlight';

console.log('=== Test regex matching ===\n');

for (var i = 0; i < fieldNames.length; i++) {
  var field = fieldNames[i];
  // Regex from parseBatchEnrichResult
  var regex = new RegExp(field + '\\s*[=:]\s*([\\s\\S]+?)(?=\\n(?:##?\\s*)?Shot\\s*\\d+|\\n\\s*\\[|\\s*```|$)', 'i');
  console.log('Field: ' + field);
  var match = rawText.match(regex);
  console.log('Match: ' + (match ? '"' + (match[1] ? match[1].substring(0, 30) : 'EMPTY') + '"' : 'null'));
  console.log();
}

console.log('=== Test sections split ===');
var clean = rawText.trim();
var sections = clean.split(/(?=\n(?:##?\s*)?Shot\s*\d+)/gm);
console.log('Section count: ' + sections.length);
for (var j = 0; j < sections.length; j++) {
  console.log('Section ' + j + ': ' + sections[j].substring(0, 80));
}
