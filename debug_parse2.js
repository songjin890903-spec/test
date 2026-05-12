// Test with actual log format
var fieldNames = ['visual', 'speakerAction', 'listenerReaction', 'physicalFeedback', 'sound'];

// Actual AI output from debug_enrich.log
var rawText = '## \u955c1\n' +
'visual: \u89d2\u8272A\u4ece\u684c\u9762\u62ac\u8d77\u4e00\u4e2a\u73bb\u7483\u676f\uff0c\u676f\u5e95\u5728\u6728\u684c\u4e0a\u53d1\u51fa\u8f7b\u54cd\uff0c\u4ed6\u盯着\u676f\u4e2d\u6b8b\u7559\u7684\u6c34\u6cfe\uff0c\u89c6\u7ebf\u7f13\u6162\u62ac\u8d77\u626b\u89c6\u623f\u95f4\n' +
'speakerAction:\n' +
'listenerReaction:\n' +
'physicalFeedback: \u6307\u819c\u5728\u676f\u58f3\u7559\u4e0b\u6a21\u7cca\u7684\u6307\u7eb9\uff0c\u6c34\u6cfe\u5728\u676f\u5e95\u805a\u6210\u4e00\u5c0f\u6c40\n' +
'sound: \u73bb\u7483\u676f\u5e95\u63a5\u89e6\u684c\u9762\u7684\u6e05\u8106\u649e\u51fb\u58f0\uff0c\u968f\u540e\u662f\u8863\u6599\u78c5\u64c5\u7684\u8386\u8386\u58f0\n' +
'\n' +
'## \u955c2\n' +
'visual: \u89d2\u8272B\u7ad9\u5728\u7a97\u524d\uff0c\u4fa7\u8138\u88ab\u7a97\u5916';

console.log('=== Original regex test ===\n');
for (var i = 0; i < fieldNames.length; i++) {
  var field = fieldNames[i];
  var regex = new RegExp(field + '\\s*[=:]\s*([\\s\\S]+?)(?=\\n(?:##?\\s*)?\\u955c\\s*\\d+|\\n\\s*\\[|\\s*```|$)', 'i');
  var match = rawText.match(regex);
  console.log('Field [' + field + ']:');
  console.log('  Match: ' + (match ? '"' + match[1].substring(0, 40) + '"' : 'null'));
  if (match && match[1]) {
    var val = match[1].trim().replace(/^[""''"\u201C\u201D]+|[""''"\u201C\u201D]+$/g, '');
    console.log('  After trim: "' + val.substring(0, 40) + '"');
    console.log('  Length: ' + val.length);
    console.log('  Pass filter (val && len>1): ' + (!!val && val.length > 1));
  }
}

console.log('\n=== Fixed regex test (require non-empty after colon) ===\n');
for (var i = 0; i < fieldNames.length; i++) {
  var field = fieldNames[i];
  // Fixed: require at least one non-whitespace char after colon
  var regex = new RegExp(field + '\\s*[=:]\s*([^\n]+?)(?=\\n(?:##?\\s*)?\\u955c\\s*\\d+|\\n\\s*\\[|\\s*```|$)', 'i');
  var match = rawText.match(regex);
  console.log('Field [' + field + ']:');
  console.log('  Match: ' + (match ? '"' + match[1].substring(0, 40) + '"' : 'null'));
}
