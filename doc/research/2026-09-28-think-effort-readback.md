# 思考等级「回读读不到档位」——真因与修复（0.19.49，2026-09-28）

> 用户报障原文：
>
> ```
> 本轮运行失败THINK_EFFORT_UI_CHANGED: 思考等级「标准」没有生效（站点 kimi）—
> 回读：读不到档位（判定 no-readback）。本轮已中止，避免把「用户选了高档、网页仍是低档」
> 当成成功。
> 其余都是类似原因
> ```
>
> **「其余都是类似原因」这句话是对的** —— 五个站点里有四个各自有独立的回读缺陷。

本文记录取证过程、每个站点的真因、修法与验收读数。全部读数来自**真机**；
取不到的证据如实标「未取证」。

---

## 一、取证方法：为什么不能用 profile 副本

`test-mock/probe-think-effort-live.mjs` 走的是「拷一份 profile 副本再开浏览器」那条路。
对 kimi 这条**不成立**：kimi 的登录态**不在 cookie 里**（9 枚 cookie 全是统计/偏好类），
而在 localStorage 的 `access_token`。副本里没有它 ⇒ 打开的是**游客页**：

```
你直接打开副本得到（test-mock/out/think-effort-live-kimi-2026-09-28T11-19-23.json）：
  "title": "Kimi AI 官网 - K3 上线，专为智能体编程与知识工作打造"
  scene.clickables 里有 "登录" 与 "登录以同步历史会话"
  overlayCount: 0        ← 模型菜单从未打开
  → THINK_EFFORT_UNAVAILABLE: 档位菜单里没有「标准」（当前读数：快速 进阶）
```

拿游客页的读数去解释线上报错，就是本仓库记过的「拿另一种现场的证据下结论」。

**本轮改用只读 CDP**：桥自己用 `--remote-debugging-port=0` 启动浏览器，端口号落在
profile 的 `DevToolsActivePort` 文件里。顺着它连上去 `Runtime.evaluate` **只读**执行
（不点击、不填框、不发消息、不改状态），拿到的就是**线上那个已登录页面**的真读数。

| 脚本 | 作用 | 退出码 |
| --- | --- | --- |
| `.tmp-probe/cdp-effort-inspect.mjs` | 读触发控件现状 + 复刻 `FIND_EFFORT_CONTROL` 看它选中谁 | 0 |
| `.tmp-probe/cdp-effort-models.mjs` | 读模型菜单三条模型名 + `effort-item` 结构（点一次开菜单后立即 Esc） | 0 |
| `.tmp-probe/cdp-effort-all.mjs` | 逐站点读触发控件文本，核对 anchor 是否在文本里 | 0 |
| `.tmp-probe/cdp-verify-fix.mjs` | 把真机读数喂给**生产判据**复算，验证修复 | 0 |

---

## 二、kimi —— 把**模型名**当成了锚点（用户报障的那一条）

### 真机读数（`.tmp-probe/cdp-effort-models.json`）

```json
{
  "trigger": "K3 标准",
  "effort": "标准",
  "modelName": "K3 标准",
  "triggerAttrs": { "cls": "current-model", "testid": "model-select-trigger",
                    "ariaHaspopup": "menu", "ariaExpanded": "false" },
  "modelOptions": [
    { "name": "K3",           "checked": true  },
    { "name": "K2.8 Preview", "checked": false },
    { "name": "快速",          "checked": false }
  ],
  "effortItem": [ { "text": "思考强度 标准", "cls": "effort-item" } ]
}
```

即：触发控件 = `div.current-model[data-testid=model-select-trigger]`，文本是
**`<当前模型名> <当前思考档>`**；模型菜单里 `快速` **也是一个模型名**。

### 真因

0.19.48 声明的是 `triggerText: '快速'`。于是：

- 用户选「快速」这个模型时，触发文本是 `快速 进阶` ⇒ 锚点命中 ⇒ 回读成功
  （09-28 的 dump 恰好是这个状态，所以当时**看起来是好的**）；
- 用户选 `K3` 时，触发文本是 `K3 标准` ⇒ **锚点不在文本里** ⇒
  `FIND_EFFORT_CONTROL` 的 token 匹配池为空 ⇒ 回读 `label: null` ⇒
  `confirmEffort` 直接返回 `{state:'unknown', reason:'no-readback'}` ⇒
  **每一轮都抛 `THINK_EFFORT_UI_CHANGED`**，站点彻底不可用。

### 修法（两处，判据只写一份）

1. **锚点不再承担定位**：删掉 `triggerText`，改用 `triggerSelectors: ['[data-testid="model-select-trigger"]']`
   —— testid 与模型名无关，是站点给这个控件的稳定身份。
2. **回读改读真正持有档位的节点**：新增 `readbackSelector: '.current-effort'`。
   真机实测 `span.current-effort` 的文本是 `标准`（**恰好是档位**），
   而 `div.model-name` 是 `K3 标准`（含模型名）——所以只有 `current-effort` 能当回读源。
3. `openVia` 一并去掉：它与 `triggerSelectors` 指的是**同一个节点**，旧计划会先点一次
   `openVia`、再点一次触发控件，第二次把刚打开的菜单关掉。

### 验收（`.tmp-probe/cdp-verify-fix.mjs`，同一线上页面）

```
kimi 声明: readbackSelector=".current-effort"  档位=标准/进阶
[真机] READ_SELECTOR_TEXT(".current-effort") = {"text":"标准","cls":"current-effort"}
[真机] 触发控件文本 = "K3 标准"

  目标「标准」
     旧：state=unknown  reason=no-readback    ← 用户报错的形态
     新：state=match    reason=trigger-extra-exact  seen="标准"
  目标「进阶」
     旧：state=unknown  reason=no-readback
     新：state=mismatch reason=other-effort:标准  seen="标准"
```

---

## 三、glm —— 模型名与档位**无缝拼接**，词级判据切不出来

### 真机读数（`.tmp-probe/cdp-effort-all.json`）

```
触发控件: <div class="think-mode-trigger mode-button …"> "GLM-Flash极致"
```

对照：同一个控件在另一个模型下是 `GLM-5.3 极致`（**有**空格）。

### 真因

glm 没声明 `triggerText`，于是走词级兜底 `seen.split(' ').filter(Boolean).includes(id)`。
`'GLM-Flash极致'.split(' ')` = `['GLM-Flash极致']` —— `极致` **不独立成词** ⇒
词级判据失效 ⇒ `extra = null` ⇒ `unknown` ⇒ 每轮抛错。

### 修法

1. `confirmEffort` 新增**后缀判据**：文本「恰好等于某档位」或「以某档位结尾」即认它
   （长者优先，避免 `最高` 被读成 `高`）。
2. glm 补 `triggerSelectors` + `readbackSelector: '.think-mode-trigger'`（选择器定位，不靠文本）。

---

## 四、qwen —— 触发文本**就是**档位 id，锚点语义自相矛盾

### 真机读数（`test-mock/out/think-control-qwen-2026-09-28T10-51-12.json`）

```
<div class="qwen-thinking-selector">自动</div>
```

切档后触发文本变成 `思考` —— 也就是说它**不是固定前缀**。

### 真因

0.19.48 声明 `triggerText: '自动'`，而 `自动` **同时是一个档位 id**。于是
`effortFromTriggerLabel('自动','自动')` 剥不出「附加部分」返回 null；
而 `confirmEffort` 又因为「声明了锚点」把词级兜底关掉 ⇒ 恒 `unknown`。

### 修法

删掉 `triggerText`，补 `triggerSelectors` + `readbackSelector: '.qwen-thinking-selector'`；
「整段文本即档位」这条形态由 `confirmEffort` 的后缀判据（形态②）识别。

---

## 五、zai / doubao —— 本轮未发现缺陷（如实记）

- **zai**：`triggerText: '深度思考'` 是**真的**固定前缀（真机 pill 文本 `深度思考 最高`），
  锚点在文本里 ⇒ 回读成立。用真机形状（pill + `role=menu` + 三条 `menuitem` + `role=switch`）
  在**当前代码**上跑 `applyEffort`，三个档位全部 `applied=true` 且回读正确
  （`.tmp-probe/zai-sim.mjs`）。
- **doubao**：走 `readback: 'aria-checked'`（弹层里被 checked 的那条），
  不依赖触发文本 —— 真机触发按钮文本是拼接的 `豆包 2.1 Turbo专家`，
  正因如此当初才选了 aria-checked 这条口径。

> ⚠ 一处须如实说明：`test-mock/out/think-effort-live-zai-*.json` 里有若干 zai 失败读数，
> 但其中一份的 `reason` 是 `token-in-label` —— **当前源码里不存在这个字符串**，
> 说明那批读数跑在**已被改掉的旧修订**上，不能当作「当前代码也坏」的证据。
> 本轮用真机形状在当前代码上重跑（上述 zai-sim）来定性，这才是可归因的读数。

---

## 六、判据变更（这是一次**有意的行为放宽**，写清代价）

`confirmEffort` 里「当前档位」的取法，旧实现是：

```
extra = 剥掉声明锚点后的附加部分 ??（没声明锚点时才按词找已知档位）
```

新实现按优先级取三种形态：

| # | 形态 | 例子 | 旧行为 | 新行为 |
| --- | --- | --- | --- | --- |
| ① | 锚点 + 后缀 | zai `深度思考 最高` | match | match |
| ② | **整段即档位** | qwen `自动` | **unknown** | match |
| ③ | **无分隔符拼接** | glm `GLM-Flash极致` | **unknown** | match |

**代价与安全线**：放宽的只是「怎么从文本里取出当前档位」，**没有**放宽
「取出之后算不算命中」——「有没有读到**别的**档位」仍然只按词判（`低 ⊂ 最高`
这类互为子串的成员不会被误判）。并且**绝不允许**按「文本里含目标片段」判定：
`'进阶的快速响应'` 这种「档位出现在词中」的文本仍然诚实报 `unknown`
（护栏 `test/think-effort.test.mjs` ③ 有一条专门钉它）。

为什么敢放宽：旧行为在这些形态下返回 `unknown`，而调用方**无法补救** ——
`no-readback` 会让整轮中止（`THINK_EFFORT_UI_CHANGED`），用户看到的是
「一句话就处理失败」。**读得出另一个真实档位**（`mismatch`）比**读不出**（`unknown`）
在两边都更好：mismatch 会触发一次真实的改档，unknown 只会中止。

---

## 七、护栏

| 文件 | 项数 | 钉住什么 |
| --- | --- | --- |
| `test/think-effort.test.mjs` | 27 | 声明层 / 计划形状 / 三态判据（含本轮新增的形态②③与「词中不算命中」）/ 执行层全流程 |
| `test/think-effort-realtext.test.mjs` | 5 | **真机触发文本**逐条（含出处与日期）：锚点必须在文本里、回读节点必须读得出档位、真机文本喂判据不许 unknown、kimi 锚点不许再写成模型名、接线判据 |

`think-effort-realtext.test.mjs` 单独成文件的理由写在它的头注里：它的判据是**数据**，
而这类判据最容易在重构中被「顺手改成 fixture 想要的形状」而失去意义 ——
每条都标了出处与日期，改它之前必须先拿到新读数。

---

## 八、未取证 / 已知缺口

1. **「其余都是类似原因」只覆盖了已取证的站点。** zai / doubao 本轮**未发现**缺陷
   （有真机形状复算），但没有在线上跑完整轮次验证 —— 它们浏览器当时不可达
   （`DevToolsActivePort` 存在但端口连不上）。
2. **chatgpt / gemini / grok / claude 仍未声明等级**（本机网络取不到读数），
   这条与 0.19.48 相同，缺口照旧记在 `doc/long-term-issues.md`。
3. **z.ai 的总开关与本模块的关系**：网页端把思考关掉时，选档位不会把它打开
   —— 桥不替用户猜「关掉是不是误操作」。既有缺口，未变。
4. 本轮修复**未在线上跑一次完整的真实轮次**（发消息 → 选高档 → 看模型是否用高档作答）。
   已验证的是：真机 DOM 上的回读判据（`.tmp-probe/cdp-verify-fix.mjs`）与执行全流程
   （单测 + 假 DOM 用真机文本）。真实轮次验收**需要人**（登录态在用户浏览器里），
   见 §9 的清单 —— 这条缺口本身已登记为长期问题 **#33**（「需要人才能过的验收环节
   没有提醒人手动过的回路」）。
   **2026-09-29 复跑实况（如实记）**：交付时**没有任何浏览器在跑** —— 五个站点的
   `DevToolsActivePort` 都在，但端口全部 `积极拒绝`（kimi 9570 / glm 6353 / qwen 11419 /
   zai 11632 / doubao 7155，根 profile 13610 同）⇒ 只读 CDP 这条路当时**也走不通**。
   因此本条**至今仍未取证**，不得当成已验。
5. **kimi 的 `.current-effort` 是否在「思考过程中」也稳定存在**：只在静止的输入框上取过读数。
   若站点在某状态下隐藏该节点，`readBack` 会如实回落 `FIND_EFFORT_CONTROL` 启发式
   （两条路都读不到才算 `no-readback`），因此不会静默误判，但那种状态本轮没采到样本。

---

## 九、交付后建议的真机核对清单

1. 站点选 **kimi**，模型选 `K3`，思考等级选 **标准** ⇒ 应当**不再**出现
   `THINK_EFFORT_UI_CHANGED`；选 **进阶** ⇒ 应能真实切档并回读为 `进阶`；
2. 站点选 **glm**（模型 `GLM-Flash`），档位选 **极致** ⇒ 回读应读到 `极致`；
3. 站点选 **qwen**，档位选 **思考** ⇒ 回读应读到 `思考`；
4. 站点选 **zai**，档位在 **低/高/最高** 之间切换 ⇒ 每次都应生效；
5. 任何站点把档位切回 **Default** ⇒ 桥**一个字都不动网页**（`noop` 计划），
   这是设计行为，不是「没生效」。
