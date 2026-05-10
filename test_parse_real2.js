// 用日志里的真实AI返回测试 parseBatchEnrichResult
const { parseBatchEnrichResult } = require('./lib/structuredC.js');

const rawText = `## 镜1
visual: 角色A右手从桌面拿起一个透明玻璃杯，指尖捏住杯底边缘，杯底在木质桌面上拖出一声轻响
speakerAction: 拇指在杯壁上来回摩擦两下
listenerReaction: 角色B转身看向角色A，肩膀靠向窗框
physicalFeedback: 杯底在桌面上留下一圈圆形水渍
sound: 玻璃杯底摩擦木桌的沉闷刮擦声

## 镜2
visual: 角色B背对窗户站立，左手肘搭在窗台上，右手自然垂在身侧，窗帘边缘在身后轻微晃动
speakerAction: （无动作）
listenerReaction: （无听话人）
physicalFeedback: 窗帘边缘轻微摆动，在角色B背上投下条纹光影
sound: 窗外传来远处车辆驶过的低鸣声，在句尾渐弱`;

const shots = [
  { no: 1, visual: '', physicalFeedback: '', sound: '', speakerAction: '', listenerReaction: '' },
  { no: 2, visual: '', physicalFeedback: '', sound: '', speakerAction: '', listenerReaction: '' }
];

console.log('=== 测试 parseBatchEnrichResult ===');
const result = parseBatchEnrichResult(rawText, shots);
console.log('解析结果:');
console.log(JSON.stringify(result, null, 2));

console.log('\n=== 逐字段检查 ===');
for (const [key, val] of Object.entries(result)) {
  console.log(`  镜${key}: visual=${val.visual ? '✓' : '✗'}, speakerAction=${val.speakerAction ? '✓' : '✗'}, listenerReaction=${val.listenerReaction ? '✓' : '✗'}, physicalFeedback=${val.physicalFeedback ? '✓' : '✗'}, sound=${val.sound ? '✓' : '✗'}`);
}
