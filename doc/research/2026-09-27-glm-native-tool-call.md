# chatglm（智谱清言）工具调用：原生 vs 文本协议 —— 真实捕抓与结论

> 2026-09-27。全部结论来自**真实抓包与真实流量复算**，不是推断。
> 抓包文件：`C:\Users\rsyhn\.dsh\webcode-edge-profile\sites\glm\.sse-debug\sse-glm-1789973933106.log`
> 真实回复日志：`C:\Users\rsyhn\.dsh\logs\webcode-bridge-replies.glm.log`
> 复算工具：`test-mock/probe-glm-parse-replay.mjs`、`probe-glm-hybrid-shape.mjs`、
> `probe-glm-stream-withhold.mjs`、`verify-glm-mutation.mjs`

---

## 一、直接回答：chatglm 的工具调用**是不是原生的**？

**两个答案是分开的，不能混为一谈：**

| 问题 | 答案 | 证据 |
| --- | --- | --- |
| chatglm.cn **自己有没有**原生工具调用层？ | **有，而且是真的一等公民** | 真实 SSE 帧里 `content[].type === 'tool_calls'` / `'tool_result'`，带 `id`/`name`/`arguments` |
| 桥在 chatglm 上用的工具调用**是不是原生的**？ | **不是。桥走的是文本协议**（```json 代码块 / 标签），因为原生层只认站点自己的内置工具 | 原生层只出现 `execute_sandbox_code`、`finish`；DSH 的 `read`/`pwsh`/`write` 从不出现在原生帧里 |

**一句话**：站点有原生通道，但那条通道**不为你开放**——它只服务 chatglm 自己的内置工具。
所以桥在 chatglm 上**只能**走文本协议，这不是权宜之计，是唯一的通路。

---

## 二、真实捕抓：chatglm 原生工具调用的完整帧序列

抓包文件 27 帧、16,330 字节，真实一轮「写 Python 求 3¹² 并执行」的完整流：

```
帧#7   tool_calls    {"name":"finish","arguments":"{}"}                     ← 模型决定用原生工具
帧#8-12 text          "好的，我来写一段 Python 代码计算 3 的 12 次方并执行："   ← 正文（累积快照）
帧#13  tool_calls    {"id":"call_8aaa4a55dbc5407d81559eff",
                      "name":"execute_sandbox_code",
                      "arguments":"{\"code\": \"result = 3 ** 12\\nprint(...)\"}"}  ← 发起原生调用
帧#14  tool_result   {"content":"{\"success\": true, \"results\":[{\"message_type\":\"stream\",
                                    \"text\":\"3 的 12 次方 = 531441\\n\"}]}",
                      "tool_calls":{"id":"call_8aaa4a55dbc5407d81559eff",
                                    "name":"execute_sandbox_code", …}}          ← 结果**在同一条流里回来**
帧#19  tool_calls    {"name":"finish","arguments":"{}"}                     ← 收尾
帧#20-26 text        "计算完成！**3 的 12 次方 = 531441** …"                  ← 最终答复
```

### 原生帧的**准确字段形状**（逐字）

```json
// 发起调用
{"type":"tool_calls","tool_calls":{"id":"call_8aaa4a55dbc5407d81559eff",
                                   "name":"execute_sandbox_code",
                                   "arguments":"{\"code\": \"...\"}"}}

// 工具结果
{"type":"tool_result","content":"{…站点自己的结果 JSON…}",
                       "tool_calls":{"id":"…","name":"…","arguments":"…"}}
```

三个要点：
1. `arguments` 是**转义后的 JSON 字符串**，不是对象（与 OpenAI 的 `arguments` 同形）。
2. `tool_result.content` 是**字符串化的 JSON**，里面再嵌 `results[].text`。
3. 调用与结果**成对出现**，`id` 能把它们配上。

---

## 三、核心问题：原生工具调用**能不能拦截并转成本地结果**？

### 结论：**不能。** 原因是一句话——

> **原生工具的 `tool_result` 与 `tool_calls` 出现在同一条 SSE 流里，中间没有任何客户端往返。**

对比一下就清楚了：

| 模型 | 工具在哪执行 | 客户端有没有回包机会 | 桥能拦截吗 |
| --- | --- | --- | --- |
| OpenAI / DeepSeek API 函数调用 | **客户端**（你执行完再发下一轮） | **有**——`tool_calls` 返回后挂起，等你提交 `tool` role 消息 | **能**，这正是 DSH 的正常姿势 |
| **chatglm.cn 原生工具** | **站点服务端**（智谱自己的沙箱） | **没有**——`tool_calls` 后面**直接**跟 `tool_result` | **不能** |

帧#13→帧#14 是**相邻两帧**，同一个 `captureId`、同一条流。服务端自己把 `execute_sandbox_code`
跑完，把结果塞回同一份响应。浏览器这一侧从头到尾**没被问过任何问题**——没有可插手的钩子。

因此：

- ✗ 「拦截 chatglm 的原生调用、改由 DSH 本地执行、把本地结果回注」——**物理上做不到**。
- ✗ 也没有「把 DSH 的工具注册进 chatglm 原生工具表」的公开入口（那份工具表在站点服务端）。
- ✓ 能做、且桥正在做的是：**用文本协议把 DSH 工具教给模型**，模型在正文里写出调用，
  桥解析后交 DSH 执行，再把结果作为下一条用户消息回注同一个网页会话。

### 那「原生通道」对桥还有什么用？

有用，而且值得记下来——**它是「模型跑偏了」的信号源**。原生帧里出现
`finish` / `execute_sandbox_code` / `search` 这类名字，说明模型这一轮**去用站点自己的工具了**，
而它本该写 DSH 的调用。所以：

- 桥应当**看见**这些帧（现在 `GlmDecoder` 只是清空文本段累积、把它们丢掉，
  见 `lib/decoder.js` 的 `type === 'tool_calls' || type === 'tool_result'` 分支）；
- 「这一轮出现了原生工具帧」是一条**可观测的读数**，可以在 `/__webcode/status` 上暴露，
  用来回答「为什么这轮没有产出 DSH 调用」——而不是让用户看到一句干巴巴的「没有调用」。

> **本条列为下一步建议，本轮未实施**（用户本轮要求：只修 chatglm 的失败，
> 不加新功能）。诚实标注：上表「不能拦截」的结论建立在**一次抓包、27 帧**上；
> 若站点改版引入客户端执行路径，本结论需要重新取证。

---

## 四、真实流量复算：用户说的「工具调用老是失败」到底是什么

用生产解析器 `parseAgentReply` 逐条复算桥自己落的 **41 条真实 GLM 回复**
（`webcode-bridge-replies.glm.log`，`test-mock/probe-glm-parse-replay.mjs`）：

```
总记录 41｜一致 32｜复算多出（当时丢调用）9｜复算变少 0
其中 raw reply（真实外发回复）5 条当时丢了调用，raw thinking 4 条是思考草稿（不该执行，见下）
```

### 罪魁：GLM 的**混合形状**

真实回复里出现 5 条的写法（**逐字**，记录[11]）：

```
<tool_call>pwsh
{"mcp_action": "call", "name": "pwsh", "purpose": "…", "arguments": {…}}
```
```

它把桥教的**两套形状混在了一起**：开标签来自标签形状，``` 收尾来自 GLM 的代码块形状。
既不是纯 tag 形状（没有 `</tool_call>`），也不是纯 codeblock 形状（没有开围栏 ```json）。

**修复前的后果（全部真实复现）：**

| 缺陷 | 现场 | 用户侧表现 |
| --- | --- | --- |
| **A. 调用被静默丢弃** | 记录[11]：`calls=0`，而 JSON 完全配平、name/arguments 齐全 | 「写了调用却没执行」，一轮白跑 |
| **B. 一条正文里丢前一个** | 记录[3]/[12]/[14]：两个调用只解出后一个 | 少做一半事 |
| **C. 调用顺序颠倒** | 记录[3]：解出 `['glob','pwsh']`，原文是 pwsh 在前 | 有依赖的连续调用会做错 |
| **D. 同一调用解出两次** | 原生模板形状 → `calls=2` | **同一轮派发两遍**（危险） |
| **E. 参数多嵌一层** | 旧实现把整个信封当 `arguments` | 工具拿到 `{"mcp_action":…,"name":…}` 这种错参数 |

### 根因（钉到具体分支）

| 缺陷 | 所在分支 | 根因 |
| --- | --- | --- |
| A | `agent-preset.js` 裸名分支 `bareNameRe` | 终止符守卫**只认 `</tool_call>`**，不认 ``` 收尾 |
| B/C | `agent-preset.js` `fenceCallBodyAt` | 混合形状的**收尾**围栏被当成**开启**围栏，抢走了下一个调用的 JSON（与 0.19.23 修过的 `closingFenceAfter` 同族） |
| D/E | `bareNameRe` 与 `bareObjRe` 两支 | 同一段原文被两支各收一次；且第一支把整个信封当参数对象 |

### 修复（只放宽**终止符**与**入账形状**，不动「什么算调用」的判据）

1. `bareNameRe` 的终止符：`</tool_call>` **或** 收尾的 ``` 围栏；
2. 体内已是完整信封（`mcp_action:'call'` 或含 `name`+`arguments`）时，把**原文**交给
   `takeObj`——两支共用原文去重，重复自然消失，参数也不再被多嵌一层；
3. 新增 `closesHybridCallFence()`：紧贴在「`<tool_call>工具名` + 配平 JSON」之后的
   ``` 是**收尾**围栏，不是开启围栏。

### 修复读数

| 读数 | 修复前 | 修复后 |
| --- | --- | --- |
| 混合形状单调用（真机记录[11]） | **0 个调用**（丢失） | **1 个**，name/arguments/purpose 全对 |
| 混合形状双调用（真机记录[3]） | 1 个（丢前一个）+ 顺序反 | **2 个**，顺序 `['pwsh','glob']` 与原文一致 |
| 原生模板形状 | **2 个**（重复派发）+ 参数多嵌一层 | **1 个**，参数干净 |
| 流式扣留（协议会不会当正文泄漏） | — | 逐字符推进 **0 泄漏**，只有散文外发 |
| 全量单测 | 1162 pass | **1167 pass / 0 fail** |
| 变异测试（三处修复各自变异掉） | — | **三处都如期变红**，还原后全绿 → 闸门不是空转 |

---

## 五、附带的第二个真机事故：GLM 的 `PROMPT_TRUNCATED`

**这不是工具调用问题，但用户同时报的「chatglm 老是失败」有一半来自它。**

真实报错（本机 0.19.40，2026-09-27）：

```
PROMPT_TRUNCATED: 网页输入框只接收了 12870/12911 字符（网页端长度上限）
```

**根因**：`SITE_ATTACH_INLINE_LIMIT` 里只有 `{deepseek: 8000, kimi: 8000}`，**`glm` 缺席**。
于是 12,911 字符的提示词拿全站默认阈值 60,000 → `under-limit` → **inline** →
灌进 chatglm 输入框 → 被站点静默截断 → 整轮失败。

**最讽刺的是**：`browser-driver.js` 的 `ATTACH_FORBIDDEN_SITES` 注释（0.16.31 写）早就写着——

> 真正的站点差异（**GLM 输入框装不下长文**）仍然由各站点的**阈值**表达。
> 真机读数：GLM 的输入框装不下长文（用户原话「他在附件可以，输入框过长」），
> 所以它必须留在附件路径上。

**而阈值表里从来没写 glm。** 那句话只是注释，没有约束力。

**修复**：`SITE_ATTACH_INLINE_LIMIT` 加 `glm: 8_000`（与 deepseek/kimi 同口径）。
用户设置里本来就已经是 `promptTransportBySite.glm = "attach"`，本次只是让阈值与那份显式选择对齐。

复算：12,911 字符 → 修复前 `inline/under-limit`，修复后 **`attach/over-limit`**。
且只收紧不开启：配置 0 时仍一律 inline；未列出的站点零位移。

---

## 六、参考项目对照：别人为什么「流畅」

`reference/webcode`（VSCode 扩展 + 浏览器扩展）的工具调用链路，与本桥的关键差异：

| 维度 | reference/webcode | 本桥（dsh-webcode-bridge） |
| --- | --- | --- |
| 抓取层 | 浏览器扩展在 **page MAIN world 直接拦网络响应**（`network_capture.ts`） | Playwright 从外部 CDP 收 SSE |
| 工具调用来源 | `network_tool_calls.ts` 从**网络响应文本**里提取调用（`collectTurnCandidates` + `looksLikeToolCall`） | `agent-preset.parseAgentReply` 从回复正文解析 |
| DOM 依赖 | 低（网络优先，DOM 只作活动指示） | 中（依赖回答节点选择器判收束） |
| 协议校验 | `toolCallProtocol.ts`：白名单字段 + 三类 issue 回灌给模型 | `parseAgentReply` + `diagnostics` 回灌 |
| 工具结果投递 | `result_delivery.ts` 专门控制「什么时候能投」 | `index.js` 的 `autoContinueRound` |

**值得本桥吸收的一条**：webcode 把「解析失败」当成**要给模型看的具体 issue 列表**
（`ToolCallProtocolError.issues`，逐条点名「字段 X 必须是…」），而不是一句泛泛的失败。
本桥的 `diagnostics` 已经有这个形态，但**混合形状**这种「明明写得对、只是收尾不合教法」
的情况，修复前连诊断都只能给一句「协议标记在场但没有一段能配平成调用」——
模型照着这句**无从下手**，于是连抄三轮坏形状。**本次修复让这个形状直接可执行，是比
「更好的错误提示」更彻底的解法。**

---

## 七、关于「没有交付文档就视为未完成、补发提醒」

用户问：能不能在模型没有交付文档时视为未完成并补发提醒？**效果更好？**

**回答：这个机制桥里已经有了，叫自动续跑（`autoContinueRound`），但它有一个前提条件。**

代码位置 `lib/index.js`：

- `autoContinueRound(noticeText)`：把「再教学提示」**作为一条新的用户消息**补发进**同一个网页会话**，
  然后收第二轮——模型第二次就有机会写出正确的调用。
- 触发条件：`withheld > 0 && !calls.length`，即**协议原文被扣住、但一个调用都没解出来**。
- 次数上限：`autoContinueRounds`（默认 1，0 = 关闭）。
- 相关出口：`TOOL_UNKNOWN` 自动续跑、`thinking-only` 自动续跑（0.16.26/0.16.27）。

**所以「补发提醒」是既有能力，不是新需求。** 本次修复的**混合形状丢调用**，
恰恰是**绕过了这个兜底**的一类：

- 修复**前**：混合形状被丢弃时，`diagnostics` 只有一句泛泛的「协议标记在场」，
  补发提醒虽然发出去了，但模型看不出自己错在哪，**照原样再抄一遍**；
- 修复**后**：这个形状**根本不再失败**——直接解出来执行。这比「更好的提醒」更彻底。

**建议的增强方向（本轮未做，需用户点头）**：
把「模型整轮没写任何调用、也没交付物」——不只是「写了但没解出」——也纳入续跑判据。
现在这一格只覆盖「协议被扣住」，「什么都没写就收尾」不进续跑，会被判成正常完成。
（注意：这会改变「模型选择纯文本回答」的语义，属于产品决定，不该由一次修复顺手带上。）

---

## 八、本轮改了什么、没改什么

**改了（只碰 chatglm 相关路径）：**

| 文件 | 改动 |
| --- | --- |
| `lib/agent-preset.js` | ① 裸名分支终止符放宽（``` 也算收尾）；② 完整信封交 `takeObj` 原文去重；③ 新增 `closesHybridCallFence()` |
| `lib/browser-driver.js` | `SITE_ATTACH_INLINE_LIMIT` 加 `glm: 8_000`（注释里承诺了三版的结论终于有约束力） |
| `test/glm-hybrid-call.test.mjs` | 新增 5 条护栏（含 4 条反例，防过度放宽） |
| `test/glm-attach-limit.test.mjs` | 新增 5 条护栏（含「修复前判据确实会判 inline」的对照，防空转） |

**没改（按用户明确要求）：**

- **不升级版本号、不打包、不安装**（用户原话：「先别升级和打包安装，不用动」）。
- 不碰其它站点：`deepseek`/`kimi` 的阈值逐字不变，未列出的站点零位移；
  `deepseek` 官方模板分支不经本次改动的任何一行。
- 不加新功能（「原生帧读数暴露」「未交付即未完成」都只列为建议）。

**未验证项（诚实标注）：**

- 以上全部为**离线复算真机日志**。修复后的**真机回合**未跑：`sites/glm` 的
  浏览器实例被正在运行的 `dsh web`（pid 22024）持锁，本轮不打断用户正在用的会话，
  因此没有发起真实发送。**要让修复在真机上生效，需要重启 `dsh web`**——
  安装只换磁盘文件，正在跑的进程里仍是旧代码。

— 报告完 —
