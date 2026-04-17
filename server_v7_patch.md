# server.js 改造说明（v7）

本文件告诉你 server.js 里哪些地方改、怎么改。
**不整体重写 server.js**——那个文件 2853 行，整体重写风险极高。
我用"定位 → 替换"的方式给你精确补丁。

强烈建议：开工前先 `git checkout -b v7-migration` 或者打个 tag。

---

## 改动总览

共 **8 处改动**，全部在 server.js 里：

| 编号 | 位置（大致行号） | 类型 | 说明 |
|---|---|---|---|
| 1 | 顶部 require 区 | 新增 | require('./annotation_v7') |
| 2 | `buildSystemPrompt` 函数内 | 替换 | 加载 v7 的 wenxi/core 文件 |
| 3 | `callAPI` 里 DeepSeek 分支 | 新增 | 支持 `response_format: json_object` 参数 |
| 4 | `CONCURRENCY` 常量 | 替换 | 从 4 改成 6 |
| 5 | `writeAndVerifySegment` 函数 | 替换 | 字数 Cascade 压缩 |
| 6 | `/api/agent-a/annotate` 路由整体 | **完全替换** | v7 JSON 引擎 |
| 7 | `/api/reload-prompts` 路由 | 替换 | 清除 v7 缓存 |
| 8 | 启动日志 | 替换 | 标注 v7 |

---

## 改动 1：顶部 require 新增

**位置**：文件最顶部，在 `const express = require('express');` 之后（约第 1-6 行）

**操作**：在第 6 行 `const path = require('path');` 后面**新增一行**：

```javascript
const annotationV7 = require('./annotation_v7');
```

---

## 改动 2：`buildSystemPrompt` 函数改用 v7 prompt 文件

**定位**：搜索函数名 `function buildSystemPrompt(sceneType)`（约第 134 行）

**原代码**（整个函数）：

```javascript
function buildSystemPrompt(sceneType) {
  const core = loadPrompt('core.txt');
  if (sceneType === 'wuxi') return core + '\n\n' + loadPrompt('wuxi.txt');
  // wenxi 或 mixed（含混合场景）都只加载 wenxi——
  // 混合场景按文戏规则写整个片段，武戏动作当作"大幅度的情绪驱动肢体"来处理
  return core + '\n\n' + loadPrompt('wenxi.txt');
}
```

**替换为**：

```javascript
function buildSystemPrompt(sceneType, options = {}) {
  // v7 用 core_v7.txt + wenxi_core_v7.txt（范例独立加载）
  const core = loadPrompt('core_v7.txt');
  if (sceneType === 'wuxi') return core + '\n\n' + loadPrompt('wuxi_v7.txt');

  // 文戏/混合：默认只加载 wenxi_core_v7（不含范例）
  let prompt = core + '\n\n' + loadPrompt('wenxi_core_v7.txt');

  // 按需注入对应范例（命中一个就加，不加载全部）
  if (options.sceneContent) {
    const examples = loadPrompt('wenxi_examples_v7.txt');
    const content = options.sceneContent;

    // 场景类型判断 → 加载对应单个范例
    const exampleRanges = [];
    if (/吃饭|饮酒|围坐|酒桌|吃面/.test(content)) {
      exampleRanges.push(['▌文戏写法范例一', '▌文戏写法范例二']);
    }
    if (/擦刀|擦剑|擦枪|整理|修|刻|削苹果/.test(content)) {
      exampleRanges.push(['▌文戏写法范例二', '▌文戏写法范例三']);
    }
    // 一对多（人物列表 ≥3 且有台词）
    if (options.dialogueCount >= 3 && options.characterCount >= 3) {
      exampleRanges.push(['▌文戏写法范例三', '▌文戏写法范例四']);
    }
    // 一对一（人物列表 = 2 且有多轮对话）
    if (options.dialogueCount >= 4 && options.characterCount === 2) {
      exampleRanges.push(['▌文戏写法范例四', '▌文戏写法范例五']);
    }
    // 独白
    if (options.hasLongOS) {
      exampleRanges.push(['▌文戏写法范例五', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n▌写戏方法论']);
    }

    if (exampleRanges.length > 0) {
      let injected = '\n\n━━━ 按需注入的范例 ━━━\n';
      for (const [startMark, endMark] of exampleRanges.slice(0, 1)) { // 最多注入 1 个范例，避免 prompt 膨胀
        const si = examples.indexOf(startMark);
        const ei = examples.indexOf(endMark, si + 1);
        if (si >= 0 && ei > si) {
          injected += examples.substring(si, ei) + '\n';
        }
      }
      prompt += injected;
    }
  }

  return prompt;
}
```

然后搜索所有调用 `buildSystemPrompt(` 的地方（约 5-6 处），改用新签名：

| 原调用 | 改为 |
|---|---|
| `buildSystemPrompt(scene.sceneType)` | `buildSystemPrompt(scene.sceneType, { sceneContent: scene.content, dialogueCount: dialogues.length, characterCount: scene.characters.length, hasLongOS: /OS[：:]/.test(scene.content) && scene.content.length > 400 })` |
| `buildSystemPrompt(seg.sceneType)` | `buildSystemPrompt(seg.sceneType, { sceneContent: scene.content, dialogueCount: dialogues.length, characterCount: scene.characters.length, hasLongOS: /OS[：:]/.test(scene.content) && scene.content.length > 400 })` |

---

## 改动 3：`callAPI` 支持 JSON mode

**定位**：搜索 `apiType === 'anthropic'` 找到整个 callAPI 函数（约第 456 行起）

**操作**：在 DeepSeek 分支（约第 591 行）找到 body JSON 构造：

**原代码**（约第 594-600 行）：

```javascript
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'deepseek-chat',
          max_tokens: 8192,
          messages: [{ role: 'system', content: systemPrompt }, ...messages]
        })
      });
```

**替换为**：

```javascript
      const bodyObj = {
        model: model || 'deepseek-chat',
        max_tokens: 8192,
        messages: [{ role: 'system', content: systemPrompt }, ...messages]
      };
      // v7 JSON mode：config.jsonMode=true 时启用·DeepSeek 原生支持
      if (config.jsonMode) {
        bodyObj.response_format = { type: 'json_object' };
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(bodyObj)
      });
```

同样的改动**也要在 anthropic 和 gemini 分支里加**（保险起见，虽然你主用 DeepSeek）：

Anthropic 分支：JSON mode 通过 tool_use 实现，或在 system prompt 里强约束（当前设计不改，config.jsonMode 对 anthropic 不生效即可）。

Gemini 分支：在 `generationConfig` 里加 `responseMimeType: 'application/json'`。找到约第 547 行：

```javascript
generationConfig: { maxOutputTokens: 8192 }
```

改为：

```javascript
generationConfig: Object.assign(
  { maxOutputTokens: 8192 },
  config.jsonMode ? { responseMimeType: 'application/json' } : {}
)
```

**打印 DeepSeek 缓存命中**（可选但强烈建议）：在 DeepSeek 分支 `const data = await res.json();` 后面加一行：

```javascript
if (data.usage?.prompt_cache_hit_tokens) {
  console.log(`   💾 缓存命中 ${data.usage.prompt_cache_hit_tokens} tokens（总 ${data.usage.prompt_tokens}）`);
}
```

这样你就能在日志里直接看到缓存是否命中。

---

## 改动 4：并发数从 4 提到 6

**定位**：搜索 `const CONCURRENCY = 4`（有 3 处：约第 1819、2582、2670 行）

**全部替换为**：

```javascript
const CONCURRENCY = 6;
```

理由：DeepSeek 官方文档明确"不限速率"，并发 6 是安全值。

---

## 改动 5：`writeAndVerifySegment` 字数 Cascade

**定位**：搜索 `// 字数检查 + 自动压缩重写`（约第 1528 行）

**原代码**（约第 1528-1555 行）：整段 `if (charCount > 1800) { ... compressPrompt ... }`

**替换为**：

```javascript
    // ─── v7 字数 Cascade：先砍 F → 再砍 D → 最后才去 API 压缩 ───
    let charCount = segOutput.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;
    if (charCount > 1800) {
      console.warn(`⚠️ ${seg.id} 字数 ${charCount}·启动 Cascade 压缩...`);

      // 第一级：regex 砍 F（必现目标）——0 API 调用
      const afterCutF = segOutput.replace(/【F】必现目标[：:]?[^【]*?(?=\n【|$)/, '').trim();
      const c1 = afterCutF.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;

      if (c1 <= 1800) {
        segOutput = afterCutF;
        charCount = c1;
        console.log(`✓ ${seg.id} Cascade 级1·砍 F 后 ${c1} 字`);
      } else {
        // 第二级：再砍 D（尾帧）——0 API 调用
        const afterCutDF = afterCutF.replace(/【D】尾帧[：:]?[^【]*?(?=\n【|$)/, '').trim();
        const c2 = afterCutDF.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;

        if (c2 <= 1800) {
          segOutput = afterCutDF;
          charCount = c2;
          console.log(`✓ ${seg.id} Cascade 级2·砍 D+F 后 ${c2} 字`);
        } else {
          // 第三级：API 压缩 C 修辞（最后手段·+1 次调用）
          console.warn(`⚠️ ${seg.id} 级2 后仍 ${c2} 字·API 压缩 C...`);
          try {
            const compressPrompt =
              `以下片段字数 ${c2}·超 1800·请只压缩 C 部分的形容词和修辞·不得删除任何镜号、台词、（）物理反馈。D 和 F 已经被砍过·不用再碰。\n\n原片段：\n${afterCutDF}\n\n直接输出压缩后的完整片段。`;
            const compressed = await callAPI(effectiveSystemPrompt, compressPrompt, config);
            const c3 = compressed.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;
            if (c3 < c2 && c3 <= 2000) {
              segOutput = compressed;
              charCount = c3;
              console.log(`✓ ${seg.id} 级3·API 压缩后 ${c3} 字`);
            } else {
              segOutput = afterCutDF;
              charCount = c2;
              console.warn(`⚠️ ${seg.id} API 压缩无效·保留级2（${c2} 字）`);
            }
          } catch (err) {
            segOutput = afterCutDF;
            charCount = c2;
            console.warn(`⚠️ ${seg.id} API 压缩失败·保留级2: ${err.message}`);
          }
        }
      }
    } else {
      console.log(`✓ ${seg.id} 字数 ${charCount}·合格`);
    }
```

---

## 改动 6：`/api/agent-a/annotate` 路由整体替换（最大的改动）

**定位**：搜索 `app.post('/api/agent-a/annotate'` （约第 2545 行）

**整个路由函数替换为下面的代码**（从 `app.post('/api/agent-a/annotate'` 开始，到匹配的 `});`——约第 2789 行结束）：

```javascript
app.post('/api/agent-a/annotate', async (req, res) => {
  const { scriptText, soulCard, config, mode, mappedSegments } = req.body;
  if (!config?.apiKey) return res.status(400).json({ error: '请填写 API Key' });
  if (!scriptText?.trim()) return res.status(400).json({ error: '缺少剧本内容' });

  const isDirectorMode = mode === 'director';
  if (isDirectorMode) {
    if (!mappedSegments?.length) return res.status(400).json({ error: '导演讲戏模式需要已确认的映射数据' });
  } else {
    if (!soulCard?.trim()) return res.status(400).json({ error: '缺少剧魂定位卡' });
  }

  const { scenes } = parseRawScript(scriptText);
  if (!scenes.length) return res.status(400).json({ error: '未识别到场景' });

  const jobId = 'agentA_' + Date.now();
  agentAJobs.set(jobId, {
    status: 'running',
    progress: scenes.map(s => ({ sceneId: s.id, status: 'pending', message: '等待中' })),
    results: new Array(scenes.length).fill(null),
    validations: new Array(scenes.length).fill(null),
    total: scenes.length, completed: 0, finalResult: null,
    mode: isDirectorMode ? 'director' : 'ai'
  });
  res.json({ jobId, sceneCount: scenes.length });

  // 导演模式时·预分组讲戏
  const { byScene: segsByScene, globals: globalSegs } = isDirectorMode
    ? groupMappedSegments(mappedSegments)
    : { byScene: {}, globals: [] };

  (async () => {
    const job = agentAJobs.get(jobId);
    const systemPromptPath = isDirectorMode ? 'agent_a_director_v7.md' : 'agent_a_v7.md';
    const systemPrompt = loadPrompt(systemPromptPath);
    if (!systemPrompt) {
      job.status = 'error'; job.finishedAt = Date.now();
      console.error(`❌ 提示词文件 ${systemPromptPath} 未找到`);
      return;
    }

    const CONCURRENCY = 6;
    let index = 0;
    const sceneFeels = new Array(scenes.length).fill(null);
    const sceneDataList = new Array(scenes.length).fill(null);

    console.log(`\n🎬 Agent A v7 启动（${isDirectorMode ? '导演讲戏' : 'AI 分析'}模式）·${scenes.length} 个场景·并发 ${CONCURRENCY}`);

    async function runNext() {
      if (index >= scenes.length) return;
      const i = index++;
      const scene = scenes[i];

      try {
        job.progress[i] = { sceneId: scene.id, status: 'processing', message: '批注中...' };

        // 第一步：解析 items
        const items = annotationV7.parseSceneItemsV7(scene.content);

        // 第二步：构建 prompt
        const prevFeel = i > 0 ? sceneFeels[i - 1] : null;
        const options = isDirectorMode
          ? {
              sceneSegments: segsByScene[scene.id] || [],
              globalSegments: globalSegs,
              prevFeel,
            }
          : {
              soulCard,
              prevFeel,
            };
        const userPrompt = annotationV7.buildAnnotationPromptV7(scene, items, isDirectorMode ? 'director' : 'ai', options);

        // 第三步：调用 API（启用 JSON mode）
        const jsonConfig = Object.assign({}, config, { jsonMode: true });
        let jsonText = await callAPI(systemPrompt, userPrompt, jsonConfig);
        let data = annotationV7.parseAnnotationJSON(jsonText);

        // 第四步：验证·必要时重试一次
        const sceneSegs = segsByScene[scene.id] || [];
        let errors = data ? annotationV7.validateAnnotationV7(data, items, sceneSegs) : ['JSON 解析失败'];

        if (errors.length > 0) {
          console.log(`⚠️ 场景${scene.id} 第一次验证 ${errors.length} 条问题·重试...`);
          job.progress[i].message = `验证失败(${errors.length}条)·重试...`;
          const retryPrompt = userPrompt + `\n\n⚠️ 上次 JSON 有以下问题·请修正后重新输出：\n` + errors.map(e => `- ${e}`).join('\n');
          jsonText = await callAPI(systemPrompt, retryPrompt, jsonConfig);
          const data2 = annotationV7.parseAnnotationJSON(jsonText);
          if (data2) {
            const errors2 = annotationV7.validateAnnotationV7(data2, items, sceneSegs);
            if (errors2.length === 0) {
              data = data2;
              errors = [];
              console.log(`✓ 场景${scene.id} 重试后通过`);
            } else {
              data = data2; // 用重试版·但打警告
              errors = errors2;
              console.warn(`⚠️ 场景${scene.id} 重试后仍 ${errors2.length} 条警告·继续`);
            }
          }
        } else {
          console.log(`✓ 场景${scene.id} 首次验证通过`);
        }

        if (!data) {
          throw new Error('JSON 解析两次均失败');
        }

        // 第五步：代码组装批注版剧本
        let annotatedText = annotationV7.assembleAnnotationV7(scene, items, data);

        // 第六步：角色名修正（导演模式的口误修正）
        if (isDirectorMode && scene.characters?.length) {
          annotatedText = normalizeCharNames(annotatedText, scene.characters);
        }

        // 第七步：保存结果
        sceneFeels[i] = data.scene_feel || '';
        sceneDataList[i] = data;
        job.results[i] = annotatedText;
        job.validations[i] = {
          sceneId: scene.id,
          stats: annotationV7.getAnnotationStatsV7(items, data),
          errors: errors || [],
        };
        job.progress[i] = {
          sceneId: scene.id,
          status: 'done',
          message: errors.length > 0 ? `完成（${errors.length}条警告）` : '完成 ✓',
        };
      } catch (err) {
        console.error(`❌ 场景${scene.id} 失败:`, err.message);
        job.progress[i] = { sceneId: scene.id, status: 'error', message: '失败: ' + err.message };
        job.results[i] = `[场景${scene.id} 批注失败: ${err.message}]`;
      }
      job.completed++;
      await runNext();
    }

    const workers = Array(Math.min(CONCURRENCY, scenes.length)).fill(null).map(() => runNext());
    await Promise.all(workers).catch(console.error);

    // 代码生成摘要（不走 API）
    const allAnnotations = job.results.filter(r => r && !r.startsWith('[')).join('\n\n');
    try {
      const summary = annotationV7.generateSummaryV7(scenes, job.results, sceneDataList, job.validations);
      job.finalResult = allAnnotations + '\n\n' + summary;
    } catch (err) {
      job.finalResult = allAnnotations + `\n\n[摘要生成失败: ${err.message}]`;
    }

    job.status = 'done';
    job.finishedAt = Date.now();
    console.log(`✓ Agent A v7 完成·${scenes.length} 个场景`);
  })();
});
```

---

## 改动 7：`/api/reload-prompts` 清缓存扩展

**定位**：搜索 `app.post('/api/reload-prompts'`（约第 1912 行）

**替换整个路由**为：

```javascript
app.post('/api/reload-prompts', (req, res) => {
  for (const key of Object.keys(_promptCache)) delete _promptCache[key];
  delete _planCoreCache.content;
  res.json({
    message: '提示词缓存已清空，下次处理时重新读取',
    prompts: [
      'core_v7.txt', 'wenxi_core_v7.txt', 'wenxi_examples_v7.txt', 'wuxi_v7.txt',
      'agent_a_v7.md', 'agent_a_director_v7.md',
      // v6 老文件保留·用于回滚
      'core.txt', 'wenxi.txt', 'wuxi.txt', 'agent_a.md', 'agent_a_director.md'
    ]
  });
});
```

---

## 改动 8：启动日志

**定位**：搜索 `console.log('\n🎬 视频提示词工具 v6 已启动');`（约第 2846 行）

**替换为**：

```javascript
  console.log('\n🎬 视频提示词工具 v7 已启动');
  console.log('📍 访问地址：http://localhost:' + PORT);
  console.log('📁 提示词目录：' + path.join(__dirname, 'prompts'));
  console.log('   Agent A v7：JSON 引擎·LLM 只产批注·代码拼装原文');
  console.log('   Agent C v7：字数 Cascade·范例按需注入·DeepSeek JSON mode');
  console.log('   并发：6·缓存命中会在日志打印\n');
```

---

## 改完后要做的事

1. **把 v7 文件放到对应目录**
   - `annotation_v7.js` → 项目根目录，和 server.js 同级
   - `prompts/core_v7.txt` → prompts/ 下
   - `prompts/wenxi_core_v7.txt` → prompts/ 下
   - `prompts/wenxi_examples_v7.txt` → prompts/ 下
   - `prompts/wuxi_v7.txt` → prompts/ 下
   - `prompts/agent_a_v7.md` → prompts/ 下
   - `prompts/agent_a_director_v7.md` → prompts/ 下

2. **老文件保留不删**，具体参考 DEPLOY_V7.md

3. **本地先跑 test**：`node test_v7.js`（应该 41/41 通过）

4. **启动服务器**：`node server.js`
   - 看到 "🎬 视频提示词工具 v7 已启动" 就对了

5. **首次跑批注**，看日志里有没有：
   - `💾 缓存命中 XXXX tokens` （从第二次请求开始应该有）
   - `✓ 场景X-X 首次验证通过` （大部分场景一次过）
   - `✓ 场景X-X 重试后通过` （偶尔才应该出现）

---

## 如果你想要 100% 不改 server.js 的方案

很遗憾不行。架构从"LLM 复述原文 + 挂批注"改成"代码复述原文 + LLM 产 JSON"，这是路由级的改动，不动 server.js 做不到。

但如果你对修改 server.js 心里没底，可以这样稳妥：

1. 把改动 6（整个 annotate 路由）另起一个路由，叫 `/api/agent-a/annotate-v7`
2. 前端 index.html 加一个开关，默认调老接口
3. 你调 v7 的时候 URL 加个 `?v7=1` 参数
4. 老路由留着，跑稳了再删

这样两套并存一段时间，心里最踏实。但 index.html 要改——你说不想改前端，那就只能选择直接上。

建议：直接上。41/41 测试都过了，模块本身是可靠的。
