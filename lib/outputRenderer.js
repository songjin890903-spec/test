function stripInternalDialogueTags(text) {
  let s = String(text || '');
  s = s.replace(/台词\s*\[D\d{3,}(?:-\d+)?\]\s*/g, '');
  s = s.replace(/\n【F】台词覆盖：[\s\S]*?(?=\n---\n|\n@[^\n]+\n\s*【片段|\s*$)/g, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
function renderCleanCOutput(internalText) { return stripInternalDialogueTags(internalText); }
module.exports = { renderCleanCOutput, stripInternalDialogueTags };
