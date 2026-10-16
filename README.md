# dsh-model-quota — 模型余额与额度面板（DSH 插件）

给 DeepSeek Harness Web 界面加一个「模型余额与额度」面板：侧栏底部常驻一张额度卡片，
点一下在右侧展开面板，逐行列出各供应商的**账户余额**或**套餐窗口（5 小时 / 每周 / 每月）
剩余百分比 + 重置时间**。默认只显示 DeepSeek 账号，其余供应商一旦检测到已配置的凭据
就自动出现；`设置 → 额度面板` 里可以逐个开关。密钥只在宿主进程内使用，绝不下发浏览器。

![面板预览](tests/sandbox-shot.png)

![设置页](tests/sandbox-settings.png)

（上图是 `tests/sandbox-render.html` 沙盒渲染的实拍：真实 GUI 里卡片在左侧边栏底部，
面板从卡片右侧弹出，设置页在「设置」弹窗的左侧导航里。）

## 两个 DeepSeek 是两回事

| 供应商 | 接入方式 | 余额来源 | 凭据 |
|---|---|---|---|
| **DeepSeek Account**（`deepseek-account`） | DSH 直接以**账号身份**接入（设置 → 账号与余额 里登录） | 宿主账号服务 `ctx.deepseekAccount.getBalance()`：充值钱包 + 赠金钱包 | 登录凭证记录 `deepseek-account-platform/default`（不读 API Key） |
| **DeepSeek API**（`deepseek`） | 独立的 **API Key** 接入 | `api.deepseek.com/user/balance` | `DEEPSEEK_API_KEY` |

两者互不影响：账号的充值/赠金与 API Key 余额各算各的，面板里是两行。

## 安装

### 从 npm（推荐）

```bash
dsh plugin --profile <你的 profile 名> add dsh-model-quota
```

装完**完全退出并重开 DSH Desktop**（客户端半在启动时组装，刷新页面不够）。

### 从 tarball / 本地目录

```bash
dsh plugin --profile desktop add ./dsh-model-quota-1.0.0.tgz
# 或
dsh plugin --profile desktop add file:/绝对路径/dsh-model-quota
```

### 手动安装（不使用插件管理器）

1. 把包放进 profile 的 `node_modules/`（复制或 junction 都行）：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-model-quota" `
     -Target "C:\path\to\dsh-model-quota"
   ```

2. 在 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里加一行 `"dsh-model-quota"`。
3. 重启 DSH Desktop。

> 包自带的 `cordis.patch.yml` 已经 `insert` 了 `id: dsh-model-quota`。**不要在用户层再 insert
> 同一个 id**（重复 id 会让加载器起不来）；要改配置就在 profile 的 `cordis.patch.yml` 里写一条
> 同 id 的覆盖行（见下面「配置」）。

## 它解决什么

同一个 DSH 里往往配了好几个供应商：DeepSeek 按量计费看余额，OpenCode Go / GLM Coding /
Kimi Code 是套餐制看滚动窗口。以前要分别登录各家控制台才能知道「还能不能接着干」。
本插件把这些读数聚合到侧栏一个卡片上，一眼可见。

## 显示规则（默认只留 Account）

- **DeepSeek Account 常驻显示**（唯一默认常驻的行）。
- 其它供应商：**检测到已配置的凭据就自动出现**，没有就不显示。检测口径 =
  凭据库里该名字已配置 / 环境变量里有 / 账号已登录。
- 每个供应商有三态开关（`设置 → 额度面板`）：`自动`（检测到就显示，默认）/ `显示`（无视检测结果都显示）/ `隐藏`。
- **卡片跟随当前对话的模型商**（默认开）：读 DSH 客户端 `sessions.list` 里
  `retainedBy.mainView > 0` 的那个会话，再取它的模型商，映射到本插件的供应商行
  （如 `opencode-go` → OpenCode Go、`deepseek-official` → DeepSeek API）。取不到时回落到配置里的 `primary`。

  实现细节（决定它快不快）：**不建目录、不拉模型目录、不联网**——直接读会话的
  「模型选择」投影 `binding.session.projections.faceOf('modelSelection')`（权威来源，
  官方模型选择器自己也从这里的 `next` 取值），并**订阅**它与会话列表：切模型 / 切会话时
  卡片立刻更新，不再等下一次快照轮询。只有投影还没给出选择（空白会话）时才退回
  `modelDirectories.directoryFor(id).store`，且按会话缓存、只解析一次。
  这里用「订阅 + 只存字符串」而不是 `useSyncExternalStore`，是为了避免某些 store 的
  `getSnapshot` 每次返回新对象时自激成无限渲染（React #185）。
- 开关与偏好保存在 `$DSH_HOME/dsh-model-quota/state.json`（默认 `~/.dsh/dsh-model-quota/state.json`），
  人可读、可直接编辑或删除；删掉即回到默认。
- 想「永远列出全部（含未配置的灰显行）」：配置里把 `showUnconfigured: true` 打开。

例：只登录了 DeepSeek 账号 + 配了 `DEEPSEEK_API_KEY` + `OPENCODE_GO_API_KEY`，
面板里就只有这三行（DeepSeek Account / DeepSeek API / OpenCode Go）；其余供应商不显示，
但在设置页里仍然可见、可手动打开。

## 面板里有什么

- **卡片**（侧栏底部，设置项上方）：默认**跟随当前对话所选的模型商**——对话里用的是
  OpenCode Go 的模型，卡片就显示 OpenCode Go 的额度；`default` 标签会变成「当前模型」。
  第二行是余额或 `剩余 NN%`，第三行是窗口名（如「5 小时额度」）或「余额」。
  侧栏收起时退化成一行紧凑读数。
- **面板**（点卡片展开）：
  - 余额型供应商：大号金额，下面按「赠金优先」规则显示（见下）；
  - 套餐型供应商：每个窗口一行 `窗口名 —— 剩余 NN%` + 进度条 + `MM月DD日 HH:MM 重置`；
    优先项（默认 5 小时）排在最前；
  - 未配密钥的供应商（仅在 `showUnconfigured` 或手动「显示」时出现）灰显「未配置凭据」，
    并把**逐个候选凭据名的存在性**列出来；
  - 页脚：`前台每 N 分钟更新 · 设置 → 额度面板 管理显示` + 数据更新时间；右上角 ⟳ 立即刷新。
- 排序：读到数据的在前，报错的其次，未配置的最后。

## 余额怎么显示（赠金优先 + 颜色）

DeepSeek Account / DeepSeek API 这类带「赠金 / 赠送余额」的供应商：

- **有未用完的赠金**且开了「赠金优先显示」→ 大号数字显示**赠金**，右侧一个
  **绿底白字的「赠金」圆角标**；赠金下方以**灰色小字**显示正常余额（非赠金部分）。
- **没有赠金**（或关掉「赠金优先显示」）→ 直接显示正常余额。

**颜色**（数字与「赠金」标同色）：

| 颜色 | 条件（默认阈值） |
|---|---|
| 绿 | 充足：≥ 20 CNY |
| 黄 | 警告：≥ 5 CNY |
| 红 | 严重不足：< 5 CNY |
| 灰 | 没有余额或已欠费（≤ 0） |

「赠金参与告警颜色计算」开关决定用哪个数判色：**开**（默认）→ 有赠金就按赠金判色，
赠金用完自动回落按余额；**关** → 只看余额。阈值本身可在设置页改（默认 20 / 5 CNY）。

## 额度怎么显示（进度条 + 颜色）

套餐型供应商（OpenCode Go / GLM Coding / Kimi Code / MiniMax 等）：

- **优先显示哪个窗口**可在设置页选：5 小时（默认）/ 每周 / 每月；卡片与面板都按它排序。
- **颜色**（默认阈值）：剩余 ≥ 20% 绿 · ≥ 5% 黄 · < 5% 红 · **0% 空条**（不画填充）。
  阈值可在设置页改（默认 20 / 5 %）。

## 供应商目录

开箱支持（`lib/impl.js` 的 `CATALOG`，按需增删）：

| id | 显示名 | 凭据引用 | 接口 | 语义 |
|---|---|---|---|---|
| `deepseek-account` | DeepSeek Account | （账号登录记录） | 宿主 `ctx.deepseekAccount` | 充值 + 赠金余额，**默认常驻** |
| `deepseek` | DeepSeek API | `DEEPSEEK_API_KEY` | `api.deepseek.com/user/balance` | 账户余额（含充值/赠送明细） |
| `moonshot` | Moonshot 开放平台 | `MOONSHOT_API_KEY` | `api.moonshot.cn/v1/users/me/balance` | 账户余额 |
| `kimi-coding` | Moonshot Kimi Code 订阅 | `KIMI_API_KEY` | `api.kimi.com/coding/v1/usages` | 5 小时 / 每周窗口 |
| `glm` | GLM 开放平台 | `ZHIPU_API_KEY`、`GLM_API_KEY` | `open.bigmodel.cn/api/monitor/usage/quota/limit` | 配额剩余（无公开余额接口） |
| `glm-coding-cn` | GLM Coding 套餐（国内） | `GLM_CODING_API_KEY`、`ZAI_CODING_CN_API_KEY` | 同上 | 5 小时 / 每周 / 每月 |
| `zai-coding` | Z.AI GLM Coding（国际） | `ZAI_API_KEY` | `api.z.ai/api/monitor/usage/quota/limit` | 5 小时 / 每周 / 每月 |
| `opencode-go` | OpenCode Go | `OPENCODE_GO_API_KEY` | `opencode.ai/zen/go/v1/usage` | 5 小时滚动 / 每周 / 每月 |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` | `openrouter.ai/api/v1/credits` | 已购 − 已用 |
| `siliconflow-cn` | SiliconFlow（国内） | `SILICONFLOW_CN_API_KEY` | `api.siliconflow.cn/v1/user/info` | 账户余额 |
| `minimax` / `minimax-cn` | MiniMax Coding | `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` | `/v1/token_plan/remains` | 5 小时 / 每周 |
| `stepfun` | StepFun 阶跃星辰 | `STEPFUN_API_KEY` | `api.stepfun.com/v1/accounts` | 账户余额 |
| `xai` | xAI | `XAI_API_KEY` | `api.x.ai/v1/billing/credits` | 剩余额度 |

凭据按 `refs` 顺序查找：先经 DSH 凭据缝（`ctx.credentials`，也就是设置页里存的
`~/.dsh/.credentials.yaml`）解析，取不到再退回进程环境变量。**凭据值只在宿主进程内存里
使用，不写入任何响应体**；面板下发的只有「凭据名」提示。

### 凭据名别名（「已配置却显示未配置凭据」的根治）

同一家的 key 在不同工具里名字不一样，**只认一个名字就会误判**。真实例子：

| 工具 | OpenCode Go 的凭据名 |
|---|---|
| DSH（`llm-pi-ai` 的 `apiKeyEnv`） | `OPENCODE_GO_API_KEY` |
| 天枢 Tianshu-harness（`provider-presets.ts`） | `OPENCODE_GO_KEY` |

所以每个供应商都按「自己的名字 → 别名」依次尝试（`lib/impl.js` 的 `REF_ALIASES`），
并且把**逐个候选名的体检结果**放进快照：面板在「未配置凭据」下面直接列出
「查找过的凭据名：`KIMI_API_KEY` 未设置 / `KIMI_CODE_API_KEY` 已设置（环境变量）…」，
`GET /summary` 的 `probe.refs` 也能拿到同一份事实。

只列**同一把 key 的不同写法**；语义不同的 key 不互相别名（Moonshot 开放平台的按量
key 与 Kimi Code 订阅 key 是两个体系，不能混）。要加名字：改 `REF_ALIASES`，或在该
供应商的配置里直接写 `refs: [...]`（配置里写的排在别名前面）。

## 安装（本机现状）

已装进 `desktop` profile：

- 源码：`C:\Users\Leaf_\Documents\deepseek-harness\default-workspace\dsh-model-quota`
- profile 里以 **junction** 挂载：`~\.dsh\profiles\desktop\node_modules\dsh-model-quota`
- `~\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里加了 `"dsh-model-quota"`
- `~\.dsh\profiles\desktop\cordis.patch.yml` 末尾有 `- id: dsh-model-quota` 的配置覆盖行
  （包自带的 `cordis.patch.yml` 已 insert 过该 id，用户层只能覆盖、不能重复 insert）

> **junction 掉了怎么修**：这条挂载没写进 `dependencies`（避免和 pnpm 的 lockfile 打架），
> 所以以后用 GUI 插件管理器装/卸别的插件时，pnpm 重排 node_modules 可能会把它删掉。
> 现象是面板消失、`/dsh-model-quota/api/summary` 404；重挂一条即可（不用重启：
> 再改一次 cordis.patch.yml 触发重组）：
>
> ```powershell
> New-Item -ItemType Junction `
>   -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-model-quota" `
>   -Target "C:\Users\Leaf_\Documents\deepseek-harness\default-workspace\dsh-model-quota"
> ```


### 卸载

1. 删掉 profile `package.json` 里 bundles 的 `"dsh-model-quota"` 一行；
2. 删掉 `cordis.patch.yml` 末尾那条 `- id: dsh-model-quota` 覆盖行；
3. 删掉 `node_modules\dsh-model-quota` 这个 junction；
4. 重启 DSH Desktop。

## 配置

写在 profile 的 `cordis.patch.yml`（`- id: dsh-model-quota` 那一行）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就完全不挂载 |
| `refreshMs` | `300000` | 后台刷新周期（毫秒），下限 60000；面板页脚文案跟着它变 |
| `timeoutMs` | `15000` | 单个供应商请求超时 |
| `showUnconfigured` | `false` | `false`=只显示 Account + 检测到的（推荐）；`true`=全部列出（未配置的灰显） |
| `primary` | `deepseek-account` | 卡片优先展示哪个供应商 |
| `accountClientVersion` | 环境变量/`0.2.0-rc.2` | DeepSeek 账号余额请求带的客户端版本号 |
| `statePath` | `$DSH_HOME/dsh-model-quota/state.json` | 显示开关与偏好的持久化路径 |
| `hide` | `[]` | 从面板与设置页隐藏的供应商 id |
| `providers` | `{}` | 按 id 覆盖目录条目，或新增自定义供应商 |

覆盖/新增的例子：

```yaml
- id: dsh-model-quota
  config:
    primary: opencode-go
    hide: [xai, stepfun]
    providers:
      deepseek:
        label: DeepSeek 官方
      my-gateway:                       # 目录外的自建网关
        label: 自建网关
        refs: [MY_GATEWAY_KEY]
        endpoint: https://gw.example.com/v1/credits
        format: openrouter-credits      # 复用已有解析器
        currency: $
```

新增供应商时 `endpoint` / `format` / `refs` 三者必填，`format` 必须是已注册的解析器
（`deepseek-balance`、`moonshot-balance`、`openrouter-credits`、`siliconflow-balance`、
`stepfun-accounts`、`xai-credits`、`zhipu-quota`、`zai-coding-quota`、`kimi-coding-usage`、
`minimax-remains`、`opencode-usage`）。要接一个全新形状的接口，在 `CATALOG` 旁边加一个
解析函数并登记到 `PARSERS` 即可，约 10 行。

## HTTP 路由（宿主半 → 浏览器半）

前缀 `/dsh-model-quota/api`，仅同源可访问（带 `Origin` 且与 `Host` 不符直接 403）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/summary` | 完整快照：`{ updatedAt, refreshing, lastError, config, probe, settings, providers[] }`（`providers` 只含当前应展示的行） |
| `POST` | `/refresh` | 立刻重新拉取（2 秒冷却，防止连点） |
| `GET` | `/settings` | 显示设置：全部候选供应商 + `mode/detected/visible` + `prefs` + 状态文件路径 |
| `POST` | `/settings` | 改设置：`{ providers: { id: "auto"\|"on"\|"off" }, prefs: { followModel, bonusFirst, bonusInColor, balance:{healthy,warn}, quota:{preferred,healthy,warn} } }`（都可部分更新），落盘并重算可见性 |
| `GET` | `/providers` | 只列出供应商 id / 名称 / 凭据引用 |

`probe` 是诊断字段（**不含任何密钥值**）：凭据缝是怎么拿到的（`inject` / `direct`）、
上次解析与体检的报错、命中了哪些环境变量名，以及 `refs: { 引用名: { present, source, usedBy[] } }`
——「已配置却显示未配置凭据」的取证入口。`describe()` 只回 `configured/source/writable`，
从不回值，测试里也断言了这一点。

### 行字段（对齐天枢的 `ProviderUsageAccount` 词表）

每行同时给出插件自己的字段与天枢契约里的等价字段，方便两边工具复用同一份数据：

| 字段 | 说明 |
|---|---|
| `provider` / `providerLabel` | 同 `id` / `label`（对齐 Tianshu `ProviderUsageAccount`） |
| `kind` | `balance`（按量余额）/ `subscription`（套餐窗口）/ `unsupported`（无公开接口，只报配额） |
| `status` | `ok` / `unconfigured` / `error`（+ 首屏 `loading`） |
| `errorCode` | `auth` / `rate-limit` / `timeout` / `network` / `invalid-response` / `unavailable` / `unknown` |
| `refsTried` | 逐个候选凭据名的 `{ ref, present, source, used }` |
| `account` | 账户型行（DeepSeek Account）为 `true`，`configured/accountSignedIn` 表示登录态 |
| `wallet` | `{ currency, total, topUp, bonus }`：赠金优先显示与告警颜色都基于它 |
| `sessionProviders` | 该行对应的「会话模型商名」，卡片跟随当前对话时用来配对 |
| `windows.<key>` | `{ period: '5h'\|'7d'\|'monthly', label, remainingPercent, usedPercent, resetsAt }` |

## 测试

```bash
node --test tests/quota.test.mjs          # 31 项：解析器（含钱包/赠金） + 配置与偏好归一化 + 凭据别名/诊断 + 可见性/设置页 + 账号余额 + 路由端到端（假 fetch）
```

`tests/sandbox-render.html` 是客户端半的渲染沙盒：用 CDN 的 React 加载 `lib/client.js`，
喂一份假的 `/summary` 数据，自动展开面板——用无头 Chrome 截图就能看外观：

```bash
# 面板
chrome --headless=new --window-size=1000,780 --virtual-time-budget=8000 \
  --screenshot=tests/sandbox-shot.png tests/sandbox-render.html
# 设置页
chrome --headless=new --window-size=1000,780 --virtual-time-budget=8000 \
  --screenshot=tests/sandbox-settings.png "tests/sandbox-render.html?view=settings"
```

## 改代码后怎么生效

入口 `lib/host.js` 只做一件事：`import('./impl.js?v=<stamp>')`。于是：

- 改 `lib/impl.js`（目录、解析、路由、调度）→ 触发一次 profile 重组（改
  `cordis.patch.yml` / `package.json` 任意一处并保存）即可生效，**不用重启**；
- 改 `lib/host.js` 入口本身、或客户端半 `lib/client.js` → 需要重启 DSH Desktop
  （客户端半也可以只刷新页面，前提是重启过一次让它在启动时进入客户端模块图）；
- 为什么用带 `?v=` 的动态导入：本机 DSH 的 HMR 是 `root: []`，只监听 profile
  配置文件、不监听模块源码，模块缓存又按 URL 命中——带时间戳的动态导入是让
  「重组即重载」生效的最省事办法。

## 排查「显示未配置凭据」

按顺序看三个地方，能直接定位到底是哪一类问题：

```powershell
# 1) 面板里：未配置的那一行下面会列出「查找过的凭据名 + 已设置/未设置」
# 2) 宿主端事实（同一份数据）：
Invoke-WebRequest http://127.0.0.1:19387/dsh-model-quota/api/summary -UseBasicParsing |
  Select-Object -ExpandProperty Content | ConvertFrom-Json |
  Select-Object -ExpandProperty providers | Where-Object id -eq 'opencode-go' | ConvertTo-Json -Depth 5
```

| 现象 | 含义 | 怎么办 |
|---|---|---|
| 所有候选名都 `present: false` | 这个进程里没有这把 key：既不在 DSH 凭据库，也不在环境变量 | 在 **设置 → 模型** 里填 key（写入 `~/.dsh/.credentials.yaml`）；或设好环境变量后**重启 DSH**（环境变量只在启动时读） |
| 某个候选名 `present: true` 但状态是 `unconfigured` | 名字对了，但凭据缝解析没返回值 | 看 `probe.lastResolveError`；凭据库文件被外部改动/只读时会这样 |
| `present: true` 且状态 `error` + `errorCode: 'auth'` | key 找到了，上游说无效/过期 | 换 key |
| `probe.seam: 'none'` | 凭据服务没拿到（插件挂载时服务还没就绪） | 重启一次；仍不行就把 `probe` 贴给我 |
| 某供应商压根没出现在面板里 | 没检测到凭据（默认 `auto`） | 在 设置 → 模型 里加 key，或去 `设置 → 额度面板` 把它调成「显示」 |
| `deepseek-account` 显示「未登录 DeepSeek 账号」 | DSH 账号没登录 | 设置 → 账号与余额 里登录 |
| `deepseek-account` 显示「账号服务未就绪」 | 这个组合里没有 `deepseek-account-platform`（例如纯 `dsh web`） | 正常现象；不需要就把它调成「隐藏」 |

> 注意：环境变量是**进程启动时**读的，`set` 完不重启 DSH 不会生效；这也正是
> 「明明设了却还是未配置」的常见成因之一。

## 与天枢（Tianshu-harness）的关系

参考了 [huiliyi37/Tianshu-harness](https://github.com/huiliyi37/Tianshu-harness)（Apache-2.0），
但**没有移植它的面板代码**：那个「模型余额与额度」面板的实现不在公开仓里，而在闭源的
`src/pro/provider-usage/`（`src/server/provider-usage-routes.ts` 里 `loadImplementation()`
只在 `pro/` 与 `server/pro/` 下找模块，公开构建里缺席）。公开仓里真正能复用的是两样东西，
本插件都吃下了：

1. **供应商预设表**（`src/config/provider-presets.ts`）——各家官方 key 页、`apiKeyEnv`
   命名、baseUrl。我用它校准了凭据名与别名，其中一条直接解释了「已配置却显示未配置凭据」：
   天枢给 OpenCode Go 的 `apiKeyEnv` 是 `OPENCODE_GO_KEY`，而 DSH 是 `OPENCODE_GO_API_KEY`。
2. **数据契约**（`src/server/protocol.ts` 的 `ProviderUsageAccount` / `ProviderUsageSnapshot`
   与 `ProviderUsageStatus` / `ProviderUsageError` / `ProviderQuotaPeriod` 词表）——本插件的行
   字段与错误码词表按它对齐（见上表），`kind: 'subscription'`、`period: '5h'|'7d'|'monthly'`、
   `remainingPercent`、`errorCode: 'auth'|'rate-limit'|…` 都取自这里。

顺手记一条天枢侧的可疑缺陷（供上游参考，不是本插件的问题）：它的标准环境变量兜底是
`src/api/factory.ts:97` 的 `` `${name.toUpperCase()}_API_KEY` ``，provider 名用的是
`opencode-go`，于是兜底名成了 **`OPENCODE-GO_API_KEY`（连字符）**，而用户自然会设的
`OPENCODE_GO_API_KEY`（下划线，也是 DSH 的命名）**既不等于预设的 `OPENCODE_GO_KEY`、
也不等于兜底名** → 面板就可能报「未配置凭据」。同一写法还会波及 `zhipu-vision` 等
带连字符的 provider 名。天枢自己的注释里也承认过这类风险（`provider-key-store.ts`
「UI 说未配而请求实际拿得到 key」）。

## 设计取舍

- **零第三方依赖**：只用 Node 内建 `fetch` 与 DSH 的公开缝（`credentials`、`webServer`、
  `slots`），不 import `@deepseek-ai/*`，不碰 DSH 配置与会话日志，纯只读。
- **逐行独立失败**：一个供应商挂了只影响它自己那行（显示错误原因），不影响其他行。
- **不猜数**：上游解析失败就显示「读取失败 + 原因」或 `—`，绝不把读不到当成 0。
- **密钥不出宿主**：浏览器只拿到结果，且路由带同源校验。
- **已知限制**：各家额度接口都不是公开承诺的稳定 API，上游改字段会导致对应行报错
  （改 `PARSERS` 里对应的解析函数即可）；Moonshot 开放平台余额接口只在国际站可用；
  MiniMax / 智谱的窗口语义按社区实测口径归一化，若你的套餐口径不同，改
  `windowLabels` 或解析函数。
