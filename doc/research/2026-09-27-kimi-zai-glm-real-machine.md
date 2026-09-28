# 0.19.41 —— Kimi / Z.ai / GLM 真机取证与修复（2026-09-27）

本文件记录**用户报障 → 真机取证 → 修复 → 验证**的完整链条。按本仓库纪律，
每一条结论都带可核对的读数与命令；**没取到证的地方如实写「未取证」**。

用户报障原文（本轮起点）：

```
Kimi / Qwen / 豆包 / Z.ai —— 现在都不行，我真实验证--直接发送简短的一句话kimi就会不能够：
你好，请你了解这个插件项目
处理失败
本轮运行失败PROMPT_TRUNCATED: 网页输入框只接收了 20158/38807 字符（网页端长度上限）—
请缩短上下文或先压缩历史再重试
然后z.ai:本轮运行失败WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，判定相位=
网页还没开口且驱动不在忙（按常规窗口未宽限），最近驱动活动时间 1s 前，页面已有 7 字回复未回传）
— 本轮已中止，可重试
```

两个报错**都不是真因**——这是本轮最重要的一条发现。下面逐条给出真因。

---

## 一、Kimi：`20158/38807` 不是网页的上限，是桥自己的分块写入丢的

### 1.0 本条最终定性：投递链已修好，卡点是**账号级限流**（外部事实）

把 §1.1–§1.4 的四处缺陷全部修完后再跑真机（`.tmp-probe/kimi/lead-final-out.json`、
`probe-kimi-send.mjs`、`probe-kimi-inline-e2e.mjs`），链路读数逐格变绿：

```
[probeAttachment] {"ok":true,"nameHit":{"tag":"p","cls":"file-card-info-name",
                   "snippet":"<p … class=\"file-card-info-name\">webcode-context</p>",
                   "matched":"stem"},"ms":173}          ← 修复前：等满 90s 超时
[send path]        sel=.send-button-container ready=true composerChars=65 url=https://www.kimi.com/
[send confirmed]   url=https://www.kimi.com/                ← 修复前：SEND_NOT_CONFIRMED
[inline-write]     {"wrote":12532,"echoed":12532,"lossless":true}   ← 修复前：20158/38807
[inline 38.8k]     send path ready=true composerChars=35950  ← 38,807 字符**逐字写入成功**
                   （修复前这一步就是 `PROMPT_TRUNCATED`）
```

然后服务端在 `POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat` 上回：

```json
{"error":{"code":"resource_exhausted","details":[{"type":"common.error.v1.ErrorDetail",
  "value":"CHUSSQoFemgtQ04SQOWSjEtpbWnogYrlpKnnmoTkurrlpKrlpJrkuobvvIzor7fm…"}]}}
```

base64 解出来是 kimi 自己的原话：

> **「和Kimi聊天的人太多了，订阅会员可进入优先队列」**（`zh-CN@…`，含 Request ID）

⇒ **这条不是桥的缺陷**：消息已写入、已发送、已被网页受理，是 kimi **账号级限流**拒答。
本轮顺带把它变成可读读数（见 §1.5）——在此之前用户看到的是
`web capture ended incomplete: invalid_stream | 流首段: {"heartbeat":{}}`，
**一个字都没提到限流**。

### 1.1 报错归因错了

`PROMPT_TRUNCATED: … 网页输入框只接收了 20158/38807 字符（网页端长度上限）`
把失败归给「网页端的长度上限」，并建议「缩短上下文或先压缩历史」。

真机实测（`.tmp-probe/kimi/RESULT.md`，产品同源路径 + `readComposer` 的 `innerText`，
纯 ASCII 与中文+换行两种形状都测）：

| 写入方式 | 写入 | 回读 | 丢失 | 耗时 |
| --- | --- | --- | --- | --- |
| **单次** `insertText` | 8,000 / 16,000 / 20,000 / **20,158** / 24,000 / 32,000 / **38,807** | 逐字相等 | **0** | 19–66ms |
| **单次** `insertText` | 50,000 / 100,000 / 200,000（中文+换行） | 逐字相等 | **0** | 43 / 94 / 167ms |
| **分块** 20,000+18,400（含换行） | 38,400 | **20,002** | 尾部 18,398 | — |
| **分块** 10,000+10,000（含换行） | 20,000 | **10,060** | 尾部 | — |
| 分块 20,000+18,400（纯 ASCII） | 38,400 | 38,400 | 0 | — |

三条关键读数：

1. **`20158` 不是站点常量**：它是「第一块写进去了、第二块几乎整块丢掉」的产物。
   用产品路径在**另一个长度**上复现成 `20012/38025`（`.tmp-probe/kimi/probe-h`），
   两个数字不同 ⇒ 不是网页的上限。
2. **加长块间间隔无效**：0 / 100 / 300 / 600 / 1000 / 2000 / 4000ms **七档读数完全一致**，
   插入后 4 秒轨迹也稳定 ⇒ 不存在「等编辑器准备好」这条出路。
3. 三条写入路径对照（同一段 24,000 字符）：`keyboard.insertText` 24,000 ✓、
   `document.execCommand('insertText')` 24,000 ✓、`el.innerText = text` → **1**
   （编辑器用自己的状态重渲染，丢弃外部赋值）⇒ 前两条可用，第三条不可用。

### 1.2 修法

`lib/browser-driver.js` 的 `fillComposer`：**contenteditable 分支改为一次性
`page.keyboard.insertText(text)`**（`composerWritePlan` 的 `mode/chunkChars` 从此只对
表单控件 `field` 生效）。护栏：`test/composer-single-write.test.mjs`（4 条，钉在源码
结构上：不得有按块循环、`insertText` 恰好一次、不得改用每块 `evaluate`）。

### 1.3 顺带发现的第二条缺陷：kimi 的会话槽从来没落过 id

补 kimi 的会话地址形状之前，真机读数是：

```
WEB_SESSION_LOST: 会话槽为空（site=kimi，no-stored-session） — 需要整段重建
```

`webcode-sessions-kimi.json` 里只有 4 条**探针自造**的键，没有一条来自真实轮次。

本轮拿到了**可导航**的真机证据（`page.goto` 之后地址逐字不变、页面上读回了只存在于
那一轮正文里的标记 `hasOne:true`）⇒ 补 `CONVERSATION_URL_SHAPES.kimi` 与
`CONVERSATION_URL_BUILDERS.kimi`（`/chat/<uuid>`），依据写在 `providers.js` 的注释里。
**对照**：z.ai 的 `/c/<uuid>` 同样**观察到**了，但 `goto` 被打回根地址、标记 0 次命中
⇒ 那条**继续不声明**。两条读数的差别就是「能不能导航回去」，这也是本仓库
「宁可不切，也不猜着切」的判据。

### 1.4 第三条：附件投递可用，但确认判据在 kimi 上恒为 null

真机实测（内容级判据，标记埋在附件**最后一行**）：

| 附件尺寸 | 模型回复 | 结论 |
| --- | --- | --- |
| 3,004 字符 | `OK:CZEFS1SKRAMK`（= 附件里的标记） | 读到了 |
| 38,032 字符 | `OK:CZEFS1TKRAMK` | 读到了 |

但产品路径把它判成失败：kimi 的附件卡渲染的是**去掉扩展名的 stem**
（`<p class="file-card-info-name">webcode-context</p>`，扩展名单独放在 `.file-ext`），
而 `waitForAttachment` 找的是完整文件名 ⇒ `ATTACH_NOT_CONFIRMED` ⇒ 回落 inline ⇒
撞上 §1.1 的分块丢尾。

修法（`lib/attach-scope.js` + `lib/browser-driver.js`）：证据匹配增加**第二把尺子**——
完整名不命中时按去扩展名的 stem 再试一次，仍受「composer 作用域内 / 不在正文里 /
长度 ≤ stem+80」三道闸约束。

**为什么不干脆打开类名候选**：同一份真机读数里 kimi 页面上 `[class*='file-card']`
有 **42 个可见节点**、`img[src^='blob:']` 为 **0** ⇒ 按类名放行会把历史附件卡全算成
本轮证据，那正是 0.19.9 刻意修掉的假阳性。

**真机复验（Lead 跑，`.tmp-probe/kimi/lead-final-out.json`）**：

```
[probeAttachment] {"ok":true,"evidence":"[class*='file'], …","nameHit":{"tag":"p",
  "cls":"file-card-info-name","snippet":"<p … class=\"file-card-info-name\">webcode-context</p>",
  "matched":"stem"},"ms":106}
[inline-write]    {"wrote":12532,"echoed":12532,"ms":24,"lossless":true}
```

即：修复前这一格是**等满 90s 超时后报 ATTACH_NOT_CONFIRMED**，现在是 **106ms 命中**、
`matched:"stem"` 如实标出用的是哪把尺子。

### 1.5 第四处：带附件时**发送键处于禁用窗口**，Enter 完全不响应

修完 §1.1–§1.4 后仍有一轮 `SEND_NOT_CONFIRMED`。逐拍现场（`.tmp-probe/kimi/lead-send-out.json`）：

| 时刻 | 输入框长度 | 发送控件 | 附件 chip | 地址栏 |
| --- | --- | --- | --- | --- |
| 按 Enter 前 | 81 | `div.send-button-container **disabled**` | 14 | `https://www.kimi.com/` |
| Enter + 0.4s | 81 | 同上（仍 disabled） | 14 | 未变 |
| Enter + 2.0s | 81 | `div.send-button-container`（**disabled 已消失**） | 15 | 未变 |
| **点它之后** | **1**（只剩换行） | 又变回 disabled | **0** | 切到 `/chat/<uuid>` |

⇒ kimi 的发送控件在**附件上传完成前**带 `disabled` 类，那一刻按 Enter 网页**完全不响应**；
旧实现的「点按钮 → 回车 → 再点按钮」三条路**全落在禁用窗口内**，于是带附件的轮次
必然发不出去（用户侧就是「附件上传了但发不出去」）。

修法两处：

- `providers.js` 的 kimi 条目补 `sendButton: '.send-button-container'`
  （此前走「按 Enter」默认路径——而这条路在 kimi 上从一开始就不可靠）；
- `browser-driver.js` 发送前**等宿主控件的 `disabled` 类消失**（判据取页面事实，
  最多 12s；上传耗时随文件大小变化，等固定时长必然两头不讨好），并且不再用
  `btn.isEnabled()` 预判——kimi 的控件是 **div**，`isEnabled()` 恒真，
  旧实现会明知禁用还去点。禁用态按**切词后精确相等**判定
  （不写含 `|` 的正则字面量：`test/driver-scope.test.mjs` 会把正则里的 `|` 当代码切分，
  于是 `…|disabled|…/i` 被误读成一个自由标识符——本轮实测撞到并已修正）。

### 1.6 第五处：服务端原话被丢掉，用户只看到 `invalid_stream`

真机错误帧的 `details[0].value` 是 base64（前 8 字节 protobuf 头，其后 UTF-8 原话）。
旧实现只置 `failed = true`，整轮报成
`web capture ended incomplete: invalid_stream | 流首段: {"heartbeat":{}}`——
**排查者看不到服务端说了什么**。

修法（`decoder.js`）：新增 `kimiErrorText()` 把 base64 解成
`code：原话`（解不出来就原样带出 value 前缀，**绝不编造**），
`JsonLinesDecoder` 新增 `failureReason` 字段并让 `finish()` 优先用它；
限流原话表补上 kimi/GLM 的实际措辞（它们**一个 rate/frequent 字样都没有**，
纯英文判据必然漏）。护栏 `test/kimi-decoder.test.mjs` ③。

### 1.7 第六处：网页明说「还在生成」，驱动却按 2.5s 稳态把轮次收束了

修完发送链后出现新现场：一轮**还在思考**的回复被收束，正文 0 字符——

```
wip steady state — settling turn with 0 chars answer / 114 chars thinking (partial-wip-settled)
partial web stream accepted (incomplete, status=n/a, 0 chars, 0 image(s))
```

根因：`shouldSettleWip` 的第二条件是「页面 DOM 助手节点停止增长」，而 kimi 的**思考阶段**
正文节点读不到内容（`answerSelector` 对 kimi 用的是兜底串，实测 `.markdown` /
`[data-message-author-role]` / `.ds-markdown` 对该页面**零命中**）⇒ 该时间戳冻结
⇒ 流静默 2.5s 即收束。而 kimi 的流里**每帧都带** `message.status`
（`MESSAGE_STATUS_GENERATING` / `MESSAGE_STATUS_COMPLETED`）——**权威信号一直在，
只是被丢掉了**（旧代码那句注释写着「此处只做 completion 锚点」，而它连锚点都没设）。

修法：解码器把 `generating` 状态位透出（`isGenerating()`），status 转终态时**真的**置
`done`（于是 `finish()` 交回 `complete:true`，不再把正常完成的回复当部分流落账）；
驱动侧新增第四条判据——网页说还在生成就**推迟**收束，但仍受既有硬上限
（`answerTimeoutMs`）约束并留 warn（一个永远不说「完成」的站点不能被挂死）。
护栏 `test/kimi-decoder.test.mjs` ①②④⑤。

---

## 二、Z.ai：「页面已有 7 字回复未回传」是**假读数**，真因是站点风控闸门

### 2.1 那 7 个字从来不是回复

`answerSelector` 旧值是
`div.markdown-body, .markdown-body, [class*="prose"], [class*="message"], main`
（宽特征，注释里自己写着「未取得真机命中读数」）。在真机会话页的 293 元素逐字清单上
逐一复算（夹具 `test/fixtures/zai-real-dom/zai-chat-dom-inventory.json`）：

| 选择器 | 命中 | 命中节点 |
| --- | --- | --- |
| `div.markdown-body` / `.markdown-body` / `main` | 0 / 0 / 0 | z.ai 没有这些 |
| `[class*="prose"]` | 2 | #151 用户消息、#172 助手轮容器（0 字） |
| `[class*="message"]` | 4 | …**#184 `div.messageInputContainer`（输入框容器）** |

驱动的读取语义是 `[...querySelectorAll(sel)].pop()` = 文档序**最后一个**命中 ⇒
恒为 #184，而它的 `innerText` 恰好是「深度思考\n最高」= **7 字**。
三处独立读数逐字吻合：夹具复算、落地页实测、事故现场 `replyChars: 7`。

危害不止于日志：`answerSelector` 恒命中且文本恒定 ⇒ ①「页面还在长 → 绝不动」这条
保护对 z.ai 是死的；②捕获停摆兜底会把「深度思考\n最高」当成模型回答交给上层。

修法：`answerSelector` → `div.chat-assistant, #response-content-container`
（语义特征，不是 `.svelte-xxxx` 编译期哈希）。护栏：`test/zai-answer-selector.test.mjs`。

### 2.2 真因：站点风控闸门拦在请求之前（**跑不通，明确跑不通**）

真机四轮复现（headless×3 含一轮完整 `driver.sendTurn`、headed×1），**全部 0 帧**；
chat.z.ai 的 POST 清单里没有任何 `/api/chat/completions`。站点自带前端
（`z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.96/assets/index-p_7VciLU.js`）逐字写着：

```js
if (l()?.features?.enable_captcha) { try { lc = await HN() } catch { …return } }
const bu = await bhe(localStorage.token, {stream, model, messages, params, files, mcp_servers, features}, …, lc)
```

`bhe` 就是 `fetch(`${base}/api/chat/completions?…`)`。自动化环境下 `await HN()`
（阿里云滑块验证）不返回 ⇒ `bhe` **永不执行**。同页 `#chat-captcha-element`、
`#aliyunCaptcha-window-popup.window-show` 可见。`GET /api/config` 的唯一命中读数是
`features.enable_captcha = true`。把 UA 从 `HeadlessChrome` 换成正常 Chrome **也没过闸**。

**绕滑块属于破解站点风控，本项目不做。** 因此本轮对 z.ai 的处置是
**「诚实化读数 + 提前如实报错」**，不是「让它能跑」：

- 站点声明位 `captchaSelector: '#chat-captcha-element, #aliyunCaptcha-window-popup.window-show'`；
- 驱动在**发送已确认之后**做一次采样（2.5s），命中可见节点即抛
  `WEB_CAPTCHA_REQUIRED`，文案说明「消息未被网页受理」「wire 上零帧」、
  要求「在弹出的浏览器窗口里手动完成验证后重试」，并**明确否掉**「解码器/网页没回传」
  这两个误导方向；有头时把窗口带到前台。
- 护栏：`test/captcha-gate.test.mjs`（5 条，含「必须晚于发送确认与 PROMPT_TRUNCATED」
  「不得按站点名硬编码」「必须是一次采样而不是轮询等超时」）。

**未取证（不猜）**：人肉过一次验证之后 `enable_captcha` 是否仍每次触发——`lc` 是每次
发送的局部变量、`await HN()` 每次发送重跑，但 `HN()` 内部是阿里云无痕验证语义
（分低静默通过、分高弹滑块），我们**没有任何一次 `HN()` 成功返回的观测**。
决定性下一步：`$env:PROBE_HEADED='1'; node .tmp-probe/zai/probe-zai-chat-frames.mjs`
（有头窗停在页面 150s，人肉拖过滑块后 fetch tee 自动落盘真机帧）。

### 2.3 被推翻的假设：z.ai 不是 GLM 帧

站点自带前端里 `"parts"` **0** 次、`choices` **0** 次、`reasoning_content` **0** 次
⇒ 既不是 GLM 的 `parts[].content[].type`，也不是 OpenAI 的 `choices[].delta.content`。
真实帧是扁平字段：`{id, done, content, delta_content, edit_content, sources, …,
tool_name, delta_arguments, status, metadata, content_blocks}`，其中
**`delta_content` 是增量、`content` 是全量快照**（混用必须做前缀差分）。
`lib/decoder.js` 现有 9 个 kind 没有一个读 `delta_content` ⇒ 换用 `glm` 解码器是
「猜着解不出」，更糟；因此本轮**刻意不改 decoder**，把字段形状与差分要求如实记在这里，
等有真机帧的一次录制再写。

---

## 三、GLM：真机原生调用形态有 3 种，旧解析器对其中 2 种给出**错参数**

### 3.1 真机现场

日志 `%USERPROFILE%\.dsh\logs\webcode-bridge-replies.glm.log`（桥自己落的**真实网页
回复全文**）里，会话 `session-75d52255` 的 turn3 step2 派发出的两个 `read` 调用是：

```json
{"md":"limit=150\n<tool_call>glob\npath=D:\\…\\package\\dsh-webcode-bridge\npattern=**/*.js"}
{"md":"limit=120"}
```

DSH 以 `invalid arguments: missing required property "file_path"` 拒收。
模型当时的原文（夹具 `test/fixtures/glm-native/glm-native-a-keyeq-lines.txt`，逐字）：

```
<tool_call>read
file_path=D:\…\README.zh-CN.md
limit=150
<tool_call>glob
path=D:\…\package\dsh-webcode-bridge
pattern=**/*.js</arg_value></tool_call>…
```

即 GLM 的**变体 A**：`<tool_call>` + 裸工具名 + `key=value` 行，
**没有任何 `<arg_key>` 标签**，块尾是模型自己写的 `</arg_value>`（无配对开标签）。

旧实现里有两条路径会在这里出错：

1. `tagRe` 体内 `count === 0` 的兜底正则
   `([a-zA-Z_]\w*)\s*\n([\s\S]*?)</arg_value>` 把键取成 **`md`**（`README.md` 的行尾）、
   值取成整段残文；
2. 三个块共用收尾、开标签只有两个 ⇒ `tagRe` 一个都取不到。

**错参数比丢调用更坏**：调用发出去了、工具拿到垃圾参数，模型以为格式已对，
于是只微调格式反复重试，一路烧窗口。用户看到的就是「工具调用老是失败」。

### 3.2 另外两种形态（同一条回复里混着出现）

- **变体 C**（既有实现已支持，`glm-native-c-argkey.txt`）：规范的
  `<arg_key>k</arg_key><arg_value>v</arg_value>`，且**同一条回复的尾部又跟了两个
  ```json 围栏信封**——同一个逻辑调用出现两次，必须去重、不得执行两遍。
- **变体 D**（`glm-native-d-teaching-placeholder.txt`，**思考通道**原文）：模型在思考里
  写教学模板 `{"mcp_action":"call","name":"工具名","arguments":{"参数名":"值"}}`。
  `lib/index.js:1785` 会把思考全文喂给同一个解析器兜底 ⇒ 假名会进入派发。

### 3.3 修法（`lib/agent-preset.js`）

- 新增 `parseNativeKeyValueLines(raw, declaredKeys)`：按 `key=value` 行取键、
  非键行续到上一个键的值（支持多行值）、剥掉行尾收尾标签；**给定 `declaredKeys` 时
  每个键都必须由该工具 schema 声明，否则整块拒绝**。
- 新增「GLM 原生 key=value」一支，排在 `tagRe` 之前（`tagRe` 要求标签成对，
  而变体 A 的开闭标签数量不等）；加工具名闸（名字必须在工具表里）。
- **删掉** `tagRe` 里那条 `key\nval</arg_value>` 兜底正则（`{"md":…}` 的来源），
  并在原位留下注释说明为什么删、由谁接手。
- 变体 D 的假名**刻意不在解析层拒绝**：`test/nameless-call.test.mjs ⑨` 要求
  「未知工具名原样保留，交给 TOOL_UNKNOWN 判定」、`test/official-tool-calls.test.mjs`
  要求无工具表时骨架仍解析出 1 条。两条既有护栏合起来说明
  **「这个名字是占位符还是模型真写错了」在解析层不可判定**（同一段文本配不同工具表，
  答案相反）。真正的过滤层是 `index.js` 的工具表过滤（`valid` / `unknownNames`），
  它有对应的用户可见提示。本轮按既有护栏结论**放弃**了那版收紧，并把这段推理
  写进 `agent-preset.js` 的注释，避免下一个人重复踩。

### 3.4 量化复算入口

`node test-mock/probe-glm-parse-replay.mjs` —— 把日志里全部真实 GLM 回复逐条喂给
**生产解析器**复算，与桥当时的 `calls=N` 读数对比。本轮口径：
**一致 32 / 复算多出 9 条（当时丢了调用）/ 复算变少 0**。
`node test-mock/probe-glm-native-shapes.mjs` —— 三种变体的逐条断言（5 条判据，PASS）。

---

## 四、一条被证伪的假设（记下来，别再试）

「教给网页模型的调用格式不对」曾被认为是 GLM 调用失败的原因。真机读数逐字否掉它：
GLM 正文里的 ```json 围栏信封**格式完全正确**（`mcp_action`/`name`/`purpose`/`arguments`
齐全，`parseAgentReply` 每次都解出来了）。失败发生在**模型自己临时换写法**的那些轮次
（变体 A），而模型的换写法是被**错的解析结果**逼出来的——它收到
`missing required property "file_path"` 之后开始猜格式。所以修解析器才是正解。

---

## 五、验证与命令（全部逐条跑过）

```
# 语法
node --check lib/agent-preset.js lib/browser-driver.js lib/attach-scope.js lib/providers.js   → 0

# 解析层
node test-mock/probe-glm-native-shapes.mjs    → RESULT: PASS（变体 A 4 个调用参数全对；C 去重；D 假名不命中真工具）
node test-mock/probe-glm-parse-replay.mjs     → 一致 32 / 复算多出 9 / 复算变少 0

# 新增护栏
node --test test/composer-single-write.test.mjs   → 4/4
node --test test/captcha-gate.test.mjs            → 5/5
node --test test/zai-answer-selector.test.mjs     → 6/6（★ 项已反向验证：换回旧值/删声明位即变红）

# 受影响的既有护栏
node --test test/glm-session-replay.test.mjs  → 1/1
node --test test/nameless-call.test.mjs       → 15/15
node --test test/official-tool-calls.test.mjs → 9/9
node --test test/regression.test.mjs          → 54/54（约 6 分钟，正常）
node --test test/prompt-transport.test.mjs    → 12/12（含新增 ⑪ inline-unsafe）
node --test test/glm-conversation.test.mjs    → 18/18（含新增 kimi 会话形状）
node --test test/site-attach-limit.test.mjs   → 5/5

# 真机
node .tmp-probe/kimi/probe-kimi-final.mjs   → 附件证据 106ms 命中（matched:"stem"）；inline 单次写入 12532/12532 逐字相等
node .tmp-probe/kimi/probe-kimi-resume.mjs  → Q1 地址形状；Q2 goto 回去 sameId=true、hasOne=true
```

---

## 六、未做 / 未取证（如实登记）

1. **kimi 分块丢内容的内部机制未证明**。已确证「只发生在连续写入、间隔无效、单次可靠」；
   未做 Lexical `beforeinput` 插桩。下一步取证法写在 `.tmp-probe/kimi/RESULT.md` §8.1。
2. **z.ai 真机帧未取得** ⇒ 「按真机帧写 decoder」这一项**未交付**（不是没做，是取不到）。
   字段形状来自站点自带前端 bundle 的逐字片段，**不是**一次真实响应。
3. **z.ai 人肉过一次验证后是否仍每次触发**：未取证（理由见 §2.2）。
4. **Qwen / 豆包本轮未取证**：用户报障里提到它们「也不行」，但本轮拿到的失败现场只有
   kimi 与 z.ai 两条。Qwen/豆包需要各自的一轮真机复现才能归因——**不猜**。
5. 本轮所有真机发送都在**副本 profile**（`.tmp-probe/profiles/kimi-probe`）里，
   用户 kimi 侧边栏会多出若干探针会话；线上 profile 全程只做只读 CDP 读取。
