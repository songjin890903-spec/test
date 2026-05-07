function cleanSpeakerName(s) {
  return String(s || '').replace(/[（）]/g, '').replace(/OS$/i, '').replace(/VO/i, '').trim() || '画外音';
}

function inferDramaFunction(d) {
  const t = `${d.speaker || ''}${d.state || ''}${d.text || ''}`;
  if (/赵氏财团|专线|24小时|怎么会/.test(t)) return '身份防御：用手机和财团身份撑住旧权力';
  if (/打错/.test(t)) return '试探质疑：用合理解释戳破说话者强撑';
  if (/怎么可能|傻子|这种电话/.test(t)) return '压迫反驳：用攻击把质疑压回去';
  if (/没关系|别的电话|另一个号码/.test(t)) return '转场续拨：把失败强行接到下一次证明';
  if (/不太好使/.test(t)) return '权力嘲讽：旁观者刺破身份有效性';
  if (/我爹|私人电话|一定能打通/.test(t)) return '最后底牌：用父亲私人电话重建控制感';
  if (/喂，大少爷/.test(t)) return '接通回弹：旧秩序短暂给出回应';
  if (/赶紧把电话给我爹|急事/.test(t)) return '命令旧秩序：接通后立刻恢复少爷口吻';
  if (/董事长他/.test(t)) return '迟滞铺垫：现实荒诞到说不出口';
  if (/我爹他怎么了/.test(t)) return '不安求证：最后权力支点被逼问';
  if (/成丧尸/.test(t)) return '反转消息：父亲和财团秩序直接坍塌';
  if (/荒唐|开什么玩笑|拍电影/.test(t)) return '否认现实：把无法接受的消息推远';
  if (/没开玩笑|安全地方|世界乱套/.test(t)) return '生存警告：放弃解释，只传递逃命信息';
  if (/真的有丧尸/.test(t)) return '证据公开：个人手机变成公共证据';
  if (/怎么会这样/.test(t)) return '现实崩塌：证据压碎强撑底气';
  if (/丧尸末日/.test(t)) return '末日命名：用旧概念给新现实命名';
  if (/欢迎来到新时代/.test(t)) return '解释权接管：后景人物接管全场意义';
  if (d.channel === 'vo' || d.channel === 'os') return '画外/电话信息：声音改变画面中听者状态';
  return '关系推进：台词必须改变现场关系';
}

function inferCausalityBeat(d) {
  const speaker = cleanSpeakerName(d.speaker);
  const t = `${d.state || ''}${d.text || ''}`;
  if (/赵一铭/.test(speaker)) {
    if (/赵氏财团|专线|无人接听/.test(t)) return '状态：手机无人接听让身份外壳第一次裂开；动作：确认失败提示后把手机握回胸前；台词：用赵氏财团身份撑住场面；作用：范思瑶刚要开口被压回去，视线落回手机。';
    if (/怎么可能/.test(t)) return '状态：赵一铭不允许“打错”成立；动作：手机屏幕闯进两人之间；台词：短促反压；作用：范思瑶视线先被屏幕挡住，脚下退半步。';
    if (/傻子|这种电话/.test(t)) return '状态：赵一铭用攻击遮住慌乱；动作：手机收回胸前但不低头拨号；台词：盯住范思瑶反问；作用：范思瑶解释动作停住，话收回去。';
    if (/没关系|别的电话|另一个号码/.test(t)) return '状态：上次失败被强行转成下一次证明；动作：低头划开通讯录；台词：把失败接到下一通电话；作用：拇指按下拨号键，场面转入下一次等待。';
    if (/我爹|一定能打通/.test(t)) return '状态：赵一铭抓住最后底牌；动作：拇指停在父亲私人号码上；台词：抬头重新撑底气；作用：张玄不接话，只看他按下拨号键。';
    if (/赶紧|急事/.test(t)) return '状态：接通让赵一铭短暂恢复少爷秩序；动作：身体前压，手机压紧耳边；台词：立刻下命令；作用：电话那头迟迟不回应，他抬起的气势卡住。';
    if (/怎么了/.test(t)) return '状态：父亲成为最后支点；动作：手机贴得更紧；台词：追问父亲情况；作用：范思瑶和刀哥的动作同时停住。';
    if (/荒唐|拍电影/.test(t)) return '状态：现实太荒诞，赵一铭用否认自保；动作：手机从耳边滑开半寸；台词：把消息当玩笑顶回去；作用：范思瑶和刀哥不接话，注意力压在手机上。';
    if (/怎么会这样/.test(t)) return '状态：短视频把电话里的荒诞变成证据；动作：看着刀哥手机屏幕；台词：底气断掉；作用：他没有去捡脚边那部失效手机。';
  }
  if (/范思瑶/.test(speaker)) return '状态：她看见赵一铭底气裂开；动作：先看手机再看人；台词：小心试探或命名现实；作用：对方反压或张玄获得接管入口。';
  if (/张玄/.test(speaker)) {
    if (/欢迎/.test(t)) return '状态：众人已被证据夺走旧解释；动作：等视线从手机转到自己，再从院门一侧站稳；台词：平静接管解释权；作用：刀哥手机停在半空，赵一铭不再说话。';
    return '状态：张玄不抢话，等赵一铭自己失势；动作：院门一侧不靠近；台词：冷刺身份失效；作用：赵一铭低头回到手机寻找下一张底牌。';
  }
  if (/刀哥/.test(speaker)) return '状态：个人手机发现外部证据；动作：先看清短视频再举给众人；台词：公开证据；作用：众人视线从赵一铭地上手机转到刀哥手机。';
  if (/刘秘书|VO|画外音|旁白/.test(speaker) || d.channel === 'vo') return '状态：电话声把外部现实压进院子；动作：画面拍听者和手机；台词：电话声进入；作用：听者手、手机或站位发生可见变化。';
  return '状态：先明确人物正在维持什么；动作：一个具体准备动作；台词：原文；作用：听者或物件发生一个可见变化。';
}

function inferListeners(scene, d) {
  const speaker = cleanSpeakerName(d.speaker);
  const cast = (scene.cast || []).filter(Boolean);
  let listeners = cast.filter(c => !speaker.includes(c) && !c.includes('刘秘书')).slice(0, 3);
  if (!listeners.length) listeners = ['赵一铭','范思瑶','张玄','刀哥'].filter(c => !speaker.includes(c));
  return listeners;
}

function listenerBeatFor(name, d) {
  const text = `${d.text || ''}${d.state || ''}`;
  if (/范思瑶/.test(name)) {
    if (/打错|傻子|怎么可能/.test(text)) return '话到嘴边停住，脚下后退半步或视线被手机压回去。';
    if (/丧尸|世界乱套/.test(text)) return '手抬到一半停住，身体向后收半步。';
    return '先看物件，再看说话者，动作收住。';
  }
  if (/刀哥/.test(name)) {
    if (/丧尸|世界乱套|没开玩笑/.test(text)) return '低头看自己的手机，拇指停在屏幕边缘。';
    return '手里的手机停在胸前，抬头确认局面。';
  }
  if (/张玄/.test(name)) return '保持后景旁观，视线从物件转到说话者，不抢话。';
  if (/赵一铭/.test(name)) {
    if (/丧尸|世界乱套/.test(text)) return '手机从耳边放下，手臂失力但不夸张。';
    return '用手机动作遮住不安，视线回到屏幕。';
  }
  return '动作停住或视线落到关键物件。';
}

function buildPerformancePlan(scene) {
  const lines = [];
  lines.push('【表演因果层计划】');
  lines.push('先判断每句台词的戏剧功能，再写镜头。每个重要台词镜头必须形成：说话者状态 → 原台词 → 作用对象 → 可见变化。不是多写动作，而是让台词改变现场关系。');
  lines.push('前景/后景不是装饰：赵一铭手机是身份外壳，手机屏幕可压迫范思瑶；地面手机是失败锚点；刀哥手机是公共证据；院门/门框让张玄后景压场并最后接管解释权。');
  for (const d of scene.dialogues) {
    const listeners = inferListeners(scene, d);
    lines.push(`${d.id} ${d.speaker}${d.state ? '（' + d.state + '）' : ''}：“${d.text}”`);
    lines.push(`  戏剧功能：${inferDramaFunction(d)}`);
    lines.push(`  表演因果：${inferCausalityBeat(d)}`);
    lines.push(`  主要听者：${listeners.join('、') || '画面中主要听者'}`);
    for (const l of listeners.slice(0, 2)) lines.push(`  ${l}落点：${listenerBeatFor(l, d)}`);
  }
  return lines.join('\n');
}

module.exports = { buildPerformancePlan, inferDramaFunction, inferCausalityBeat };
