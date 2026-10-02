# 复用 DSH 自带浏览器内核：设想、现状与「先不改」的结论（2026-10-02）

> **这份文档回答什么**：用户设想「去除插件自带的 Chromium，改用官方 DSH
> 『浏览器』自带的内核，减少重复资源占用」。本文记录这个设想、核实的现状、
> 决定性实测、以及**为什么本轮不改**。将来捡起这条线时，从本文起步，不必重测。
>
> **证据级别**：本机实跑的探针、实读的源码（本插件 `lib/`、DSH 0.2.0-rc.2 的
> `app.asar` 内嵌源码路径、`dsh-codearts-auth@c74e0c2` 的 `lib/`）。
> 凡写「实测」的都真跑过；写「实读」的都是真打开过的文件。

---

## 0. 一句话结论

**「把 DSH 桌面版内核当自动化浏览器」实测不可行**（`Target.createTarget` 返回
`Not supported`，且会整只启动 DSH 应用）；「减少重复资源占用」的正解是
**浏览器来源偏好可配 + 系统优先档**（本机有 Edge，切过去立省 428 MB）——
这是一个小改动，但**等 0.19.53 收尾后单独一轮做**，不与本轮混车。

---

## 1. 设想（用户原话，2026-10-02）

> 「现在你能够就是去除自身插件按照新的 chromium 而是使用官方 dsh『浏览器』
> 自带的吗？减少重复资源占用——先调研现状，现在版本更新了很多了」

拆成两个诉求：① **省资源**——不想让插件再下载/常驻一份 playwright Chromium；
② **用官方的**——DSH 桌面版既然自带一个 Chromium（Electron），为什么还要第二份。

---

## 2. 现状（实测/实读核实，2026-10-02）

### 2.1 插件现在的浏览器来源链

`browser-runtime.js` 的 `resolveBrowserExecutable()`（唯一真源）：

1. 设置页显式 `executablePath`（最高优先）；
2. **playwright 自带 Chromium**（`%LOCALAPPDATA%\ms-playwright\chromium-*`，
   按 revision 降序取最新；headless_shell 刻意排除——跑不了登录交互）；
3. 系统浏览器兜底（Edge → Chrome → Brave → Chromium → Vivaldi，跨平台候选表）；
4. 全都没有时，launch 现场自动 `playwright-core install chromium`
   （0.18.0 兑现「下载插件即可用」，用户 2026-09-22 原话在案）。

生产默认 `headless: true`（`index.js:311`；登录走一次性有头，之后无头）。

### 2.2 本机实况（这台机器）

| 检查 | 读数 |
| --- | --- |
| `ms-playwright` 总占用 | **约 1.6 GB**：chromium-1217（408 MB）+ chromium-1232（428 MB，**当前生效**）+ headless_shell ×2（538 MB，本插件不用）+ firefox-1534（333 MB，同前） |
| 生效的 executablePath 覆盖 | 无（settings.yaml 无 webcode 段）⇒ 走第 2 级 bundled |
| 系统 Edge | **在位**，`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，150.0.4078.83 |
| playwright-core | 1.63.0，browsers.json 期望 revision **1243**（新机器自动下载 ≈ 700 MB 解压后） |

⇒ 「重复资源占用」**坐实**：这台机器同时养着 playwright 的 Chromium（428 MB）
与 DSH 桌面版的 Electron 内核，且系统 Edge 一直空着没用。

### 2.3 DSH 桌面版的「浏览器」到底是什么（实读 app.asar）

- 本体 = Electron 应用 `DeepSeek Harness.exe`（本机
  `D:\2_Download_Main\4_DeepSeek Harness_code\`，FileVersion 0.2.0-rc.2）。
  **没有独立 chrome.exe**；`resources/runtime` 只是 node 24.18.1 + pnpm 11.7.0 工具链。
- 官方的「浏览器」= **Web App 里的内嵌浏览器页面**，一套 Page 抽象两个渲染后端：
  - **web 版**：沙箱 `<iframe>`（`lib/types/client/pages.js` 的 `createIframePage`，
    `element.src = target.url` 直连目标站 + `WEB_BROWSER_SANDBOX` 沙箱属性）；
  - **桌面版**：`<webview>`（`lib/types/client/electron/ElectronWebviewPresentation.js`：
    `partition` / `name=lease` / `allowpopups` / `src="about:blank#<lease>"`）。
- **会话不归 renderer 管**：renderer `bridge.acquire(workspaceKey) → { lease, partition }`
  向主进程申请预约，主进程按租约发放 Electron session（cookie 按租约隔离并持久）；
  guest 被回收（render-process-gone）时客户端自动重建；用完 `bridge.release(lease)`。
- **插件唯一正门** = 壳注入的 `globalThis.dshDesktop`（origin 域限定 preload，仅桌面版）：
  `protocolVersion === 1` 门 + `.browser.acquire()/release()`（**租 guest webview 挂进
  插件自己的 UI**）+ `.keyboard` / `.shortcuts` / `.deviceInfo`。UI 侧另有
  `browserAvailable` 标志与 `linkOpening` 设置。已知唯一消费例是 codearts 的
  captcha「内部载体」（`lib/client/jet-hub.js` 的 `readDesktopBridge` / `ensureGuest`）。
- ⚠ web 版（`dsh web`，本插件主力部署形态）**没有壳** ⇒ `dshDesktop` 不存在，
  租约不可用（codearts `captcha-carrier.js` 文件头明言同款限制）。

---

## 3. 决定性实测（探针，2026-10-02）

用 playwright-core 1.63 的 `chromium.launchPersistentContext` 直接驱动
`DeepSeek Harness.exe`（临时 profile、用完即清）：

```
PROBE-FAIL: browserContext.newPage: Protocol error (Target.createTarget): Not supported
```

进程能启动、CDP 管道握手成功，但**开不出自动化页面**。另有三个独立否决项：

1. **资源反向劣化**：以这种方式拉起会让整个 DSH 应用（cordis + 全部插件）作为
   第二实例启动——比一份 428 MB 的静态 Chromium 贵得多。
2. **无头不支持**：Electron 无真 headless，而本插件生产默认 `headless: true`。
3. **附着「正在运行的壳」走不通**：需要壳带 `--remote-debugging-port` 启动
   （`dsh-web-launcher` 的 config.json 没有这个口，属 DSH 官方行为）；
   且 CDP 新建上下文不持久，登录态随壳重启丢失，与红线二冲突。
   本轮刻意未实测这条路——它需要带调试口启动第二实例，可能干扰在跑的 `dsh web`。

> 探针脚本一次性用后即删；结论如上，重测可按本节描述 10 分钟复现。

---

## 4. 为什么先不改（理由清单）

1. **技术死路是实测的**，不是推测：`Target.createTarget` 不支持 ⇒ playwright 驱动
   Electron 二进制这条路关闭。
2. **官方能力面不开放**：`dshDesktop.browser` 只在 client 侧（renderer），
   服务端 node 拿不到；调试口也不在 launcher 的暴露面。插件侧做不了硬保证。
3. **即使打通也不省**：spawn DSH exe = 启动整个 DSH 应用；附着运行中壳 =
   共享进程稳定性风险 + 登录态不持久（红线二形状）。
4. **版本可控性回退**：0.18.0 的承诺是「自带优先 = 版本可控」（`browser-runtime.js`
   文件头）。改用 DSH 内核 = 版本随 DSH 桌面版漂移，与 system 兜底同级的风险。
5. **省资源的正解已有更便宜的路**（见 §6），不必动高风险的那条。

---

## 5. 本轮任务完成报告（2026-10-02）

| 任务 | 结果 |
| --- | --- |
| 调研现状 | §2（来源链 + 本机读数 + DSH 机制），全部实测/实读 |
| 可行性判定 | §3 探针 + §4 理由 ⇒ **先不改** |
| 0.19.53 发布 | 提交 `3413339`：单一 `webcode` 真路由组 + 注册幂等 + 桌面端独立副本；提交前抽查逮住裸跑隔离红并当场修（`regression.test.mjs` 显式 `WEBCODE_PROMPT_STORE_DIR='off'`），复跑 54 条全绿；四闸门全 PASS |
| 缺陷登记 | 提交前抽查暴露**生产缺陷候选**：真实轮重放读回首轮正本会丢后续增量（红线二形状）→ `doc/long-term-issues.md` #38，本轮不修 |
| 本文档 | 入库 + `doc/README.md` 登记（闸门验链接） |

---

## 6. 将来若要捡起（触发条件与路径）

1. **省资源（推荐，小改动）**：`browser-runtime.js` 加「来源偏好」设置
   （auto=现状自带优先 / **system-first** / bundled-only）+ 设置面板 + 状态展示。
   本机切 system-first 立省 428 MB，新机器免下载；版本风险与今天 system 兜底同构。
2. **等 DSH 官方能力**（触发后再评估）：`dshDesktop.browser` 服务端化 / launcher
   暴露调试口 / 官方提供浏览器模式。届时重测 §3。
3. **清理共享缓存（低优先）**：`ms-playwright` 里的 chromium-1217 与两个
   headless_shell 共约 676 MB 可释放，但那是**全机共享目录**（firefox 等属于
   其他工具），删前必须先确认没有别的消费者。
