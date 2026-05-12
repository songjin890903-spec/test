const { allocateSegments } = require('./parser');

function splitDialogueIntoParts(d) {
  const text = String(d.text || '').trim();
  if (!text) return [];
  const duration = Number(d.duration || 0);
  const isShortSystemVo = (d.channel === 'vo' || /VO|旁白|画外音/.test(String(d.speaker || ''))) && /无人接听|忙音|系统/.test(text) && Array.from(text).length <= 18;
  if (duration <= 3 || isShortSystemVo) return [{ id: d.id, text, mode: '单镜号可承载' }];
  let parts = text.split(/(?<=[，。！？、；…]|\.\.\.)/).map(x => x.trim()).filter(Boolean);
  const targetParts = duration > 8 ? 3 : 2;
  if (parts.length < targetParts) {
    parts = [];
    const chars = Array.from(text);
    const size = Math.ceil(chars.length / targetParts);
    for (let i = 0; i < chars.length; i += size) parts.push(chars.slice(i, i + size).join(''));
  }
  if (parts.length > targetParts) {
    const buckets = Array.from({ length: targetParts }, () => '');
    parts.forEach((p, i) => { buckets[Math.min(targetParts - 1, i % targetParts)] += p; });
    parts = buckets.filter(Boolean);
  }
  return parts.map((p, i) => ({
    id: `${d.id}-${i + 1}`,
    text: p,
    mode: i === 0 ? '起始镜号' : (duration > 8 && i >= 1 ? '必须声画分离/反打/听者反应' : '切镜/反打/听者反应')
  }));
}

function shotForPart(part, index, total, d) {
  const mmByTask = { space: 35, phone: 100, speaker: 85, listener: 50, reaction: 85, relation: 50, floor: 100, screen: 85 };
  const isVo = d.channel === 'vo' || d.channel === 'os' || /VO|旁白|画外音/.test(d.speaker || '');
  if (index === 0 && isVo) return { task: `${part.id} 声音信息进入，物件/听筒或手机先承载`, shot: '手机/听筒特写', motion: '声音进入并改变持机状态', focal: mmByTask.phone, composition: '手机/听筒/手部为主，听者可在边缘或下一镜反应' };
  if (index === 0) return { task: `${part.id} 说话者起句，先给组织动作和台词目的`, shot: '中近景/近景', motion: '贴肩推进或手持轻推', focal: mmByTask.speaker, composition: '说话者实焦，听者肩线/身体在前景或后景' };
  if (/声画分离/.test(part.mode)) return { task: `${part.id} 声画分离，拍听者/物件/空间反应承载声音`, shot: '过肩/反打/中景', motion: '横移到听者或后撤给关系', focal: mmByTask.listener, composition: '听者实焦，非说话者有可见大动作' };
  return { task: `${part.id} 切镜承载台词后半，给听者反应或INSERT`, shot: '听者反应/物件前景/关系中景', motion: '台词作用后的可见变化', focal: index % 2 ? mmByTask.listener : mmByTask.phone, composition: '声音与反应同时存在，避免单人念完' };
}

function buildShotPlan(scene) {
  const segments = allocateSegments(scene);
  const lines = [];
  lines.push('【镜头任务表·C执行蓝图】');
  lines.push('强制原则：先执行镜头任务，再写运镜。不要用“滑到/滑回”串场。每个镜号必须有任务、焦段理由、演员互动。');
  for (const seg of segments) {
    const ds = seg.dialogueIds.map(id => scene.dialogues.find(d => d.id === id)).filter(Boolean);
    lines.push(`片段${seg.id}：`);
    lines.push('  镜1：空间/关系建立；35mm或50mm；让说话者与主要听者都在场，非说话者有基线动作。');
    let shotIndex = 2;
    for (const d of ds) {
      const parts = splitDialogueIntoParts(d);
      parts.forEach((part, i) => {
        const plan = shotForPart(part, i, parts.length, d);
        lines.push(`  镜${shotIndex++}：${plan.task}；${plan.shot}；${plan.motion}；建议焦段${plan.focal}mm；构图：${plan.composition}`);
      });
    }
    lines.push(`  末镜：本片段情绪余震/接棒；50mm或85mm；关系落点或接棒动作；必须给下片段接棒物：手机/屏幕/地上手机/张玄站位。`);
    lines.push('  运镜配比：本片段至少包含物件前景、听者动作中断、证据公开、后景压场、关系落点中的4类；滑动结构最多2次。');
  }
  return lines.join('\n');
}

module.exports = { buildShotPlan };
