# 本项目架构 vs DSH 官方适配插件体系（对照审计）

> 日期：2026-09-30　项目：`dsh-webcode-bridge` 0.19.51
> 取证基线（**两代不同，必须分开引用**）：
> - `reference/deepseek-harness`（官方 monorepo 源码）= **0.1.7-alpha.2**，HEAD `00102833`
> - 本机实装 `@deepseek-ai/dsh` = **0.2.0-rc.2**
>
> ⚠️ **这不是猜测**：`evaluatePluginCompatibility`（插件兼容门禁）在 0.1.7-alpha.2 源码树里
> **不存在**（glob + grep 全树零命中），它只出现在 0.2.0-rc.2 的编译产物里。
> 凡涉及门禁的结论，本文件都注明「仅 0.2.0-rc.2 起」。
>
> 本文件回答一个问题：**本项目的插件声明面与执行形态，与官方适配插件体系差在哪、
> 哪些差异是「路线不同」、哪些是「真偏离」。**
> 每条结论都有 `路径:行号`，改代码前请重读原文（wiki 纪律同样适用于本文件）。

---

## 0. 一句话结论

本项目的**声明面与官方契约逐字段一致**（`dsh.bundle.patch` + `dsh.client.platform` +
`cordis.patch.yml` 的 `insert/id/name` + `inject` 可选依赖纪律 + `__ModuleLoader__`
客户端 bundle + `registerAdapter` 持有实例）。**没有任何一处是自造协议。**

真正的差异全部落在**执行层**，且是**路线差异而非偏离**：官方插件把「模型」当作
远端 HTTP 端点，本项目把「模型」当作一个**被 playwright 驱动的、随时会改版的网页会话**。
由此派生出本项目独有的 12 类东西（§4），官方体系里没有对应物。

**唯一需要人拍板的一处**：本项目**刻意不调** `registerConfigurableProviders`，
而同类插件 `dsh-codearts-auth` **调了**。§3.1 给出决定性的官方源码证据，
结论是**本项目的做法在当前两代上都是正确的**，但它依赖的是一个**未写进官方文档的
实现事实**（`buildModelCatalog` 只读 `listProviders()`），因此值得在此留档。

---

## 1. 声明面：逐字段对照（**结论：一致**）

| 项 | 官方规范 | 本项目 | 判定 |
| --- | --- | --- | --- |
| `dsh.bundle.patch` | `string \| string[]`，相对包根 | `"./cordis.patch.yml"`（`package.json:39-41`） | ✅ 字符串是合法最简形态 |
| `dsh.client.platform` | 必填，Web 取 `'web'` | `"web"`（`package.json:42-44`） | ✅ |
| `dsh.client.inject` | 可选，**纯信息性**（非 Cordis 服务注入） | **未声明** | ✅ 省略合规；曾误写服务名，0.19.1 已删 |
| `dsh.manifestVersion` | 可选 | 未声明 | ✅ 官方 85 个包 0 个声明 |
| `cordis.patch.yml` | 顶层 YAML 数组，元素含 `insert`/`id`/`name` | 两个 `- insert:` 块（`cordis.patch.yml:3`、`:83`） | ✅ 形状一致 |
| `id` 的语义 | profile 条目 id；0.1.7 起**同时是 settings 表单命名空间** | `webcode-bridge` | ✅ |
| `name` 的语义 | **npm 包名**（且是断言，不是改名） | `dsh-webcode-bridge` | ✅ |
| `exports["./client"]` | 客户端 bundle 入口，**缺了加载期抛错** | `"./lib/client.cjs"`（`package.json:48`） | ✅ |
| `files` 覆盖产物 | 每个相对运行时 import 与产出资产都要被覆盖 | `lib` / `bin` / `cordis.patch.yml` / … | ✅ |
| `main` | 宿主入口 | `"./lib/index.js"` | ✅ |

**`cordis.patch.yml` 语义的三条硬事实**（官方唯一真源 `vendor/include/src/index.ts:76-124`）：

1. `insert` **无** `id` → 直接 push 进层；`insert` **带** `id` → 目标必须是 `group`，
   否则 warn `patch insert: entry %C is not a group`；
2. `name` 是**断言**：不匹配就 `warn('patch: name mismatch …')` 并跳过；
3. 其余键**逐字段覆盖**目标行，`config` 因此是**整体替换、不做深合并**
   （官方文档 `docs/user/develop/basic/publish.md:129` 逐字：
   *a patch replaces a row's entire config value rather than deep-merging keys*，
   `:131` 补 *must restate every key the row needs*）。

> ⚠️ **第 3 条对本项目有实际风险**：本项目的 `cordis.patch.yml` 块 1 一次性写了
> 9 个 config 字段（`port` / `host` / `providerId` / … / `queueTimeoutMs`）。
> 任何后来者若用 `- id: webcode-bridge` + 只写 `config: { port: 9000 }` 去覆盖，
> **其余 8 个字段会全部消失**。本项目目前没有第二个补丁文件，故未踩到。

---

## 2. 宿主侧：注入与注册（**结论：一致，且理由可交叉验证**）

### 2.1 静态 `inject` 只列「一定有」的服务

本项目（`lib/index.js:126`）：

```js
export const inject = ['llm', 'agents', 'sessions', 'sessionProjections', 'subagents'];
```

同类插件 `dsh-codearts-auth`（`reference/deepseek-harness-codearts/src/index.ts:55`）：

```ts
export const inject = ['credentials', 'commands', 'llm']
```

**两个仓库各自把「不一定存在」的服务排除出静态 inject，改走 `ctx.inject([...], cb)`**：

| | 排除的服务 | 理由（逐字要点） |
| --- | --- | --- |
| 本项目 | `webServer`（`lib/index.js:118-124`）、`agentTeams`（`:112-115`） | 只有 web profile 提供；写进 inject 会让 headless profile 整条 entry pending。**真机复现**：`dsh --profile headless "回复两个字：收到"` → `webcode-bridge: pending (waiting for service: webServer)`，退出 1 |
| codearts | `connection`（`src/index.ts:48-54`） | 只由 Web bundle 提供；静态 inject 会让 headless/CLI profile 以 `plugin tree failed to load: 1 entry did not activate` 启动失败 |

⇒ **两个独立仓库踩到同一个真机坑，症状与修法逐字同构。**
这条可以当作**已交叉验证的官方契约事实**（虽然官方文档没有把它写成一条规则）。

官方对「可选服务」的正式表述在 `packages/AGENTS.md`：
*Optional services use `ctx.get(name)`. Reserve `ctx.<name>` for declared injections;
the property proxy is topology-sensitive, while strict `ctx.get` reads the global service store.*

### 2.2 `registerAdapter` + 持有适配器实例

本项目（`lib/index.js:2494-2495`）：

```js
const providerIds = providerIdsForRegistration();
llm.registerAdapter(providerIds, adapter);
```

一次注册 **11 个 provider**：1 个兼容空壳 `webcode` + 10 个 `webcode-<siteId>`
（`lib/providers.js:775-777`）。官方契约 `registerAdapter(providers: string[], adapter: LlmAdapter)`
（`packages/llm/llm/src/index.ts:391`）**形状一致**。

**两边都返回并持有适配器实例**，理由同构：
- 本项目：`listModels` 要在选择器打开时读实时目录；
- codearts：`ctx.llm` 不透传自定义方法，Jet Hub 的「显示列表」需要 `listAllModels()`
  （`src/llm-adapter.ts:1796-1797`）。

### 2.3 `LlmAdapter` 的 7 个方法：本项目全覆盖

官方抽象类（`packages/llm/llm/src/index.ts:204-285`）要求实现 `stream`（唯一 `abstract`），
可选覆盖 `providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` /
`resolveModel` / `prepareCall`。本项目 7/7 全覆盖（`lib/index.js:1019-1146`）。

**一处已登记的缺口**：官方类级 JSDoc 逐字要求
*Every provider HTTP request must include `attributionHeaders()`*
（`packages/llm/llm/src/index.ts:200-202`），本项目 `lib/` + `bin/` 对该符号**零命中**。
本项目的自洽理由是**它不发 provider HTTP 请求**（只驱动浏览器，
`lib/index.js:7-8` 逐字 *this plugin only ADDS an llm route and a local server*）。
⚠️ **但「不发 HTTP 请求」这个豁免没有写在任何注释或文档里**——见 §6 待办第 1 条。

---

## 3. 两处需要单独判定的差异

### 3.1 `registerConfigurableProviders`：本项目不调，同类插件调（**已判定：本项目正确**）

**本项目**（`lib/index.js:920-926` 逐字）：

```
  // Pure adapter registration (the shape opencode2dsh's adapter mode uses): the
  // provider appears in the model selector immediately and listModels is read
  // live at selector time. We deliberately do NOT also call
  // registerConfigurableProviders — declaring the same provider in the
  // "configurable" directory as well makes the GUI treat it as an endpoint-
  // gated provider and the models never surface in the main selector.
```

**codearts**（`src/llm-adapter.ts:1785-1795`）：两个都调。

**官方源码给出的判定**（这是本文件最硬的一段取证）：

| 事实 | 证据 |
| --- | --- |
| `registerConfigurableProviders` 只写一个**独立的 directory** | `packages/llm/llm/src/index.ts:485-545`，私有字段 `private directory = new Map<string, LlmConfigurableProvider>()`（`:339`） |
| 它的语义是「**声明**一条 adapter 插件**可以通过配置激活**的路由，无论该路由当前是否已注册」 | `packages/llm/llm/src/types.ts:240-245` 逐字：*One provider route an adapter plugin can activate through configuration, **whether or not the route is currently registered*** |
| **主选择器的目录构建只读 `listProviders()`** | `packages/api/session-controller/src/catalog.ts:20`：`const providers = ctx.llm.listProviders()` |
| 实装 0.2.0-rc.2 **同样如此** | 实装 `dsh-api-session-controller/lib/index.js` 的 `buildModelCatalog` 内 `ctx.llm.listProviders()`（同一函数，未变） |
| `listConfigurableProviders()` 的消费者**只有设置页** | 全 monorepo grep：唯一客户端消费者是 `packages/client/ui-settings-models/src/client/store.ts:185` |
| 目录页把两者**join**，并标 `active` | `store.ts:42-68` 的 `joinProviderDirectory(registered, directory)`；`active: active.has(entry.provider)`（`:53`） |

**⇒ 结论**：调 `registerConfigurableProviders` **不会**把 provider 从主选择器里挤掉
（`buildModelCatalog` 根本不看 directory）。它只是让**设置页**多出一行「可配置但未激活」
的 provider 条目。

**但本项目的不调用仍然是对的**，理由换了一条（**这条比原注释更准确**）：

1. 本项目的 provider 是**注册即激活**的（`listModels` 直接读实时站点目录），
   不存在「休眠路由靠配置激活」这个语义——所以 directory 对本项目**没有信息量**；
2. 若声明了 directory，设置页会按 `settingsNs: 'webcode'` 去 join，并渲染
   「已配置 / 未配置」徽章与凭据徽章（`store.ts:199-214`），而本项目的凭据是
   **浏览器 profile 登录态**、不经 `ctx.credentials` —— 会渲染出一个**语义错误的徽章**；
3. 官方 README 对该 API 的定位是 *Expose and activate providers through configuration*
   （`packages/llm/llm/README.md:65`）——本项目没有「靠配置激活」这一层。

> ⚠️ **原注释需要修正**：它说「GUI 会把 provider 当成需要 endpoint 配置的 provider，
> 模型反而不出现在主选择器里」——**前半句方向对**（设置页确实会这么归类），
> **后半句不成立**（主选择器不受影响）。
> 本条已作为文档缺陷登记（§6 待办第 2 条）；**改代码注释前先重读 `catalog.ts:20`**。

### 3.2 前后端通信路线：`ctx.webServer` vs `ctx.connection`

| | 本项目 | codearts |
| --- | --- | --- |
| 控制面 | `ctx.webServer` 上挂 `/__webcode/*`（`lib/index.js:4413-4415`） | `ctx.connection` 的 management RPC（`plugin-src/management-rpc.mjs`） |
| 路由清单 | **从 action 表派生**（`webControl.routes`），不手写第二份（`lib/index.js:4306-4315`） | RPC 端点表 |
| 挂载次数 | **两次**：webServer 同源（主）+ 本地 relay `/bridge/web/*`（回落） | 一次 |
| 安全姿态 | Host 必须回环 + 跨站拒绝 + Origin 白名单 | 未在本轮取证 |

**判定**：两条都是合法路线，官方没有规定必须用哪一条。
本项目的「同源挂载」还额外获得一个官方生态里的先例（`deepseek-web-import` 同款，
`lib/index.js:4292-4294` 逐字 *same pattern deepseek-web-import uses*）。
**这不是偏离。**

---

## 4. 本项目独有的东西（官方插件体系里**没有对应物**）

> 判定口径：官方 monorepo 全树 grep 不到对应能力，且它由本项目的**路线**（驱动真实网页）
> 必然派生。这些**不是**「不合规」，而是「路线不同」。

| # | 独有物 | 为什么官方没有 | 代码位置 |
| --- | --- | --- | --- |
| 1 | **playwright 驱动的真实浏览器** | 官方 provider 是远端 HTTP 端点，不需要浏览器 | `lib/browser-driver.js:1-19`；唯一运行依赖 `playwright-core` |
| 2 | **网页会话 / 会话槽** | 官方是 API session（无状态请求） | `lib/browser-driver.js:1330` 的 `sessionSlot` 只读投影 |
| 3 | **从正文文本解析工具调用**（`mcp_action` 围栏） | 官方 provider 走原生 OpenAI `tools`/`tool_calls` | `lib/agent-preset.js:1-12` |
| 4 | **控制面 action 表（42 条路由）** | 官方 UI 直接走 `ctx.remote.*`，不需要自定义 HTTP 面 | `lib/web-control.js:480` 起 |
| 5 | **任务台账（任务不寄生在会话上）** | 官方任务图在 `experimental/agent-team`，且权威状态是 Lead 会话事件日志 | `lib/task-ledger.js:1-13` |
| 6 | **并列多列（2–4 列）Team** | 官方 Team 形态是 agent-team 花名册 + 任务板 | `lib/client.cjs:6462-6488` |
| 7 | **同源镜像（把真实站点注入右栏）** | 官方 `ui-sidebar-browser` 是 iframe + 另一个 cookie 罐 | `lib/mirror.js:1-14` |
| 8 | **思考等级真源（含回读判定）** | 官方 `reasoning` 由 adapter 声明即可，无「回读网页 UI」问题 | `lib/think-effort.js` |
| 9 | **账户槽（站点 × 槽）+ 跨进程单实例锁** | 官方凭据是 `ctx.credentials` 的 ref | `lib/accounts.js`、`lib/bridge-lock.js:1-14` |
| 10 | **站点声明渐进迁移（`lib/sites/`）** | 官方每个 provider 一个包 | `lib/sites/index.js:34-36`（当前仅 `deepseek`） |
| 11 | **判据层（纯函数、可离线反向验证）** | 官方无对应层 | `zero-progress.js` / `repeat-detect.js` / `wait-stats.js` 等 |
| 12 | **提示词基准 harness** | 官方无「教网页模型用工具」这个问题 | `lib/bench.js` + `test-mock/prompt-bench.mjs` |

**其中 #3 与官方的根本冲突点**（这是本项目最大的结构性差异）：
官方把工具调用当作**协议字段**，本项目把它当作**提示词教学质量问题**。
后果：本项目的成功率直接取决于提示词，且必须处理「模型写错工具名」这类官方不存在的失效形状
（`lib/index.js:2487-2493` 的兼容空壳 provider 就是为此而存在）。

---

## 5. 边界：本项目**不做**的事（与官方约束一致）

| 官方约束 | 本项目状态 | 证据 |
| --- | --- | --- |
| 只走文档化的扩展点，不改 agent-loop | ✅ 只注册 llm 路由 + 本地服务 + UI 插槽 | `lib/index.js:7-8` |
| 不替换 `fs`/`shell`/`skills`/`MCP` 注册表 | ✅ 运行时零命中 `ctx.fs`/`ctx.shell`/`ctx.skills`/`ctx.mcp`/`ctx.tools` | 实测 grep 全 0 |
| 不自造审批 | ✅ 用户可见的「审批」全由官方承担；桥只做自己领域的 `requireConsent` 同意闸 | `doc/compliance-audit-0.19.1.md:83-85` |
| `every contribution goes through ctx.effect()` | ✅ 客户端用 `ctx.effect`（`lib/client.cjs:6033-6040`） | 官方 `AGENTS.md` *Registrations are effects* |
| UI 插件不替换 app root / 不读别的插件的 DOM | ✅ 只 `slots.register` | `lib/client.cjs:6049` 起 10 处注册 |
| 图标 ≤256 KiB、留在 manifest 目录内 | ✅ `icon.svg` | 官方 `package-meta.ts:24-40` |

**唯一一条本项目**有**而官方明令禁止的相邻行为**：本项目在客户端**手写单文件
`client.cjs`**（无构建步骤）。官方客户端插件的规范做法是**多文件源码 + 打包产物**
（`dsh.client.external` / 模块图 / `require.async` 那一整套）。
但本项目的做法**不违反**任何一条：它产出的是合法的 `__ModuleLoader__` bundle、
只用平台种子（`react` / `react-dom` / `primitives`）、无相对 `require`。
代价是**丢失了官方的模块图排序与 `external` 契约能力**——本项目用不到它们
（没有多文件、没有非基座依赖），故这是一个**有意的取舍**，不是缺陷。

---

## 6. 待办与未决项（**不要在别处当结论引用**）

| # | 项 | 现状 | 建议 |
| --- | --- | --- | --- |
| 1 | `attributionHeaders()` 豁免未声明 | `lib/` + `bin/` 零命中；理由是「不发 provider HTTP 请求」，但**没有任何注释/文档写明** | 在 `lib/index.js` 的 adapter 段加一句显式豁免说明（官方类级 JSDoc 要求了它，读者会来问） |
| 2 | `lib/index.js:920-926` 注释的后半句不准确 | 「模型反而不出现在主选择器里」被 `catalog.ts:20` 证伪（主选择器只读 `listProviders()`） | 按 §3.1 的三条理由改写注释；**不要**因此改成调用它 |
| 3 | 本项目未声明 `@deepseek-ai/dsh-llm` 等 peer | 只声明 optional 的 `dsh-client-ui-sidebar-right`（`package.json:81-88`） | ⚠️ **仅 0.2.0-rc.2 起**：`evaluatePluginCompatibility` 会逐条比对 `@deepseek-ai/dsh*` peers。不声明 = 不参与门禁 = 不拒绝；是否需要声明取决于「是否要与宿主共享同一个服务实例」。同类插件 codearts 声明了并论证「必须枚举 prerelease tuple」 |
| 4 | `Config` 是否必须是 schemastery | 本项目用 `settingsNs: webcode`，未验证 | codearts 的实测：裸函数会让 `SettingsForms.describe()` 抛 `.toJSON is not a function`，**连带整块 settings 界面失效**（`src/index.ts:69-72`） |
| 5 | 官方 monorepo 是 0.1.7-alpha.2，实装是 0.2.0-rc.2 | **两代不同** | 任何「官方源码如此」的结论都要注明版本；涉及兼容门禁的必须用实装产物 |
| 6 | `reference/dsh-official-plugins/` 是历史快照 | tarball 里的 `ui-subagent@0.0.1-rc.1` 依赖 `dsh-client-runtime` / `dsh-client-ui-slash`，**这两个包在当代不存在** | 抄实现必须回 monorepo `packages/client/**`，别用那份 tarball |

---

## 7. 附：本文件用到的关键官方文件

| 文件 | 行数 | 用途 |
| --- | --- | --- |
| `packages/util/package-manifest/src/types.ts` | 94 | `dsh` 字段全部类型定义 |
| `vendor/include/src/index.ts` | 343 | **patch 语义唯一真源**（`applyEntryPatches`） |
| `packages/boot/app-boot/src/profile.ts` | 717 | profile/bundle 发现、层叠顺序 |
| `packages/llm/llm/src/index.ts` | 1153 | `ctx.llm` 全部注册 API + `LlmAdapter` 契约 |
| `packages/llm/llm/src/types.ts` | 526 | `LlmConfigurableProvider` 语义（§3.1 的关键） |
| `packages/api/session-controller/src/catalog.ts` | 67 | **`buildModelCatalog` 只读 `listProviders()`**（§3.1 的决定性证据） |
| `packages/client/ui-settings-models/src/client/store.ts` | 340 | `listConfigurableProviders` 的**唯一**消费者 |
| `packages/client/modules/src/client/manifest.ts` | 448 | `__ModuleLoader__` 线协议 |
| `docs/subsystems/slots.md` | 198 | **可用 slot id 权威清单** |
| `docs/user/develop/basic/publish.md` | 189 | 层叠顺序、config 整体替换、git 安装陷阱 |

**同类插件对照**：`reference/deepseek-harness-codearts`（`dsh-codearts-auth`，11 个 provider）
—— 它的声明面取证见 [`reference/local-refs/deepseek-harness-codearts-reference-notes.md`](../reference/local-refs/deepseek-harness-codearts-reference-notes.md)。

---

本文件是审计记录，**不是运行链路的一部分**；改动或删除本文件不影响任何行为。
