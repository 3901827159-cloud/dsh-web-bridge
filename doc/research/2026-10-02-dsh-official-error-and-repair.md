# DSH 官方对「对话报错」的约束与修正机制（0.2.0-rc.2 实读）

> **这份文档回答什么**：用户问「官方是怎么约束、怎么修正对话报错的？本插件和
> harness 这样修正需要先学习和记录文档」。
>
> 即：**当一个模型请求失败时，官方 harness 有哪些内建的约束与自动修复动作，
> 以及第三方适配器（本插件）要满足什么契约才能被这套机制接住。**
>
> **取证方式**：读本机实装的 `@deepseek-ai/dsh@0.2.0-rc.2`（
> `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`，287 个子包），
> 加上**对本机 284 份真实会话日志的全量扫描**。凡标「实测」的都是本次真跑过的命令。
>
> ⚠ **本文含一个已确证的真实缺陷**（§6）：本插件的错误码在 harness 边界
> **全部退化成 `UNKNOWN`**，导致官方的自动重试与自动压缩修复**对本插件完全失效**。
> 证据是 **137/137**（本插件丢码 100%，官方 provider 丢码 0）。
>
> ✅ **同轮已修（0.19.54）**：新增 `lib/error-codes.js` 错误码真源，24 处抛点全部改走它，
> 并把空回复对齐成官方 `EMPTY_RESPONSE`；端到端与反向变异均已验证（见 §7 的实施记录）。
> ⚠ 但**基线数字 137/137 不会因此改变**——历史会话的 `UNKNOWN` 是既成事实。
> 本轮声称的是「**机制已接通**」，不是「丢码率已下降」。

---

## 0. 结论先行

| 问题 | 答案 | 证据 |
| --- | --- | --- |
| 官方怎么「约束」报错？ | **错误码是唯一路由判据**：`HarnessError.code` 是稳定机器码，文案只给人看；「route on this, never by parsing `message`」 | `dsh-llm/lib/types/error.d.ts:13` |
| 官方怎么「修正」报错？ | **两个瀑布扩展点 + 一组订阅者**：`agent/request-error`（决定要不要重试）、`agent/request`（改请求配置）；订阅者包括 `llm-retry`（退避重试）与 `compaction-basic` / `image-offload`（改上下文后重试） | `dsh-agent-loop/lib/index.js:1124`、`dsh-base/cordis.patch.yml:91,341,418,427` |
| 官方会不会**自动压缩**？ | **会，且本机 profile 已挂载**（`dsh-base` 带 `compaction-basic`） | `dsh-base/cordis.patch.yml:341-342` |
| 上下文超限官方怎么办？ | 收到 `CONTEXT_WINDOW_EXCEEDED` 就**压缩上下文然后自动重试**（有次数上限） | `dsh-compaction-basic/lib/index.js:862-886` |
| **本插件接住了吗？** | ❌ **没有**。本插件抛的是普通 `Error` + `.code`，官方只认 `HarnessError` 实例 ⇒ **码退化成 `UNKNOWN`** | `dsh-llm/lib/index.js:471-473`，实测见 §6 |
| 后果 | 自动重试对本插件**从未生效**；`CONTEXT_WINDOW_EXCEEDED` 的自动压缩修复**从未触发**；UI 一律显示 `UNKNOWN` | §6.3 全量扫描：本插件丢码 **137/137**，官方丢码 **0** |

**一句话**：官方那套「约束 + 修正」机制设计得完整、也确实挂载在本机，
但**本插件因为抛错了异常类型，整体被挡在门外**——修复动作一次都没跑到我们身上。

---

## 1. 官方错误分类：`HarnessError` / `LlmError`

### 1.1 基类与派生类

```js
// dsh-llm/lib/types/error.d.ts:12-16
export declare class HarnessError extends Error {
    /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
    readonly code: string;
    constructor(message: string, code: string, options?: ErrorOptions);
}
```

```js
// dsh-llm/lib/types/index.d.ts:63-72
export declare class LlmError extends HarnessError {
    /** Serializable facts retained beside this live Error. */
    readonly failure: LlmFailure;
    constructor(message: string, code: string, options?: LlmErrorOptions);
}
```

`LlmErrorOptions`（`dsh-llm/lib/types/index.d.ts:49-58`）——**这四个字段是唯一能改变
重试行为的载荷**：

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `status?` | 100–599 整数 | 真实 HTTP 状态，诊断用 |
| `providerRetryAfterMs?` | 正有限数 | 服务端要求的等待时长，**直接决定退避** |
| `requestId?` | 非空串 | 厂商请求 id |
| `offloadImages?` | 正整数 | 仅配 `IMAGE_OFFLOAD_REQUIRED`：还要卸载几张图 |

构造函数**逐字段校验**，非法值当场抛（`dsh-llm/lib/types/index.js:66-102`）：
message/code 必须非空串、status 必须 100–599、`providerRetryAfterMs` 必须为正。

### 1.2 有名字的规范码（只有 6 个是导出常量）

`dsh-llm/lib/types/error.js`：

| 常量 | 值 | 语义 |
| --- | --- | --- |
| `CONTEXT_WINDOW_EXCEEDED_CODE` | `CONTEXT_WINDOW_EXCEEDED` | 超出上下文窗口 |
| `QUOTA_EXCEEDED_CODE` | `QUOTA` | 额度/余额耗尽 |
| `ACCOUNT_QUOTA_EXCEEDED_CODE` | `ACCOUNT_QUOTA` | 账号额度（可去计费页补充） |
| `EMPTY_RESPONSE_CODE` | `EMPTY_RESPONSE` | 正常收尾但**零内容块** |
| `INVALID_CREDENTIAL_CODE` | `INVALID_CREDENTIAL` | 凭据**格式坏**（不是缺失） |
| `IMAGE_OFFLOAD_REQUIRED_CODE` | `IMAGE_OFFLOAD_REQUIRED` | 图片预算超限，需卸载 N 张 |

**其余码只是字符串字面量**，散落在默认可重试集与各 provider 里：
`RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `AUTH` / `INVALID_REQUEST` /
`NO_ADAPTER` / `ABORTED` / `UNKNOWN` / `MISSING_CREDENTIAL` 等。

`EMPTY_RESPONSE` 的注释把「为什么必须报错而不是给一条空消息」写死了
（`error.d.ts:23-32`）：

> Providers occasionally emit a degenerate completion (a terminal stop with zero output);
> adapters classify it as this failure instead of yielding an empty assistant message,
> because an empty message silently ends the turn with nothing for the user or the loop
> to act on. The attempt produced nothing durable, so retry policy treats it as safe to repeat.

⚠ **这一条正是本插件 `assertNonEmpty` 的官方对位**（`lib/index.js:2620-2625`）——
它现在抛的是裸 `Error`（无 code），见 §6.4。

### 1.3 厂商错误 → 码：**每个适配器自己映射**，核心不提供

核心**没有** `httpErrorCode()` 之类的统一映射。以官方 DeepSeek 适配器为例
（`dsh-llm-deepseek/lib/index.js:1749-1756`）：

```js
if (status === 401 || status === 403 || ["authentication_error","permission_error"].includes(type)) code = "AUTH";
else if (isQuotaExceededError(detail) || status === 402) code = "QUOTA";
else if (status === 429 || type === "rate_limit_error") code = "RATE_LIMIT";
else if (isContextWindowExceededError(detail)) code = "CONTEXT_WINDOW_EXCEEDED";
else if (status === 400 || status === 413 || type === "invalid_request_error") code = "INVALID_REQUEST";
else if (status !== void 0 && status >= 500 || ["api_error","overloaded_error"].includes(type)) code = "SERVER";
else code = status === void 0 ? "SERVER" : `HTTP_${status}`;
```

**⇒ 给本插件的含义**：把「网页报错文案」映射成这套码，是**适配器的责任**。
官方没有替我们做这件事的地方。

---

## 2. 重试策略：`retryPolicy`（provider 声明，宿主执行）

### 2.1 默认值（`dsh-llm/lib/types/retry-policy.js`）

```js
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10_000;
const DEFAULT_JITTER_RATIO = 0.1;
const DEFAULT_RETRYABLE_CODES = Object.freeze([
    EMPTY_RESPONSE_CODE, 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
]);
```

**只有这 5 个码默认可重试。** `AUTH` / `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` /
`INVALID_REQUEST` / `INVALID_CREDENTIAL` 都**不在**默认集里。

⚠ `INVALID_CREDENTIAL` 的排除是**刻意的**（`error.d.ts:37-39`）：

> Deliberately outside the default retryable set — a malformed credential fails identically on every attempt.

### 2.2 两种模式

| 模式 | 语义 |
| --- | --- |
| `normal`（默认） | 只重试 `retryableCodes` 里的码，上限 `maxRetries`（默认 5） |
| `always` | **任何**失败都重试，直到成功 / 取消 / 卸载（含认证、额度、协议错） |

`always` 的语义由 `dsh-llm-retry/README.md` 明确：连永久性失败也一直重试。
**它不是「更宽容的 normal」，而是「无限重试」**——用之前要想清楚。

### 2.3 退避算术（`dsh-llm-retry/lib/index.js:44-49`）

```js
function localDelay(config, retry, random) {
    const exponent = Math.min(retry - 1, 1024);
    const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
    const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
    return Math.min(exponential * jitter, config.maxDelayMs);
}
```

指数退避 + **对称抖动** `[1-r, 1+r]`，抖动后再夹一次上限。

**服务端要求的等待优先**（`:167-172`）：

```js
if (failure.providerRetryAfterMs !== void 0 && ... > 0)
  if (failure.providerRetryAfterMs > policy.maxDelayMs) {
    if (policy.mode === "normal") return next();   // ← 超上限：normal 直接放弃
    delayMs = localDelay(policy, retry, random);   // ← always 回落本地退避
  } else delayMs = failure.providerRetryAfterMs;
else delayMs = localDelay(policy, retry, random);
```

### 2.4 适配器怎么声明策略

官方抽象类的方法（`dsh-llm/lib/index.js:1687`，默认返回 `undefined`）：

```js
providerRetryPolicy(_provider) {}
```

宿主解析（`:1867`）：

```js
const retryPolicy = adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(void 0, `llm: provider "${provider}" retryPolicy`);
```

**⇒ 返回 `undefined` 就是「用 normal 默认」（5 个码、5 次、500ms 起）**。
本插件当前正是 `providerRetryPolicy() { return undefined; }`（`lib/index.js:1069`）——
**声明面没错，但因为抛的码是 `UNKNOWN`，这套默认策略永远不会命中**（§6）。

### 2.5 耐久性：先落盘再等待

```js
// dsh-llm-retry/lib/index.js:141-149
agent.session.append("llm/retry", eventData);          // ← 先落盘
if (!await cancellableDelay(delayMs, fusedSignal)) return;  // ← 再等待
agent.session.append("llm/retry-started", { retryId, turn, step, retry });
```

模块文档把理由写死了（`:17`）：

> Each scheduled retry is durable before its cancellable wait.

README 补一句（`dsh-llm-retry/README.md:72`）：

> A retry is scheduled through the session log before any timer starts, so a crash or
> cancellation never leaves an invisible pending retry.

重试计数通过 **session projection** `llmRetry` 存活过重启，键是
`(provider, policyKey)`；`retryPolicyKey` 对 `retryableCodes` **排序后**序列化，
所以改策略会开启一段新的重试历史（`:50-64`）。

---

## 3. 修正的挂载点：`agent/request-error` 瀑布

### 3.1 主循环怎么用

`dsh-agent-loop/lib/index.js:1118-1134`（**这是整套机制的心脏**）：

```js
if (finish.kind === "error" || finish.kind === "aborted") {
    live.settle("assistant/attempt", () => this.session.append("assistant/attempt", {...}).seq);
    const action = await this.dispatch.waterfall("agent/request-error", {
        turn, step,
        provider: request.provider,
        failure: finish.failure,
        retryPolicy: preparedCall?.retryPolicy,
        signal
    }, () => Promise.resolve(void 0));
    signal.throwIfAborted();
    if (action?.kind !== "retry") throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
    continue;   // ← 重试：重新推导请求
}
```

要点：

- **`error` 与 `aborted` 都进这个瀑布**（不是只有 error）。
- 订阅者返回 `{kind:'retry'}` ⇒ `continue` 重来一轮；否则**重建 `LlmError`** 抛出。
- ⚠ **抛出的是从 `failure` 快照重建的 `LlmError`，不是你那个活的 Error 实例**
  （`throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)`）。
  ⇒ **只要 `failure.code` 是 `UNKNOWN`，重建出来的也是 `UNKNOWN`**。
- `signal.throwIfAborted()` 在瀑布之后 —— **取消优先于重试**。

### 3.2 谁订阅了（本机 profile 实装）

`dsh-base/cordis.patch.yml`（我们的 web profile 通过 `dsh-base` 继承）：

| 行 | 插件 | 角色 |
| --- | --- | --- |
| `:91-92` | `dsh-llm-retry` | 退避重试执行器 |
| `:341-342` | `dsh-compaction-basic` | 上下文压力/超限 → 压缩 + 重试 |
| `:346-347` | `dsh-command-compact` | 手动 `/compact` |
| `:418-422` | `dsh-compaction-tool-result-pruner` | 超大工具结果裁剪 |
| `:427-428` | `dsh-compaction-image-offload` | 图片超预算 → 卸载 + 重试 |

**⇒ 这五条都在本机生效。** 「官方修正机制没装」这个假设是错的。

### 3.3 官方还有第二个瀑布：`agent/request`

`dsh-agent-loop/lib/index.js:1179-1183` —— 在**发出请求之前**让插件改配置
（provider/model/reasoningEffort/maxTokens）。加上 `agent/pre-step`（`:954`），
官方一共三个扩展点：

| 扩展点 | 时机 | 用途 |
| --- | --- | --- |
| `agent/pre-step` | 每步之前 | 压缩检查（`compaction-basic` 的触发点） |
| `agent/request` | 请求构造时 | 改路由/配置 |
| **`agent/request-error`** | 失败收尾时 | **决定重试 / 修上下文后重试** |

---

## 4. 官方的「上下文修复」家族（自动压缩怎么修对话）

### 4.1 触发公式（`dsh-compaction-basic/lib/index.js:124-147`）

设 `W` = contextWindow、`O` = reservedCompletionTokens、`B` = headroomTokens(默认 65536)：

```js
messageBudgetTokens  = W - O;
pressureBudgetTokens = (W - O) - B;
thresholdTokens = Math.floor(Math.min(W * thresholdRatio, pressureBudgetTokens));
retainTokens    = Math.floor((W - O) * retainRatio);
```

默认 `thresholdRatio = 0.8`、`retainRatio = 0.16`。

**`threshold = floor(min(W × 0.8, W − O − 65536))`**

⇒ **声明窗口 `W` 直接决定何时触发**。本插件给站点声明的是乐观值
（glm/zai 实测 1M），所以阈值被推到 80 万——这与
`2026-09-23-dsh-longrun-and-compaction.md` 的既有结论一致。

### 4.2 两种触发：压力 vs 超限

| 路径 | 触发条件 | 选段 | 失败时 |
| --- | --- | --- | --- |
| **pressure** | `agent/pre-step` 里测出 `totalTokens >= thresholdTokens` | 保留 `retainTokens` | **只告警，不失败这一轮**（`:844-849`） |
| **context-overflow** | 收到 `CONTEXT_WINDOW_EXCEEDED` | `retainTokens = 0`（最大幅度） | **有重试权**（见下） |

### 4.3 超限修复的重试判据：**看「表面是否真的前进了」**

`dsh-compaction-basic/lib/index.js:862-886`（这是全文最值得学的一段）：

```js
ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
    ...
    const generation = agent.session.surface.replaceGeneration;
    ...
    result = await this.compactIfNeeded(agent, "context-overflow", signal);
    ...
    if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
    if (result !== null) logResult(result, "context overflow recovery");
    this.overflowRetries.set(agent, retries + 1);
    return { kind: "retry" };
});
```

三个设计点：

1. **重试的判据是 `replaceGeneration` 前进，不是「处理函数返回了」。**
   甚至压缩**抛错**了，只要表面已经前进过，照样重试（`:875-879`）。
2. **有次数上限**：`maxOverflowRetries`（默认 1）。
3. **预算会重置**：agent 空闲（`agent/status → idle`）或任何新 `assistant/message` 到达即清零。

### 4.4 图片卸载（`dsh-compaction-image-offload/lib/index.js:141-145`）

```js
ctx.on("agent/request-error", ({ agent, failure }, next) => {
    if (failure.code !== IMAGE_OFFLOAD_REQUIRED_CODE || failure.offloadImages === void 0) return next();
    if (!offloadOldestImages(agent.session, agent.session.surface.nodes, failure.offloadImages)) return next();
    return Promise.resolve({ kind: "retry" });
});
```

图片被换成**占位文本**（`offloadedImageText`），**不是删除**；且
**不消耗 provider 重试预算、不写 `llm/retry` 事件**（README:42）。

### 4.5 修复的落地形态：耐久事件 + 一次 `surfaceOp` 替换

`compaction/{start,summary,end,prune}`、`image/offload` 全部是**只记日志**的事件；
唯一改变模型可见内容的是**一条带 `surfaceOp: {op:'replace'}` 的替换消息**。
原始事件留在 append-only 日志里 ⇒ **重放是确定性的**。

`compaction/start` 是**锁**，在第一次 `await` 之前同步追加；每个失败路径都恰好
尝试一次 `compaction/end`，**失败时故意留下未配对的 start** 作为崩溃信号。

---

## 5. 官方对适配器的硬性要求（契约清单）

从 `dsh-llm` 的类型声明与实现里逐条读出来的：

| # | 要求 | 证据 |
| --- | --- | --- |
| 1 | **抛 `LlmError`（或 `HarnessError` 子类），带非空稳定码** | `dsh-llm/lib/index.js:471-473` |
| 2 | **绝不抛裸 SDK 错误**——它会被归一化成 `UNKNOWN`，而 `UNKNOWN` **不在默认可重试集**，永远不会重试 | 同上 |
| 3 | 用**既有词汇表**的码；新增码要同时决定它是否进 `retryableCodes` | `retry-policy.js:16-22` |
| 4 | 填 `status`（100–599）与 `providerRetryAfterMs`（正有限 ms）——**只有这两个字段改变退避** | `index.d.ts:49-58` |
| 5 | 通过 `providerRetryPolicy(provider)` 返回 `resolveRetryPolicy(...)`；**不要自己写退避或内部重试循环** | `dsh-llm/lib/index.js:1867` |
| 6 | **每个 stream 恰好一个终止 `finish`**；取消要报 `ABORTED`（得到 `kind:'aborted'`），不要报 error | `:2380` |
| 7 | **尊重 `options.signal`**：及时中止，且中止后不得再安排工作 | `dsh-llm-retry/lib/index.js:154` |
| 8 | 若要加恢复动作，订阅 `agent/request-error`，**只在决定已耐久后**返回 `{kind:'retry'}`，否则 `next()` 委托 | 契约文档 |

### 5.1 ⚠ 归一化的实现细节（本插件踩的就是这里）

`dsh-llm/lib/types/adapter-failure.js:104-107`：

```js
/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error) {
    return error instanceof HarnessError ? error.code : 'UNKNOWN';
}
```

**只有 `instanceof HarnessError` 才保留 `code`。** 归一化入口在
`dsh-llm/lib/index.js:2376-2388`（`adapterFailureChunk`），被
`:2325`（dispatch 期抛错）与 `:2340`（迭代期抛错）两处调用。

**有一条逃生口**：若抛出的对象自带**合法且自洽**的 `failure` 快照，则采信它
（`adapter-failure.js:19-21`）：

```js
const carried = ownFailureSnapshot(error);
if (carried !== undefined && carried.code === ownErrorCode(error)) return carried;
```

即 `err.failure = {message, code}` **且** `err.code` 与之相等时可用——
但这是给「跨包副本丢失类身份」用的兜底，**不是推荐路径**（推荐 `LlmError`）。

---

## 6. ⚠ 本插件的实测缺陷：错误码在边界全部退化成 `UNKNOWN`

### 6.1 事实

本插件**从不 import `dsh-llm`**（全 `lib/` grep 零命中），**从不构造 `LlmError`**
（`new LlmError` 零命中），而是**给普通 `Error` 挂 `.code`**，共 **24 处**：

```
browser-driver.js: BRIDGE_ACCOUNT_BUSY PROMPT_WRITE_STALLED ATTACH_UNAVAILABLE
  ATTACH_NOT_CONFIRMED NEED_LOGIN WEB_SESSION_LOST PROMPT_TRUNCATED SEND_NOT_CONFIRMED
  WEB_CAPTCHA_REQUIRED MODEL_UI_CHANGED RATE_LIMITED VISION_REQUIRES_IMAGE
  MODEL_UNAVAILABLE DRIVER_BUSY COOKIE_IMPORT_UNDECRYPTABLE
index.js:          WEB_NO_PROGRESS CONTEXT_WINDOW_EXCEEDED
think-effort.js:   THINK_EFFORT_UNKNOWN
upstream.js:       ZSTD_UNSUPPORTED ENCODING_UNSUPPORTED SSRF_REDIRECT_BLOCKED
```

### 6.2 逐字复现（本次实测）

```js
import { normalizeLlmFailure } from '.../dsh-llm/lib/types/adapter-failure.js'

// A) 本插件今天的形状：普通 Error + .code
const a = new Error('WEB_SESSION_LOST: x'); a.code = 'WEB_SESSION_LOST';
normalizeLlmFailure(a)  →  {"message":"WEB_SESSION_LOST: x","code":"UNKNOWN"}   ← 码丢了

// B) 官方形状：HarnessError / LlmError
normalizeLlmFailure(new HarnessError('WEB_SESSION_LOST: x','WEB_SESSION_LOST'))
                        →  {"message":"WEB_SESSION_LOST: x","code":"WEB_SESSION_LOST"}  ✅

// C) 逃生口：自带自洽 failure 快照
c.failure = {message:'WEB_SESSION_LOST: x', code:'WEB_SESSION_LOST'}
                        →  code 保留 ✅

// D) 快照与自身 code 不一致 → 仍然 UNKNOWN
                        →  {"message":"x","code":"UNKNOWN"}
```

### 6.3 全量会话日志扫描（**决定性证据**）

对 `~/.dsh/sessions` 下 **284 份会话**逐条读 `turn/end` / `step/end` 的
`reason.kind === 'error'`：

```
sessions read: 284  (unreadable: 0)
error-kind finishes: 171
code=UNKNOWN: 137 => 80.1%
codes: {"UNKNOWN":137,"SERVER":17,"PI_AI_ERROR":9,"INVALID_REQUEST":1,"AUTH":4,"CONTEXT_WINDOW_EXCEEDED":1,"QUOTA":2}

归因到本插件的 error finishes: 137
   → 137 / 137 全部是 code=UNKNOWN          ← 无一例外（存活率 0.0%）
非本插件（官方 provider）的 UNKNOWN: 0        ← 官方一条都没丢
```

**两个数字合起来才是重点**：

- 本插件**丢码率 100%**（137/137）；
- 官方 provider **丢码率 0%**（0 条）。

⇒ 这不是「DSH 的码机制普遍不好用」，而是**本插件单方面的接口错配**。

#### 同码对照（最干净的一组证据）

`CONTEXT_WINDOW_EXCEEDED` 这个语义码，**两边都在用**，落盘结果却是：

| 来源 | 消息形状 | 落盘的 `code` |
| --- | --- | --- |
| **本插件**（`lib/index.js:1033`） | `CONTEXT_WINDOW_EXCEEDED: 本轮提示词 91394 字符 ≈ 70374 token…` | **`UNKNOWN`** ❌ |
| **官方适配器** | `400: {"message":"This endpoint's maximum context length is 262144 tokens…"}` | **`CONTEXT_WINDOW_EXCEEDED`** ✅ |

**同一个码名、同一个语义、同一个 harness**，只因为异常类型不同，一个活一个死。
这也是 §6.4② 的直接证明：官方那条超限会触发自动压缩，本插件这两条不会。

**丢了码的本插件消息**（计数 = 出现次数）：

| 次数 | 消息开头 | 本插件原本的码 |
| --- | --- | --- |
| 27 | `web capture ended incomplete: inco…` | （驱动内部，无码） |
| 20 | `web capture ended incomplete: no_r…` | （驱动内部，无码） |
| 18 | `WEB_NO_PROGRESS: 网页侧超过 120s…` | `WEB_NO_PROGRESS` |
| 18 | `empty response from web AI` | （`assertNonEmpty`，无码） |
| 14 | `RATE_LIMITED: DeepSeek 网页版 网页端限流…` | `RATE_LIMITED` |
| 7 | `TOOL_PROTOCOL_INVALID: 工具参数不完整…` | `TOOL_PROTOCOL_INVALID` |
| 5 | `WEB_SESSION_REBUILD_THROTTLED: 30s…` | （提示码） |
| 4 | `locator.fill: Timeout 30000ms exce…` | （Playwright 裸错） |
| 3 | `empty response from web AI（收束原因…` | 同上 |
| 3 | `webcode relay: request timed out a…` | （relay 内部） |
| 2 | `page.goto: net::ERR_NAME_NOT_RESOL…` | （Playwright 裸错） |
| 2 | `WEB_SESSION_REBUILD_THROTTLED: 50s…` | 同上 |
| 1×7 | `PROMPT_TRUNCATED: 网页输入框只接收了…` | `PROMPT_TRUNCATED` |

**旁证（一条真实会话的原始 JSONL）**：

```json
{"type":"turn/end","seq":278,"data":{"turn":1,"reason":{"kind":"error","error":{
  "message":"WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容…",
  "code":"UNKNOWN"}}}}
```

消息里明明白白写着 `WEB_NO_PROGRESS`，**`code` 字段却是 `UNKNOWN`**。

### 6.4 三条具体后果

**① 自动重试从未生效。**
`DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`。
本插件没有任何码能进这个集合（全是 `UNKNOWN`）⇒ `llm-retry` 的
`policy.retryableCodes.includes(failure.code)` 恒为假 ⇒ **直接 `next()`，不重试**。

⚠ 注意本插件**自己实现了两套重试**（`RATE_LIMIT_RETRIES = 2` 的站点退避、
`WEB_SESSION_LOST` 的整段重建）。这在官方契约里是**重复实现**——
契约第 5 条要求「不要自己写退避或内部重试循环」。但**在码被吞掉的前提下，
自建重试反而是当前唯一在工作的重试**（§7 的迁移顺序因此要小心）。

**② `CONTEXT_WINDOW_EXCEEDED` 的自动压缩修复从未触发。**
`compaction-basic:862` 的判据是 `failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE`。
本插件 `lib/index.js:1038` **确实设了** `err.code = 'CONTEXT_WINDOW_EXCEEDED'`，
但因为抛的是普通 `Error`，到了那里已经变成 `UNKNOWN` ⇒ **不匹配 ⇒ `next()` ⇒ 不压缩**。
**官方的上下文自动修复对本插件是死的**——§6.3 的同码对照就是它的直接证据：
官方那条 `CONTEXT_WINDOW_EXCEEDED` 会进压缩分支，本插件那两条不会。

**③ UI 一律显示 `UNKNOWN`。**
`dsh-client-ui-chat/lib/client.js:1219-1224`：

```js
function failureMessage(message, code, t) {
    if (code === "ACCOUNT_SIGNED_OUT") return t("message.failure.accountSignedOut");
    if (code === "ACCOUNT_SIGN_IN_REQUIRED") return t("message.failure.accountSignInRequired");
    if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
    return code === "AUTH" ? t("message.failure.auth") : message;
}
```

UI 会把 `node.code` 渲染成一个 `<code>` 徽章（`:1302-1305`）。
所以用户看到的是「失败 + 文案 + **`UNKNOWN`**」——**码这一栏对本插件永远是 `UNKNOWN`**。

### 6.5 附带发现：`RATE_LIMITED` 与官方 `RATE_LIMIT` 不是同一个码

本插件用 **`RATE_LIMITED`**（`browser-driver.js:3735`、`index.js:3589`），
官方用 **`RATE_LIMIT`**（`retry-policy.js:18`）。

⇒ 即使把异常类型修好，`RATE_LIMITED` **仍然不在** `DEFAULT_RETRYABLE_CODES` 里，
**仍然不会被重试**。**类型修好只是第一步，码名对齐是第二步。**

---

## 7. 修法（**0.19.54 已实施第 1、2 步；第 3、4 步未做**）

> **实施记录**：本节最初是「建议」。**第 1 步（让码活下来）与第 2 步（码名对齐）已在
> 同一轮实施并验证**，第 3、4 步**刻意未做**（理由见下）。缺陷条目
> `doc/long-term-issues.md` #39 已随之标记「同轮已修」。
>
> **实测验证**（三条，缺一不可）：
>
> | 验证 | 读数 |
> | --- | --- |
> | 端到端（真实 `adapter.stream()` → 真实官方 `normalizeLlmFailure`） | `{"code":"EMPTY_RESPONSE"}`（修前 `UNKNOWN`）✅ |
> | 反向变异：删 `failure` 快照 | 护栏 **3 条红** ✅ |
> | 反向变异：把 `CONTEXT_WINDOW_EXCEEDED` 混进 `retryableCodes` | 护栏 **1 条红** ✅ |
>
> ⚠ **基线数字未变**（仍是 137/137）：历史会话的 `UNKNOWN` 是**既成事实**，不会被追溯
> 修复。本轮的结论是「**机制已接通**」，不是「丢码率已下降」——后者要等新会话产生后
> 再跑 `scripts/scan-error-codes.mjs` 才能声称。

按「收益 / 风险」排序。**每一步都应独立可验证，不要一次全做。**

### 第 1 步（收益最大、风险最低）：让码活下来 —— ✅ 已实施

实施为新增模块 [`lib/error-codes.js`](../../package/dsh-webcode-bridge/lib/error-codes.js)：
`webcodeError(message, code, extra)` 与 `withWebcodeCode(err, code)`，
**不可分割地**同时写 `code` 与一个**自洽的** `failure` 快照。

**24 处抛点全部改走真源**（`browser-driver.js` 22 / `index.js` 2 / `think-effort.js` 1 /
`upstream.js` 3），另把两处「空回复」的无码错误对齐成官方 `EMPTY_RESPONSE`。

- **为什么不用 `LlmError`**（原本的推荐）：实测 `@deepseek-ai/dsh-llm`
  **不在本仓库工作区**（`ERR_MODULE_NOT_FOUND`），静态 import 会让全部测试文件加载失败；
  且桌面版把宿主打进 `app.asar`，插件解析到的 `dsh-llm` 与宿主内部那份**可能不是同一
  模块实例** ⇒ `instanceof` 跨副本不成立。**自洽快照比 `LlmError` 在 asar 跨副本下更稳**，
  且零新依赖。官方实现自己就为这件事留了口子（`adapter-failure.js:17-21` 逐字
  *Cross-package copies preserve own data but not class identity*）。
- ⚠ **不要**只改一半（快照与 `code` 不一致 ⇒ 仍然 `UNKNOWN`，§6.2 D 已实测）。

**验收判据（已达成）**：真实 `adapter.stream()` 抛出的错误经真实官方归一化后
`code` **不再是 `UNKNOWN`**；且 `test/error-codes.test.mjs` ② 会扫描 `lib/` 禁止裸赋值回归。

### 第 2 步：码名对齐官方词汇表 —— ✅ 部分实施

**已对齐的两个**：

| 本插件 | 结果 |
| --- | --- |
| `CONTEXT_WINDOW_EXCEEDED` | 已是官方名；修好类型后 `compaction-basic` 的自动压缩**即生效** ✅ |
| `empty response from web AI`（原**无码**） | 改为官方 **`EMPTY_RESPONSE`**（在默认可重试集里）✅ |

**刻意不改的**（理由写进 `error-codes.js` 的 `WEBCODE_CODES` 表）：

| 本插件 | 官方同名 | 为什么不改 |
| --- | --- | --- |
| `RATE_LIMITED` | `RATE_LIMIT` | 官方退避 500ms 起，而本站限流滑窗以**十秒**计；改名后每次重试都是**一次真实浏览器投递**，代价远高于 HTTP 重试。保留自定名 + 自建 10s 下限退避。 |
| `NEED_LOGIN` | `AUTH`？ | 官方 UI 会把 `AUTH` 替换成「API 密钥无效」，而这里该做的是「打开网页登录一次」——映射会**把人引向错误的排查方向**。 |
| `MODEL_UI_CHANGED` | `INVALID_REQUEST`？ | 语义是「网页改版」，不是「请求非法」。 |

⚠ **不要为了「进重试集」而把语义不匹配的码硬映射**：`AUTH` 进不了重试集
（不在默认集），但会**改变 UI 文案**。映射前先想清楚「这个码要驱动什么行为」。

### 第 3 步：把自建重试收敛到官方策略 —— ❌ **未做（有意的）**

契约要求「不要自己写退避循环」，但**在码活下来之前不能删自建重试**
（那会变成「两条都没有」）。现在码活了，但**仍不能直接删**：

- 需要先**观察官方 `llm-retry` 是否真的接住**（新会话产生后跑 `scan-error-codes.mjs`）；
- `RATE_LIMITED` 的自建退避是 `max(发送间隔,10s) × 已重试次数`，与官方
  `localDelay` 的指数+抖动**语义不同**；换过去会改变实际等待时长，属于**行为变更**，
  需要真机对照。

⚠ **已实施的相关部分**：`providerRetryPolicy` 从 `undefined` 改为显式
`WEBCODE_RETRY_POLICY`（`maxRetries: 1`、`initialDelayMs: 2000`）。返回 `undefined`
会用官方 **HTTP** 默认（5 次 / 500ms 起），而本插件重试一次 = 再驱动一次浏览器。

⚠⚠ **`CONTEXT_WINDOW_EXCEEDED` 绝不进 `retryableCodes`**：`dsh-base/cordis.patch.yml` 里
`llm-retry`（:91）注册在 `compaction-basic`（:341）**之前**，waterfall 按注册顺序调用
⇒ `llm-retry` 一旦命中就**不再 `next()`**（`dsh-llm-retry/lib/index.js:160`）。
把它放进可重试集，超限请求会被**原样重发** N 次，而**官方的压缩修复永远不会跑**。
`test/error-codes.test.mjs` ④ 专门钉死这一条。

### 第 4 步：订阅 `agent/request-error` 做「网页会话丢失」的自动修复 —— ❌ **未做**

官方允许插件在这个瀑布里修上下文后重试。本插件**已有** `WEB_SESSION_LOST` →
整段重建的能力（`index.js:3381`），但它**在适配器内部**做，不在官方扩展点上。
把「整段重建后重试」搬到 `agent/request-error` 是**结构性**改动，
需要单独一轮设计（涉及游标、节流窗、`replaceGeneration` 等价物）。

---

## 8. 与本仓库既有文档的关系

| 文档 | 关系 |
| --- | --- |
| `doc/research/2026-09-23-dsh-longrun-and-compaction.md` | **已覆盖**压缩的装配与触发公式（§4.1 与它一致）。**本文新增**的是「压缩作为 `agent/request-error` 订阅者的自动修复路径」（§4.3），以及它对本插件**从未生效**的原因（§6.4②） |
| `doc/architecture-vs-official-plugins.md` | 覆盖**声明面**（7 个 adapter 方法、`inject`、`registerConfigurableProviders`）。**本文补的是运行面**：错误类型契约与重试/修复机制。该文档 §2.3 说本项目 7/7 覆盖 `providerRetryPolicy`——**声明属实，但返回值 `undefined` + 码被吞 ⇒ 策略空转** |
| `doc/bridge-failure-ledger.md` | 错误码台账（本插件视角）。**本文是它的官方对位**：那些码在 harness 侧实际变成了什么。建议在该文件加一条指向本文的索引 |
| `doc/long-term-issues.md` | §6.5 的 `RATE_LIMITED` vs `RATE_LIMIT` 与 §6.4 的三条后果，若要排期修，应登记为条目 |

---

## 9. 未证实 / 不许当结论用的部分

1. **`code=UNKNOWN` 里有多少是「本可自动重试」的**：本插件 137 条里
   `RATE_LIMITED`(14) + `empty response`(21) + `PROMPT_TRUNCATED`(7) 语义上
   接近官方可重试集，但**重试是否真能成功、成功率多少，本轮未做实验**。
2. **`RATE_LIMITED` → `RATE_LIMIT` 改名后官方重试的实际行为**：未实测。
   注意官方重试会**重新发一次完整请求**，而网页桥的一次重发代价是
   「再驱动一次浏览器」，**代价远高于 HTTP 重试**——这可能是「不该进重试集」的
   真实理由，需要专门判定。
3. **`RATE_LIMITED` 自建退避与官方退避的耗时差异**：只读了公式，未做对照实验。
4. **本插件是否该依赖 `@deepseek-ai/dsh-llm`**：**已判定为「不依赖」**——它不在本仓库
   工作区（实测 `ERR_MODULE_NOT_FOUND`），静态 import 会让全部测试文件加载失败；
   且 asar 跨副本下 `instanceof` 不成立。改走自洽 `failure` 快照（见 §7 第 1 步）。
5. **`agent/request` 瀑布能否用于本插件**：未研究。
6. **§7 的第 1、2 步已实施并验证；第 3、4 步刻意未做**（理由见 §7）。

---

## 10. 给下一个接手的人

**官方那套机制只有一句话：错误码是接口。**
码对了，`llm-retry` 会替你退避重试、`compaction-basic` 会替你压缩上下文再重试；
码错了（或像本插件修复前那样**根本没有码**），这些能力**一条都不会跑到你身上**，
而且**不会报错**——你只会看到 UI 上那个 `UNKNOWN` 徽章，和一份
「80.1% 的失败都没有分类」的日志。

**0.19.54 已把这条接口接通**（§7）。但要**注意两件事**，否则会误判现状：

1. **基线数字不会自己变**。历史会话里那 137 条 `UNKNOWN` 是既成事实，
   不会被追溯修复。要看到「存活率」上升，必须**产生新会话**（发几轮真实请求）
   再跑扫描脚本。**不要拿旧会话的读数说修复无效**，也不要拿它说修复生效。
2. **还有两个码刻意没对齐官方**（`RATE_LIMITED` / `NEED_LOGIN`），理由在
   `lib/error-codes.js` 的表里。看到「只差一个字母」时**先读那条理由再动手**。

复核命令：

```powershell
node scripts/scan-error-codes.mjs          # 看「本插件错误码存活率」（需新会话）
node scripts/scan-error-codes.mjs --webcode # 看具体哪些消息还在丢码
```
