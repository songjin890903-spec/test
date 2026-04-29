const fs = require('fs');

const text1 = fs.readFileSync('C:/Users/Administrator/Downloads/杀猪宴.txt', 'utf-8');
const text2 = fs.readFileSync('C:/Users/Administrator/Downloads/11-1.txt', 'utf-8');

function parseScript(text) {
  const scenes = [];
  const copyMatch = text.match(/===复制区开始===([\s\S]*?)===复制区结束===/);
  const workText = copyMatch ? copyMatch[1].trim() : text;
  const episodeMatch = workText.match(/【批注剧本】(.+)/);
  const episodeInfo = episodeMatch ? episodeMatch[1].trim() : '本集';
  const normalized = workText
    .replace(/[─━—\-═]{8,}/g, '\n<<<SEP>>>\n')
    .replace(/\*{8,}/g, '\n<<<SEP>>>\n');
  const rawParts = normalized.split('<<<SEP>>>');

  const sceneHeaderRe = /(?:^|\n)\s*(?:\*{0,3})(?:场景\S+|第\S+[场幕]|\d+[-–]\d+)/;
  const parts = [];
  for (let i = 0; i < rawParts.length; i++) {
    const t = rawParts[i].trim();
    if (!t) continue;
    const nonEmptyLines = t.split('\n').filter(l => l.trim()).length;
    if (sceneHeaderRe.test(t) && nonEmptyLines <= 5) {
      let j = i + 1;
      while (j < rawParts.length && !rawParts[j].trim()) j++;
      if (j < rawParts.length) {
        parts.push(t + '\n\n' + rawParts[j].trim());
        i = j;
      } else {
        parts.push(t);
      }
    } else {
      parts.push(t);
    }
  }

  let currentEpisode = '01';
  const stripMd = (s) => s.replace(/^\*{1,3}\s*|\s*\*{1,3}$/gm, '').replace(/^#{1,6}\s*/gm, '');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const ep = { v: '01' }; // skip episode detection for test
    if (ep.v) currentEpisode = ep.v;
    const stripped = stripMd(trimmed);

    // 用 matchAll 匹配所有场景
    const sceneMatches = [];
    for (const m of stripped.matchAll(/^\s*(?:场景(\S+)|(\d+[-–]\d+[A-Za-z]?)|第(\S+)[场幕]|【([^】]{1,20})】)\s+([^\n]*)/gm)) {
      let sceneId = m[1] || m[2] || m[3] || m[4];
      let fullHeader = (m[5] || '').trim().replace(/\*+/g, '');
      if (!sceneId || (m[4] && !/\d/.test(m[4]))) continue;
      sceneMatches.push({ sceneId, fullHeader, index: m.index });
    }

    if (sceneMatches.length === 0) continue;

    for (let si = 0; si < sceneMatches.length; si++) {
      const { sceneId, fullHeader, index } = sceneMatches[si];
      const nextIndex = si + 1 < sceneMatches.length ? sceneMatches[si + 1].index : trimmed.length;
      const sceneContent = trimmed.slice(index, nextIndex).trim();
      scenes.push({ id: sceneId, header: fullHeader, chars: sceneContent.length });
    }
  }
  return scenes;
}

console.log('=== 杀猪宴.txt ===');
const r1 = parseScript(text1);
console.log('场景数:', r1.length);
r1.forEach(s => console.log(' ', s.id, '-', s.header));

console.log('\n=== 11-1.txt ===');
const r2 = parseScript(text2);
console.log('场景数:', r2.length);
r2.forEach(s => console.log(' ', s.id, '-', s.header));
