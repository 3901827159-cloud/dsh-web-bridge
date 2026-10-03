// probe-account-identity.mjs — 真机探查「当前登录账号的昵称 / 头像」候选（2026-10-03）。
//
// # 为什么需要这个脚本
//
// `lib/browser-driver.js` 的 `readAccountIdentity()` 靠两样东西从网页 DOM 里读昵称与头像：
//   ① 站点在 `lib/providers.js` 里声明的 `accountProbe`；
//   ② 没有声明时的**通用猜测**（`GENERIC_NAME_SELECTORS` / `GENERIC_AVATAR_SELECTORS`）。
//
// 目前十个站点里**只有 GLM** 声明了 `accountProbe`（providers.js 第 235-238 行，有真机取证）；
// 其余 9 站全靠通用猜测，真机 `/status` 读数显示 deepseek / doubao / z.ai 的 `accountName`
// 都是空——也就是「猜的那族选择器在这些站点上没命中」。
//
// 而本仓库的硬纪律是：**没有真机读数不许编选择器**（providers.js 每个选择器后面都挂着证据）。
// 所以补选择器之前，必须先有一步「把页面上所有可能承载昵称/头像的节点 dump 出来」的取证。
// 本脚本就是那一步：在**已登录的落盘 profile 副本**上打开站点，回传候选证据，
// 让人据此挑出可复用的稳定选择器（而不是由脚本替人拍板）。
//
// # 用法
//
//   node test-mock/probe-account-identity.mjs <siteId> [--slot N] [--root DIR]
//                                             [--headless] [--keep] [--settle MS] [--goto URL]
//
//   <siteId>  十个之一：deepseek glm chatgpt kimi qwen doubao grok claude gemini zai
//   --slot    账户槽，默认 default（路径推导走 lib/accounts.js 的 slotProfileDir）
//   --root    profile 根目录，默认 %USERPROFILE%\.dsh\webcode-edge-profile-desktop
//             （本机运行中的桥实际用的就是这个；~/.dsh/webcode-edge-profile 是旧默认，留作兼容）
//   --headless 无头（默认有头，便于人工肉眼看页面状态）
//   --keep    保留临时 profile 副本（默认跑完删掉）
//   --settle  导航后等待毫秒，默认 6000（网页首屏渲染慢时调大）
//   --goto    不打开站点首页，直接指定一个 URL
//
// 输出：
//   test-mock/out/account-identity-<siteId>[-<slot>]-<ts>.json   全量读数（= 证据）
//   .tmp/shots/account-identity-<siteId>[-<slot>]-<ts>.png       页面截图
//
// 退出码：0 = 正常跑完（哪怕候选为空，空也是读数）；1 = 参数/站点错误；
//         2 = 硬失败（浏览器或页面从未打开，原因在 JSON 的 `notes`）。
//
// # 安全边界（刻意为之，别放宽）
//
//   · **只读**：不填输入框、不发消息、不点击、不提交表单、不注入绕过风控的脚本；
//   · 打开的是**落盘 profile 的临时副本**（拷到 .tmp-probe/profiles/ 下）——
//     本机运行中的桥正持有真实目录，绝不能对它启动第二个浏览器进程；
//     杀进程/崩溃也只污染副本，登录态不受影响；
//   · 单个站点**一次运行最多 1 次页面加载**（仓库风控纪律：不重试轰炸）；
//     站点弹验证码/风控/超时一律如实写进 JSON 的 `notes`，那是事实，不是失败；
//   · 不引第三方依赖：只用 playwright-core、node 内置模块、仓库自己的 lib/。
//
// # 沙箱兜底（本机限制，不是设计选择）
//
// 本机受限模式下**带管道 stdio 的子进程会被 EPERM 拦下**（`node -e`
// spawn 一个程序用默认 `stdio:'pipe'` 直接 `spawn EPERM`；`stdio:'ignore'` 才放行）。
// 而 `launchPersistentContext` 恰恰用 `--remote-debugging-pipe` 拉起 Chromium ⇒ 必然 EPERM。
// 因此脚本保留 `launchPersistentContext` 为主路径，**仅当**它抛 EPERM/spawn 时改走
// `launchChromeViaCdp()` 兜底：自己用 `stdio:'ignore'` 拉起 Chromium（不建管道，
// 不触发 EPERM），监听 `--remote-debugging-port=0`，再用 `connectOverCDP` 连上。
// 功能等价——同一个 profile 副本、同一个页面、同样只读；`launchMode` 字段记录走了哪条。
// 详见 `notes` 与 `doc/long-term-issues.md` 对应的沙箱条目。

import { chromium } from '../node_modules/playwright-core/index.mjs';
import { getSite } from '../lib/providers.js';
import { slotProfileDir, normalizeSlot, DEFAULT_SLOT } from '../lib/accounts.js';
import { ACCOUNT_CANDIDATE_PROBE } from '../lib/account-candidates.js';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = path.resolve(import.meta.dirname, '..');

// ---- CLI 解析（风格照 probe-think-control.mjs）--------------------------------
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : d; };
const FLAGS_WITH_VALUE = new Set(['--slot', '--root', '--settle', '--goto']);
const siteId = argv.find((a, i) => !a.startsWith('--') && !FLAGS_WITH_VALUE.has(argv[i - 1]));

const HEADLESS = argv.includes('--headless');
const KEEP = argv.includes('--keep');
const SLOT_RAW = argOf('--slot', DEFAULT_SLOT);
const SETTLE_MS = Number(argOf('--settle', '6000'));
const GOTO = argOf('--goto', null);
// 默认根目录：本机运行中的桥实际用的是 `webcode-edge-profile-desktop`。
// `~/.dsh/webcode-edge-profile` 是 0.18 之前的旧默认，只作为兼容保留（--root 可显式指定）。
const DEFAULT_ROOT = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'webcode-edge-profile-desktop');
const ROOT = argOf('--root', DEFAULT_ROOT);
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const USAGE = '用法: node test-mock/probe-account-identity.mjs <siteId> [--slot N] [--root DIR] [--headless] [--keep] [--settle MS] [--goto URL]\n'
  + '  <siteId>: deepseek glm chatgpt kimi qwen doubao grok claude gemini zai';

if (!siteId) { console.error(USAGE); process.exit(1); }
const site = getSite(siteId);
if (!site) { console.error('未知站点: ' + siteId + '\n' + USAGE); process.exit(1); }
const slot = normalizeSlot(SLOT_RAW);
if (!slot) { console.error('非法槽名: ' + SLOT_RAW + '\n' + USAGE); process.exit(1); }
if (!Number.isFinite(SETTLE_MS) || SETTLE_MS < 0) { console.error('非法 --settle: ' + argOf('--settle', '') + '\n' + USAGE); process.exit(1); }

const SITE_KEY = slot === DEFAULT_SLOT ? siteId : siteId + '-' + slot;
const OUT_DIR = path.join(PKG, 'test-mock', 'out');
const SHOT_DIR = path.join(PKG, '.tmp', 'shots');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const report = {
  siteId, slot, at: new Date().toISOString(), url: null, title: null,
  profileSource: null, headless: HEADLESS,
  looksLoggedIn: null, loginHints: [],
  nameCandidates: [], avatarCandidates: [], notes: [],
};

/** 递归拷贝 profile，跳过缓存/锁/日志（体积大且与登录态无关）。 */
function copyProfile(src, dst) {
  const SKIP = /^(Cache|Code Cache|GPUCache|ShaderCache|GrShaderCache|GPUPersistentCache|DawnCache|BrowserMetrics|Crashpad|component_crx_cache|extensions_crx_cache|segmentation_platform|Local Traces|logs|Sync Data)$/i;
  fs.mkdirSync(dst, { recursive: true });
  const walk = (from, to) => {
    let entries = [];
    try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.test(e.name) || /^(Singleton|DevToolsActivePort|lockfile)/i.test(e.name) || /\.(log|tmp)$/i.test(e.name)) continue;
      try {
        if (e.isDirectory()) walk(path.join(from, e.name), path.join(to, e.name));
        else if (e.isFile()) fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
      } catch { /* 单文件失败不阻断（缓存文件常被占用） */ }
    }
  };
  walk(src, dst);
}

/**
 * 删除**已核实的**临时目录：只允许删 `.tmp-probe/profiles/` 下的路径。
 * Windows 路径安全纪律——不对未核实的计算路径做删除。
 */
function safeRm(dir) {
  const resolved = path.resolve(dir);
  const base = path.resolve(PKG, '.tmp-probe', 'profiles');
  if (!resolved.startsWith(base + path.sep)) { console.warn('跳过删除（不在 .tmp-probe/profiles 下）: ' + resolved); return; }
  try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* 留着的代价只是磁盘 */ }
}

// ---- 真实槽目录用 accounts.js 的唯一推导，绝不自己拼路径 -----------------------
const siteProfileSrc = slotProfileDir(ROOT, siteId, slot, { primary: site.mountAtRelayRoot === true });
const workRoot = path.join(PKG, '.tmp-probe', 'profiles', SITE_KEY);
const userDataDir = path.join(workRoot, 'profile');
if (!fs.existsSync(siteProfileSrc)) {
  console.error('✗ 站点 profile 不存在: ' + siteProfileSrc
    + '\n  （先用 --root 指向正确的 profile 根，或在桥里打开一次该站点的独立窗口完成登录）');
  process.exit(1);
}
if (fs.existsSync(workRoot)) safeRm(workRoot);   // 清掉上次同名副本，避免混入旧状态
copyProfile(siteProfileSrc, userDataDir);
report.profileSource = siteProfileSrc;
report.profileCopy = userDataDir;

// ---- **不静默半拷贝**（2026-10-03 真机踩到，必须挡住）--------------------------
//
// 运行中的 Chromium 会**独占** `<profile>/Default/Network/Cookies`。此时
// `fs.copyFileSync` 抛 EBUSY，而 `copyProfile` 的 `catch { /* 单文件失败不阻断 */ }`
// 会把它咽掉——于是得到一个**没有登录态的副本**：页面渲染成游客态，
// 而探针的读数看起来完全正常（nameCandidates 为空、looksLoggedIn=false），
// 读它的人只会得出「这个站点没登录」的错误结论。
//
// 真机证据（2026-10-03）：同一台机上，桥自己的活页面 verify-login 对 glm 回
// `probe-ok` 且抓到 `RSYHN`，而本脚本的副本渲染成「登录送积分好礼」游客页；
// 事后核实副本里**根本没有 Cookies 文件**（`robocopy` 直读源文件同样是共享冲突）。
// 这正是本项目最忌讳的静默降级——所以这里显式核对，缺了就硬失败。
const srcCookies = path.join(siteProfileSrc, 'Default', 'Network', 'Cookies');
const copyCookies = path.join(userDataDir, 'Default', 'Network', 'Cookies');
if (fs.existsSync(srcCookies) && !fs.existsSync(copyCookies)) {
  console.error('✗ profile 副本缺少 cookie 库（源被运行中的浏览器独占，拷贝 EBUSY）：\n'
    + '  源: ' + srcCookies + '\n'
    + '  → 该副本没有登录态，页面会是游客态，读数会**误导人**，因此中止（不是「没登录」）。\n'
    + '  出路：① 关掉持有该 profile 的浏览器 / 桥之后再跑本脚本；\n'
    + '        ② 改用桥的**活页面**取证：POST /__webcode/account-identity\n'
    + '           { "siteId": "<站点>", "debug": true }（服务端 0.19.60+ 支持）。');
  if (!KEEP) safeRm(workRoot);
  process.exit(2);
}

// 内置 Chromium 优先、系统兜底——来源与桥完全一致（lib/browser-runtime.js）。
const exeInfo = resolveBrowserExecutable();
const exe = exeInfo.path;
report.executablePath = exe || '(playwright default)';
report.executableSource = exeInfo.source;
if (!exe) report.notes.push('未解析到 Chromium/Edge/Chrome 可执行文件，交由 playwright 默认解析（可能失败）');

// ---- 页面内读数函数（在浏览器里跑，必须是自包含的）---------------------------
/**
 * 一份「账号身份候选」读数：昵称候选（子树叶子）+ 头像候选（img / background-image）
 * + 登录态线索（可见可点的「登录 / Sign in / Log in」节点）。
 *
 * 刻意**不**在这里拍板选择器：回传的是候选 + 可复用选择器提示 + 语义分数，
 * 由人据此选出稳定选择器再写进 providers.js（本仓库纪律：选择器必须来自真机读数）。
 */
// 页面侧扫描的**唯一**实现：见 lib/account-candidates.js 的文件头。
// 这里刻意不再内联一份——两处各写一遍必然漂移（本仓库记过多次）。
const READ = ACCOUNT_CANDIDATE_PROBE;

// ---- 启动浏览器（profile 副本）与采样 -----------------------------------------
const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'];

/** 读 Chrome 落在 profile 根下的 DevToolsActivePort（第一行是端口号）。 */
async function waitForDevToolsPort(dir, ms = 20_000, child = null) {
  const file = path.join(dir, 'DevToolsActivePort');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child && child.exitCode !== null) return null;   // 进程已退出：不必等满超时
    try {
      const line = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
      if (/^\d+$/.test(line)) return Number(line);
    } catch { /* 还没写出来，继续等 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * 沙箱兜底：自己用 `stdio:'ignore'` 拉起 Chromium（不建管道 ⇒ 不触发 EPERM），
 * 监听 `--remote-debugging-port=0`，再用 `connectOverCDP` 连上去。
 * 返回值里 `browser` 是 playwright 的 Browser（与 BrowserContext 一样有
 * `pages()/newPage()/close()`），`child` 是 Chromium 进程（收尾时 kill）。
 */
async function launchChromeViaCdp(dir) {
  const args = ['--remote-debugging-port=0', '--user-data-dir=' + dir,
    `--window-size=1440,900`, '--no-sandbox', ...LAUNCH_ARGS];
  if (HEADLESS) args.push('--headless=new');
  const child = spawn(exe, args, { stdio: 'ignore' });   // stdio:'pipe' 在本机会 EPERM，必须 ignore
  let spawnErr = null;
  child.on('error', (e) => { spawnErr = e; });
  const port = await waitForDevToolsPort(dir, 20_000, child);
  if (!port) {
    let code = null;
    try { code = child.exitCode; } catch { /* 读不到就只报端口 */ }
    try { child.kill(); } catch { /* 已退出 */ }
    throw new Error('CDP 兜底失败：未等到 DevToolsActivePort（Chromium 退出码 ' + code + '）'
      + (spawnErr ? ' / spawn: ' + spawnErr.message : ''));
  }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  return { browser, child };
}

let browser = null;
let cdpChild = null;
try {
  try {
    browser = await chromium.launchPersistentContext(userDataDir, {
      executablePath: exe || undefined,
      headless: HEADLESS,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      args: LAUNCH_ARGS,
    });
    report.launchMode = 'persistent-pipe';
  } catch (e) {
    const msg = String(e?.message || e);
    if (!exe || !/EPERM|spawn/i.test(msg)) throw e;
    report.notes.push('launchPersistentContext 被沙箱 EPERM 拦下，改走 connectOverCDP 兜底（自行 stdio:ignore 拉起 Chromium）');
    const r = await launchChromeViaCdp(userDataDir);
    browser = r.browser;
    cdpChild = r.child;
    report.launchMode = 'cdp-external';
  }
  const page = browser.pages()[0] ?? await browser.newPage();
  const target = GOTO || (site.origin + '/');

  // 单次页面加载（风控纪律：不重试轰炸）。导航失败如实记 note，不再重试。
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (e) {
    report.notes.push('导航失败（未重试）: ' + String(e?.message || e));
  }
  await page.waitForTimeout(SETTLE_MS);

  const read = await page.evaluate(READ);
  report.url = read.url || page.url();
  report.title = read.title || null;
  report.loginHints = read.loginHints || [];
  report.nameCandidates = read.nameCandidates || [];
  report.avatarCandidates = read.avatarCandidates || [];
  report.notes.push(...(read.notes || []));
  // 判据：页面上存在可见可点的「登录 / Sign in / Log in」节点 ⇒ 大概率是游客态。
  // 反过来没有这种节点 ⇒ 记 true（这是启发式，不是断言；异常一律看 notes）。
  report.looksLoggedIn = report.loginHints.length === 0;
  if (!report.nameCandidates.length) report.notes.push('nameCandidates 为空：探测范围可能不够，需要扩大子树范围');
  if (!report.avatarCandidates.length) report.notes.push('avatarCandidates 为空：探测范围可能不够');

  const shot = path.join(SHOT_DIR, `account-identity-${SITE_KEY}-${TS}.png`);
  try { await page.screenshot({ path: shot }); report.shot = shot; } catch (e) { report.notes.push('截图失败: ' + String(e?.message || e)); }
} catch (err) {
  report.notes.push('浏览器/页面异常: ' + String(err?.stack || err?.message || err));
} finally {
  const outFile = path.join(OUT_DIR, `account-identity-${SITE_KEY}-${TS}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  // ---- stdout：只打简短人类摘要，**不**把整个 JSON 打到 stdout -----------------
  console.log(`站点 ${siteId}${slot === DEFAULT_SLOT ? '' : ' #' + slot} | headless=${HEADLESS}`);
  console.log('URL: ' + (report.url || '(未导航)'));
  console.log('标题: ' + (report.title || '(无)'));
  console.log('profile(副本来源): ' + report.profileSource);
  console.log('launchMode: ' + (report.launchMode || '(launch 失败)'));
  console.log('looksLoggedIn: ' + report.looksLoggedIn + '  loginHints=' + JSON.stringify(report.loginHints));
  console.log(`nameCandidates (${report.nameCandidates.length}) 前 8:`);
  for (const n of report.nameCandidates.slice(0, 8)) console.log('  * ' + n.selectorHint + '  = ' + JSON.stringify(n.text) + '  score=' + n.score);
  console.log(`avatarCandidates (${report.avatarCandidates.length}) 前 8:`);
  for (const a of report.avatarCandidates.slice(0, 8)) {
    const src = a.src || a.bgUrl || '';
    console.log('  * ' + a.selectorHint + '  src=' + String(src).slice(0, 60) + '  score=' + a.score);
  }
  if (report.notes.length) { console.log('notes:'); for (const n of report.notes) console.log('  ! ' + n); }
  console.log('证据: ' + outFile);
  if (report.shot) console.log('截图: ' + report.shot);

  await browser?.close().catch(() => {});
  try { cdpChild?.kill(); } catch { /* 已退出 */ }
  if (!KEEP) safeRm(workRoot);
  // 硬失败（页面从未打开）不该静默退 0——那会让「没读到」被当成「读到了空的」。
  if (!report.url) { console.error('✗ 未取得任何页面读数（原因见 notes）；JSON 已落盘仅供排查'); process.exitCode = 2; }
}
