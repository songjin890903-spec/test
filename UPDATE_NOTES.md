# Agent A 集成 · 更新说明
> 更新时间：2026-04-04
> 版本：v4（Agent A 集成版）

---

## 一、新增文件

| 文件 | 位置 | 说明 |
|---|---|---|
| agent_a.md | prompts/ | Agent A 提示词（从 AGENT_A_剧本分析版_ai导演.md 复制） |

## 二、修改文件

### server.js（新增 ~160 行）

**新增路由：**

| 路由 | 方法 | 功能 |
|---|---|---|
| `/api/agent-a/upload` | POST | 上传原始剧本，提取纯文本（不做场景拆分） |
| `/api/agent-a/soul-card` | POST | 调用 AI 生成剧魂定位卡（单次 API 调用） |
| `/api/agent-a/annotate` | POST | 开始逐场景批注（job-based，后台异步） |
| `/api/agent-a/progress/:jobId` | GET(SSE) | 批注进度实时推送 |
| `/api/agent-a/results/:jobId` | GET | 获取批注结果 |
| `/api/agent-a/download/:jobId` | GET | 下载批注版剧本 |
| `/api/parse-text` | POST | 解析文本为场景（批注输出 → Agent C 输入） |

**设计决策：**
- 剧魂定位卡用同步 POST（单次 API 调用，通常 1-2 分钟）
- 逐场景批注用 job + SSE（可能需要多次续跑，耗时较长）
- 复用已有的 `callAPI()` 函数（自动续跑 + 429 重试）
- 复用已有的 `parseScript()` 解析批注输出

### public/index.html（新建前端）

**双模式 UI：**
1. **原始剧本 → 全流程**（Agent A 模式）
   - 步骤1：上传原始剧本
   - 步骤2：查看/编辑剧魂定位卡 → 确认
   - 步骤3：等待逐场景批注 → 预览/下载/复制
   - 步骤4：自动解析场景 → 输入服化道卡 → 生成提示词

2. **批注剧本 → 直接生成**（原有 Agent C 模式）
   - 上传批注版剧本 → 自动拆场景 → 生成提示词

---

## 三、使用流程

### Agent A 全流程
```
1. 选择「原始剧本 → 全流程」模式
2. 填写 API 设置
3. 上传原始剧本（.txt / .docx）
4. 点击「生成剧魂定位卡」→ 等待 1-2 分钟
5. 审阅定位卡（可直接编辑文本）
6. 点击「确认，开始批注」→ 等待批注完成
7. 预览批注结果，点击「进入提示词生成」
8.（可选）粘贴服化道卡
9. 点击「开始生成提示词」→ 等待各场景完成
10. 下载结果
```

---

## 四、部署说明

```bash
# 确保以下文件结构：
project/
├── server.js              # 更新后的后端
├── package.json
├── public/
│   └── index.html          # 更新后的前端
├── prompts/
│   ├── core.txt            # 不变
│   ├── wenxi.txt           # 不变
│   ├── wuxi.txt            # 不变
│   └── agent_a.md          # 新增（从 AGENT_A_剧本分析版_ai导演.md 复制）
└── uploads/                # 自动创建

# 安装依赖（如首次）
npm install

# 启动
node server.js
# → 访问 http://localhost:3001
```

---

## 五、后续待做

- **第二期 Agent B 集成**：角色自动识别 + 参考图上传 + 服化道卡自动生成
- **批注分场景并行**：当前批注为全剧本单次 API 调用，长剧本可改为分场景并行
- **定位卡编辑增强**：结构化编辑器替代纯文本编辑
- **批注结果缓存**：避免重复调用
