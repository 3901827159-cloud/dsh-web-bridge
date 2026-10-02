# `dsh-codearts-auth` 与本插件的实现对照（2026-10-02）

> **这份文档回答什么**：`https://gitee.com/iJetLi/deepseek-harness-codearts`
> 这个插件**怎么实现的**，以及它的对接方式与本仓库（`dsh-webcode-bridge`）
> **有哪些不同**。
>
> **证据级别**：两边都是**读源码得到的**（不是读 README 得到）。codearts 侧读的是
> 本机 web profile 里装好的 `lib/`（已更新到 `c74e0c2`），本仓库侧读的是
> `package/dsh-webcode-bridge/lib/`。凡本文件写「实测」「实读」的，都是本次会话
> 真跑过的命令或真打开过的文件；凡引自对方 README 的，都标明是 README 的说法。
>
> **时效**：codearts 侧处于高速迭代（210 次提交、当晚仍在改），本对照是
> `c74e0c2` 这个快照的读数。它**不是**长期结论，只是这一版的事实。

---

## 0. 一句话结论

**两者都用「一个 provider = 一组模型」接进 DSH 的 `ctx.llm`，但后端完全不同：**

- **codearts** 是**协议客户端**：拿到厂商凭据后，直接用 HTTP `fetch` 打厂商的
  **私有 API 端点**（OpenAI 兼容或 Anthropic Messages），请求体里带**原生 `tools` 字段**，
  工具调用由服务端以结构化 `tool_calls` 返回。
- **本插件** 是**浏览器驱动**：用 Playwright 打开**真实网页**，往输入框里填文本、
  点发送，然后**拦截网页自己的 SSE**，再把网页**用自然语言说出来的**调用
  **解析回**结构化 tool-call。

一句话概括差别：**codearts 的对手是「端点」，本插件的对手是「网页 UI」。**

---

## 1. 两个插件的规模与身份

| | `dsh-codearts-auth` | `dsh-webcode-bridge` |
|---|---|---|
| 包名 / 入口 | `dsh-codearts-auth` / `lib/index.js` | `dsh-webcode-bridge` / `lib/index.js` |
| 插件 `name` | `codearts-auth` | `webcode-bridge` |
| `inject` | `['credentials','commands','llm']` | `['llm','agents','sessions','sessionProjections','subagents']` |
| 注册的 provider 数 | **12** | **11**（其中 1 个是空壳） |
| provider id | `codearts` `buddy` `workbuddy` `lobsterai` `qoder` `qodercn` `trae` `cline` `loomy` `raccoon` `minimax` `zcode` | `webcode`（空壳）+ `webcode-{deepseek,glm,chatgpt,kimi,qwen,doubao,grok,claude,gemini,zai}` |
| 模块数 | `lib/` 下 114 个 `.js` | `lib/` 下 47 个 `.js` + `sites/` 2 个 + `client.cjs` |
| 客户端 bundle | `lib/client/jet-hub.js`（273 KB，esbuild） | `lib/client.cjs`（单文件 CJS） |
| 运行时依赖 | `jose`（DPoP 签名）+ cosmokit + schemastery | **`playwright-core`**（唯一） |
| 测试 | vitest + ~35 个 env 门控 e2e | `node --test`，120 个 `.mjs` |

两边**都**通过 `package.json` 的 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`，
由 profile 的 `dsh.profile.bundles` 自动拾取——**这一层机制完全一致**。

---

## 2. 注册方式：几乎相同

两边都是「一次调用注册一组 provider id」：

```js
// codearts: lib/llm-adapter.js:1794
registerAdapterIdempotent(ctx.llm, [PROVIDER], adapter);
```

```js
// 本插件: lib/index.js:2540-2541
const providerIds = providerIdsForRegistration();
llm.registerAdapter(providerIds, adapter);
```

**codearts 多一层**：`llm-register-compat.js` 把 `registerAdapter` 包成**重启幂等**——
cordis 重启插件 fiber 时，新 `apply` 的同步注册与旧 fiber 的异步 `dispose` 会在
adapter 目录这个 Map 上赛跑，撞出
`an adapter for provider "minimax" is already declared`，**整个 Jet Hub RPC 因此不可用**。
它只吞「重复注册」这一类错误（按错误码**或**文案判），非重复失败照抛。

> 这条**本插件没有**：本插件只注册一次、`providerIds` 一次给全，
> 没有这个竞态窗口（它每站点一个 provider，是 11 个 id 一次交出去）。

**codearts 还刻意停用了 `registerConfigurableProviders`**（`llm-register-compat.js`
文件头有完整论证）：声明过的 provider 会在「设置 → 模型 → 提供商」里**常驻**
12 行带 API 密钥/baseURL 编辑框的行，而它凭据走账号池、根本不读那些字段，
且传 `settingsPath: []` 会让 `configured` 判据**恒真**⇒永远无法从页面上消失。

---

## 3. 核心差异：一次模型请求到底发生了什么

### 3.1 codearts：HTTP 打厂商私有端点

以 `codearts` provider 为例（`lib/llm-adapter.js`）：

```js
// :10
export const CHAT_API_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2';
// :950
const url = `${CHAT_API_BASE}/chat/completions`;
```

请求体（`:918-949`）是**标准 OpenAI chat/completions 形状**，且**带原生 `tools`**：

```js
{
  model, messages, stream: true,
  prompt_cache_key: this.sessionId,
  include: ['reasoning.encrypted_content'],
  reasoning_summary: 'auto',
  tool_stream: true,
  max_tokens: options.maxTokens ?? 65536,
  ...wireTools.length > 0 ? { tools: wireTools } : {},   // ← 原生 function 格式
}
```

`tools` 的构造（`:890-897`）：

```js
const tools = options.tools?.map((tool) => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
}));
```

**这是最关键的一条**：工具调用是**服务端返回的结构化字段**（SSE 里的
`delta.tool_calls[]`），不需要教学、不需要解析正文。

### 3.2 本插件：Playwright 驱动真实网页

`browser-driver.js:19` `import { chromium } from 'playwright-core';`
`browser-driver.js:2072` `chromium.launchPersistentContext(cfg.profileDir, {...})`

一次 `stream()` 的路径（`lib/index.js:1192` 起）：
构造首轮 preset → `relay.submit()` 入队（车道 + 同意门）→ 驱动开/复用持久
profile → 导航 → 分块填输入框 → 点发送 → **注入捕获脚本拦截网页自己的 SSE**
（`exposeBinding('__webcodeChunk')` + `addInitScript`）→ 解码器把网页流变成
`onDelta/onThink/onImage` → **`parseAgentReply()` 从正文文本里扫出调用**。

**请求体里没有 `tools` 字段**——因为对面是网页的输入框，不是 API。工具清单是
**用自然语言写进提示词**的（`agent-preset.js:460` `'# 可用本地工具'`、
`:465` `'# 工具调用格式'`）。

### 3.3 这张对照表

| 维度 | codearts | 本插件 |
|---|---|---|
| 后端 | 厂商私有 HTTP 端点 | 真实网页（Playwright） |
| 凭据 | OAuth/设备码换来的 token、AK/SK | 浏览器登录态（持久 profile 的 cookie） |
| 工具声明 | 请求体原生 `tools[]` | 提示词文本（`# 可用本地工具`） |
| 工具调用来源 | 服务端结构化 `tool_calls` | **模型正文里的围栏**，本地解析 |
| 调用形状 | OpenAI / Anthropic 标准 | `{"mcp_action":"call",…}` 自定协议 |
| 失败形态 | HTTP 码 / 业务码 | 选择器失效、网页改版、会话丢失 |
| 并发单位 | 账号（池）+ 请求 | **账号（一个浏览器实例 + 一个输入框）** |

---

## 4. 协议族：codearts 支持两族，本插件只有一族

codearts 的 12 个 provider 分属**两个协议族**：

- **OpenAI chat/completions（10 个）**：`codearts` `buddy` `workbuddy` `lobsterai`
  `qoder` `qodercn` `trae` `cline` `loomy` `raccoon`。
  共享层是 `lib/openai-compat.js`（`serializeMessages` / `consumeOpenAiSse`）。
  ⚠ 但**共享层只被 4 个用**（qoder/loomy/raccoon/cline）——`openai-compat.js` 文件头
  明说 buddy/lobsterai **故意保留各自的 inline 副本**（避免高风险重构）。
- **Anthropic Messages（2 个）**：`minimax`（`minimax-messages.js`）与
  `zcode`（`zcode-anthropic.js`）。**两份独立实现，刻意不抽象**——因为各只有一个消费者。

本插件**只有一族**：网页文本 + `mcp_action` 围栏。协议真源是
`lib/agent-preset.js` 一处（本仓库三条红线之三）。

---

## 5. 工具调用处理：这是最本质的分野

### 5.1 codearts：服务端给结构化数据，本地只做「形状归一化」

它的难点**不是「猜模型想调什么」**，而是**「把 harness 的形状翻译成厂商要的形状」**：

- `lib/message-shape.js` — DSH 0.1.7 起工具结果是**一等消息**
  （`role:'tool'` + 顶层 `toolCallId`）。`detectMessageShape()` 按**形状**（不是版本号）
  判 `'tool-role' | 'legacy' | 'none'`，`normalizeHarnessMessages()` 把
  `role:'tool'` 降级成 `role:'user'` 包一个 `tool-result` 块。
  **真实缺陷**：不做这步时 `resolveToolPairing` 的结果 id 集恒为空 ⇒
  **所有** assistant `tool_calls` 被从请求里剥掉。
- `lib/openai-compat.js` — **工具名不可用前一个 chunk 都不发**
  （否则 `BlockAssembler` 落盘 `{name:''}`，之后每次请求 400 `11133`）。
- `lib/minimax-messages.js:293-325` — **成对提交**：assistant 消息进 `pendingAssistant`，
  与累积的 `tool_result` 一起 flush。Anthropic 要求结果紧跟 `tool_use`，
  三种错法都报 `2013`。

### 5.2 本插件：从散文里**解析**调用

`agent-preset.js`（2952 行）同时做四件事：**教学 / 解析 / 回放 / 增量**。

- **教学**：首轮发完整 preset，每 `TRAIN_EVERY = 5` 个工具结果**再教一次**
  （`:19`，用于 `:776`/`:797`）。且**分站点换形状**：GLM 只给 ```json 代码块
  （它页面有原生执行器会**抢走** `<tool_call>` 标签），DeepSeek 给官方 token 模板。
- **解析**：`parseAgentReply()`（`:2443`）先 `normalizeOfficialToolCalls()`，再跑
  **五条独立形状分支**（代码围栏 / GLM 原生 key=value / `<tool_call>` 标签 /
  裸 `{"mcp_action":…}` / `**Calling:**`）汇进同一个 `takeObj` 接受器。
  它**刻意不按会话工具表过滤**（`:2520-2534`），那是 `index.js` 的事。
- **回放**：`index.js:1618-1631` 产出**真正的 DSH 原生 chunk**：
  ```js
  yield { type: 'block-start', index: idx, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: idx, id, name: rc.name, argumentsDelta: args };
  yield { type: 'block-end', index: idx, block: { type: 'tool-call', id, name: rc.name, arguments: args } };
  ```
  id 是**合成的**：`` `call-webcode-${sessionId}-${callSeq}-${i}` ``。
- **增量**：`serializeDelta()`（`:767`）严格 `msgs.slice(sent)`，**assistant 消息整个跳过**
  （`:805` 注释：正文已经在网页那边了）。

**一句话**：codearts 的「解析」是**字段搬运**；本插件的「解析」是**从散文里
逆向出意图**——这也是本插件提示词工程占这么大篇幅的原因。

---

## 6. 凭据与账号：思路相似，存储不同

**两边都是「账号池」**，都支持多账号、启用/停用、拖拽排序（顺序即选号优先级）、
按 `(账号, 模型)` 记限流标记、到期续期。

| | codearts | 本插件 |
|---|---|---|
| 秘密存放 | `ctx.credentials`，ref = `{PROVIDER}_ACCOUNT_{HEX}` | 浏览器持久 profile（cookie/登录态）+ `accounts.js` 账户槽 |
| 索引状态 | `$DSH_HOME/jet-hub/state.json`（tmp+rename） | 见 `lib/accounts.js` |
| 单凭据回退 | 已移除（ref 仍留在管道里但**不写不读**） | — |
| 续期 | **有**：per-ref 串行队列 + 到期前 1h + 30 分钟调度器 | **不需要**：登录态由浏览器自己维持 |
| 选择 | `getAvailableAccount()`：`enabled` + 排除 + 限流过滤，**不重排** | `accounts.js` 账户槽解析 |

**两处值得记下的设计**：

1. **codearts 的 per-ref `SerialQueue`**：三个入口（30 分钟 `refreshAll`、推理时按需
   刷新、账号卡片按钮）会同时来抢**同一个会轮换的 `refresh_token`**。串行化 + 锁内
   重读短路（`sameCredential` 比 value）是必需，不是优化。
2. **codearts 把永久锁定状态放独立文件**（`permanent-locks.json` 而非 `state.json`）：
   因为 `state.json` 是 **dsh home 级、同机多 profile 共享**的，而它的存储是
   整体替换语义——另一侧旧版本任何一次写入都会抹掉它不认识的字段，
   后果是**真把永久积分烧掉**。本插件无此问题（没有积分概念）。

---

## 7. 控制面 / UI：两套完全不同的接法

| | codearts | 本插件 |
|---|---|---|
| 传输 | `ctx.connection.fetch.register({ path: '/api/jet-hub', methods:['POST'] })` | `webServer.register` 挂 `/__webcode/*` **+ 本地中继**回落 |
| 形状 | JSON-RPC（`{type:'client-request', method:'jet-hub', call:{method,payload}}`） | 一张 `'<METHOD> <suffix>'` **action 表**（42 项） |
| 方法数 | 34 个 `case`（`account.*` `login.*` `credits.*` `model.*` `captcha.*` …） | 见 `web-control.js` 的 action 表 |
| 客户端挂钩 | `settings.section` 槽（order 50）+ 一个 provider-card 槽 | `slots` / `sidebarRightTabs` / `sidebarRight` 共**五个**槽 |
| 客户端 bundle | `window.__ModuleLoader__.load({ id:"dsh-codearts-auth" })` | `window.__ModuleLoader__.load({ id:'dsh-webcode-bridge' })`（同机制） |

**`connection` 的注入方式两边都踩过同一个坑**：codearts 用
`ctx.inject(['connection'], …)` **惰性注入**（`jet-hub-rpc.js:444`），因为 `connection`
只存在于 Web bundle，静态 `inject` 会让插件在 `--profile headless` 下永久
`pending`、整个 profile 启动失败。本插件把 `webServer` 排除在静态 `inject` 外、
改用可选嵌套注入——**同一个理由**。

**本插件独有的第二块**：`mirror.js` 的同源镜像（把真实站点经
`/__webcode/*` 反代进右栏，合并驱动 profile 的 cookie）。codearts **没有**镜像——
它的面板只管账号/积分，不显示厂商网页。

---

## 8. 「浏览器」在两边扮演的角色完全不同

这是最容易误判的一点：**codearts 也用浏览器，但只用于一件事**。

- **codearts**：`lib/zcode-captcha.js` 用一个**有头 chromium**（CDP，零第三方依赖）
  只为 ZCode 每日领取**产一个阿里云 captcha param**。
  推理路径**完全不用浏览器**。而且它**偏好**用 DSH 桌面版自己的 Electron 内核当载体
  （`captcha-carrier-server.js` 起一个独立端口的静态页，
  因为桌面版主进程的 `isApplicationHost` 判据是 `u.port === host.port`——
  挂插件自己的 API 端口上会被 `allowedNavigation` 拦掉，**换端口**才绕得开）。
- **本插件**：浏览器**就是后端**。每个账号一个持久 profile、一个浏览器实例、
  一个输入框，`relay.js` 按账号分车道串行化。

> 所以「都用 Playwright」这种说法是错的：本插件把 playwright 当**执行器**；
> codearts 把它当**一次性验证码工厂**，且只在 web 版兜底路径上。

---

## 9. 本插件与它「不同之处」的完整清单

按重要性排序：

1. **后端性质**：网页 UI vs 私有 API。这决定了后面几乎所有差异。
2. **工具调用来源**：从散文解析（有教学成本、有解析失败）vs 服务端结构化字段。
3. **协议真源**：`agent-preset.js` 一处自定协议 vs 复用 OpenAI/Anthropic 两族标准。
4. **凭据本质**：浏览器登录态（cookie，无需续期）vs token/AK-SK（必须续期）。
5. **并发模型**：按账号分车道 + 单输入框串行 vs 账号池 + 并发 HTTP 请求。
6. **失败模式**：网页改版 / 选择器失效 / 会话丢失 vs HTTP 码 / 业务码 / 限流。
7. **镜像**：有同源镜像把站点搬进右栏 vs 无。
8. **provider 语义**：11 个 id 里含一个**空壳 `webcode`**（只为旧设置仍
   `routeServed`，`listModels` 返回 `[]` 所以不显示成组）vs 12 个都是真实路由。
9. **注册竞态**：codearts 需要 `registerAdapterIdempotent` 兜 cordis fiber 重启；
   本插件一次交全部 id，无此窗口。
10. **依赖**：本插件把 `playwright-core` 当**运行时必需**；codearts 运行时只有
    `jose`，浏览器是可选的兜底工具。

---

## 10. 从对方那里可以确认的、对本仓库有用的结论

（这些是**读对方源码得到的印证**，不是要求照搬。）

1. **`message-shape.js` 的按形状判据是对的**：它按 `message.role === 'tool'` 判而非
   版本号，并明说「该形状自 0.1.7 引入，0.2.0-rc.2 仍在用」。本仓库若将来要处理
   工具结果形状，这条**形状优先于版本**的判据可以直接用。
2. **「工具名不可用前不发 chunk」是一条通用护栏**：`BlockAssembler` 会落盘
   `{name:''}` 并让后续请求 400。本插件同样有「空名字 tool_call」的修法。
3. **`registerConfigurableProviders` 的陷阱是可复现的**：声明 + `settingsPath: []`
   ⇒ `configured` 恒真 ⇒ 页面上出现永远删不掉的行。本仓库已有
   `doc/architecture-vs-official-plugins.md` 讨论过这条，对方用**实测现象**印证了它。
4. **`SerialQueue` + 锁内重读**是处理「会轮换的 refresh_token 被多入口抢」的标准解。
5. **`prepare` 构建 + pnpm 10/11 `allowBuilds` 键不兼容**：本机实测的 pnpm 是
   **11.25.0**，本次更新用的键是**不带 `#<commit>` 的纯包名形式**，而它**成功了**——
   与对方 README（`:87-96`）宣称「pnpm 11 必须带 commit，纯包名永远匹配不上」**不符**。
   见下节。

---

## 11. ⚠ 一处与对方 README 不符的实测读数

对方 README（`## 安装` → `方式一` → 第 2 步）声称：

> 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 的（**pnpm 11.x**，如本机实测的一版
> DSH Desktop 内置 pnpm 11.7.0）—— git 托管包**不认**纯包名键，必须用第 1 步
> pnpm 打印的**完整键（含 `#<commit>`）**。

**本机实测不成立**：

- 本机 pnpm = **11.25.0**（`pnpm --version`）。
- profile 的 `pnpm-workspace.yaml` 里用的键是
  `'dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git': true`
  —— **纯 git 形式、不带 `#<commit>`**（也不带 `@version`）。
- 本次 `dsh plugin --profile web add "https://gitee.com/…codearts.git"` **成功**：
  `prepare` 跑了 `build:all`，`lib/` 114 个 `.js` 生成，client bundle 273 KB 写出，
  lockfile 从 `#af20398` 升到 `#c74e0c2`。

⇒ **「pnpm 11 不认纯包名键」这条至少在 pnpm 11.25.0 上不成立**。
（可能对方那台是 11.7.0 的旧行为，也可能与 `dangerously-allow-all-scripts=true`
出现在用户 `~/.npmrc` 里有关——**本机确实有这一行**，它可能让 `allowBuilds` 根本没被
用到。**这一条未做隔离实验，不当作结论**。）

**留待复核**：若将来换机器遇到 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，
按对方 README 的「完整键（含 commit）」写法试；本机当前的成功配置**不要动**。

---

## 12. 本次更新的实测记录（可复现）

```powershell
# 1) 更新前
#    lockfile: git+…codearts.git#af2039800ac2875a5ef8edc7d1842cfc1ef71ae9  (2026-09-30)
#    lib/: 95 个 .js；无 minimax-*.js

# 2) 执行
dsh plugin --profile web add "https://gitee.com/iJetLi/deepseek-harness-codearts.git"

# 3) 更新后
#    lockfile: git+…codearts.git#c74e0c288ce34b5c29bb08a92537fef871b0a0c5  (2026-10-01)
#    lib/: 113 个 .js（+18 个新模块），client/jet-hub.js 160918 → 273328 字节
```

**新增的 18 个模块**：

```
captcha-carrier-server.js   captcha-carrier.js       captcha-requirement.js
captcha-supply.js           cline-models-dev.js      cline-quota.js
cline-request-log.js        cline-routing.js         llm-register-compat.js
minimax-adapter.js          minimax-auth.js          minimax-credits.js
minimax-messages.js         minimax-oauth.js         minimax-product.js
minimax.js                  remote-catalog-gate.js   zcode-carrier-page.js
```

**验证读数**：

| 检查 | 结果 |
|---|---|
| lockfile commit | `c74e0c2` ✅ |
| `allowBuilds` 键是否需要改 | **不需要**（原键照旧生效）✅ |
| `lib/minimax-*.js` 7 个 | 全部存在，非空 ✅ |
| `node --check` 新模块 + client bundle | 全部通过（exit 0）✅ |
| `import('dsh-codearts-auth')` | `IMPORT OK`，导出 `Config,apply,inject,makeReadImage,makeReadImageRequest,name` ✅ |
| profile `package.json` / `pnpm-workspace.yaml` | 与更新前**逐字节相同** ✅ |

⚠ **未验证项**：**运行中的 `dsh web`（PID 2936，`127.0.0.1:3080`）仍在跑旧代码**——
装插件只换磁盘文件，不重载进程。要让新版本生效必须**重启 `dsh web`**。
本次**没有**重启（那会中断当前会话），故 `minimax` / `zcode` 的新增能力
**尚未在真机行使过**。

---

## 13. 一句话给下一个接手的人

**codearts 与本插件不是「同类插件的两个实现」，而是「同一个接口（`ctx.llm`
注册 provider）背后的两种截然不同的后端」**：它对接**端点**，我们对接**网页**。
因此它的代码里大量是「形状归一化 / 业务码 / 续期竞态」，我们的代码里大量是
「选择器契约 / 提示词教学 / 正文解析」。**照搬它的任何做法之前先问：
那条做法依赖的是「对面是 API」还是「对面是网页」。**
