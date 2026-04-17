# v7 部署说明

## 一、部署清单（7 个新文件 + server.js 改 8 处）

### 新文件（直接放项目）

```
项目根目录/
├── server.js                       ← 改 8 处（见 server_v7_patch.md）
├── annotation_v7.js                ← 新增
├── package.json                    ← 不动
├── index.html                      ← 不动（前端零感知）
└── prompts/
    ├── core_v7.txt                 ← 新增
    ├── wenxi_core_v7.txt           ← 新增
    ├── wenxi_examples_v7.txt       ← 新增
    ├── wuxi_v7.txt                 ← 新增
    ├── agent_a_v7.md               ← 新增
    ├── agent_a_director_v7.md      ← 新增
    ├── core.txt                    ← 【留着·回滚用】
    ├── wenxi.txt                   ← 【留着·回滚用】
    ├── wuxi.txt                    ← 【留着·回滚用】
    ├── agent_a.md                  ← 【留着·回滚用】
    └── agent_a_director.md         ← 【留着·回滚用】
```

### 分支策略

上线前：

```bash
cd 你的项目目录
git status                          # 确认工作树干净
git checkout -b v7-migration        # 开新分支
git tag v6-final                    # 给 v6 打个永久标记
git push origin v6-final            # 推到远程
```

一切搞砸了的回滚命令（2 分钟的事）：

```bash
git checkout main
git branch -D v7-migration
# 或者只回滚 server.js：
git checkout v6-final -- server.js
```

---

## 二、部署步骤

### 第 1 步：本地跑测试

在动 server.js 之前先验证引擎本身是好的：

```bash
cd 项目根目录
node test_v7.js
```

**期望看到**：`✅ 全部通过·引擎可用`（41/41）

如果不是 41/41，**停手**，检查 `annotation_v7.js` 是否完整。

### 第 2 步：改 server.js

按 `server_v7_patch.md` 的 8 处改动依次操作。建议顺序：

1. 改动 1（新增 require）—— 最安全
2. 改动 4（并发数改 6）—— 最简单
3. 改动 8（启动日志）—— 最简单
4. 改动 7（reload-prompts）—— 小
5. 改动 3（callAPI 的 JSON mode）—— 中等
6. 改动 5（writeAndVerifySegment 字数 Cascade）—— 中等
7. 改动 2（buildSystemPrompt）—— 改动面广
8. 改动 6（整个 annotate 路由替换）—— 最大

每改一步，保存文件，然后在命令行跑一下：

```bash
node -c server.js       # 只语法检查，不启动
```

没有语法错误再继续下一步。

### 第 3 步：启动服务器

```bash
node server.js
```

**期望看到**：

```
🎬 视频提示词工具 v7 已启动
📍 访问地址：http://localhost:3001
   Agent A v7：JSON 引擎·LLM 只产批注·代码拼装原文
   Agent C v7：字数 Cascade·范例按需注入·DeepSeek JSON mode
   并发：6·缓存命中会在日志打印
```

看不到 v7 标志就是改错了·回到第 2 步检查。

### 第 4 步：首次验证

打开浏览器访问 `http://localhost:3001`，跑一个剧本：

- 选 **AI 分析模式**
- 上传一个剧本（选一个你之前最容易卡死的、对话密集的剧本）
- 生成剧魂定位卡
- 点批注

---

## 三、10 条验证清单（第一次真跑必须逐条看）

| # | 看什么 | 期望结果 | 如果不对 |
|---|---|---|---|
| 1 | 启动日志 | 看到 "v7 已启动" 字样 | 改动 8 没生效 |
| 2 | 第一个场景控制台日志 | `✓ 场景X-X 首次验证通过` | 看错误消息，检查 prompt |
| 3 | 第二个场景控制台日志 | `💾 缓存命中 XXXX tokens` 出现 | 改动 3 没加缓存日志 |
| 4 | 全集完成时间 | 10 场景 ≤ 3 分钟 | 超过 5 分钟说明并发没生效或 DeepSeek 堵车 |
| 5 | 下载批注文件 | 能下载到 annotated-script-*.txt | 路由出错 |
| 6 | 批注文件首尾 | 头部是场景分隔线·尾部是【批注摘要】 | assembleAnnotationV7 bug |
| 7 | 随便挑一场数台词 | **剧本原台词数 = 批注版台词数** | parseSceneItemsV7 漏识别·或 assembleAnnotationV7 跳过 |
| 8 | 随便挑一场看▲动作行 | **全部保留·顺序不变** | 同上 |
| 9 | 情绪走向字段 | 三节点明显不同·不是"愤怒→很愤怒→最愤怒" | validator 没生效 |
| 10 | 跑一次 Agent C | 能正常读 v7 批注·正常出分镜 | 批注格式没对齐·见"格式验证" |

### 第 7 条尤其重要——台词完整性验证

最简单的做法：在终端数一下。

```bash
# 原剧本里的台词数（冒号行且冒号前≤15字的）
grep -E '^[^▲（【]{1,15}：' 你的剧本.txt | wc -l

# 下载的批注文件里的台词数
# 剥离（导演讲戏：...）块后再数
sed '/（导演讲戏：/,/^）$/d' annotated-script-xxx.txt | grep -E '^[^▲（【]{1,15}：' | wc -l
```

两个数**必须完全相等**。差一个就是引擎 bug，立刻停手告诉我。

### 格式验证（给 Agent C 用）

v7 输出的批注版剧本必须和 v6 字节级一致。关键标记：

- `═══` 分隔线
- `（导演讲戏：` 开始 · `）` 结束（全角括号）
- 【场景感受】【动作线设计】【镜头意图】【人物内心】【禁止】 标签
- 【无特殊批注】和 【待补充】 **不**包在（导演讲戏：）里

手动抽查一个场景：

```bash
# 看第一场的结构
head -50 annotated-script-xxx.txt
```

应该长这样：

```
═══════════════════════════════════
场景1-1  夜 内 守林屋
人物：张玄、王龙、李德财
═══════════════════════════════════
（导演讲戏：
【场景感受】...
【动作线设计】
张玄：...
王龙：...
）

▲张玄坐在桌边...
（导演讲戏：
【镜头意图】必须捕捉：...
【人物内心】... → ...
）
张玄：...台词原文...
（导演讲戏：
【人物内心】... → ...
）
```

任何偏差告诉我。

---

## 四、首个真实剧本跑完之后

### 如果 10/10 全部通过

✅ v7 稳了。接下来：

- 连续跑 3-5 个真实剧本（不同类型：古装武戏、现代文戏、悬疑等）
- 每次跑完都看一下"台词完整性"指标（第 7 条）
- 跑稳了就可以继续日常工作了
- **3-5 天后**如果没任何异常，可以按下面"清理 v6"的清单删老东西

### 如果某一条没过

根据控制台错误消息回来找我。以下是常见错误对照表：

| 现象 | 可能原因 | 排查 |
|---|---|---|
| "提示词文件 agent_a_v7.md 未找到" | 文件没放对位置 | 检查 `prompts/` 目录 |
| "JSON 解析两次均失败" | DeepSeek 没返回合法 JSON | 看控制台打印的 jsonText·是不是被截断 |
| 所有场景都"重试后通过" | prompt 有问题 | 告诉我验证 errors 是什么 |
| 所有场景都首次通过但摘要不对 | generateSummaryV7 bug | 看错误堆栈 |
| 台词数不相等 | parseSceneItemsV7 识别失败 | 把你的剧本第一场发给我看 |

---

## 五、跑稳后清理 v6（3-5 天之后再做）

### 可以删的文件

```
prompts/agent_a.md             ← 删
prompts/agent_a_director.md    ← 删
prompts/core.txt               ← 删
prompts/wenxi.txt              ← 删
prompts/wuxi.txt               ← 删
```

### 可以删的函数（server.js 里）

这些是 v6 独有的·v7 不再调用：

| 大致行号 | 函数名 | 作用 |
|---|---|---|
| 2027-2085 | `buildAnnotationPlanPrompt` | v6 规划阶段 |
| 2087-2101 | `parseAnnotationPlan` | 同上 |
| 2103-2140 | `validateAnnotationPlan` | v6 规划验证 |
| 2146-2195 | `buildAnnotationExecutePrompt` | v6 执行阶段 |
| 2197-2241 | `validateAnnotation` | v6 执行验证（漏台词误判的元凶） |
| 2243-2264 | `getAnnotationStats` | v6 统计 |
| 2278-2337 | `buildDirectorAnnotatePrompt` | v6 导演模式 |
| 2339-2454 | `validateDirectorAnnotation` | v6 导演模式验证 |
| 2435-2454 | `getDirectorAnnotationStats` | v6 导演模式统计 |
| 2199-2250 | `extractRawDialogues`? | 看 normalizeCharNames 还用不用·用就留 |

### 保留下来的 v6 函数（v7 还在用）

- `parseRawScript` — v7 仍调
- `stripMarkdown` — v7 仍调
- `normalizeCharNames` — v7 仍调
- `groupMappedSegments` — v7 仍调
- `extractRawDialogues` — 看情况（v7 没主动用但可能间接用）
- `parseScript` / `detectSceneType` / `extractDialogues` — Agent C 的路径还在用，必须保留
- `processDirectorNotes` / `stripDirectorNotes` — Agent C 还在用，保留
- 所有 Agent C 路径函数（`processSceneMultiStep` / `buildPlanPrompt` / `validatePlan` / `writeAndVerifySegment` / `buildSegmentPrompt` 等）—— v7 只改了 Agent A 的路径，Agent C 这条线大多数没动（只改了 `buildSystemPrompt` 和 `writeAndVerifySegment`）

---

## 六、紧急回滚（任何时刻都可用）

如果生产环境爆炸了、用户在骂你、你需要立刻回到 v6：

```bash
git checkout v6-final -- server.js
# server.js 立刻回到 v6 状态
# 老 prompt 文件还在 prompts/ 下·v6 立刻能跑

pm2 restart 服务     # 或你的进程管理工具
```

2 分钟之内你就回到了 v6。

回滚后不要立即删 v7 文件，等你分析完问题再处理。

---

## 七、性能和成本预期

### 速度

| 场景 | v6 | v7 | 来源 |
|---|---|---|---|
| 单场景 API 调用数 | 2-4 | 1-2 | 规划+执行合一 |
| 单场景时间 | 30-60s | 8-20s | 调用减少 + 缓存命中 |
| 10 场景一集 | 5-10 分钟 | 1-3 分钟 | 并发 6 |

### 成本

DeepSeek 缓存命中的部分计费降 90%。v7 的 system prompt 和场景级上下文都是稳定前缀，从第二次调用起缓存命中。

粗略估算单集成本：
- v6：~50K tokens × 25 次调用 × 原价 ≈ 按原价算
- v7：~40K tokens × 15 次调用 × (10% 缓存价 + 原价) ≈ v6 的 1/4 到 1/3

### 质量

- 台词遗漏率：v6 有非零概率 → **v7 理论为 0**（由代码保证）
- 情绪节奏断层：validator 强制拒绝同质三节点
- 格式错误：strict JSON + 三层兜底解析·基本不会再出文本格式错误

---

## 八、一句话总结

**v7 改变的是架构·不是优化。**

v6 是 LLM 抄原文 + 挂批注 → 漏是概率事件。
v7 是代码抄原文 + LLM 只产 JSON → 漏是数学不可能。

部署后要做的就一件事：**看第一个真实剧本跑完·逐条对照第三节的 10 条清单**。全过就真的稳了。
