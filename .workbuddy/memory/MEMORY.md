# 长期记忆

## StructuredC Physics算法化（2026-05-18完成）

**核心改造**：lib/structuredC.js 新增 derivePhysics() 引擎，替代 defaultPhysics 的硬编码判断。

### 三层推导优先级（从低到高）
1. **基础模板** — VISUAL_STYLE_TEMPLATES（poetic/plain）
2. **场景头** — inferPhysicsFromSceneHeader（时间/地点/天气）
3. **AI批注** — inferPhysicsFromAnnotation（剧魂定位卡标签）
4. **导演讲戏** — parseDirectorPhysics（关键词映射，最高优先级）

### 导演讲戏→physics关键词表（DIRECTOR_PHYSICS_MAP）
| 导演关键词 | 影响physics字段 |
|-----------|--------------|
| 压抑/沉重/压迫 | atmosphere→死寂+深冷，mood→压抑 |
| 浪漫/暧昧/亲密 | light→暖暗光，atmosphere→薄雾+浅景深 |
| 冷调/蓝/寒 | light→冷白光，atmosphere→青灰冷调 |
| 暖调/夕阳/暖 | light→暖橙色，atmosphere→金黄暖调 |
| 逆光/剪影/背光 | light→强烈逆光+轮廓分离 |
| 胶片感/颗粒 | render→强颗粒+晕光 |
| 复古/年代/怀旧 | material→旧材质+风化 |
| 快节奏/紧张 | atmosphere→手持感+快切 |
| 慢节奏/静 | atmosphere→固定镜头+长镜头留白 |
| 绝望/无光/黑暗 | light→极低照度，atmosphere→死寂 |
| 暴力/血腥/冲击 | light→硬边光，atmosphere→碎片/飞溅 |

### 向后兼容
- 无 directorNotes 时完全走旧 defaultPhysics 硬编码
- createSegmentSkeleton() 新增 { annotation, directorNotes } 选项参数
- 全部API端点和pipeline调用已同步更新

## 算法化注入（enrichSegmentShots，2026-05-19完成）

**修复内容**：将4个算法函数迁移到新管道（structuredC.js），并修复两个运行时bug。

### 已实现函数（structuredC.js，buildBatchEnrichPrompt前）
- `extractStableFramesFromContent(content)` — 提取场景内重复出现3次以上的稳定帧
- `extractPropStateChangesFromContent(content)` — 提取道具状态变化节点（拿起/放下等）
- `extractSemanticLocationRulesFromContent(content)` — 提取真实空间位置规则（排除道具内部误判）

### 注入位置
`enrichSegmentShots()` 内，`buildBatchEnrichPrompt()` 调用之后，通过统一的 `let lines` 数组插入各提取结果到 prompt 头部。

### 修复的两个关键bug（2026-05-19）
1. `const lines` 作用域问题 → 改为函数作用域 `let lines`，三次注入共用同一数组
2. `pipeline.js` 中 `const renderedSegments` 被重赋值 → 改为 `let renderedSegments`（Assignment to constant variable 报错）

### 用户API信息（测试用）
- Key前缀：sk-1a5aa3376fb...（DeepSeek）
- 可用模型：deepseek-v4-flash, deepseek-v4-pro
- baseUrl：https://api.deepseek.com
- 服务端口：3006，分支：0512
