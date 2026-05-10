// 端到端测试：parseBatchEnrichResult → injectEnrichment
const { parseBatchEnrichResult, injectEnrichment } = require('./lib/structuredC.js');

const rawText = `## 镜1
visual: 张玄手指收紧手机边缘，指节因用力而泛白，屏幕光照亮他下颌的明暗分界线
speakerAction: 喉结上下滚动一次，舌尖顶一下后槽牙
listenerReaction: 范思瑶目光从手机屏幕移到张玄侧脸，眉头微不可察地皱了一下
physicalFeedback: 汗珠从张玄鬓角滑下，在鼻翼侧面反光；手机壳边缘有细碎汗渍
sound: 手机听筒忙音"嘟—嘟—"每声0.5秒，空调低沉嗡鸣声填充满房间

## 镜2
visual: 范思瑶背对窗户站立，左手无名指在裤缝处轻轻敲击，眼神直视前方
speakerAction: 嘴角微微上扬又压下，舌尖顶一下腮帮
listenerReaction: 张玄视线从范思瑶背影移到自己手机屏幕
physicalFeedback: 窗帘边缘在范思瑶背上投下条纹光影，随窗外风轻微摆动
sound: 窗外远处传来汽车驶过潮湿路面的低鸣，在句尾渐弱`;

// 模拟 parsed.shots（已有部分内容，模拟真实场景）
const parsed = {
  shots: [
    {
      no: 1,
      visual: '张玄打电话',          // 原有内容空洞
      speakerAction: '',
      listenerReaction: '',
      physicalFeedback: '',
      sound: ''
    },
    {
      no: 2,
      visual: '范思瑶站着',          // 原有内容空洞
      speakerAction: '',
      listenerReaction: '',
      physicalFeedback: '',
      sound: ''
    }
  ]
};

console.log('=== 解析 AI 返回 ===');
const enrichmentMap = parseBatchEnrichResult(rawText, parsed.shots);
console.log('enrichmentMap keys:', Object.keys(enrichmentMap));
for (const [k, v] of Object.entries(enrichmentMap)) {
  console.log(`  镜${k}:`, JSON.stringify(v));
}

console.log('\n=== 注入 ===');
const result = injectEnrichment(parsed, enrichmentMap);
for (const shot of result.shots) {
  console.log(`\n镜${shot.no}:`);
  console.log('  visual:', shot.visual);
  console.log('  speakerAction:', shot.speakerAction);
  console.log('  listenerReaction:', shot.listenerReaction);
  console.log('  physicalFeedback:', shot.physicalFeedback);
  console.log('  sound:', shot.sound);
}
