// 直接测试 parseBatchEnrichResult 为什么没解析到 speakerAction 等字段

// 模拟 AI 的实际输出（从日志中复制）
const rawText = `## 镜1
visual: 角色A右手从桌面拿起一个透明玻璃杯，指尖捏住杯底边缘，杯底在木质桌面上拖出一声轻响
speakerAction: 拇指在杯壁上来回摩擦两下
listenerReaction: 角色B转身看向角色A，肩膀靠向窗框
physicalFeedback: 杯底在桌面上留下一圈圆形水渍
sound: 玻璃杯底摩擦木桌的沉闷刮擦声

## 镜2
visual: 角色B背对窗户站立，左手肘搭在窗台上，右手自然垂在身侧，窗帘边缘在身后轻微晃动
speakerAction:
listenerReaction:
physicalFeedback: 窗帘布料在气流中轻轻摆动，窗框阴影切割在角色B的背上
sound: 窗外传来远处车辆驶过的低鸣声，在句尾渐弱`;

const fieldNames = ['visual', 'speakerAction', 'listenerReaction', 'physicalFeedback', 'sound'];

console.log('=== 调试 parseBatchEnrichResult ===\n');

// 模拟 parseBatchEnrichResult 的逻辑
const clean = rawText.replace(/^```(?:json)?\s*/gim, '').replace(/\s*```$/gim, '').trim();
const sections = clean.split(/(?=\n(?:##?\s*)?(?:Shot|镜)\s*\d+)/gm);

console.log('Sections count:', sections.length);
sections.forEach((s, i) => {
  console.log(`\n--- Section ${i} ---`);
  console.log(s.substring(0, 80));
});

// 详细调试第一个 section
const section = sections[1] || sections[0];  // 跳过可能的空 section
console.log('\n=== 详细解析第一个 section ===');
console.log('Section 内容:');
console.log(section);

const lines = section.split('\n');
console.log('\n按行解析:');
lines.forEach((line, idx) => {
  const colonIdx = line.indexOf(':');
  if (colonIdx < 0) {
    console.log(`  Line ${idx}: 无冒号，跳过`);
    return;
  }
  
  const key = line.substring(0, colonIdx).trim().toLowerCase();
  const value = line.substring(colonIdx + 1).trim();
  
  const isField = fieldNames.includes(key);
  console.log(`  Line ${idx}: key="${key}", value="${value.substring(0, 20)}...", isField=${isField}, valueEmpty=${!value}`);
});
