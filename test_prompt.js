const { buildBatchEnrichPrompt } = require('./lib/structuredC.js');

const prompt = buildBatchEnrichPrompt({
  scene: {
    id: '0-0A',
    header: '测试场景',
    cast: ['张玄', '范思瑶']
  },
  segment: {
    id: '0-0A',
    title: '开场',
    reason: '建立紧张氛围'
  },
  parsed: {
    shots: [
      {
        no: 1,
        shotSize: '中景',
        lens: '50mm',
        duration: '3s',
        movement: '静止',
        task: '张玄打电话',
        dialogueLines: [{ speaker: '张玄', text: '喂', state: '紧张' }],
        actionTexts: [],
        visual: '',
        physicalFeedback: '',
        sound: ''
      },
      {
        no: 2,
        shotSize: '特写',
        lens: '100mm',
        duration: '2s',
        movement: '推进',
        task: '范思瑶反应',
        dialogueLines: [],
        actionTexts: ['范思瑶皱眉'],
        visual: '',
        physicalFeedback: '',
        sound: ''
      }
    ],
    visualStyle: 'plain',
    sceneFeeling: '紧张'
  },
  costumeCard: '',
  prevSegmentEnd: ''
});

console.log('=== PROMPT START ===');
console.log(prompt);
console.log('=== PROMPT END ===');
console.log('长度=' + prompt.length);
