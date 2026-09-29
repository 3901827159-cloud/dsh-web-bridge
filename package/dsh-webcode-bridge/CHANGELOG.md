# Changelog

All notable changes to this package. Newest first.

The canonical, in-progress record of what was changed and why lives in [doc/progress.md](../../doc/progress.md);
this file is the package-facing release history.

## 0.19.49

**修：思考等级「回读读不到档位」——5 个站点里 4 个各自有独立的回读缺陷；外加一个带槽的兼容别名真 bug。**

用户原话（2026-09-28）：
> 本轮运行失败THINK_EFFORT_UI_CHANGED: 思考等级「标准」没有生效（站点 kimi）— 回读：读不到档位
> （判定 no-readback）。本轮已中止，避免把「用户选了高档、网页仍是低档」当成成功。
> 其余都是类似原因

**「其余都是类似原因」这句话是对的。** 取证方法与逐站点真因见
[`doc/research/2026-09-28-think-effort-readback.md`](../../doc/research/2026-09-28-think-effort-readback.md)。

### ① kimi：把**模型名**当成了锚点（用户报障的那一条）

真机读数（只读 CDP，线上已登录页）：触发控件 `div.current-model[data-testid="model-select-trigger"]`
的文本是 **`K3 标准`** —— `K3` 是**当前模型名**、`标准` 才是思考档；模型菜单里可选的模型是
`K3` / `K2.8 Preview` / **`快速`** 三条。

0.19.48 声明的 `triggerText: '快速'` 因此是**把模型名当锚点**：只有当用户恰好选「快速」这个模型时
触发文本才是 `快速 进阶`（锚点命中），换成 `K3` 后是 `K3 标准` ⇒ 锚点不在文本里 ⇒
`FIND_EFFORT_CONTROL` 的 token 匹配池为空 ⇒ 回读 `null` ⇒ **每一轮都抛 `THINK_EFFORT_UI_CHANGED`**。

修法：删掉 `triggerText`（不再靠文本定位），改用 `triggerSelectors` 的 testid；新增
**`readbackSelector: '.current-effort'`** —— 真机实测该节点的文本**恰好是档位**（`标准`），
不含模型名。同时去掉 `openVia`（它与触发控件是同一个节点，旧计划会点两次、第二次把刚打开的菜单关掉）。

### ② glm：模型名与档位**无缝拼接**，词级判据切不出来

真机读数：`.think-mode-trigger` 的文本是 **`GLM-Flash极致`**（对比另一模型下是 `GLM-5.3 极致`，**有**空格）。
`'GLM-Flash极致'.split(' ')` 切不出 `极致` ⇒ 词级兜底失效 ⇒ 恒 `unknown`。
修法：`confirmEffort` 新增**后缀判据**（文本恰好等于 / 以某档位结尾，长者优先），并补 `triggerSelectors` + `readbackSelector`。

### ③ qwen：触发文本**就是**档位 id，锚点语义自相矛盾

真机读数：`.qwen-thinking-selector` 文本是 `自动`（切档后 `思考`）。0.19.48 声明
`triggerText: '自动'`，而 `自动` **同时是一个档位 id** ⇒ 剥离函数返回 null、词级兜底又被
「声明了锚点」关掉 ⇒ 恒 `unknown`。修法：删 `triggerText`，改选择器定位 + `readbackSelector`。

### ④ zai / doubao：本轮**未发现**缺陷

zai 的 `triggerText: '深度思考'` 是**真的**固定前缀（pill 文本 `深度思考 最高`），锚点在文本里；
用真机形状在当前代码上跑 `applyEffort`，低/高/最高三档全部 `applied=true` 且回读正确。
doubao 走 `readback: 'aria-checked'`（弹层里被 checked 的那条），本就不依赖触发文本。

### ⑤ 顺带修掉一个真 bug：带槽的**兼容别名**解析不了

`resolveWebModel` 的别名查表发生在**槽解析之前**、用的是整串原文。于是单账户写 `zai:auto` 正常，
**一旦启用第二个账户**（id 变成 `zai@work:auto`）就报「不支持的网页模型」—— 而这两者本该等价。
历史 settings 与 `subagent-model-selection.allowedModels` 里写的都是不带槽的形式，
用户在面板上给模型挑一个账户后就撞上它。修法：把「站点:模型」这一段单独再查一次别名表，
命中后**按原本的槽**解析（槽信息绝不因别名而丢失，否则「账户2」会静默写回默认槽的登录态）。

### ⑥ 判据变更（有意的行为放宽，代价写清）

`confirmEffort` 取「当前档位」新增两种真机形态：**整段即档位**（qwen `自动`）与
**无分隔符拼接**（glm `GLM-Flash极致`）。放宽的只是「怎么取出档位」，**没有**放宽
「取出后算不算命中」——「有没有读到别的档位」仍只按词判（`低 ⊂ 最高` 不会被误判），
且**绝不**按「文本里含目标片段」判定（`进阶的快速响应` 仍诚实报 `unknown`）。
理由：旧行为在这两种形态下返回 `unknown`，而调用方**无法补救**（整轮中止）；
`mismatch` 至少会触发一次真实改档。

### 护栏

- `test/think-effort.test.mjs` 27 项（含新增的形态②③与「词中不算命中」）
- `test/think-effort-realtext.test.mjs` **新增 5 项**：以**真机触发文本**为数据（逐条标出处与日期），
  钉住「锚点必须在文本里」「回读节点必须读得出档位」「真机文本喂判据不许 unknown」
  「kimi 锚点不许再写成模型名」「readbackSelector 接线」
- `test/model-picker.test.mjs` / `test/accounts-integration.test.mjs`：跟上 0.19.43 的
  `auto` 真删（补「历史 id 仍可解析且**槽信息不丢**」的断言）

### 验收现况（2026-09-29 收口复跑，如实记）

**绿的**：`ci-local --fast` **10/10 PASS**；受影响测试集逐个跑全绿
（`think-effort` 27/27、`think-effort-realtext` 5/5、`model-picker` 7/7、
`accounts-integration` 16/16、`multi-site-decoder` 28/28、`model-labels` 12/12，
另 6 个文件 4–17 项不等）。

**未取的**：**线上完整真实轮次仍未跑**。交付时没有任何浏览器在跑 ——
五个站点的 `DevToolsActivePort` 都在而端口全部连接被拒，只读 CDP 这条路当时也走不通。
**在拿到真实轮次读数之前，请不要把「kimi 不再抛 `THINK_EFFORT_UI_CHANGED`」当成已验证**；
手测清单见 `doc/research/2026-09-28-think-effort-readback.md` §9。
「验证需要人的环节没有提醒人手动过」这条已登记为长期问题 **#33**。

## 0.19.48

**加：思考等级（推理等级）真正下发到网页 —— DSH 模型选择器里多出「推理等级」一栏；豆包模型档位取证。**

用户原话（2026-09-28）：
> 1.现在的模型网页端，除了 deepseek 是只有深度思考开关没有思考等级开关，其他网站都有思考等级的分级你没有选择，写好 dsh 这里能主动选择，然后是 2.豆包不是只有对话和工作两个模式，左下角有模型和思考等级选择！请你都解决了！

### ① 真因：DSH 的推理等级通道**桥根本没接**

DSH 宿主本来就支持「每模型一套思考等级」：provider 适配器的 `resolveModel()` 返回
`reasoning: { efforts, defaultEffort? }`，模型选择器就会多出「推理等级」一栏，选中值随
`GenerateOptions.reasoningEffort` 回到适配器。桥此前**一个字都没声明** —— 于是所有站点在选择器里
都是「没有等级可选」。**这不是网页端没有，是桥没接。**

现在（`lib/think-effort.js` 是唯一真源）：

| 站点 | 选择器里出现的档位 | 网页上是什么 |
| --- | --- | --- |
| Kimi | 标准 / 进阶 | 模型菜单里的「思考强度」子菜单 |
| 智谱清言 | 快速 / 深度 / 极致 | 模型弹层里的「思考强度」子菜单 |
| Z.ai | 低 / 高 / 最高 | 输入框旁「深度思考 最高」那枚 pill 的档位菜单 |
| 通义千问 | 快速 / 思考 / 自动 | `qwen-thinking-selector` 的下拉 |
| 豆包 | 快速 / 专家 | 模型下拉里的档位徽章（用户说的「左下角模型和思考等级」） |

**刻意不声明 `defaultEffort`**：声明它等于桥替用户定档，而且宿主会把它 materialize 进每一轮请求。
不声明时选择器显示「Default」，桥**一个字都不动网页**（与升级前逐字相同）；只有用户显式选了某一档，
`reasoningEffort` 才出现并下发。

**未取证的站点一律不声明**（chatgpt / gemini / grok / claude 本机网络不可达；deepseek 只有「深度思考」
开关没有分级 —— 用户原话即此）。宁可下拉里少一栏，也不声明一个点不到的控件：那会让该站点每轮都报错。

### ② 绝不静默降级

`applyEffort()` 只有两种收场：设好并**回读确认**，或抛错（`THINK_EFFORT_UI_CHANGED` /
`THINK_EFFORT_UNAVAILABLE` / `THINK_EFFORT_UNKNOWN`，各带可选项与当前读数）。
没有「点了但没生效就照常发送」——用户选了「深度」而网页停在「快速」，那是一次静默降级，界面上看不出来。

### ③ 豆包：模型 + 档位两个控件都取证了

原先代码注释写着「豆包没有下拉式模型选择器」——**这是错的**。真机读数
（`test-mock/out/think-control-doubao-*.json`）证明它有两个独立控件：常驻的「对话 / 工作」分段控件，
以及 `[data-testid="chat_input_action_model"]` 模型下拉（两条：「豆包 快速」/「豆包 2.1 Turbo专家」）。
用户说的「左下角有模型和思考等级选择」正是后者，现在它的档位（快速 / 专家）进了「推理等级」栏，
模型模式仍由 `modelPicker.segmented` 契约承担。

### ④ 真机取证（`test-mock/probe-think-effort-live.mjs`）

不发任何消息，把真 Playwright 页面适配成 `applyEffort` 认的形状直接跑：

* **z.ai**：低 / 高 / 最高 三档全部下发成功（连跑两轮 3/3 PASS），回读值为「深度思考 低 / 高 / 最高」；
* **Kimi**：`进阶` 命中（幂等快路）；`标准` 那一档因该 profile 已掉登录（页面明写「登录以同步历史会话」）
  无法取证 —— **如实记，不假装验过**。

### ⑤ 取证路上修掉四个只看真机才现形的缺陷

1. **页面函数不得引用模块作用域**：`FIND_EFFORT_CONTROL` 通过 `page.evaluate` 序列化后在浏览器里
   单独执行，调模块级辅助函数 ⇒ 真机 `ReferenceError`（而 Node 单测全绿）。现在页面函数自包含。
2. **`page.evaluate(fn, cfg)` 的参数转发**：cfg 写成第三个参数会被 Playwright 静默丢掉 ⇒ 每站都报
   「找不到控件」。测试里为此单独立了一条护栏。
3. **菜单里有一条与触发控件同名的常驻行**（z.ai 的「深度思考」总开关）：菜单一开，同 token 候选从 1 个
   变 2 个，回读读到菜单行 ⇒ 三次下发全失败，而 pill 明明显示着档位。现在按「不在浮层里 + 有开合状态属性 +
   词的构成」三层判据定位触发控件。
4. **`menuOpen` 误判**：原先「页面上存在 `data-state=checked` 的元素」就算「菜单已开着」，于是 kimi 的
   模型下拉触发钮让驱动跳过「点开触发」，档位菜单永远不开。现在要求那个 checked 元素**有浮层祖先**。

### ⑥ 顺带修正的模型表（同一次真机读数）

* **Kimi**：菜单里 **K3 集群已消失**（站点提示「集群功能已移动至+号面板中」）⇒ 模型表真删 `k3-cluster`，
  新增 `k2.8-preview`；历史 id `kimi:k3-cluster` / `k3-cluster` 仍解析（收敛到 K3，旧会话不断链）。

### ⑦ 护栏与闸门

* 新增 `test/think-effort.test.mjs` **25 项**：声明层（哪些站点有读数、id 逐字、控件契约完整）、
  计划层、判定层三态、执行层（用**假 DOM 跑真页面函数**，含「点可点元素而不是内层 span」「常驻 checked
  不算菜单已开」两条真机教训的回放）、接线层（`resolveModel` 的 reasoning、驱动的 `applyEffort` 调用、
  两条发送路径都带等级）。
* `node scripts/lint-comments.mjs` 0 error 0 warn；`check-ledger` PASS（0.19.48 / 115 个测试文件）；
  `check-repo-hygiene` PASS；`gen-index --check` PASS（48 个模块）。

**如实交代**：本轮**只跑了受影响集**（新增 25/25、`model-labels` 12/12、`multi-site-decoder` 28/28），
未跑全量；Kimi 的 `标准` 档、以及 chatgpt / gemini / grok / claude 四站的思考等级**没有真机读数**，
缺口登记在 `doc/long-term-issues.md`。

## 0.19.47

**修：选了账户2 打开界面仍是账户1；模型行显示真实用户名；剥掉走错通道的 `</think>`。**

用户原话（2026-09-28）：
> 现在右侧选择了账户2打开界面仍是用户1：rsyhn的登录账户，deepseek
> 现在为什么不能做到新增账户后在模型列表就更新为：deepseek-rsyhn(这是真实用户名)，deepseek-177...这样子？？？
> 右侧tab展开站点的：DeepSeek 网页版改为真实用户名！然后是设置界面也需要同步有改为：图像+用户名
> 其余所有已登录网站的用户名和头像一样触发缓存更新字段！

### ① 账户2 打开界面仍是账户1 —— 镜像只按站点挂载

`mirrorFor(siteId)` 的 Map key 只有 `siteId`，cookie 来源写死 `driverFor(sid)` ——
传的是**裸 siteId**，按 `accounts.formatAccountKey` 的语义**恒等于默认槽**。账户2 的标签页
因此命中默认槽那个 mirror 实例、回填账户1 的 cookies；**槽在 URL 里没有任何位置 ⇒
服务端结构上无从区分**。客户端 `siteBase(sid)` 也只按 siteId 拼源，两端一起把两个号混成一条。

修法是给**槽一个独立源**（沿用本项目「每个站点独立源」的既有立场）：

| | 源 |
| --- | --- |
| 默认槽 | `http://<siteId>.localhost:8931/`（deepseek 仍走中继根）—— **逐字不变** |
| 非默认槽 | `http://<slot>--<siteId>.localhost:8931/` |

服务端按 **accountKey** 取驱动、mirror 实例 key 带槽；客户端用**活状态** `accountSlot`
（只传初值会让标签内切号不生效）。护栏 `test/mirror-slot-isolation.test.mjs` **6 项**，
已反向变异确认红灯基线。

### ② 模型行显示真实用户名（`deepseek-rsyhn` 而不是 `(账户2)`）

按槽读落盘的身份缓存，把真实用户名拼进显示名；**读不到就逐字退回 `(账户N)`**（不造假）；
单账户站点不加后缀（0.14.6 逐字不变）。**模型 id 一个字都没动** ⇒ 历史会话、别名表、
`subAgentSite` 全部不受影响。

### ③ 右侧 tab / 设置页显示真实用户名+头像，且覆盖所有已登录站点

两处真缺陷（均为本仓库记过的「后端算好了、中间层丢掉」同型）：`refreshIdentities` 的
返回值被**直接丢弃**（面板渲染的 `rows` 从没拿到 name/avatarUrl，且服务端那次刷新不写缓存）；
刷新**只挂在下拉展开上**（用户从不点开下拉的单账号站、以及账户2 都覆盖不到）。
现按 accountKey 合并进 `rows`（服务端回 null 时**不覆盖**）、并挂到既有 8s 轮询上
（只挑已登录且尚无昵称的槽）。

### ④ 剥掉走错通道的 `</think>`（真机长跑探针顺带发现）

GLM 把思考的**闭合标签**写进了 text 通道，正文出现 `` ``` … ```</think>两条输出分别是… ``。
`GlmDecoder.emitText` 现在剥掉 `</think>` / `</thinking>` 闭合标签本身；刻意**不碰**开标签与
其它标签。护栏 `test/glm-think-tag-leak.test.mjs` **4 项**，已反向变异确认红灯基线。

### ⑤ 顺带修好两条常年假红

`control-routes` 与 `multi-site-decoder` 长期各 1 条红——它们断言 `glm:auto` / `kimi:auto` /
`zai:auto` 必须在目录里，而这三个条目已在 **0.19.43 按用户指令真删**。已改成**双向断言**：
目录里没有 auto（chatgpt/qwen 因无 modelPicker 契约保留），历史别名仍解析得开。
修后 **17/17** 与 **28/28**。两条红的既有性已用 `git stash` 对照证实。

---

## 0.19.46

**修：右侧 tab 的账号昵称/头像「每次新开就没了」—— 身份读数落盘。**

用户原话（2026-09-28）：
> 1.请你查看现在右侧tab获取的deepseek账户名和图像不会缓存？每次新开？
> 然后是展开后需要显示的是图像+账号名；而不是图像+Deepseek网页版，然后设置界面DeepSeek
> 的账户与登录里面一样，其余网站你也搞好

### 根因（两处，缺一不可）

1. **`accountIdentity` 原先只是内存里的一个 `let`**（`lib/browser-driver.js`）。桥重启 /
   懒驱动被回收 / profile 重建 ⇒ 名字与头像归零，面板回到 `displayName` ——
   用户看到的就是「图像 + Deepseek网页版」。
2. **`readAccountIdentity()` 在没有活页时直接返回全 null**。而重启后浏览器尚未 launch
   ⇒ `page` 恰为 null ⇒ **缓存即使存在也被这一格抹掉**。这正是「每次新开就没了」。

对照：`loggedIn` **早就落盘了**（`webcode-login-state.json`，其注释逐字写着
「进程内存里的 loggedIn 重启即归零，没有这份缓存，面板每次重启都把所有站点打回『待检查』」）。
账号身份是同一类装饰性读数，却漏了同一层。

### 修法

新增 `webcode-account-identity.json`（与登录态缓存同目录、同 `0o600` 纪律）：

- 驱动构造时读回缓存（坏 JSON / 缺 `name` 与 `avatarUrl` 两者 ⇒ 当没有，绝不半信）；
- `readAccountIdentity()` 读到就落盘（落盘失败不影响本次读数）；
- **没有活页时回落缓存**，`basis` 如实标成 `'cache'`，**不冒充** `'site-probe'`；
- 仍**不造假**：没有缓存又没有活页 ⇒ 依然是全 null，绝不拿槽名冒充昵称。

### 护栏

新增 `test/account-identity-cache.test.mjs` **7 项**，**已反向变异确认红灯基线**
（退回「无活页即全 null」⇒ ②④ 变红）。

### 附：「profile 被占用，直接复制新开不行吗？」

**行，而且项目本来就这么设计 —— 用账户槽。** 已查实 GLM 的锁持有者 pid **确实活着**
（`process.kill(pid,0)` 回 EPERM ⇒ 按设计一律按「活着」处理），是**合法持锁，不该删**。

`POST account-add` 给 `glm` 的下一个空槽是 **`glm#2`**，其 profileDir 是
**`sites/glm/2`** —— 另一个目录 ⇒ 另一把锁 ⇒ **与在跑的桥不冲突，可真并发**。
效果等同「复制一份新开」，但由代码保证「一个槽一个目录一把锁」，不会出现两实例共用
同一目录而互相杀浏览器 / 交错网页消息。

⚠ 同一登录态在两处并发仍会撞同一网页会话；要真并发请在新槽里**登录另一个 GLM 账号**。
风控纪律照 `CONTRIBUTING.md` §1.3（串行、每变体 ≤3 次、间隔 ≥20s）。

---

## 0.19.45

**修：「空回复」报错的两处取证缺陷 —— 收束原因假陈述 + 只截流首段。**

用户原话（2026-09-28）：
> 本轮运行失败 empty response from web AI（收束原因 finished） | 流首段: data: {"id":"6ab9fff5a0610b1da4035fd6","conversation_id":"6ab9fe16a0610b1da4035b49","assistant_id":"65940acff94777010aa6b796","parts":[],"created_at":"2026-09-28 13:49:41","status":"init","last_error…

> 你看下：现在是桥的问题吗？1.正文回复明显不对？2.调用一半我不返回了却提醒这样！

### 先回答「是不是桥的问题」：这一轮不是桥把回复弄丢了，是网页侧返回了空流

**主证据**（DSH 会话存档 `session-ee3a8650` 的 `session.v4.jsonl.zstd`，逐条解帧）：turn 1 正常
`completed`；**turn 2 的前 9 个 assistant 步骤全部正常带 tool-call**（05:44:09 → 05:49:11），
**第 10 步**才返回空流。同时 `/__webcode/status` 的 `relay.lastError` 显示 `durationMs: 8620`、
`firstTokenMs: 7674`、`responseMs: 946` —— 网页侧开了流（`status:"init"`）但 `parts:[]` 随后结束。

⇒ GLM 在失败前**连续正常工作了约 6 分钟 / 9 个工具步骤**。不是桥丢内容。

**但这不代表桥没问题**：报错文本本身有两处真缺陷，它们正是让「这到底是不是桥的问题」
**无法回答**的原因。

### 缺陷 A：收束原因是一句假陈述

旧实现兜底那格**无条件写 `'finished'`**：

```js
noteEndReason(lastFinished?.settled_by || (site.decoder === 'dom' ? 'dom-capture' : 'finished'));
```

它完全不看解码器给的是 `{complete:true}` 还是 `{complete:false, reason:'incomplete'}`。
而 GLM 的解码器只在 `status === 'finish'` 帧才置 `done` —— 那一轮只有 `status:"init"`
就断了，解码器给的是 `incomplete`。**报错于是把「网页没说完」写成了「网页正常收束」**，
与本项目记过的同族缺陷（旧读数冒充本轮、`mid-stream` 被印成「已开流后的静默」）逐字同构。

**修法**：判据与 `result.complete` **同源**——跑完整才写 `finished`，没收完整就如实带出
解码器的 reason（`partial:incomplete` / `invalid_stream` / `rate_limited`…）。

### 缺陷 B：流首段按构造必然误导

`rawHead` 取的是流**最前面** 400 字符。而 `status:"init"` + `parts:[]` 是 GLM **每一轮**的
正常开帧 —— 首段按构造永远是它，与「这一轮为什么空」毫无关系。真因（限流原话 / 审核提示 /
`last_error`）都在**后面的帧**里，而报错只截首段前 200 字符。

**修法**：新增 `rawTail`（保留**最后一帧**原文），随 `rawHead` 一起进现场；首尾重合时只印
一段。两处使用点都改：`emptyWebResponseError` 与 `web capture ended incomplete`。

**修前 / 修后对照**：

```
修前: empty response from web AI（收束原因 finished） | 流首段: …"parts":[],"status":"init"…
修后: empty response from web AI（收束原因 partial:incomplete） | 流首段: … | 流尾段: …"message":"当前访问人数过多，请稍后重试"…
```

### 护栏

新增 `test/zero-progress-scene.test.mjs` **5 项**（原因自洽 / 首尾段齐备 / 不编造尾段 /
不重复印 / 有内容时不报错），**已反向变异确认红灯基线**（去掉尾段 ⇒ ② 变红）。

### 关于「GLM 以前能跑几个小时」——现有数据不支持，如实交代

查了全部工作区的 DSH 会话存档：GLM 驱动过的步骤共 **80** 个（占全部 30,464 步的 **0.26%**），
出现于 47 个会话，**最长连续运行 0.79 小时（47 分钟）/ 8 步**。会话存档里**找不到任何
「GLM 连续跑数小时」的运行**。

`doc/progress.md` 里唯一的长跑记录是 **DeepSeek** 的 70 分钟真机长跑，而那份表的第 1 轮 GLM
被明确标注为「GLM 误路由」——是事故，不是成功案例。

**为什么无法验证「0.19.40 之前」**：回复取证日志的 `site=` 与 `v=` 字段是 **0.19.30** 才加的；
更早的日志（`webcode-bridge-replies.log.1`，4276 条）没有站点字段，**无法归因到 GLM**；
且 0.19.30–0.19.39 十版在 git 里是一次性合并提交，版本级不可分辨。⇒ 这是**未取证**，
不是被推翻：现有材料既不能证实也不能否定这个记忆。

---

## 0.19.44

**修：发送间隔等待被算进了无进展看门狗窗口 —— GLM「等近两分钟才开始思考」并撞
`WEB_NO_PROGRESS` 的根因。**

用户原话（2026-09-28）：「请你查看下现在的 chatglm 怎么回事：1.超长时间刚开始加载--40 前面版本
我记得都是马上就接着思考而不是现在等近两分钟！才开始有 2. 本轮运行失败 WEB_NO_PROGRESS:
网页侧超过 120s 没有任何新内容（页面在，上一轮收束原因（120s 前） finished，判定相位=网页还没
开口且驱动不在忙（按常规窗口未宽限）） — 本轮已中止，可重试」+「这个是不是叠加1的问题引起的？」

**答：是，第 2 条就是第 1 条引起的。**

### 根因

`relay.submit()` 一调用，适配器的看门狗计时器**当场开跑**；而 `relay.submit` 只是**入队**。
从那一刻到消息真正落进网页 composer 之间，桥还要做几件**与网页生成无关**的事：

| 段 | 真机读数 / 上限 | 依据 |
| --- | --- | --- |
| 发送间隔等待 | **30,000ms**（用户设 `sendGapMs: 30000` + `end-to-start`；旧版本是 10000 + `send-to-send`） | `~/.dsh/.../webcode-settings.json` 与其 `.bak-0140` |
| 驱动懒创建 + `ensure()` 冷启动 | 数十秒量级 | GLM 非 deepseek 默认槽，创建点在 `attempt()` 里，**在间隔等待之后** |
| 附件上传 | **真机 85k 实测 53s** | `uploadTextAttachment` 注释里的既有读数（GLM 走附件） |
| 限流退避 / relay 排队 | 退避 ≤ 3 次、排队 ≤ `queueTimeoutMs` | 各自的上限 |

真机一轮 GLM 实测 **97,993ms**（`webcode-send-state.json` 的 `send`/`end` 差），
而看门狗只给 120s——30s 间隔 + 附件上传已吃掉大半，「网页还没开口」就撞线。

**决定性实测**（注入式脚本驱动，窗口压到毫秒级，首字节延迟固定 800ms，只改间隔）：

```
修前: gap=0→OK(992ms)  gap=1000→OK(1819ms)  gap=2000→FAIL(2607ms)  gap≥3000→FAIL(2609ms)
      且 gap≥3000 时**驱动调用次数只有 1**（这一轮根本没送到驱动）——看门狗是在「等间隔」期间判死的
修后: gap=0/1000/2000/3000/5000/8000/20000 → **全部 OK**，驱动调用 2 次
```

### 为什么这是口径不一致，而不是「窗口太小」

relay 自己的账本就写着「发送前等待发生在网页生成之前，**不计入** `durationMs`」
（`lib/relay.js` 的 `sendWaitMs` 注释）。同一个量在一处被排除、在另一处被计入，才是真缺陷。
**修法是让两处同口径，不是放宽窗口**——顺带一提：`idleFirstByteMultiplier` 只作用于
「首字节之前 + 驱动忙」那一格，本次恰恰落在「驱动不忙」，调它对这个 case **完全无效**。

### 改法

executor 与适配器共享同一个 `meta` 对象，新增两个字段（**唯一真源**，只在 executor 写）：

- `meta.delivering`（活标记）——进 executor 即为真，`markPreDeliver()` 时置假。
  **必须有它**：30s 间隔等待进行到第 5 秒时 `preDeliverMs` 还没法定值，看门狗若只看那个
  字段就会以为「从未投放」而在常规窗口开火（本修复第一版正是如此，实测 gap≥3000ms 仍失败）。
- `meta.preDeliverMs`（累计时长）——投放前累计耗时，每次 `attempt()` 之前重算，
  于是限流退避与压缩重试后 deadline 会相应后移。

看门狗据此算**有效 deadline**：

```
投放中   → submitAtReal + preDeliverMs + windowMs     （窗口本身逐字不变）
投放前   → Infinity（消息还没发出去，「网页不吐字节」尚无证据）
从未投放 → submitAtReal + windowMs                    （既有安全线，逐字保留）
```

**投放前不是无限豁免**：`delivering` 只在 executor 的同步流程里为真，对应的每段等待各有上限，
且新增 `PRE_DELIVER_CEILING_MS`（= `requestTimeoutMs`）硬界作双保险 ⇒ 不会「永不失败」。

### 护栏与反向验证

新增 `test/pre-deliver-window.test.mjs`（6 项）：

- ① 间隔 0→20000ms（窗口的 8 倍）、首字节在窗口内 ⇒ **每档都必须成功**，且驱动调用 2 次；
- ①b 间隔确实生效（墙钟差异 > 3s）——防「间隔根本没生效」的假绿；
- ② 首字节超窗口 ⇒ 仍判死（**窗口不得被放大**）；
- ②b 扣等待 ≠ 免判死（间隔 3000 + 首字节 4000 ⇒ 仍判死）；
- ③ 驱动不忙 ⇒ 仍按常规窗口快报（**既有安全线不得削弱**）；
- ④ 从未投放（驱动挂住）⇒ 必须按窗口判死，不得永不失败。

**反向变异确认红灯基线**：把 `isPreDelivering` 变异成恒 `false`、`preDeliverMs` 变异成恒 `0`
（= 退回修复前行为）后复跑，① 与 ①b **变红**、②③④ 保持绿 ⇒ 该护栏确实钉住本缺陷，
不是空转。

受影响集全绿（新增 6/6、`watchdog-first-byte` 9/9、`idle-window` 18/18、`timeout-order` 5/5、
`capture-stall-rescue` 18/18、`stall-settle` 15/15、`session-continuity` 14/14、`tool-loop` 14/14、
`wait-stats` 40/40、`settings-transport` 8/8、`prompt-transport` 12/12、`glm-attach-limit` 5/5、
`captcha-gate` 5/5、`model-labels` 12/12）。`regression` 53/1 与 `control-routes` 16/1 各有 1 条红，
**已用 `git show HEAD:` 换回旧版 `lib/index.js` 复跑确认两条在 HEAD 上逐字同样红 ⇒ 与本轮改动无关**。

### 仍未修 / 未取证（如实登记，见 `doc/long-term-issues.md` §24-bis）

- **GLM 走附件本身的几十秒还在**（`SITE_ATTACH_INLINE_LIMIT.glm = 8_000`）。本轮只把这段
  从「看门狗判死」里摘出去，**没有**改变它的耗时。用户若仍觉得慢，下一步该做的是
  §24 第 3 条那条一直挂着的**配对实验**：同一 prompt，`promptTransportBySite.glm` 的
  `attach` / `inline` 各跑一次比首字节。
- **GLM 首字节的直接读数至今无人量过**（与 §24 第 1 条同一个空白）。

---

## 0.19.43

**模型选择器：组名加 `webcode-` 前缀；四个有模型选择器契约的站点删掉自造的 `auto` 档。**

用户三点要求（2026-09-28）：

1. **可见组名改为 `webcode-xxx`** —— 一眼看出这组模型来自网页桥，也顺带避开与官方
   provider 分组重名。GLM 仍是 `chatglm`、z.ai 仍是 `z.ai`，只是加了前缀：
   `webcode-deepseek` / `webcode-chatglm` / `webcode-chatgpt` / `webcode-kimi` /
   `webcode-qwen` / `webcode-doubao` / `webcode-grok` / `webcode-claude` /
   `webcode-gemini` / `webcode-z.ai`。
2. **DeepSeek 去掉「（深度思考）」后缀** —— 能力注记由模型元数据 `thinking` 表达，
   不该占用显示名。行名现在是 `DeepSeek`。
3. **删掉「网站名当模型名」的那些条目** —— `智谱清言` / `豆包` / `Kimi` / `Z.ai`
   其实是每个站点那个 `auto`（「不切换网页模型」）档，是桥自己发明的，不是网页给的档位。

### 删 `auto` 的判据与边界（这一条不能只看一半）

用户原话：「这个除了网站给的自动，一般都是没有这个模型档位吧？……这里不是已经让选择了吗？
提供网站提供的模型列表就行」「如果你不知道的话，就先空着不用改」。

于是按「桥有没有该站点的 `modelPicker` 契约」划线——**契约在，说明桥知道网页真实档位**：

| 站点 | 有 modelPicker | 处置 | 现在公布的档位 |
| --- | --- | --- | --- |
| glm | 有 | **删 auto** | GLM-5.3 / GLM-5.3-Flash |
| zai | 有 | **删 auto** | GLM-5.3-Flash / GLM-5.3 / GLM-5.2 |
| kimi | 有 | **删 auto** | K3 / K3 集群 / 快速 |
| doubao | 有（segmented） | **删 auto** | 对话 / 工作 |
| chatgpt / qwen / grok / claude / gemini | **没有** | **保持不动** | 仍是那一条 auto |

后 5 个站点如果也删，`models.length === 0` 会让 DSH 目录构建器**整组不生成**——
下拉里会凭空少掉 5 个组。

**兼容性（与 `webcode` 空壳同一条纪律）**：模型表里删掉，**历史 id 仍必须解析得开**。
真机 `~/.dsh/settings.yaml` 的 `subagent-model-selection.allowedModels` 里就写着
`glm:auto` / `kimi:auto` / `doubao:auto`；只删模型表不改别名，这些白名单会当场变成
不可解析值。因此 `ALIASES` 同时覆盖裸站点名与已限定的历史 id，各自收敛到本站点档位：
`glm:auto` → `glm:glm-5.3`、`kimi:auto` → `kimi:k3`、`doubao:auto` → `doubao:chat`、
`zai:auto` → `zai:glm-5.3`。

### 取证与护栏

- `node .tmp/verify-groups-43.mjs` 模拟 DSH 目录构建器：**11 provider / 10 个可见组**，
  空壳不生成组，10 个组名全部带 `webcode-` 前缀，组内行名是裸名。
- `test/model-labels.test.mjs` **12/12**（组名对照表改成带前缀，新增一条
  「组名一律带 `webcode-` 前缀且不重复前缀」的护栏）。
- `test/regression.test.mjs` **53 pass / 1 fail** —— 那 1 条是既有失败
  （「网页会话丢失时用整段首轮提示词重放」，与本轮改动无关，0.19.42 阶段同读数同断言，
  已用 `git stash` 反证）。该文件里 auto 相关的两处断言已按本轮语义重写。

---

## 0.19.42

**模型选择器按站点分组：一个网站一层。**

此前全部站点挤在一个 provider 里，下拉只有「Harness Web Bridge」一组，10 个站点的
模型平铺在一起。现在每个站点各占一组，组名是站点短键/域：

```
deepseek · chatglm · chatgpt · kimi · qwen · doubao · grok · claude · gemini · z.ai
```

GLM 与 Z.ai 各自成组（同名的 `glm-5.3` 不再看起来像同一个网站的重复项），
组内行名改为**裸模型名**（`GLM-5.3` / `GLM-5.3-Flash`），模型 id 不变。

**兼容性**：仍然注册一个 `webcode` provider 作为兼容空壳，但它的模型列表为空
（目录侧按 `models.length > 0` 过滤，因此不会多出一个空组）。**没有它，所有旧会话、
默认模型与 20 条子代理白名单都会在发消息前报 `session/model-unavailable`** ——
DSH 每次发消息都会校验存储的 provider 是否仍被服务。

已取证：`node .tmp/verify-groups.mjs` 模拟 DSH 目录构建器 → 11 个 provider 注册、
10 个组可见、空壳不生成组且旧值仍解析。护栏：`test/model-labels.test.mjs` 新增 3 条。

**版本号**：分组改造落地时用户明确要求「只做修改 git 不要更新版本号」（2026-09-28），
因此它先以未升版形态提交（`e365eef`）；0.19.42 是**把它打包安装**时才补的版本号——
用户随即要求「打包安装新版本 42，现有刚刚改完的站点模型选择」。两个提交的内容一致，
差别只在 `package.json` 的 `version` 与本小节标题。

---

## 0.19.41

**Kimi / Z.ai 真机取证：用户拿到的两个报错都不是真因。Kimi 投递链修复（六处），Z.ai 改为诚实报错。**

用户报障：`Kimi / Qwen / 豆包 / Z.ai —— 现在都不行`，并贴了两条报错。真机取证
（完整证据 [doc/research/2026-09-27-kimi-zai-glm-real-machine.md](../../doc/research/2026-09-27-kimi-zai-glm-real-machine.md)）
发现**两条报错都在指向错的方向**。

### Kimi —— `PROMPT_TRUNCATED: 20158/38807（网页端长度上限）` 归因错了

- **20158 不是网页的上限，是桥自己的分块写入丢的**。真机逐档实测：**单次**
  `insertText` 从 8,000 到 200,000 字符**全部逐字回读**（最长 167ms）；而**分块**
  20,000+18,400 只回读到 **20,002**（尾部 18,398 字符静默丢失）。块间间隔
  0/100/…/4000ms **七档结果完全一致** ⇒ 等待无效。
  **修**：富文本输入框改**一次性**写入（`composerWritePlan` 只对表单控件生效）。
- **附件投递其实可用，但确认判据恒为 null**：kimi 的附件卡只渲染**去扩展名的 stem**
  （`<p class="file-card-info-name">webcode-context</p>`），而判据找的是完整文件名 ⇒
  `ATTACH_NOT_CONFIRMED` → 回落 inline → 撞上上一条。
  **修**：判断加第二把尺子（stem 回退，仍受作用域/正文排除/长度三闸约束）。
  **真机复验 173ms 命中、`matched:"stem"`**（此前是等满 90s 超时）。
  刻意**不**打开类名候选：kimi 页面上 `[class*='file-card']` 有 42 个可见节点。
- **带附件时发送键处于禁用窗口**：附件上传完成前控件是
  `div.send-button-container **disabled**`，那一刻按 Enter 网页**完全不响应**——
  旧实现的「点按钮 → 回车 → 再点按钮」三条路全落在窗口内。
  **修**：kimi 补 `sendButton` 声明；驱动发送前**等宿主控件的 disabled 消失**
  （判据取页面事实，不再用 `isEnabled()` 预判——控件是 div，那个判断恒真）。
- **会话槽从来没落过 id**（`WEB_SESSION_LOST: 会话槽为空`，即「每轮新开对话」）。
  真机拿到**可导航**证据后补 kimi 的 `/chat/<uuid>` 形状。
- **网页明说「还在生成」，驱动却按 2.5s 稳态把轮次收束了**（真机现场
  `settling turn with 0 chars answer / 114 chars thinking`）。kimi 的流里每帧都带
  `message.status`，是权威信号，旧实现在注释里说「做锚点」却什么都没做。
  **修**：解码器透出 `generating`，终态时**真的**置 `done`；驱动新增第四条判据
  （网页说还在生成就推迟收束，仍受既有硬上限约束）。
- **服务端原话被丢掉**：错误帧的 base64 解出来是
  「和Kimi聊天的人太多了，订阅会员可进入优先队列」，而旧实现只报
  `invalid_stream | 流首段: {"heartbeat":{}}`。**修**：解出 `code：原话` 进 reason。

**修完之后的最终定性**：投递链逐格变绿（附件 173ms 命中 / `ready=true` / `send confirmed` /
38,807 字符逐字写入），随后服务端回 `resource_exhausted` —— **kimi 账号级限流**。
这不是桥的缺陷，但以前**一个字都看不出来**。

### Z.ai —— `页面已有 7 字回复未回传` 是**假读数**；真机跑不通，且原因是风控闸门

- 那 7 个字是**输入框容器**的 innerText：旧 `answerSelector` 尾部的
  `[class*="message"]` 命中了 `div.messageInputContainer`（「深度思考\n最高」=7 字），
  而驱动读的是 `querySelectorAll(sel).pop()`。三处独立读数吻合。
  **修**：`answerSelector` 改为语义特征 `div.chat-assistant, #response-content-container`。
- **真因**：站点风控闸门拦在请求之前——`features.enable_captcha=true` ⇒ 前端
  `await HN()`（阿里云滑块）不返回 ⇒ `POST /api/chat/completions` **永不执行** ⇒
  wire 上零帧。四轮真机复现全部 0 帧；换 UA 也不过闸。
  **绕滑块属破解站点风控，本项目不做** ⇒ 处置是**诚实化**：新增站点声明位
  `captchaSelector`，驱动在发送确认后一次采样，命中即抛 `WEB_CAPTCHA_REQUIRED`
  （文案说明「消息未被受理 / wire 零帧」并要求手动过验证后重试）。
- 顺带推翻「z.ai 用 GLM 的 `parts` 帧」这条假设（站点 bundle 里 `parts`/`choices`/
  `reasoning_content` 各 0 次）；真实帧形状已记档，**decoder 刻意不改**（取不到真机帧，
  换 decoder 是「猜着解不出」）。

### GLM —— 真机原生调用形态有 3 种，旧解析器对其中 1 种给出**错参数**

真机派发出去的调用是 `read {"md":"limit=150\n<tool_call>glob\n…"}`（DSH 回
`missing required property "file_path"`）。模型原文是 `<tool_call>` + 裸工具名 +
`key=value` 行、**没有 `<arg_key>`**，而旧兜底正则把键取成 **`md`**（`README.md` 的行尾）。
**修**：新增 `parseNativeKeyValueLines`（键必须由工具 schema 声明，否则整块拒绝并留诊断）
与「原生 key=value」分支；**删掉**产生 `{"md":…}` 的那条兜底正则。
**错参数比丢调用更坏**——它让模型以为格式已对，只微调格式反复重试。

### 全量门禁

109 个测试文件 / 109 通过 / 0 失败 / exit 0（冻结工作树后逐文件串行实跑，1866s）。
本轮新增 4 个护栏：`composer-single-write` 4 项、`captcha-gate` 5 项、
`kimi-decoder` 5 项、`zai-answer-selector` 6 项。

### 未取证（不猜）

① kimi 分块丢内容的**内部机制**未证明（已确证「只在连续写入、间隔无效、单次可靠」）；
② **z.ai 真机帧未取得** ⇒「按真机帧写 decoder」未交付（取不到，不是没做，未编造夹具）；
③ z.ai 人肉过一次验证后是否仍每次触发：未取证；
④ **Qwen / 豆包本轮未取证**——用户报障提到它们，但本轮只拿到 kimi 与 z.ai 两条失败现场。

## 0.19.40

**交付前审计：修两条真缺陷 + 摘掉一条环境假红。全量单测首次跑通（1162/1162）。**

- **`lint:comments` 原本是红的**（闸门默认 `--max-warnings=0`）。CS005 在注释散文里把 CSS
  自定义属性取值 `var(--x)` 判成「像代码」——因为 `var(` 的后一个字符是 `(`，命中了
  JS 关键字判据。而 `var(` 永远不是合法 JS，这是**闸门自身的假红**。按「假红会让闸门被
  绕过，比没有闸门更坏」的纪律**修判据**：把 `var` 从那条共用正则里拆出来单列，
  `var x = 1;` 仍被抓住，只是不再把 `var(` 当代码。已验证收窄后仍能抓住真死代码。
- **本文件此前停在 0.19.33**，缺 0.19.34–0.19.39 六节——而它随包分发，用户拿到的包里
  最近六轮变更记录是空白。已补齐。
- **一条环境相关的假红**：`reply-log.test.mjs` 断言「生产日志里不得出现本用例写入」，
  而那份日志同时是桥的原始回复留痕，正文里出现该字样完全合法（本机实测确有一条被 dump 的
  回复逐字引用了该测试源码）。`git show HEAD:` 对照确认**与本轮改动无关**。返回 `null`
  已是「没有落盘」的完整证据，故删掉那条判不了「谁写的」的内容断言。修后全量 1162/1162。

## 0.19.39

**dwb 品牌矢量 + 设置页顶部更新栏（真装，但只提醒重启）。**

用户两条原话：①「参考 dsh-store 的设置界面顶部『插件市场 / dsh-market / v1.65.1 / 更新插件市场 /
本次全部忽略』设计好本插件的更新和**只做提醒重启**操作，替换现在空白的单独 github 按钮」；
②「为本项目 dwb 设计合适的矢量图标，替代所有本项目默认的图标」。

- 新增 `lib/update.js`：判据与进程调用分离。版本解析 / 比较 / 挑最新版全是纯函数
  （`parseVersion` / `compareVersions` / `pickLatest` / `updateDecision`），**不引 semver 包**
  以保住零运行时依赖；只有 `runInstall` 碰 `child_process`。
- **只认正式版**：按 `versions` 键自己挑，不直接用 `dist-tags.latest`（它可能指向预发布）。
- **三态而不是两态**：`current` / `outdated` / **`unknown`**——查不到时**不**说「已是最新」。
- 控制面拆两个动作：`GET update-status`（只读，10 分钟内存缓存）与 `POST update`
  （唯一有副作用的，走 `csrfSafe`，并**校验版本号形状**——spec 会被拼进命令行）。
- **「只做提醒重启」的落点**：`runInstall` 真装，装完只回 `needsRestart`，**绝不代重启**。
  重启会终止用户正在使用的会话；装完不重启只是没生效，代重启是当场毁掉用户手上的东西。
- `DwbMark` 品牌标记（拱 + 桥面 + 顶点，viewBox 16 / stroke 1.3 / `currentColor`），
  落在右栏 guide 大图标、右栏标签页 chip（走 `sidebar.right.pane.tab.title` 自定义节点）、
  设置界面介绍区。**设置切换标签页的导航项无法替换**——官方 `settings.section` 只收
  `id`/`order`/`label`，图标由 shell 画。

## 0.19.38

**设置标签栏：与分隔线的距离，以及滚轮到边不再带走页面。**

- 距离按官方读数重定：官方同类「文字 + 底线」分隔栏是文字底边到线 9px，而本实现是浅色胶囊，
  贴线的是**色块**而非文字 ⇒ 容器 `padding-bottom` 4px → **10px**（色块底到线 10px、
  文字底到线 15px）。修的不是「把 9 调大」，是按色块重新定距。
- 滚轮到边：旧判据 `scrollLeft` 前后不等才拦默认，而到边时浏览器把越界值钳回最大值 ⇒
  判据恒假 ⇒ 同一次滚轮继续冒泡去滚整个设置页。改为按「这条栏真的有可滚内容」拦默认，
  另加 `overscroll-behavior-x:contain`。

## 0.19.37

**账户真实昵称/头像四跳补齐 + 站点健康度三色圆点。**

- 真根因是**接线缺陷**而非选择器不准：驱动早已透出 `accountName`/`avatarUrl`，
  但 `index.js` 的 `siteStatusRow()` 两个分支都没转发、客户端的字段挑选表也没挑进来 ⇒
  界面拿到的永远是 `undefined`。四跳逐跳补上；未初始化的槽**如实给 null**，不拿槽名冒充昵称。
- 头像改真实 `img`（抓不到回落站点矢量标记，跨域拒热链时 `onError` 藏掉）；
  昵称取 `accountName || displayName`。
- 「已登录」占位框改为标题行右上角**一个圆点**，判据是跨该站点全部账户的聚合：
  全绿 = 每个账户都可用，全红 = 没有一个可用，黄 = 部分可用（`--dsw-alias-state-warn-primary`，
  取自官方 token 白名单）。颜色是唯一视觉载体，因此 `aria-label` 把含义说全。

## 0.19.36

**打开提示词文件的报码短路 + 报错/长文本换行保护。**

- 两处「查看」此前调 `api()`，而它在 `ok:false` 时直接抛 ⇒ 紧跟其后的报码映射表**永远走不到**，
  整段 JSON（含完整 Windows 路径）成了界面文案。改走 `apiSoft` + 短文案。
- 换行保护：Windows 路径 / JSON / URL 都是**没有可断点**的长串。给 `.hwb-hint` 等 13 处
  加 `max-width:100%` + `overflow-wrap:anywhere`（逐个点补而非通配，通配会命中图标与按钮）。

## 0.19.35

**等待面板行序 + 豆包/清言真矢量 + 去图标悬浮说明。**

- 删掉与标题重复的「本次会话等待发送」行；行序改成同类相邻（两个占比 → 两个轮次 →
  限流/间隔 → 平均值 → 累计总量压最底）。
- 豆包换 `doubao.svg`（3 条路径，含两条 `fill-opacity=.5` 浅色层），智谱清言换 `qingyan.svg`
  （2 条路径——`chatglm.svg` 是底层模型的标，`qingyan` 才是这个应用的标）；`SiteGlyph`
  新增多路径分支。两者档位 `official` → `vector`。
- 删掉图标上的 `title`。**删的是显示不是记录**：`SITE_ICON_TIER[].why` 逐条保留，
  改由护栏在源码层核验。

## 0.19.34

**等待面板：在途读数上标题，删「正在等待发送」行。**

- 标题右侧改读新增的 `projectedValue` = 账本累计 + 在途增量，逐秒前进。
  旧形态钉的是已落账的累计（在途期间不动），另起一行显示在途——一次等待期间面板里
  站着两个数。
- 加法收进单一函数 `projectedWaitMs(session, live, now)`：此前药丸与明细各写一遍，
  迟早会有一处漏掉在途增量。
- 死代码清理：`web-control.js` 的 `liveElapsedMs` 与载荷字段 `liveValue` 一并删除。

## 0.19.33

**设置改了，派生读数不再「跟不上」；并修掉一条会让 GLM 整轮没回复的作用域缺陷。**

用户原话：「现在设置界面分站点的投递选择更改后提示词更新跟不上，请你修复」；
以及「本轮运行失败 sleep is not defined？你看下为什么长期桥运行 glm/glm5.3 会出现这个问题」。

### 设置修订号（settingsRevision）

- 根因：设置面的派生读数（提示词模板 / 增量再教学 / 投递形态生效值）由服务端现算，
  而客户端的拉取时机此前只有「挂载时一次」——站点页保存后**没有任何东西会重拉**，
  于是「已保存」与「看到的仍是旧的」同时成立。
- 服务端在 configManager 的 set() 里自增一个单调递增的修订号（唯一落盘点，
  POST settings 与 account-add 两条写路径都覆盖），并随 GET settings / attach-status /
  prompt-variants 一起回；POST settings 的响应**当场**带回新号。
- 客户端把号当 effect 依赖，任何一次设置写入后派生读数立刻重拉，不必等下一次轮询。
- 站点页保存投递形态后额外重读一次 attach-status?siteId=…（「当前生效：」那一行是
  用户核对「本站点覆盖到底生效没有」的唯一入口）。
- 独立设置页保存后除模板外还刷新读数行，并新增逐站点生效读数。
- 顺带修掉一条同源的旧缺陷：GlobalPrompt 保存全局指令后只调 onSaved?.()，而
  PromptSection 自 0.16.38 拆卡起就不接这个回调了——「改了全局指令、模板不更新」一直存在。

### sleep is not defined（跨作用域引用，同型第二例）

- runTurn 的续聊重试分支写了 `await sleep(1500)`，而 sleep 只存在于 DOM_CAPTURE
  **注入模板串**里（喂给 page.evaluate 在浏览器执行的代码），Node 侧没有这个绑定 ⇒
  必然抛 ReferenceError，被 catch 当成普通失败。
- 触发条件与既有记录的 nav 那一例逐字相同（第一次导航就没 ready，页面冷加载慢的常见
  现场），所以用户看到的是「GLM 这一轮整个没回复」——这就是长期跑 glm 会撞上的原因。
- 修法：模块级新增 Node 侧等待原语 delay(ms)（刻意不叫 sleep，避免与浏览器侧同名混淆）。
- **护栏为什么没抓到它**：driver-scope.test.mjs 的绑定表建在原始源码上，模板串里那句
  `const sleep = …` 被当成了真实模块级绑定——正是该文件头注写明的「只会漏报」方向。
  已改为在抹掉模板串字面文本的源码上收集绑定，并新增 sleep 逐字回归钉与扫描器自检。

### 护栏

- test/site-prompt-transport.test.mjs 新增 ⑥a/⑥b/⑥c：真 HTTP 断言写入后修订号前进且
  三条读数路由号一致；源码断言每个设置写入点都应用号（按调用点逐个查，不是数个数）。
- test/driver-scope.test.mjs 新增 ⑤（sleep 回归钉）与 ⑥（扫描器自检：先断言旧写法确实
  漏报，再断言修法能抓住）。两条新护栏都做过红灯验证。

---

## 0.19.32

**提示词投递形态支持站点级覆盖：全局一个，每个站点可单独设。**

用户原话：「提示词投递：给每个模型站点都做到和『发送间隔（全局）』一样的逻辑：全局设置一个，
但是针对每个单独网站设置能够单独设置」。

- 回落链与 sendGapMsBySlot 逐字同构：**站点档 → 全局档 → 插件 config → attach**。
- 新设置键 promptTransportBySite（字典）。「跟随全局」用**删键**表达，落盘的字典里只许有
  inline / attach 两个合法值，因此「没配」与「配成跟随全局」始终可区分。
- 原生面板与独立设置页**两处**都加了入口：站点页三态（跟随全局 / 附件投递 / 纯文本）
  单选即时保存，全局页那一档原样保留。
- attach-status 现在按站点回答（?siteId=），并新增 POST attach-status 别名——客户端带
  body 就是 POST，只注册 GET 会撞 405 + 空 body（0.15.3 修过的同族缺陷）。
- 读数分两格：promptTransport（合并后的生效值）与 promptTransportSite（覆盖存在性，
  null = 跟随全局）。
- 护栏 test/site-prompt-transport.test.mjs 五条：真驱动合并、现读纪律、两个构造点都接线、
  真 HTTP 往返与归一化、面板入口存在且不新造设置键。

---

## 0.19.10

**图片「有，但加载不出来」的真因：附件证据窗口太短，把慢上传读成了失败。**

用户会话 `62f74e98`（附图 1086×1425 / 942,941 字节）里，桥自己的回复日志留下了这句：

```
⚠ 图片未能附加到网页（ATTACH_NOT_CONFIRMED），本轮将以纯文本发送
```

于是那一轮静默退化成纯文本 —— 用户看到的是「网页端有图片但加载不出来」，而模型
只能去翻 `read_image` 的元数据，最后如实回答「我看不到像素内容」。

真机复现（同一张图、同一条路径）：一次 `imageTransport.ok=true`、端到端 **37 秒**，
模型正确描述出画面。也就是说 **15s 的等待窗口不是「上传失败」，是「缩略图还没渲染」**：
DeepSeek 客户端要等它自己的上传/压缩流程走完才给出 `img[src^='blob:']` 证据，图越大越久。

修法：`uploadImages` 的证据窗口 15s → **90s**，`uploadTextAttachment` 20s → **90s**
（同一口径；85k 字符真实投递实测 53s）。证据一出现就返回，所以这只影响失败时的等待，
不让正常轮次变慢；上传入口缺失仍在 `setInputFiles` 之前立刻抛 `ATTACH_UNAVAILABLE`。

护栏 `attach-callsite` ⑥c：两个窗口都不得短于 60s、也不得超过 120s（与整轮 240s 预算打架）。

## 0.19.9

**有图又超长的轮次：正文没走附件，整段灌进了输入框。**

用户原话：「deepseek 明明在附件投递模式下，看的还是完整上下文」。

真机复现（一轮里同时有一张图和 81,004 字符正文）：页面上的用户消息
`userMsgChars=81139`、`mentionsFullHistory=true` —— 正文整段进了输入框，而
`attachTransport` 还停在**上一轮**的读数（于是面板显示「当前生效：附件投递」，
用户看到的是全文 —— 最坏的那种不一致）。

根因是调用点的一个守卫：`if (!attachEvidence)`。`attachEvidence` 在**带图轮**已被
`uploadImages` 置位，于是「既有图、正文又超长」的轮次**整块跳过**了投递判定。图片与
文本附件是网页输入区里两件独立的事，一个已经挂上不代表另一个不用挂。改法：判据换成
`plan.mode`（正文是否需要附件），不再看「有没有用过附件」。

顺带修掉一个**假阳性陷阱**：`waitForAttachment` 的类名候选判据（`img[src^='blob:']`）
分不出附件是谁的——带图轮里它会被图片命中，把「.md 没落地」误判成「已确认」。文本
附件的证据现在只认文件名（`text:<name>`，`allowCandidates:false`）；图片那条保留候选
兜底（既有行为，不动）。

> 后端 `lib/browser-driver.js` 是随 `dsh web` 进程加载的。**这两处都要重启才生效**，
> 上一轮已经踩过一次：0.19.8 交付时用户当时没重启，我复跑真机时读到的仍是旧行为。

## 0.19.8

**图片轮发不出去：发送只调用、不确认。**

真机取证（DeepSeek 统一 UI）：不带图的一轮 1.6s 正常回答；**带图**的一轮，附件上传
证据命中（`imageTransport.ok=true`、`img[src^='blob:']`），但整轮 240s 超时；22 秒后
直连浏览器（CDP）探活发现**页面仍停在站点首页、正文还躺在输入框里**——程序化 Enter
没有提交。同一页面手工按 Enter 立刻发送成功，模型正确读出图里的字符。

根因是发送没有确认：**「没发出去」与「发出去了但网页不回」在读数上长得一模一样**，
而旧实现调用完就 `startWipWatch()` 等回复。

修法：发送后按**页面事实**确认——输入框被清空，或地址栏从站点根切到 `/a/chat/s/<id>`；
未确认就换下一条路重试（契约按钮 → 聚焦输入框末位回车），三条都不成立则抛
`SEND_NOT_CONFIRMED`，不再伪装成超时。护栏见 `test/send-confirmed.test.mjs`。

## 0.19.7

**界面三条：输入框探出卡片、顶栏缺项目链接、控件风格不统一。**

1. **输入框超出卡片框**（用户反馈）：设置页的 `.hwb-model-select` / `.hwb-prompt-input`
   与任务板弹窗的 `.hwb-input` / `.hwb-select` 都缺 `box-sizing:border-box`，于是
   `width:100%` / `max-width:340px` 按**内容盒**计算，加上左右 padding 与边框就比容器宽
   二十来像素；`.hwb-card` 没有 `overflow:hidden`，看起来就是控件从卡片边框里探出来。
   已补齐 `box-sizing:border-box` + `max-width:100%` + `min-width:0`，并加护栏
   （`test/client-render.test.mjs` 的 0.19.7 用例，删掉任一条声明立刻变红）。
2. **顶部 GitHub 链接**：设置界面标题行右端（原生面板 `.hwb-settings-head`，独立设置页
   `.header-row`）各加一枚项目主页链接。
3. **统一控件风格**：模型下拉与文本框统一为「填满可用宽度、上限 340px」（旧版没有宽度、
   只有 `min-width:220px`，下拉比标签列还窄且一行里长短不一）；任务板弹窗控件补上盒模型
   与圆角刻度。

## 0.19.6

**两件事：界面文案按「官方解释长短」收紧、插件市场整页崩溃修复。**

### 一、设置界面与右栏：只留状态与动作，解释不进界面

用户反馈（2026-09-24）逐条落地：等待占比不再输出「（覆盖 n/N 轮）」；agent preset
展示名改为 **`wecode模式`**，description 与 persona 压成简短声明；设置页删掉
「正在运行（子代理 / Team）」整卡、限流退避说明、「附件探针」与「最近一次实际投递」、
真机事故叙述、会话隔离的机制句、重复的全局指令说明；「首轮提示词（只读）」卡重排美化
且信息面不变。判据落在**渲染出的文本**上，不看源码注释（`test/settings-transport.test.mjs` ⑧
与 `test/client-render.test.mjs` 的新契约用例）。

一条要紧的口径：**探针是开发者自用的读数通路，不是用户功能**。它的服务端动作
（`POST /__webcode/attach-probe`）保留，但按钮与读数已从两处用户界面（原生设置面板、
独立设置页 `/__webcode/settings-page`）全部撤掉。

### 二、插件市场（dshmarket）整页崩溃：图标导出改名

市场页报 `Minified React error #130`。根因不是市场本身逻辑，而是 **DSH 0.1.7-alpha.2
把 primitives 的图标导出整体改了名**（`IconXxxOutline14` / `…16` → `…Regular` / `…Medium`），
而 dshmarket 1.55.0 的 bundle 直接解构旧名 → `undefined` 被当组件调用 → 整棵 React 树崩。
修法：把 web profile 的 `dshmarket` 升到 **1.59.0**——它的 bundle 带 `ICON_ALIASES`
两代名字回落（0.1.7+ 的 `…Regular` 与 0.1.7 之前的 `…16/14` 依次取值）。

## 0.16.9

**三件事：Harness 侧 markdown 逐字保真、站点禁令可核对、`pnpm test` 死锁解除。**

### 一、`## 标题` 变 `##标题`、表格塌成一行（真因与修法）

用户原话：「好像零点九几的时候，harness 显示的 Markdown 是没问题的，但现在渲染到 harness
就会格式错乱」「#后面没有空格？代码块包裹没有换行？导致没有闭合？」

真因不是渲染，是**字节在桥里被吃掉了**：流式正文外发处的 `tagDebris` 判据把**纯空白**和
**ASCII 竖线 `|`** 都当成「标签残渣」，命中后静默推进游标、一个字节都不发；而
`PROSE_TAIL_CHARS = 8` 的滞后让「本片放行区间恰好是一个空格或换行」成为必然。于是
`## 标题` 丢空格、空行消失、围栏不闭合、`| 列 A | 列 B |` 塌成 ` 列 A  列 B `。

回归窗口自 **0.14.2**（那次为修「回复夹杂错误调用」加了这个判据），0.9.x 没有这条分支——
所以用户「零点九几是好的」这个观察是准确的。

修法：判据拆成 `tagOnly`（只由标签字符组成）**且** `hasTagChar`（至少含一个真标签字符），
纯空白因此照常外发，ASCII 竖线从「标签族」里剔除（它是 markdown 表格分隔符）。
护栏 `test/markdown-whitespace.test.mjs`（8/8）**逐字符驱动**——只有逐字符喂进去，释放边界
才会落在每个字符上；既有的 `markdown-block-integrity` 抓不住它，因为它只断言「块内容 ≡
Σ增量」，而本缺陷里**两条通道一起**少同一个字节。

### 二、DeepSeek 禁令现在**看得见**

0.16.7 加了站点禁令，但它只存在于代码里：`site-no-attach` 分支不写读数、`status()` 不投影
这个布尔量，`GET attach-status` 反而还在承诺「超过 60000 字符时改走附件」（对该站点已不成立）。
用户因此**无法核对修复是否生效**。本轮补齐 `SITE_NO_ATTACH` 读数、`status()` 的
`attachForbidden` + `siteId` 投影，以及面板上的「本站点永不使用附件投递」。护栏 ⑩（11/11）。

### 三、`pnpm test` 曾连**启动**都做不到

lockfile 把**可选** peerDep 记成普通依赖且 `specifier: '*'` 对 `version: 0.1.5-alpha.1`
自相矛盾，pnpm 的前置检查（`install --frozen-lockfile`）必然失败——**CI 下它会先删
`node_modules` 再报错**，实测真删过一次。修法是把 specifier 收紧为 `^0.1.5-alpha.1`。
顺带修了 `control-routes` 夹具在并行负载下读端口为 `null` 的既有 flake（用 HEAD 版本同样会红，
已确认与本轮改动无关）。

## 0.16.31

**三件事：DeepSeek 附件投递解禁、发送间隔新增「距上次回复完成」口径、等待药丸不再跳动。**

### 一、DeepSeek 附件投递解禁（`ATTACH_FORBIDDEN_SITES` 清空）

0.16.7 的静态禁令（「DeepSeek 收得下附件但读不到它」）建立在一次真机事故上：附件传上去了、
页面也出现了，但那一轮**零回复**。0.16.31 用只上传、**绝不发送**的探针
（`POST /__webcode/attach-probe`）重测，读数推翻了其中一半前提：

```json
{ "ok": true, "evidence": "text:webcode-probe.md", "ms": 105,
  "domSnippet": "<div class=\"e70accd6\">webcode-probe.md</div>", "cleaned": false }
```

即**收得下、渲染得出**在今天的页面上成立（当年 `ATTACH_NOT_CONFIRMED` 的直接原因是文件名
证据还没实现，类名清单零命中）。而另一半（模型读不读）现在有**运行期自愈**兜底：
`DYNAMIC_ATTACH_BLOCKS` 对「附件轮整轮零回复」的两个签名自动降级并记住，当轮即回落
inline。

取舍写在明处：静态禁令用**永久走不了附件**换**一轮风险**，不划算，因此清空静态表；
若自愈再次记下 `ATTACH_ZERO_REPLY`，`/__webcode/status` 的 `attachBlocked` 会如实报出，
那时再按读数据决定是否恢复。**本轮没有真机验证「模型确实读到了附件内容」**——
探针不发送，回答不了这个问题，如实记在台账里。

顺带修了附件 chip 的清理路径：`cleanupAttachment` 原先只沿祖先链找删除控件（真机上 chip
的最深节点是文本 div，控件不一定在祖先里），现在先按语义标签找、再按**位置**找（与文件名
同容器、位于其右侧的可点控件），且多附件时**不按位置猜**——点错会删掉别人的附件。

### 二、发送间隔：新增 `end-to-start`（距上次回复完成）

用户原话：「我需要的是 web 思考后调用时间后不立即回复而是间隔多少秒回复……为了隔开和
他发消息我立马回复的规避点！」。这与既有的 `send-to-send`（距上次发出）**防的不是一件事**：

- `send-to-send`（**仍是默认**）：防站点的滑窗限流，按请求到达计——上一轮跑得久时本轮
  **无需再等**。改默认值等于静默改掉所有既有用户的行为，因此只新增选项。
- `end-to-start`：防对话节奏贴得太紧——上一轮跑了多久**不影响**本轮，**答完那一刻起**
  重新数满间隔。

落盘格式从裸数字升成 `{ send, end }`（**旧格式照样读**，升级不丢基准）；设置页两个面
（HTML 页 + 右栏面板）都有口径下拉；读数新增 `gapBasis`，面板文案随口径切换为
「距上次发出」/「距上次回复完成」。护栏 `test/send-gap-basis.test.mjs` 12 条。

### 三、等待药丸的跳动（真缺陷）

用户报「底下框的时间会跳动」。根因不是取整，是**在途读数被提前清空**：
`clearLiveWait` 原在等待 sleep 的 `finally` 里，于是等待一结束读数就消失，而账本要等整轮
生成跑完才吸收——中间那几十秒药丸掉回**上一轮**的旧值，收束时再跳上去。现在正常路径
保留在途读数（`endsAt` 已把它冻结在满值），只有 **abort** 才清（那时本轮不会有 metrics，
留着会让药丸停在一个不动的假数上）。

## 0.16.30

**官方 token 的「双竖线」漂移让整族解析归零**——这是用户报「版本更新后自动化流程被打断、
每轮都错」的根因。真机回复里模型把包裹竖线写成**两枚** U+FF5C：

```
<｜｜tool▁calls▁begin｜>
<｜｜tool▁call▁begin｜>pwsh<｜｜tool▁sep｜>{"command":"pwd"}<｜｜tool▁call▁end｜>
<｜｜tool▁calls▁end｜>
```

而 0.16.18–0.16.29 的解析正则全是 `'<' + 单枚竖线 + '\s*'`，`\s*` **吃不下第二枚竖线**，
于是四条链路一起失守：`findProtocolStart` → `-1`（认不出边界）、`normalizeOfficialToolCalls`
→ 原文逐字不变（改不动）、`parseAgentReply` → `calls=0`（每轮 `TOOL_CALL_UNPARSED`）、
`partialProtocolAt` → `-1`（半截标记不扣留、漏成正文）。

**「改了什么」的答案**：协议从 DSML 族换成官方 token 族时，**DSML 族一直有的竖线宽容没跟过来**。
`DSML_MARK_SRC` 写的是 `DSML_BAR_CLS + '{1,3}'`（容 1~3 枚），官方族从 0.16.18 引入起只有一枚。
日志计数坐实两族都在写双竖线：全日志 9,803 处 —— DSML 时代 9,764 处（当年被容下、照常执行）、
官方 token 族 25 处（本次现场，一条都不认）。

修法是新增 `OFFICIAL_BAR_CLS = OFFICIAL_BAR + '{1,3}'`（与 `DSML_BAR_CLS` 同纪律、同字符、
同 1~3 上界），替换官方族**全部五条**正则的包裹竖线，并给 `partialProtocolAt` 的精确前缀表
补上双竖线族（前缀表是精确字符串，归一化对"标记不完整"一格都不改，所以归一化救不了它）。
上界 3 不是无界：锚点与改写要在流式途中反复调用，无界量词会把 `<｜｜｜｜｜…` 噪声吞进协议判定。
**只放宽竖线，单竖线既有行为逐字不变。**

再教学提示点名真实病灶（「包裹竖线是一枚，不要写成两枚」）——与 0.16.20/0.16.25 同一条纪律：
提示要指出模型实际写错的那一处，否则模型自查「name 在、JSON 合法」后无处可改、只能原样重发。

验证：新增 `test/official-double-bar.test.mjs` 11 条，对已发布的 0.16.28 代码实跑 **8 红 3 绿**
（红的正是双竖线全族，绿的正是"不许回归"三条），修复后 11/11 绿。真机回复原文重放：日志里
双竖线官方 token 共 **6** 轮、live 运行时 **6/6 全记 `calls=0`**，修复后 **6/6 全部解析成功**、
共产出 **13** 条可执行调用。

## 0.16.29

**再教学提示不再铺进会话正文**（用户指令：「关于 TOOL_CALL_UNPARSED: 直接隐藏」）。三处出口
（`TOOL_CALL_UNPARSED` / `TOOL_UNKNOWN` / `THINKING_ONLY_NO_ANSWER`）的提示仍逐字作为**补发的
用户消息**发给模型，界面上只留一句 `AUTO_CONTINUED: 已自动补发提醒，网页已重新发起 N 条调用。`。
例外：补发**根本没发生**时（`autoContinueRounds=0` 或无会话键）提示照旧当正文交回——
隐藏的前提是它已经送达模型。

**落盘从副本升格为投递源。** 用户要的是「如果新开会话-web 端，就一样把这个当上下文通过文件
发送」。0.16.28 只落了盘（写而不读），本轮新增 `readPromptFile` + `readSessionPrompt`，
整段重建改为 `readSessionPrompt(sessionKey) ?? rebuild()` —— **优先读磁盘正本**，
读不到才回落内存序列化。发出去什么、重建用什么，从此同一份字节。

顺带修掉 0.16.28 的一个真缺陷：`writePromptFile` 用 `[..., ''].filter(Boolean).join('\n')` 拼头部，
那个空串被 `filter` 删掉，头部末行与正文首行**粘成一行**（真机实测：读回只剩第二行之后，
正文首行被吞）。现改为显式 `+ '\n\n'`，读回端兼容旧粘行格式。

**节流窗文案更正**：`SESSION_REBUILD_THROTTLE_MS` 自 0.16.6 起就是 **60 秒**（注释里的「30 秒」
是引 0.16.6 提交里用户对更早版本的描述）。真机佐证：reply-log 的 `19.962s 前…还剩约 40.038s` = 60.0s。

## 0.16.7

> **⚠ 本节结论已于 0.16.31 推翻（原文保留作历史记录）**：`ATTACH_FORBIDDEN_SITES`
> 已清空，DeepSeek 恢复附件投递。推翻的是**前提**：0.16.7 当时判定「网页收下了」所依赖的
> 类名选择器清单在真机上**零命中**，于是把「确认失败」误读成「模型不读」（文件名证据 0.16.3
> 才实现，探针 0.16.4 才有）。0.16.31 的探针实测 `ok:true` 并实拍到 chip DOM。
> **未被推翻的是风险本身**：模型究竟读不读附件，探针回答不了；现在由运行期自愈兜底
> （附件轮零回复 → 当轮降级 inline 并记住）。详见 §0.16.31 一。

**DeepSeek 站点不再走附件投递。** 真机实测（2026-09-18）：71994 字符走附件时，附件确实
传上去了、页面上也出现了，但这一轮**没有任何回复**——`domChars:0`、页面退回
`chat.deepseek.com` 根地址，navTrace 里连 `landed:after-submit` 都没有；同一账号改回
**纯文本投递**就正常（用户原话：「deepseek以附件投递会出问题！不能回复！前面时候改为
输入框还行！」）。

也就是说「网页收得下附件」与「网页模型会读这个附件」是两件事，而 DeepSeek 的答案是「不读」。
因此新增站点契约 `ATTACH_FORBIDDEN_SITES`（当前含 `deepseek`），并在投递判定里把它排在
**阈值之前**：该站点无论多长都只走输入框，宁可慢，也不要「网页收下了、什么都不回」。
判据是**站点声明**而不是调用方的开关——这条知识属于站点契约，写在别处必然漂移。

反向要求同样成立：GLM 的输入框装不下长文，必须留在附件路径上。**本表只排除，
不改变其它站点的既有行为。** 护栏：`test/prompt-transport.test.mjs` ⑨（禁令生效）/
⑨b（不误伤 GLM）。

## 0.16.6

**会话重建节流不再中断会话。** 同一个会话键在 60 秒内已经整段重建过一次时，第二次不再重放
四十万字符——但 0.16.4 的实现是抛 `WEB_SESSION_REBUILD_THROTTLED` 把这一轮**判死**，
界面上就是一条红色「本轮运行失败」、会话当场断掉（用户原话：「改为只提示已经切换会话而不是
打扰直接中断会话」）。现在改为交回一条提示正文：

```
SESSION_SWITCHED: 网页会话已切换——本轮不再重放首轮上下文（上一次整段重建在 30s 前、
重放了 127895 字符，节流窗还剩约 30s）。会话没有中断：直接发送下一条消息即可继续——
窗口过去后这一轮会整段重建，窗口内则继续显示本条提示。
```

节流那一轮的正文一个字节都没进网页会话，所以发送游标**不前进**（下一轮会把这一轮的内容
一并带上，而不是只发一个没有前文的增量），会话槽也**不重置**（留给下一轮与驱动的 URL 自愈）。
提示过几次可在 `/__webcode/status` 的 `driver.sessionSwitchNotices` 核对。护栏：
`test/session-continuity.test.mjs` ⑥（这一轮成功且正文是提示 / 重放仍只发 1 次 / 下一轮仍整段重建）。

> 0.15.0–0.16.5 的变更未逐条回填本文件，见仓库根 `README.md` 的「当前能力 / 验证和边界」
> 与 `doc/progress.md` 的逐轮台账。

## 0.14.5

**修掉两个由真机会话日志定位的缺陷，并把右栏按官方审美重排。**

### 超长提示词写不进输入框（`PROMPT_WRITE_STALLED`）

真机证据（`session-c710ef6e` 的 turn 2 终局，逐字）：

```
locator.fill: Timeout 30000ms exceeded
  - locator resolved to <textarea … placeholder="给 DeepSeek 发送消息 ">
  - fill("# 可用本地工具…(+807789)
```

一次性把 80 万字符交给 `fill()` 时，Playwright 在网页侧整段卡住，30s 后超时；卡住期间
**没有任何中间态可读**。现在按 `composerWritePlan` 分块写入、块间回读长度，连续两块不增长即
抛 `PROMPT_WRITE_STALLED`，错误里带**已写/总长度**与元素现场（标签、id、placeholder、可见性）。
决策抽成纯函数（`composerWritePlan` / `stallStep`），`test/composer-write.test.mjs` 12 项钉住边界。

### `<tool_result>` 外壳漏进正文

同一会话的 `assistant/message` seq=587 里，网页模型把工具结果连同外壳吐了回来：

```
block 9  text len=198  <tool_result>\n{"mcp_action":"result","name":"edit",…
block 11 text len=200  </tool_result>\n{"mcp_action":"result","name":"write",…
```

协议边界锚点只认 `tool_call`，于是边界落在**外壳之后**的 JSON 上，`<tool_result>\n`（13 字符）被当正文发出。
现在 `tool_result|tool_results` 进锚点，但**故意不进 transport 判定**——工具结果不是工具调用，
绝不能被当成待执行的调用。`test/protocol-leak.test.mjs` +2 项钉住这条区分。

### 右栏重排（对齐官方右栏的实测尺寸）

- **顶层工具条**：当前站点名 + 8px 状态点 + 右侧四颗 **28px 图标按钮**（刷新 / 独立窗口 /
  新面板 / 浮动），尺寸与官方 `ExpandButton` 实测值一致（`width/height:28px`、`border-radius:28px`、
  hover `--dsw-alias-interactive-bg-hover`）。文字全部进 `title`/`aria-label`。
- **站点选择**（0.16.37 定稿）：右栏「Web Bridge」标签页 = **站点目录**，每行是官方「新建终端」
  同款**胶囊**——左侧主区（图标 + 站点名，多账户时多一行「N 个账户可选」）是一颗官方
  `Button variant:'ghost'`，右端一颗 44px 宽的 chevron `Button` 作为官方 `Menu` 的锚点；
  点开列出该站点的各账户，选中即用那个槽开标签。尺寸**逐项**取自官方 `TerminalGuide.module.css`
  （`border-radius:24px` / `min-height:56px` / `padding:14px 20px` / 触发器 `width:44px` /
  标题 `15px`、说明 `13px`）。点主区 = 为该站点**新开一个独立标签**（`multiple: true`），
  于是官方标签条上就是「Web Bridge / DeepSeek / 智谱清言 …」一行并列，点回 Web Bridge 即回目录。
  面板内**不再**有任何自建站点导航条，工具条上的站点下拉按钮与 `SiteMenu` 组件也已删除。
- **图标**：十个站点**全部**有真实品牌矢量。DeepSeek 用官方 primitives 的 `FISH_LOGO_PATH`；
  八个（ChatGPT / Claude / Gemini / Grok / Qwen / Kimi / 豆包）用 simple-icons（CC0-1.0）；
  GLM 与 Z.ai 用 `@lobehub/icons-static-svg` 取回的矢量——simple-icons 实测没有它们的条目
  （`zhipu` / `chatglm` / `zai` / `z-ai` / `zhipuai` / `bigmodel` / `zcode` / `glm` 八个 slug 全 404）。
  来源分档记在 `SITE_ICON_TIER`（`official` / `vector` / `missing`），逐条挂在图标 `title` 里，
  **不把社区图集说成官方发布**。
- 空态/错误态统一成官方 guide 卡片形态（`.5px` 边框、`bg-layer-1`、标题+说明+主按钮三层）。

### 会话日志归因工具（长期资产）

`test-mock/parse-session-log.mjs`：DSH 的会话落盘是**多帧拼接**的 zstd，`zstdDecompressSync`
只解第一帧（1.3 MB 的文件解出 220 字节），这个坑上一轮会话连踩三次。工具按 zstd magic 切帧逐帧解压，
输出事件直方图、轮次结局、失败项、工具调用与用户输入。错误码与归因见 `doc/bridge-failure-ledger.md`。

## 0.14.4

原生「设置 > 网页桥接」管理登录与启用开关。默认沿用 `~/.dsh/webcode-edge-profile`。
模型分组 Harness Web Bridge 暴露全部内容服务站点（`site:model` 限定 id）；显示名为
「站点短键/模型 id」（如 `z.ai/glm-5.3`、`deepseek/deepseek`），**一眼能看出是哪个
网站**；兼容别名 `deepseek-web` 不出现在下拉里（历史会话仍可解析）。

## 0.14.4

**修掉「打开右侧网页之后掉登录」，并把等待时间变成可核对的两个数。**

（本节以下为 0.14.4 的原始记录，保留不动。）

### 掉登录（豆包真机报障）

根因在 `Set-Cookie` 的两个消费方向被混成字符串替换（`lib/cookies.js` 是本次抽出的纯模块）：

1. **删除指令被当成「设成空值」**。站点在 iframe 里刷新会话时回 `name=; Max-Age=0`，
   旧实现把空值写回驱动 profile——**把有效登录 cookie 就地抹掉**，下一轮真实发送即未登录。
   现在按 RFC 6265 判定删除，翻译成 `expires: 0`。
2. **`__Secure-` / `__Host-` 前缀 cookie 被剥掉 `Secure`**。浏览器按前缀规则**直接丢弃**，
   playwright 侧同样抛错导致整批写不进去。现在保留/补齐 `Secure`，`__Host-` 补 `Path=/`。
3. **镜像转发时 profile 的 cookie 被 iframe 的旧值挤掉**。旧实现「请求带 cookie 就只用请求里的」，
   于是驱动 profile 里真正登录的那份**永远不再发给上游**。现在按 profile 优先、请求补缺合并。

### 等待时长（输入框底下的统计药丸）

`lib/wait-stats.js` 是纯计算层：本会话与累计**同口径**（都来自 relay 的 `sendWaitMs`），
文案由服务端一次算清（`/__webcode/wait-stats` 的 `label` / `detailRows`），
避免两处各写一份格式化后漂移。账本落盘 `webcode-wait-stats.json`，重启不清零。

**与官方统计同一栏（0.15.11 改为结构性方案）**：展示走官方
`conversation.composer.dock` 槽位，取官方 ui-chat `StatsPills` 的尺寸
（28px 高、24px 圆角、14px 线框图标、13px tabular-nums）。

同栏**不靠几何偏移**：`conversation.composer.dock` 的每个条目都是官方那条 dock
flex 行的直接子项，只要自己是 `inline-flex` 就自动同栏，居中、间距、换行全部
由官方 CSS 决定。（0.16.18 起不再 portal、也不再自建整行：DSH 0.1.6-alpha.2 的
`StatsPills` 已不渲染 `[data-composer-stats]`，原先那段「等官方行出现再 portal
进去」的 MutationObserver 因此删掉了。）

> 0.15.10 曾用负上边距把本行「拽」进官方那一行，那是几何猜测：官方行一旦
> 换行（右侧栏把输入区挤窄）或字体档位变化，两块内容就会叠在一起。0.15.11
> 起源码里不允许再出现给等待 wrap 算偏移量的代码，由测试钉住。

交互照官方 `stat-dialog` 契约：**默认只给一个短读数**（如「等待发送 12 s」；
秒级取整——因为正在等待时这个数会逐秒往上走），在途时显示**正在等的
那一段**并把它从起始时刻现算出来（官方那枚药丸同样是「开始就涨」，而不是等
结束才一次性给数），轮询同步提到 1 秒；等待结束、账本结算后自动回落到本会话累计。
点击才展开浮层，内含本会话与累计的完整明细（轮次、平均、限流、发送间隔目标、
距上次发送）。浮层尺寸/圆角/阴影/`dl` 网格逐项对齐官方 `stat-dialog.module.css`，
锚在药丸上右对齐展开。

关闭语义同样对齐官方 `StatsPills`（它由 `useStatDialog` + `useDismissOnOutsidePointer`
驱动，同一时刻只有一枚药丸开着）：**Esc 收起**，且**pointerdown 落在本组件之外
即收起**——于是点官方任何一枚药丸时本面板随之关闭。关闭边界取本组件自身而非
整行，点自己面板内部（含滚动条）不会误关。

**设置页不再重复统计等待时长**：原先那里另有一块「累计等待发送」网格，读的是
同一份账本、同一个数字，属于重复展示（0.15.10 已删除）。设置页「速度与等待」
只保留实测速度指标。

### 右栏

- 站点标签条支持**鼠标滚轮横向滚动**（原生非被动监听），去掉滚动条并加两端渐隐——
  消除「只能拖右滑栏、还有一点遮挡」。
- 「刷新 / 独立窗口 / 分屏 / 浮动」统一成同一套图标按钮（同高、同圆角、同状态表达），
  窄面板下自动只留图标。
- **多开不同网页**：`Ctrl+点击`站点在新分屏打开；或直接用面板上的「分屏 / 浮动」，
  走 DSH 官方 `sidebarRight.split` / `.float`，不自绘浮层（自绘正是遮挡的来源）。
- 站点栏 `z-index` 与 `flex:none` 保证永不被网页区遮住。

### 测试

新增 `test/cookies.test.mjs`（25 例）与 `test/wait-stats.test.mjs`（18 例）；
修掉 `test/mirror.test.mjs` 里把「剥掉 Secure」钉成期望行为的旧断言（它锁的正是本次修的 bug）；
`test/tool-loop.test.mjs` 补测试隔离——它此前读**用户真实**设置（`sendGapMs: 30000`），
退避变成 30s+30s+60s 撞上 120s 看门狗，用例「看环境脸色」。全套 **249/249**。

## 0.14.3

**修掉两个只有真机复验才看得见的 bug**（0.14.2 的单测全绿，但 GLM 第二轮仍然失败）。

复验第一步就发现：0.14.2 的会话**身份**修复完全正确（`result.sessionId` 不再是 null、
`webcode-sessions-glm.json` 不再是 `{}`），但第二轮**换了一个失败方式**：

```
✖ locator.fill: Timeout 30000ms exceeded
  - locator resolved to <textarea>appkey: "CF_APP_WAF", …</textarea>
  - element is not visible
```

1. **登录回退判定只数个数、不看可见性**。导航到 `?cid=` 时 GLM 返回阿里云滑块验证页
   （「滑动验证页面」），页面上 3 个 textarea 全是**隐藏**的 WAF 脚本模板；
   `locator(SEL.input).count() > 0` 于是判成「输入框在 = 已登录」，接着 `fill` 必然超时。
   现在改为 `visibleComposerCount()`：逐元素查可见性，且**遍历全部候选选择器**
   （GLM 的真实 composer 是裸 `<textarea>`，只认 `textarea#chat-input` 会漏掉它）。
2. **「是否已在目标会话上」用 URL 字符串前缀判断**。站点会把地址补成 `?lang=zh&cid=X`，
   而桥拼的目标是 `?cid=X` → `startsWith` 判为不同 → **白白整页重载**，正好撞上风控页。
   现在按**会话 id** 比较（`conversationIdFromUrl`）。
3. **风控页单独成一态**：`detectChallenge()` 认验证页文案与 WAF 脚本指纹，在登录判定
   **之前**调用；报错用 `navReason='challenge-page'` 与「会话过期」分开——否则用户按
   会话过期去查，永远查不到风控。

真机复验结果：GLM 连发两轮，`cid` 逐字相同、`sessionLostCount=0`、第二轮正文正确；
A-4b（重启后第一轮发送间隔）与 F（`:8931` 路径 `gapTargetMs=10000`）均通过。

## 0.14.2

**GLM/Z.ai 的会话身份与上下文预算（B/C/F 三组）。** 用户报「GLM 作为子代理时同一会话却
每轮新开对话」——真机探针查出根因：桥把「会话 id ↔ 地址」的知识硬编码成了 DeepSeek 的两种
形状（`?chat_session_id=` / `/a/chat/s/`），而 GLM 的地址栏是
`https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77`，
其 `cid` 与 SSE 首帧的 `conversation_id` **逐字相同**。旧实现读不到 → `sessionId` 恒 null →
`rememberConversation` 从不执行 → 每轮 `WEB_SESSION_LOST` → 上层 fresh 重开。

1. **会话地址形状按站点声明**（`providers.js` 的两张表 + `contract.conversationNav`），
   导航判定收成三态 `fresh / resume / unsupported`。**没有第四态**：`unsupported` 必须报错，
   不再像旧实现那样默默开一个新会话把增量发进去（那正是「跑着跑着变傻」）。
2. **解码器透出 `conversation_id`**（`GlmDecoder`，基类 `finish()` 统一带出）——身份取
   「地址优先、流兜底」两个来源。
3. **`WEB_SESSION_LOST` 不再静默**：`sessionLostCount` / `lastSessionLost` 进 `/status`，
   右栏显示「网页会话已丢失 N 次（桥已按重放首轮整段自愈）」。
4. **`zai` 故意不声明地址形状**：探针在 chat.z.ai 上只拿到裸根地址、且整轮 120s 超时
   （`replyChars:0`），**没有证据就不编形状**——编出来会导航到不存在的地址，比「不支持」更糟。
5. **上下文窗口声明有实测依据**：探针把 GLM composer 灌到 **120 万字符**、Z.ai 到 100 万字符，
   **全部逐字回读、没有一档被截断**，所以 1M 是有实测支撑的下界（不再是随手写的占位）。
   它是「本桥愿意让 transcript 长到多大」，**不是模型注意力窗口的规格**。
6. **发送前预算闸** `CONTEXT_WINDOW_EXCEEDED`：越界在**写入 composer 之前**就拒，报错文本带
   「多少字符 ≈ 多少 token > 声明窗口多少」与可行建议。旧实现只有填写**之后**的
   `PROMPT_TRUNCATED` 回读校验，报错只有长度差，看不出超了多少。
7. **窗口声明可见**：`GET /__webcode/context-windows` 列出每站点的声明值与**来源**。
8. **修 OpenAI 前端（`:8931`）绕过发送间隔**（真机 0.14.0 矩阵发现）：`lib/openai.js` 两条
   分支构造 `meta` 时都没带 `sendGapMs`，`clampSendGapMs(undefined) === 0`，于是设置页的间隔
   在这条路径上被整体绕过（实测 `gapTargetMs=0`）。改为注入**当场求值**的取值函数。

新增护栏：`test/context-budget.test.mjs`（11 项）、`test/glm-conversation.test.mjs`（17 项）、
`regression` 47/47（+2 接线断言）、`control-routes` 5/5（+`context-windows`）。

## 0.14.1

**工具协议分叉不再整轮作废，纯标签残片不再当正文外发。**

真机会话暴露出两个症状：一轮里工具调用「有时候没执行」，以及回复里夹杂 `</</` 这样的
错误调用碎片。取证后的根因是**解码器与增量通道的分叉**：decoder 对 `fragments` 做静默
全量替换时不补发增量，于是增量累计的 `acc` 与权威全文 `end.text` 在结构上分叉（两个方向
都实锤过：canonical 多出一个 `grep`、canonical 丢失一个 `edit`）。旧实现遇到分叉一律
`TOOL_PROTOCOL_INVALID` 把整轮扔掉，用户看到的就是「调用了但没执行」。

现在开块时保存已经配平的 JSON，发现分叉时改为**修复**而不是作废：同名第 k 个流式块与
第 k 个同名权威调用配对，流式块用它自己配平的 JSON 收口，没被覆盖的权威调用补发新块。
只有块连配平 JSON 都没有时才保留旧的抛错路径。另外，调用之间那些只剩 `</</` 的纯标签
碎片按空白同型跳过，不再混进正文。

回归护栏：`test/regression.test.mjs` 45/45（新增 3 条——分叉的两个方向、标签残片）。
新测试用临时 `profileDir`，避免 0.14.0 引入的发送间隔落盘成为跨测试的干扰通道。

## 0.14.0

**两个真机问题 + 四项既定改动。** 两个问题都是「先取证、后改」：

**① 发送间隔「好像没按设置来」。** 设置一直存得住，真正的原因是三条：基准取的是
「上一轮**结束**」而不是「上一轮**发出**」（一轮跑 20.9s 时，10 秒间隔只剩 7.6 秒
可见）；基准只在进程内存，**重启后第一轮零等待**；`sendWaitMs === 0` 时那条统计
整条不渲染——设了间隔反而「界面上什么都没有」。现在：判定改为 send-to-send 并
**落盘**（`webcode-send-state.json`，原子写、24h 过期），右栏「发送前等待」**恒可
核对**（未等待时也写明「距上次发送 20.9 s 已满足」），目标值与实际间隔都透出到
`/status`。

**② 网页端回复了但 Harness 这边卡住。** 网页流可能以 `status:'WIP'` 结束且**永不发
FINISHED**，驱动只能等 240s 总超时，界面上就是**无限「思考中」**。现在有三条防线：
驱动侧按「流停 **且** 页面 DOM 不再增长」双条件在秒级收束（只看流停会腰斩长回复，
所以是双条件）；适配器侧有「无进展」看门狗，把无限挂住变成一条带页面现场的明确
报错；`lastEndReason` / 超时现场进 `status`，右栏显示「网页流未收尾但内容已保住 N 次」。

**③ 模型显示名自带站点出处**（`z.ai/glm-5.3`），并修掉下拉里的重复行。

**④ 首轮提示词默认显示**：设置界面不再折叠，直接显示发送首条消息时注入网页的完整
内容。

0.16.25 起改为**按网站逐行列出**（每行一个网站，行内下拉可选该网站可用的协议；
下拉只**预览**模板，不改真实选路——每个网站实际用哪一支由桥按站点决定并标在行首）。
原因：协议只有三支、网站有十个，按协议列时用户得自己推断「我这个站算哪一支」；
每行的模板全文折进「查看该协议的完整模板」里，十份全文不会把页面淹掉。

三支协议与站点的对应（`variantIdForSite`，与 `serializeFirstTurn` 的真实分支一一对应）：

| 协议 | 站点 | 形状 |
|---|---|---|
| `official` | deepseek | DeepSeek 官方训练模板（原生工具调用格式） |
| `glm` | glm | ```json 代码块（该网页会抢走调用标签执行） |
| `default` | 其余全部 | `<tool_call>{…}</tool_call>` 标签 |

> 本次同时修掉一个**此前不可见**的错误：`deepseek` 曾被映射到 `default`（标签形状），
> 而它实际走官方模板分支——设置页因此给 deepseek 显示了一份它根本不会收到的模板。
> 之前下拉只有两支，用户不会去比对；改成「每行一个网站」后它立刻就是错的。

模板由 `agent-preset.serializeFirstTurn` 现算——**设置里看到的 = 真正发出去的**。
协议文本（首轮教学、增量轮再教学、解析失败自动续跑）全桥只有一处定义：
`agent-preset.transportNoteFor`。0.16.25 抽取它是为了自动续跑——续跑要把再教学提示
作为用户消息补发，那一轮看到的协议段必须与该站点**首轮逐字相同**；否则会出现
「首轮教 A、续跑重申 B」，模型在两者之间摇摆。

**⑤ 右栏规范化**：注册走 `ctx.effect` 生命周期，标签动作菜单、tablist 方向键导航，
样式改用 DSH 的 `--dsw-alias-*` token。

**⑥ 修掉两处「空转护栏」**：`client-render` 测试的 fetch mock 不是忠实 Response、
渲染器又没递归进 children——两处叠加导致**所有**数据路径静默失败、嵌套组件从未
渲染，旧断言等于空转。修好后 0.14.0 的新面板才真的被测到。

## 0.13.1

**交付物必须以 `present` 呈现，写进预设提示词。** 此前预设从未教过这件事，于是
模型写完文件只在**正文**里列一串路径——用户看到的是一堆点不动的纯文本，而不是
可点开的文件面板。现在预设新增「# 交付物呈现（present）」章节，讲清三件事：
只在正文写路径**不算**交付；`present` 让文件变成可点开的面板；要在最终答复
**之前**调用。首轮的 `[本地工具传输协议]` 尾部也带一句提醒（收尾那一刻最容易忘），
glm 的代码块分支与其它站点的标签分支都覆盖。
**仅在本会话真的注册了 `present` 时才教**——否则模型会去调一个不存在的工具，
白费一轮并撞 TOOL_UNKNOWN。

> 为什么必须升版本号：0.13.0 已发布过一份**不含**该提示词的包，同名同版本却换了
> 内容会让 pnpm 按版本号去重而静默不更新（实测安装副本仍是旧文件），也让构建指纹
> 失去意义。任何内容变更都必须伴随版本号变更。

## 0.13.0

**模型选择从「空承诺」变成真实切换。** 0.12.9 的驱动遇到 `auto` 直接返回、
**页面上一个动作都不做**，而每站目录里又只有这一条 auto——UI 有下拉，网页什么都不会变。
现在按站点声明**模型选择契约**（触发 / 选项 / 名字节点 / 回读），由 `lib/model-picker.js`
执行**精确名匹配 + 点击后回读确认**；契约缺失就如实报「未切换网页模型」，绝不假装成功。
真机实测目录（`test-mock/probe-model-dropdown.mjs` 全量 dump）：

- **z.ai**：`GLM-5.3-Flash` / `GLM-5.3` / `GLM-5.2`
- **GLM**：`GLM-5.3` / `GLM-5.3-Flash`
- **Kimi**：`快速` / `K3` / `K3 集群`
- **豆包**：`对话` / `工作`（分段控件形态，**本地默认 = 对话**）
- chatgpt / claude / gemini / qwen：未校准（诚实显示，不假装可选）

注意 `GLM-5.3` 是 `GLM-5.3-Flash` 的**前缀**，因此匹配必须是精确的
（`test/model-picker.test.mjs` 把这个陷阱钉死）。真机验证
`node test-mock/verify-model-switch.mjs` **11/11 PASS**。

**harness 截图能真的传到网页端了。** 旧实现只认 wire 形状的图片块，而 DSH 原生
（截图走的）是 `{type:'image', attachment}`——两者零交集，于是每次截图传图都被
**静默丢弃**。现在原生块经 `ctx.attachments.readImageRequest` 取像素（预算与
dsh-llm-deepseek 同档），并声明 `inputModalities` 防止宿主把图片提前换成文字；
上传后**必须看到页面上出现附件证据**才发送（拿不到就报错，绝不发一条没有图的消息）。
真机端到端 `node test-mock/real-vision-upload.mjs` PASS：上传已知色带图，
模型答「3条，红色、绿色、蓝色」。

**「检测」按钮不再报 JSON 解析错误。** 根因是 `verify-login` / `site-probe` /
`session-import` 三个 action 进了 action 表却**没进挂载清单**（手写数组漏了），
请求落到宿主兜底回 **405 + 空 body**，客户端在判断状态码之前就 `.json()`，
于是把真实原因吞成一句 `unexpected end of JSON data`。现在挂载清单从 action 表
**派生**（结构上不可能再漏），未知方法回 405 JSON、未知路径回 404 JSON，
客户端先读文本再按 content-type 解析。

**设置界面改为 harness 风格**：三段内联硬编码色合并为一张 token 化样式表
（`--dsw-alias-*` + fallback，16px 圆角卡片 / .5px 边框 / pill 按钮，与 DSH 自家
设置区同款）；站点行改为「状态点 + 名字 + 行内动作」，并**露出登录判定依据**
（`loginBasis` 一直有，此前 UI 把它丢了，于是「未登录」看起来像凭空断言）；
「检测」结果分三态，`待检查` 不再画成红色错误。

## 0.9.7

**工具调用「能执行」。** 真机 64 次工具报错全部是参数形状漂移（数字写成字符串
`"10"`、数组写成单对象、布尔写成字符串）。新增 `coerceArguments`：按工具 schema
**显式声明的类型**做定向纠偏，只做无歧义的方向，解析失败一律原样保留交给 DSH 报错。
网页调了本会话不存在的工具时，不再整轮作废，而是把「TOOL_UNKNOWN + 本会话可用工具
清单 + 请重试」作为这一轮的回复交回会话，下一轮模型自纠。

**关于「某些工具在 DeepSeek 下执行不了」。** 桥只负责把网页发来的调用正确解析、
纠偏、交付；**一个会话能用哪些工具由 DSH 的会话预设决定**——极简模式实测只注册
`pwsh`，此时 `subagent`/`write`/`edit` 本来就不可用。要跑多工具任务请把预设切到
标准模式。新增 `test/tool-loop.test.mjs` 把网页五种真实调用形状（`<tool_call>` /
全角 DSML / 裸 `<invoke>` / ```json 围栏 / `**Calling:**`）固定成回归。

## 0.9.6

**一轮连发多个工具调用不再出错。** 复现真机形状（模型一轮里连发 3 个 `read`）后，
把流式协议边界的三处缺陷一次改掉：同一个调用被开成 32 个块并整轮作废；游标推进后
又命中更早的收尾标签，`</tool_call>{"mcp_action":…` 整段漏回正文；把非调用的裸 `{`
当截断点导致正文下标卡死、流式循环挂住。现在边界**单调不减**、按边界下标去重、
用 `partialProtocolAt()` 扣住 `<t`/`<tool_cal`/`**Calling:` 这类半成品标记。
顺带修掉调用块关闭时把下标当块内容发出去（`block.text` 变成数字）。

## 0.9.5

**登录任意站点。** 设置页「连接 → 登录网站」下拉选择站点后点「登录所选网站」：打开
真实 Edge 窗口等你完成一次性登录，检测到已登录自动切回无头，并把结果（成功/已登录/
失败原因/耗时）回报到界面。旁边的「独立窗口打开」把该站点开成可交互的真实浏览器窗口，
与桥共用登录态。每站点独立 profile，互不串号；上次被强杀留下的 Chromium 单实例锁会在
启动前自动清理并重试一次（「退出过一次之后哪儿都登不上」的直接原因）。

**跑到一半突然停止已修。** 真机 13 份会话转录逐事件统计：12 次异常收尾全是
`web capture ended incomplete`——网页没发 `FINISHED`/`close` 就断流，旧解码器要求
两帧齐全，于是已经解出的正文和完整工具调用被一起丢掉。现在解码器把已解出内容带出来
并标 `partial`，驱动层接受这一轮；真的什么都没有、或结构坏掉，才失败。

**工具调用失败有据可查。** 真机 64 次工具报错全部是参数形状漂移（`"offset" must be a
number`、`"questions" must be an array`、缺 `description`），并新增 `TOOL_UNKNOWN`：
网页调了本会话不存在的工具时不再静默过滤成"收束"，而是报错并把可用工具名回传，下一轮
可自纠。游标指纹改为只锁工具名集合，工具描述升级不会再顶掉上下文游标。

**预览打不开会说明原因。** 实测 `chat.deepseek.com` 经镜像反代被 CloudFront 判成机器人
返回 403（glm/kimi/qwen/grok/zai 均 200）。镜像现在补常规浏览器指纹、识别 CDN/WAF
错误页并换成「为什么 + 改用独立窗口打开」的说明页；站内 302（豆包 `/` → `/chat/`）
改写为带镜像前缀，不再落在命名空间外变空壳。

**新增站点 z.ai**（`https://chat.z.ai`，OpenAI 兼容 SSE，静态域 `z-cdn.chatglm.cn`，
别名 `zai`/`z-ai`/`chat.z.ai`），实测镜像 200。

取证结论见 `doc/bridge-failure-ledger.md`（本机 13 份真实会话转录的逐事件统计；
原先指向的 `doc/incident-2026-09-11.md` 已于 2026-09-16 删除）。

## 0.9.4

协议文本不再进助手文本：截在正确的层。

真机会话里助手消息存的是整段协议原文（正文里出现 `<tool_call>` / 全角
DSML 标记加 JSON）。真因不在渲染，而在流式边界探测与解析器各认一套形态：
`parseAgentReply` 有 DSML 归一化，所以工具照常执行；而流式那句行内 `marker()`
只认半角标签 / 围栏 / Calling / 裸 `{`，对全角 DSML 恒返回 -1，于是协议原文被当
正文一路发出去。显示层折叠救不了它（那段是正文段落，不是 `<pre>`）。

- `findProtocolStart()`（`lib/agent-preset.js`）：与 `parseAgentReply` 共用同一套形态
  知识，探测协议起点与工具名；流式循环改用它。
- `stripProtocolText()`：下游兜底，保证写进会话的助手文本是散文。
- `normalizeDsml()`：归一化收为一处，探测与解析不再各写一份正则。

**工具闭环一字不改**：解析仍吃原文，只是“发往界面”的那一侧被截断。
回归：`test/protocol-leak.test.mjs`（9 项，真机夹具 `test/fixtures/leaked-dsml-reply.txt`）锁住
探测命中、解析照旧拿到完整调用、探测与解析形态不得漂移。
MIT。SSE 解码协议参考 MIT 项目 three-water666/webcode。产品展示名更新，安装包名及 provider ID 保持兼容。
