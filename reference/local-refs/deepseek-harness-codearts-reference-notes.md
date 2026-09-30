# `deepseek-harness-codearts` 参考笔记（官方插件体系的**活体范例**）

> 抓取时间：2026-09-30。来源：<https://gitee.com/iJetLi/deepseek-harness-codearts>
> 本地目录：`reference/deepseek-harness-codearts`（纯 `git clone`，不入库）
> 取证版本：HEAD `af2039800ac2875a5ef8edc7d1842cfc1ef71ae9`（2026-09-30 00:30 +0800，`master`）
>
> **本笔记的用途**：本项目（`dsh-webcode-bridge`）要对齐「DSH 官方适配插件体系」时，
> 这个仓库是一份**能跑、且已发布过多个真实缺陷修复**的同类插件——它比官方文档更具体地
> 展示了「一个 DSH 插件到底由哪些声明面组成」。凡本笔记的结论都给了 `文件:行号`，
> **改本项目对应位置前请重读原文**（wiki 纪律同样适用于参考笔记）。

---

## 1. 它是什么

一个 **DSH 插件**，包名 `dsh-codearts-auth`，对外描述是「华为云 CodeArts 浏览器登录 +
凭据管理」，但它实际已经长成**十一个 LLM provider 的聚合插件**：

| provider id | 是什么 | 与其它 provider 的关系 |
| --- | --- | --- |
| `codearts` | 华为云 CodeArts（`SDK-HMAC-SHA256` 签名，非 Bearer） | 独立 |
| `buddy` | 腾讯 CodeBuddy 中国版 | 与 `workbuddy` **同源** |
| `workbuddy` | 腾讯 WorkBuddy 国际版 | 差异收敛在 `src/product.ts` 的产品配置 |
| `lobsterai` | 有道 LobsterAI（龙虾） | 独立 |
| `qoder` | 阿里系 Qoder | 与 `qodercn` **同协议族、共用同一份 WASM** |
| `qodercn` | Qoder 中国版 | 同上 |
| `trae` | 字节跳动 TRAE | 独立（SOLO 格式请求体 + 自定义 SSE） |
| `cline` | Cline 桌面端 | 独立 |
| `loomy` | 讯飞 Loomy 办公助手 | 独立（唯一短信验证码登录、唯一不能自动续期） |
| `raccoon` | 商汤 Raccoon Work（小浣熊） | 独立 |
| `zcode` | 智谱 Z.ai 免费额度 | 独立（最新加入，含 captcha 护栏） |

证据：`README.md:117-127`（「除 `codearts` 外，插件另注册十个独立的 provider 路由」）；
`src/index.ts:233`（`registerCodeArtsLlm`）、`:1250-1259`（十个适配器实例的注册表）。

**规模实测**（`git`/`fs` 读数，2026-09-30）：

| 项 | 值 |
| --- | --- |
| 提交数 | 158 |
| `src/*.ts` | 99 个文件 + 1 个 `.wasm`（`qoder-auth-wasm.wasm`，291.6 KB） |
| `src/` 总行数 | 49,897 |
| `tests/unit` | 144 个文件 |
| `tests/e2e` | 42 个文件 |
| `plugin-src/client/` | 12 个文件（esbuild 打包入口 `index.js`） |
| `docs/` | 4 份 md |
| `README.md` | 1,587 行 |
| `AGENTS.md` | 4,365 行 / **381,163 字节**（比本项目 AGENTS.md 大两个数量级） |
| 仓库体积 | 9.6 MB |
| 首次提交 | 2026-08-14（`872128a init`） |

> ⚠️ **`AGENTS.md` 的体量本身就是一条信息**：它把每个 provider 的**真实缺陷与踩坑**
> 逐条写进去（「真实缺陷」出现数十次）。这个仓库的做法是**把排障结论写进给 AI 读的
> 指令文件**，而不是只写进 changelog。本项目 `doc/` + `wiki/` 的分工更细，但可以对照：
> 它的 `AGENTS.md` ≈ 本项目的 `doc/long-term-issues.md` + `doc/comment-style.md`。

---

## 2. 为什么它对**本项目**特别重要

本项目与它的**目标同构**：都是「给 DSH 增加 LLM provider 路由的插件」。
差别只在**模型从哪来**：

| | `dsh-webcode-bridge`（本项目） | `dsh-codearts-auth` |
| --- | --- | --- |
| 模型来源 | 网页版 AI（playwright 驱动真实浏览器） | 官方/半官方 **HTTP API**（含逆向出的私有端点） |
| 会话载体 | 网页会话（真实 DOM） | 无状态 HTTP 请求 |
| 工具调用 | 网页**正文文本**里解析（`mcp_action` 协议） | 原生 OpenAI 兼容 `tools` / `tool_calls` |
| 凭据 | 浏览器持久 profile 的登录态（cookie/localStorage） | `ctx.credentials` 里的 token / AK-SK |
| 声明面 | 同（都是 DSH 插件） | 同 |

⇒ **两者的「插件声明面」应当逐字一致，而「执行层」完全不同。** 这正是第 2 项任务
（本项目架构 vs 官方适配插件体系）的对照基准：凡差异出现在**声明面**上，就是本项目
可能偏离官方契约的地方；凡差异出现在**执行层**上，那是路线不同，不是偏离。

---

## 3. 声明面逐条取证（可直接对照本项目）

### 3.1 `package.json` 的 `dsh` 字段

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```

证据：`package.json:62-69`。

**`exports` 的关键一条**（本项目对照点）：

```json
"./client": "./lib/client/jet-hub.js",
```

证据：`package.json:13`。⇒ 客户端 bundle 经 **`exports["./client"]`** 暴露，
指向 esbuild 产物 `lib/client/jet-hub.js`。

**`files` 白名单**：`["lib", "locale/*.json", "cordis.patch.yml"]`（`package.json:17-21`）
——**注意 `lib/` 被 gitignore、但必须在 `files` 里**，因为它是构建产物。

### 3.2 `cordis.patch.yml` 的形状

```yaml
# dsh-codearts-auth 配置包补丁：在空配置根上追加插件行。
# 后续配置补丁可通过 id 引用此行。
- insert:
    - id: codearts-auth
      name: 'dsh-codearts-auth'
```

证据：`cordis.patch.yml:1-5`（**全文只有 5 行**）。

**逐字段语义**：
- `insert:` —— 在 profile 的 layer 栈里**追加**条目（不是覆盖）；
- `id: codearts-auth` —— **条目 id**。⚠️ 这个 id 同时是 **settings 表单的命名空间**
  （见 `src/index.ts:60-62` 的注释：「DSH 0.1.7-rc.1 起，settings 表单的命名空间就是
  profile 条目 id」）；
- `name: 'dsh-codearts-auth'` —— **npm 包名**，DSH 据此解析并加载插件。

⇒ 本项目的 `cordis.patch.yml` 用的是 `id: webcode-bridge` / `name: dsh-webcode-bridge`
（`package/dsh-webcode-bridge/cordis.patch.yml:4-5`），**形状完全一致**。

### 3.3 宿主侧入口的三件导出

```ts
export const name = 'codearts-auth'
export const inject = ['credentials', 'commands', 'llm']
export const Config = Schema.object({
  providers: Schema.dict(Schema.any()).default({}).volatile(),
})
export function apply(ctx: Context): void { ... }
```

证据：`src/index.ts:47`、`:55`、`:74-76`、`:193`。

**关键判据（本项目的对照点）**：

1. **`inject` 只列「一定有」的服务**。`connection` **刻意不列入**静态 `inject`，
   因为它只由 Web bundle 提供，headless/CLI profile 里不存在；静态 inject 会让插件在
   那些 profile 里**永久 pending**，导致整个 profile 以
   `plugin tree failed to load: 1 entry did not activate` 启动失败。
   证据：`src/index.ts:48-54` 的注释（原文含「chicheng-cron 的 skill/agent 任务正是通过
   `dsh --profile headless` 运行的，会因此全部 exit 1」）。
   ⇒ **可选依赖走 `apply()` 内的 `ctx.inject([...], cb)`**，证据 `src/jet-hub-rpc.ts:653`。

   > ⚠️ 这与本项目 `lib/index.js:98-126` 的注释**是同一条纪律、同一个真机事故形状**
   > （本项目记的是 `webServer` 与 `agentTeams`，headless profile 复现为
   > `webcode-bridge: pending (waiting for service: webServer)`，退出 1）。
   > **两个独立仓库各自踩到同一个坑**——这条可以当作「已交叉验证的官方契约事实」。

2. **`Config` 必须是 schemastery schema**，不能是裸函数。理由（`src/index.ts:69-72`）：
   `SettingsForms.describe()` 会对每个注册项调用 `schema.toJSON()`，传裸函数会让它抛
   `TypeError: ... .toJSON is not a function`，**进而使所有依赖 settings 的界面全部失败**。
   `.volatile()` 标记的字段才会被投影进 settings 表单。

3. **`ctx.provide('accountPool', pool)`**（`src/index.ts:1263`）——插件也可以**对外提供**
   服务，不只是消费。

### 3.4 LLM 注册的两个调用（**本项目最关键的一处差异**）

`dsh-codearts-auth` 走的是**两个都调**：

```ts
export function registerCodeArtsLlm(ctx: Context, options: CodeArtsAdapterOptions): CodeArtsAdapter {
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'CodeArts Agent',
      settingsNs: settingsNamespaceFor(ctx, 'llm-codearts'),
      settingsPath: [],
    },
  ])
  const adapter = new CodeArtsAdapter(options)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return adapter
}
```

证据：`src/llm-adapter.ts:1783-1799`。

而**本项目刻意只调后者**：

```js
// Pure adapter registration (the shape opencode2dsh's adapter mode uses): the
// provider appears in the model selector immediately and listModels is read
// live at selector time. We deliberately do NOT also call
// registerConfigurableProviders — declaring the same provider in the
// "configurable" directory as well makes the GUI treat it as an endpoint-
// gated provider and the models never surface in the main selector.
llm.registerAdapter(providerIds, adapter);
```

证据：`package/dsh-webcode-bridge/lib/index.js:920-926`、`:2495`。

⇒ **这是两个仓库对同一个 API 的相反取舍，且都写了理由。**

> ✅ **2026-09-30 已判定**（决定性证据见
> [`../../doc/architecture-vs-official-plugins.md`](../../doc/architecture-vs-official-plugins.md) §3.1）：
> `buildModelCatalog` **只读 `ctx.llm.listProviders()`**
> （`reference/deepseek-harness/packages/api/session-controller/src/catalog.ts:20`，
> 实装 0.2.0-rc.2 同），`listConfigurableProviders()` 的**唯一**客户端消费者是
> 设置页 `ui-settings-models/src/client/store.ts:185`。
> ⇒ 调 `registerConfigurableProviders` **不会**把 provider 从主选择器挤掉；
> 它只让设置页多出一行「可配置/未激活」条目。
> **本项目不调用仍然正确**，但理由应换成「本项目 provider 注册即激活、
> directory 无语义信息量，且会渲染出语义错误的凭据徽章」——
> 本项目原注释的后半句（「模型反而不出现在主选择器里」）**不成立**。
> 细节与待办见上述对照审计的 §3.1 与 §6。

另一个差异：`registerCodeArtsLlm` **返回适配器实例**，理由是
「Jet Hub『显示列表』需要 `listAllModels()`；`ctx.llm` 不透传自定义方法，故必须由调用方
持有引用」（`src/llm-adapter.ts:1796-1797`）。本项目同样持有 `adapter` 引用。

### 3.5 客户端侧的注册（官方 `__ModuleLoader__` 契约）

**客户端源码**（`plugin-src/client/index.js`，全文 29 行）：

```js
export const name = 'jet-hub-client'
export const inject = ['slots', 'connection']

export function apply(ctx) {
  ctx.effect(() => installJetHubStyles(), 'jet-hub: install styles')
  const rpcCall = async (endpoint, payload, signal) => { ... }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'jet-hub',
    order: 50,
    label: () => 'Jet Hub',
    inject: () => ({ rpcCall }),
  }, JetHubPage))
}
```

证据：`plugin-src/client/index.js:7-28`。

**bundle 包装**（esbuild 的 `footer` 等价物，手工拼接）：

```js
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`
```

证据：`plugin-src/client/build.mjs:29-38`；`loaderId = 'dsh-codearts-auth'`（`build.mjs:9`）。

**关键事实**：
- bundle 格式是 **CJS**（`format: 'cjs'`，`build.mjs:14`），`external: ['react','react-dom']`
  （`build.mjs:21`）——**react 由宿主提供，不打进 bundle**；
- 产物路径 `lib/client/jet-hub.js`（`build.mjs:8`）；
- `charset: 'utf8'`（`build.mjs:20`）——默认 `ascii` 会把中文转义成 `\uXXXX`，使
  「用 `includes` 校验产物文案」失效；加载器按 utf8 解码，故安全。

⇒ 本项目 `lib/client.cjs:1-19` 的注释与实现**逐条对应**（`window.__ModuleLoader__.load`
+ `factory(require, module)` + 不能用 ESM + 不能 import `lib/`），
`inject = ['slots', 'sidebarRightTabs', 'sidebarRight']`（`client.cjs:128`）。

**唯一的形式差异**：codearts 用 **esbuild 打包**（源文件多文件 → 单产物），
本项目是**手写的单文件 `client.cjs`**（无构建步骤）。两者产物形状都满足
`__ModuleLoader__` 契约，差别在「多文件可维护」vs「零构建步骤」。

### 3.6 peer 范围：**必须枚举并集**（一条可移植的硬结论）

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.2",
  "@deepseek-ai/dsh-commands": "^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1",
  "@deepseek-ai/dsh-credentials": "^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1",
  "@deepseek-ai/dsh-llm": "^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1",
  "@deepseek-ai/schemastery": "^3.18.4"
}
```

证据：`package.json:70-76`。其 `AGENTS.md` 有整章论证（Issue `IKIZ36`）：

- `^0.1.2-rc.1` 对 `0.x` **只锁次版本** ⇒ 等价 `>=0.1.2-rc.1 <0.2.0`，装不上 `0.2.0-rc.1`；
- **纯区间写法（`>=0.1.2-rc.1 <0.3.0-0`）也不够**：dsh 门禁用
  `semver.satisfies(v, range, { includePrerelease: true })`，而 **npm/pnpm 默认语义更严**
  （range 里必须出现**同 tuple** 的 prerelease），实测纯区间在 npm 下仍 `ERESOLVE`；
- ⇒ **必须把每个要支持的 prerelease tuple 枚举进并集**；
- ⚠️ 用 `file:` 目录依赖会**绕过** npm 的 peer 校验，**必须用 `npm pack` 的 tarball 才测得出来**；
- `<0.3.0-0` 里的 `-0` 是必需的（否则 `includePrerelease` 下会放进 `0.3.0-rc.1`）。

**对本项目的意义**：本项目 `package.json` 的 `peerDependencies` 只有
`@deepseek-ai/dsh-client-ui-sidebar-right`（且 optional），**没有声明
`@deepseek-ai/dsh-llm` / `dsh-credentials` 等 dsh 包**（实测
`package/dsh-webcode-bridge/package.json:81-88`）。这是一条**待判定的差异**：
codearts 的 AGENTS.md 把 peer 声明当成安装门禁的一部分（装不上是硬失败），
本项目是否也需要、以及是否需要枚举并集，属于第 2 项任务的取证范围。

### 3.7 构建与测试链

| 脚本 | 命令 | 说明 |
| --- | --- | --- |
| `build` | `tsc -p tsconfig.json` | 宿主侧 → `lib/` |
| `build:client` | `node plugin-src/client/build.mjs` | esbuild → `lib/client/jet-hub.js` |
| `build:assets` | `node scripts/copy-assets.mjs` | 复制 `.wasm`（`tsc` 不搬） |
| `build:all` | `pnpm build && pnpm build:assets && pnpm build:client` | **完整构建** |
| `prepare` | `pnpm build:all` | git 安装时自动构建 |
| `test` | `vitest run` | 单元测试（无网络） |
| `test:e2e:*` | `cross-env DSH_*_E2E=1 vitest run --config vitest.e2e.config.ts ...` | 30+ 个 e2e，**均有闸门、默认全跳过** |

证据：`package.json:22-61`。

⚠️ **`prepare` 与 `link:` 的陷阱**（`README.md:62-74`）：`dsh plugin install` 以 `link:`
方式安装时 **pnpm 不跑 `prepare`**，故必须先手动 `pnpm build:all`，否则 dsh 启动报
`ERR_MODULE_NOT_FOUND: ... dsh-codearts-auth/lib/index.js`。

⇒ 本项目**没有构建步骤**（`lib/` 直接入库、`client.cjs` 手写），因此**不存在这个陷阱**。
这是本项目的一个真实优势，值得在对照结论里记一笔。

---

## 4. 可移植的工程做法（与本项目对照后值得吸收的）

> 以下每条都是**这个仓库的实测结论**，不是我的推测。标注了是否已适用于本项目。

1. **可选服务依赖必须走 `ctx.inject([...], cb)`，不能进静态 `inject`**
   —— 两个仓库独立踩到同一坑（§3.3）。✅ 本项目已做（`lib/index.js:118-126`）。
2. **`Config` 必须是 schemastery schema**，裸函数会让 `SettingsForms.describe()` 抛错、
   连带整块 settings 界面失效（§3.3）。❓ 本项目未验证（本项目用 `settingsNs: webcode`）。
3. **peer 范围要枚举 prerelease tuple**，纯区间在 npm 下装不上（§3.6）。❓ 本项目未声明。
4. **客户端 bundle 用 `charset: 'utf8'`**，否则中文被转义、文案校验失效（§3.5）。⚪ 不适用
   （本项目无打包步骤）。
5. **`registerConfigurableProviders` 的取舍**：codearts 调、本项目不调，**两边理由相反**
   （§3.4）。⚠️ **待判定**。
6. **`ctx.llm` 不透传自定义方法**（如 `listAllModels`），要自己持有适配器实例
   （§3.4）。✅ 本项目已持有。
7. **续期不得按 `enabled` 过滤**（只看 `refreshable`）——这是 codearts 的**真实缺陷**教训
   （`AGENTS.md` 有整章）。⚪ 不直接适用（本项目无 token 续期），但「停用 ≠ 不需要保持新鲜」
   这条语义区分值得记住。
8. **错误码归类不能替代业务语义判断**：`SERVER` 在 harness 的
   `DEFAULT_RETRYABLE_CODES` 里，于是「今日额度已用尽」（确定性错误）被白重试 5 次；
   `billing_error → permission`（不可重试）与 `rate_limit → rate_limited`（可重试）
   **必须分开**。⚪ 不直接适用（本项目不重试），但与本项目的错误码分层同源。
9. **`enabled` / `refreshable` / `visible` 三个维度不可互相推导**：门控只看「凭据能否解析」，
   不看 `enabled`；目录播报与路由能力分离（`listModels` 返回空数组只是**建议性**目录，
   不构成请求拒绝）。⚠️ 本项目有「兼容空壳 provider 的 listModels 返回 `[]`」——
   **与这条契约直接相关**（`lib/index.js:2490-2493`）。
10. **把排障结论写进 AI 读的指令文件**：它的 `AGENTS.md` 381 KB，逐条记录真实缺陷与判据。
    ✅ 本项目走 `doc/` + `wiki/` 分工，是同一目的的不同落点。

---

## 5. 尚未取证的项（**不要当成结论**）

- ❓ `registerConfigurableProviders` 的**官方契约原文**：它是否真的会让 GUI 把 provider
  当成「需要 endpoint 配置」从而不显示模型？（本项目 `lib/index.js:924-926` 如此断言，
  但本笔记**没有**去官方源码核对这句话。）⇒ 属于第 2 项任务。
- ❓ 本项目是否**需要**声明 `@deepseek-ai/dsh-llm` 等 peer（§3.6）。
- ❓ codearts 的 `settingsNs: settingsNamespaceFor(ctx, 'llm-codearts')` 与
  本项目 `settingsNs: webcode` 的语义差异。
- ❓ 它的 `plugin-src/management-rpc.mjs`（`callManagementRpc`）走的
  `ctx.connection` RPC 通道，与本项目「控制面挂 `ctx.webServer` 的 `/__webcode/*`」
  是**两条不同的前后端通信路线**——哪一条是官方推荐，本笔记未判定。
- ❓ `tests/e2e` 的 42 个文件与 30+ 个 `test:e2e:*` 脚本的组织方式（本项目用
  `test-mock/` + 真机探针，形态不同）。

---

## 6. 怎么把它拿回来

```powershell
git clone https://gitee.com/iJetLi/deepseek-harness-codearts reference/deepseek-harness-codearts
git -C reference/deepseek-harness-codearts checkout af2039800ac2875a5ef8edc7d1842cfc1ef71ae9
```

- remote **直连 gitee，无 `ghfast.top` 镜像前缀**（实测 `git remote -v`）；
- HEAD SHA 见 `reference/README.md` §4 的表（该表由
  `node scripts/gen-reference-index.mjs` 生成，`--check` 可校验）；
- 本笔记是**入库**的（`reference/local-refs/` 是 `.gitignore:10` 显式重开的唯一例外），
  因此**换机器后活下来的只有这份笔记**，代码树要按上面两行重新克隆。
