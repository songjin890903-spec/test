function buildSourceLedger(scene) {
  const lines = [];
  lines.push('【来源账本·强制边界】');
  lines.push('来源等级：');
  lines.push('L1[原文]：剧本明确写出的动作、台词、地点、人物、屏幕画面，必须原样优先执行。');
  lines.push('L2[AGENT_A]：场景感受、动作线、人物内心、镜头意图和禁止项，只能解释原文，不得改写事实。');
  lines.push('L3[AGENT_B]：角色、服装、场景、物件、画面物理系统，作为视觉资产边界。');
  lines.push('L4[自然表演补充]：允许补充演员可拍反应，如视线、停顿、靠近/后退半步、手部停住、手机举起/放下、衣袖被攥紧；不得改变剧情事件。');
  lines.push('禁止来源：新增地点、新角色、新灾难奇观、新世界观设定、新台词、新情节结果。');
  lines.push('');
  lines.push('【本场L1原文事实】');
  if (scene.cast && scene.cast.length) lines.push(`人物：[原文] ${scene.cast.join('、')}`);
  lines.push(`地点：[原文] ${scene.header || scene.id}`);
  for (const a of scene.actions) lines.push(`${a.id} [原文动作] ${a.text}`);
  for (const d of scene.dialogues) lines.push(`${d.id} [原文台词] ${d.speaker}${d.state ? '（' + d.state + '）' : ''}：${d.text}`);

  const screenActions = scene.actions.filter(a => /手机|屏幕|短视频|抖音|视频界面|界面/.test(a.text));
  const zombieScreenActions = scene.actions.filter(a => /丧尸|大街|商场|马路|车窗|追尾/.test(a.text));
  if (screenActions.length || zombieScreenActions.length) {
    lines.push('');
    lines.push('【屏幕层/现实层分离·强制】');
    lines.push('现实层只能是张家祖宅院内的人物反应、手机物件、地面、院墙/廊柱等现实空间。');
    lines.push('屏幕层只存在于刀哥或赵一铭的手机屏幕内，短视频画面不得溢出到现实院落。');
    lines.push('屏幕层允许的画面仅限以下原文动作：');
    for (const a of zombieScreenActions) lines.push(`${a.id} [屏幕层原文] ${a.text}`);
  }

  lines.push('');
  lines.push('【禁扩清单·强制】');
  lines.push('禁止扩展城市燃烧、天空异象、绿云、军队崩溃、丧尸冲进祖宅、张玄审判者/教主化、末日仪式、权力交接、非原文灾难大场面。');
  return lines.join('\n');
}

module.exports = { buildSourceLedger };
