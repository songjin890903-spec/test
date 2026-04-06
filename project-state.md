# 视频提示词工具 · 项目状态文档
> 最后更新：2026-04-04
> 用途：开新对话时上传此文件 + 最新的 server.js / index.html / core.txt / wenxi.txt / wuxi.txt，AI 即可恢复完整上下文。

---

## 一、系统架构

```
用户上传批注剧本(.docx/.txt) + 粘贴服化道卡
    ↓
server.js (Node.js + Express, 端口3001)
    ↓
┌─────────────────────────────────────────┐
│  parseScript()  解析剧本 → 拆场景      │
│  detectSceneType()  判断文戏/武戏/混合  │
│  extractDialogues()  提取台词          │
│  calcMinDuration()  算台词最短时长      │
└─────────────────────────────────────────┘
    ↓ 每个场景走 processSceneMultiStep()
┌─────────────────────────────────────────┐
│  第一步：规划（buildPlanPrompt）         │
│    · system prompt = core.txt only      │
│    · 输出 JSON：片段/镜号/时长/台词分配  │
│    · 程序验证（validatePlan）            │
│    · 失败重试一次，再失败降级单次模式    │
│                                         │
│  第二步：并行写作（buildSegmentPrompt）   │
│    · system prompt = core.txt + wenxi/wuxi│
│    · 所有片段同时发 API 调用            │
│    · 每片段写完自动台词核验+补写        │
│    · Promise.allSettled 单片段失败不影响 │
│                                         │
│  第三步：全场景台词总检                  │
│    · 所有片段拼合后再查一遍台词完整性   │
│    · 字数检查（每片段≤1800字）          │
└─────────────────────────────────────────┘
    ↓
前端展示 + 下载（index.html）
```

---

## 二、文件清单与职责

| 文件 | 位置 | 职责 |
|---|---|---|
| server.js | 根目录 | 后端主程序，结构逻辑 |
| index.html | public/ | 前端界面 |
| core.txt | prompts/ | 通用 system prompt（铁律+模板+三原则） |
| wenxi.txt | prompts/ | 文戏专项规则（模型库+写法规则+声画分离） |
| wuxi.txt | prompts/ | 武戏专项规则（模型库+写法规则+情绪基线→打法） |

---

## 三、核心规则体系（跨文件一致）

### 台词切镜阈值（3秒/8秒/15秒三层）

| 台词时长 | 处理方式 | 涉及文件 |
|---|---|---|
| ≤3秒 | 一个镜号拍完 | server.js 规划规则 + core.txt 铁律③ + 验证器 |
| >3秒 | 必须切镜（换角度/反打/INSERT/声画分离） | 同上 + wenxi.txt 规则十-补 |
| >8秒 | 切镜中必须含声画分离 | 同上 |
| >15秒 | 声画分离可跨片段 | 同上 |

### 声画分离画面优先级（wenxi.txt 规则十-补）
1. 在场其他角色的反应（最优先）
2. 说话者自身细节（不是对嘴）
3. 空景/环境镜头（情绪标点）

### 表演·摄影机·情绪铺垫三原则（core.txt）
- 原则一·表演内敛律：身体先动脸最后到，用动作替代情绪形容词
- 原则二·摄影机意图律：摄影机是观众替身，每个运动有意图，禁止"镜头切到"
- 原则三·情绪铺垫律：预埋→触发→落地，三拍缺一不可

### 情绪基线（core.txt analysis模板 + wuxi.txt 规则八）
- 每个角色进场前锁定"底色"（不是反应，是默认状态）
- 武戏：基线决定打法质感（做实验/碾压/死撑/赴死→同一动作不同写法）
- 所有表演细节必须从基线生长，转折前不能泄露转折后的情绪

### 武文混合场景节拍（server.js 规划规则7）
- [武]动作冲击：镜号短1-3s
- [文]台词对话：>3秒切镜，>8秒声画分离
- [转]过渡：武→文插余震/定格，文→武插蓄力/临界

---

## 四、已解决的关键问题

### server.js 修复历史
1. Promise.all → Promise.allSettled（片段失败不影响其他）
2. 续跑死循环防护（MAX_CONTINUATIONS=5）
3. 非429 HTTP错误处理（!res.ok检查）
4. 重试计数重置
5. API空响应防御（可选链检查）
6. 结果乱序（push→索引赋值）
7. 嵌套括号截断（正则→processDirectorNotes平衡括号函数）
8. extractDialogues误杀旁白/画外音（豁免处理）
9. loadPrompt缓存 + reload清缓存
10. calcMinDuration：剥离舞台指示（括号内容）和书名号
11. detectSceneType：台词≥5条加权，避免误判纯武戏
12. validatePlan：末尾片段放宽镜头数下限
13. 空tailFrame兜底提示
14. 引号类型统一（QUOTE_STRIP_RE共享常量）
15. 全场景台词总检（多步+单次模式都有）
16. 字数检查（每片段≤1800字，log警告）
17. JSON格式示范含声画分离镜号（解决规划器不生成声画分离的问题）

### index.html 修复历史
1. setApiType选择器错误（querySelectorAll→精确ID）
2. parseSegments正则损坏（[sS]→[\s\S]，/未转义）
3. downloadCleanBtn残留
4. 同一文件无法重新上传（fileInput.value清空）
5. SSE出错时按钮卡死（onerror+error分支恢复）
6. innerHTML未转义用户内容

---

## 五、当前状态与下一步

### 当前可用功能
- 上传剧本 → 自动拆场景 → 批量生成视频提示词
- 支持 Anthropic Claude 和 OpenAI 兼容 API
- 场景级并发2 + 片段级全并行
- 台词自动核验+补写+总检
- 声画分离自动规划
- 武文混合节拍切换

### 待做：第一期 Agent A 集成
目标：用户上传原始剧本（非批注版），系统自动跑 Agent A 生成批注剧本
流程：
1. 上传剧本 → 调 API 跑 Agent A → 输出剧魂定位卡
2. 前端展示定位卡 → 用户确认
3. 确认后 → 调 API 逐场景批注 → 输出批注版剧本
4. 批注剧本自动进入现有 Agent C 流程

涉及文件：
- AGENT_A_剧本分析版_ai导演.md（Agent A 的 prompt）
- server.js（新增 Agent A 路由和逻辑）
- index.html（新增定位卡展示和确认UI）

### 待做：第二期 前端改造 + Agent B
- 角色自动识别 + 参考图上传
- 服化道卡自动生成
- AGENT_B_更新版.md（Agent B 的 prompt）

### 待做：第三期 全链路优化
- 减少确认步骤
- 批量多集处理
- 结果缓存/历史记录
