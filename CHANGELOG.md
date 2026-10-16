# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [1.0.0] — 2026-10-16

首个公开发布。

### 功能

- **侧栏常驻额度卡片 + 「模型余额与额度」面板**：点卡片在右侧展开，逐行列出各供应商读数。
- **卡片跟随当前对话的模型商**：读会话的模型选择投影
  （`sessions.binding(id).session.projections.faceOf('modelSelection')`）并订阅它与会话列表，
  切模型 / 切会话立刻更新；取不到时回落到配置的 `primary`。
- **DeepSeek Account 与 DeepSeek API 区分开**：前者走宿主账号服务
  （`ctx.deepseekAccount.getBalance()`：充值钱包 + 赠金钱包），后者走独立 API Key 的
  `/user/balance`；两者互不影响。
- **赠金优先显示**：有未用完的赠金时大号显示赠金 + 绿底白字「赠金」圆角标，
  下方灰字显示正常余额（非赠金部分）；无赠金则显示正常余额。
- **余额颜色告警**：≥20 CNY 绿 / ≥5 黄 / <5 红 / ≤0 灰；可开关「赠金是否参与颜色计算」
  （关=只看余额；开=有赠金按赠金、用完自动回落余额），阈值可改。
- **额度进度条颜色告警**：剩余 ≥20% 绿 / ≥5% 黄 / <5% 红 / 0% 空条；优先展示窗口
  可选 5 小时（默认）/ 每周 / 每月，阈值可改。
- **默认只显示 DeepSeek Account**，其它供应商检测到已配置凭据才自动出现；
  `设置 → 额度面板` 提供三态开关（自动 / 显示 / 隐藏）与全部展示偏好。
- **13 个供应商适配器**：DeepSeek Account / DeepSeek API / Moonshot 开放平台 /
  Moonshot Kimi Code 订阅 / GLM 开放平台 / GLM Coding（国内）/ Z.AI GLM Coding /
  OpenCode Go / OpenRouter / SiliconFlow / MiniMax（国际、国内）/ StepFun / xAI。
- **凭据名别名**：同一把 key 的不同写法都认（如 `OPENCODE_GO_API_KEY` 与
  `OPENCODE_GO_KEY`），并把逐个候选名的存在性作为诊断下发——根治「已配置却显示未配置凭据」。
- **HTTP 只读数据面**：`/summary`、`/refresh`、`/settings`（GET/POST）、`/providers`，
  同源校验，密钥不出宿主进程。

### 设计

- 零第三方依赖（只用 Node 内建 `fetch` / `node:fs` 与 DSH 公开缝）。
- 逐行独立失败：单个供应商出错只影响它自己那行。
- 不猜数：上游解析失败显示错误原因，绝不把读不到当成 0。
- 行字段与错误码词表对齐 Tianshu-harness 的 `ProviderUsageAccount` / `ProviderUsageError`。

### 测试

- 31 项 `node --test`：解析器（含钱包/赠金）、配置与偏好归一化、凭据别名与诊断、
  可见性判定与设置页落盘、账号余额四种状态、HTTP 路由端到端。
- 客户端半有独立渲染沙盒（`tests/sandbox-render.html`），用无头 Chrome 出两张参考图。
