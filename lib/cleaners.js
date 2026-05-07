function stripProcessLeak(text) {
  let s = String(text || '');
  const leakMarkers = [
    '我统计剧本原文', '我认为可以', '因此重新判断', '最终【台词清单】如下',
    '为了符合', '重新写完整输出', '注意：台词清单', '修正后正式台词',
    '原D001：', '全集汇总：', '最终【台词清单·交接AGENT_C用】如下'
  ];
  const lines = s.split(/\r?\n/);
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    if (leakMarkers.some(m => line.includes(m))) { dropping = true; continue; }
    if (dropping && (/^═{8,}/.test(line.trim()) || line.includes('【台词清单·交接AGENT_C用】') || line.includes('【批注摘要】'))) dropping = false;
    if (!dropping) kept.push(line);
  }
  return kept.join('\n').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim();
}

function cleanAgentAForC(output, parserHandoff = '') {
  let s = stripProcessLeak(output);
  const marker = '【台词清单·交接AGENT_C用】';
  const idx = s.indexOf(marker);
  if (idx >= 0) s = s.slice(0, idx).trim();
  if (parserHandoff) s = (s + '\n\n' + parserHandoff).trim();
  return s;
}

function extractBlockByTitle(text, title) {
  const s = String(text || '');
  const idx = s.indexOf(title);
  if (idx < 0) return '';
  const rest = s.slice(idx);
  const tail = rest.slice(title.length);
  const m = tail.search(/\n(?:#{1,3}\s*)?【[^\n】]+】|\n-{3,}|\n={6,}/);
  return (m >= 0 ? rest.slice(0, title.length + m) : rest).trim();
}

function cleanAgentBForC(output) {
  const s = String(output || '');
  let picture = extractBlockByTitle(s, '【画面物理系统】');
  if (!picture) {
    const m = s.match(/【画面物理系统(?:｜A_FULL|\|A_FULL|·A_FULL)?】[\s\S]*?(?=\n【[^\n】]+】|\n##|\n#|$)/);
    if (m) picture = m[0].trim();
  }
  const cleanMarker = '【给AGENT_C的干净资产卡】';
  const idx = s.indexOf(cleanMarker);
  const cleanCard = idx >= 0 ? s.slice(idx).trim() : '';
  const parts = [];
  if (picture) {
    parts.push('【C.A画面物理系统·权威母版】');
    parts.push('以下内容只用于 C 的【A】画面物理系统；不得混入站位、画幅、镜头偏好或人物调度。');
    parts.push(picture);
  }
  if (cleanCard) parts.push(cleanCard);
  if (parts.length) return parts.join('\n\n').trim();
  let fallback = s;
  fallback = fallback.replace(/【外貌锁定】[\s\S]*?(?=\n【表演基线】|\n【服装|\n【漂移|\n【角色词条】|$)/g, '【外貌基线】\n（未提供参考图；C仅使用低风险外观基线，不采用过细五官。）\n');
  fallback = fallback.replace(/身高[^，。\n]*[，。]?/g, '');
  fallback = fallback.replace(/M型发际线|纹身|花臂|军靴|钥匙串|顶级商务车|具体车型|枪/g, '');
  return fallback.trim();
}

module.exports = { cleanAgentAForC, cleanAgentBForC, stripProcessLeak };
