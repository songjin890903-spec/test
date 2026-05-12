// 直接测试 enrichSegmentShots 完整流程
const { enrichSegmentShots, buildBatchEnrichPrompt } = require('./lib/structuredC.js');
const { parseScript } = require('./lib/parser.js');
const fs = require('fs');

// 读取测试剧本
const scriptText = fs.readFileSync('C:/Users/Administrator/Downloads/杀猪宴.txt', 'utf8');
console.log('剧本长度:', scriptText.length);

// 模拟 config
const config = {
  apiKey: 'sk-1a5aa3376fb04902a286b15d1ea9330a',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxTokens: 16384,
  baseUrl: 'https://api.deepseek.com/v1'
};

// 模拟 scene, segment, parsed
const scene = {
  id: '0',
  sceneType: 'dialogue',
  title: '杀猪宴开场',
  cast: ['角色A', '角色B']
};

const segment = {
  id: '0-0A',
  dialogueIds: [0, 1],
  startTime: 0,
  endTime: 15
};

const parsed = {
  shots: [
    {
      no: 1,
      task: '角色A拿起酒杯',
      visual: '角色A从桌面拿起一个玻璃杯',
      speakerAction: '',
      listenerReaction: '',
      physicalFeedback: '',
      sound: '',
      dialogueLines: [{ speaker: '角色A', line: '今天这酒不错' }]
    },
    {
      no: 2,
      task: '角色B回应',
      visual: '角色B站在窗前',
      speakerAction: '',
      listenerReaction: '',
      physicalFeedback: '',
      sound: '',
      dialogueLines: [{ speaker: '角色B', line: '是啊，难得聚一次' }]
    }
  ]
};

const costumeCard = '角色A：中年男性，穿深色夹克\n角色B：年轻女性，穿白色连衣裙';

console.log('\n=== 开始测试 enrichSegmentShots ===');
console.log('segment:', segment.id);
console.log('shots:', parsed.shots.length);

enrichSegmentShots({ scene, segment, parsed, costumeCard, config })
  .then(result => {
    console.log('\n✅ 完成！');
    console.log('结果 shots:');
    result.shots.forEach((s, i) => {
      console.log(`  Shot ${s.no}:`);
      console.log(`    visual: ${s.visual ? '✅' : '❌'}`);
      console.log(`    speakerAction: ${s.speakerAction || '空'}`);
      console.log(`    listenerReaction: ${s.listenerReaction || '空'}`);
      console.log(`    physicalFeedback: ${s.physicalFeedback || '空'}`);
      console.log(`    sound: ${s.sound || '空'}`);
    });
  })
  .catch(err => {
    console.error('\n❌ 失败:', err.message);
  });
