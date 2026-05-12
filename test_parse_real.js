// 独立测试 parseBatchEnrichResult
const fieldNames = ['visual', 'speakerAction', 'listenerReaction', 'physicalFeedback', 'sound'];

function parseBatchEnrichResult(rawText, shots) {
  if (!rawText || !shots || !shots.length) return {};
  const result = {};

  const clean = rawText
    .replace(/^```(?:json)?\s*/gim, '')
    .replace(/\s*```$/gim, '')
    .trim();

  const sections = clean.split(/(?=\n(?:##?\s*)?(?:Shot|镜)\s*\d+)/gm);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const headerMatch = trimmed.match(/^(?:##?\s*)?(?:Shot|镜)\s*(\d+)/i);
    if (!headerMatch) continue;

    const shotIdx = parseInt(headerMatch[1], 10) - 1;
    if (shotIdx < 0 || shotIdx >= shots.length) continue;

    const data = {};
    const lines = trimmed.split('\n');

    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;

      const key = line.substring(0, colonIdx).trim().toLowerCase();
      const value = line.substring(colonIdx + 1).trim();

      if (fieldNames.includes(key) && value && value.length > 0) {
        const invalidVals = ['空', '无', '无特殊', '暂无', '不适用', '无特殊反应', '无特殊动作'];
        if (!invalidVals.includes(value)) {
          data[key] = value;
        }
      }
    }

    if (Object.keys(data).length > 0) {
      result[shotIdx] = Object.assign({}, result[shotIdx], data);
    }
  }
  return result;
}

// 日志中的真实 AI 输出
const rawText = '## 镜1\n' +
'visual: 角色A从桌面拿起一个玻璃杯，杯底在木桌上发出轻响，他盯着杯中残留的水渍，视线缓慢抬起扫视房间\n' +
'speakerAction:\n' +
'listenerReaction:\n' +
'physicalFeedback: 指腹在杯壁留下模糊的指纹，水渍在杯底聚成一小滩\n' +
'sound: 玻璃杯底接触桌面的清脆撞击声，随后是衣料摩擦的沙沙声\n' +
'\n' +
'## 镜2\n' +
'visual: 角色B站在窗前，侧脸被窗外的光照亮\n' +
'speakerAction:\n' +
'listenerReaction:\n' +
'physicalFeedback: 背影在光线中显得柔和\n' +
'sound: 窗帘裁动的轮轮声音';

const shots = [{ no: 1 }, { no: 2 }];

console.log('=== Test with real AI output ===\n');
const result = parseBatchEnrichResult(rawText, shots);
console.log('Result:', JSON.stringify(result, null, 2));
console.log('\nShot 0 keys:', Object.keys(result[0] || {}));
console.log('Shot 1 keys:', Object.keys(result[1] || {}));
