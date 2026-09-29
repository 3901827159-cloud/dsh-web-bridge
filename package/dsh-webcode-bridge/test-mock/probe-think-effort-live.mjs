// probe-think-effort-live.mjs — 真机验证「思考等级」下发（0.19.48）。
//
// # 它验的是什么（以及为什么不发消息）
//
// 思考等级的下发路径是纯逻辑（`lib/think-effort.js` 的 `planEffort` / `applyEffort`）+
// 一个真页面。而 `applyEffort(page, {siteId, target})` 只需要一个**像 Playwright Page 的
// 对象**：`evaluate` / `locator` / `getByText` / `mouse.click` / `waitForTimeout`。
// 于是本探针把它接到真页面上（薄适配器 `realPage`），**一条消息都不发**就能验证：
//
//   ① 站点声明的触发控件在真机上找得到（选择器 / token 是否还准）；
//   ② 档位菜单里真有我们声明的那些档位（清单是否过期）；
//   ③ 反复下发两次同一档位时，第二次**一眼判定为已生效**（不会白点一遍）；
//   ④ 换一个档位能真的切过去（z.ai 的 高 → 最高、qwen 的 思考 → 快捷 等）。
//
// 这四件事各自都曾在真机上出过错（见 lib/think-effort.js 头部），所以它们必须逐站点留读数。
//
// # 用法
//
//   node test-mock/probe-think-effort-live.mjs zai
//   node test-mock/probe-think-effort-live.mjs kimi --target 标准 --target 进阶
//   node test-mock/probe-think-effort-live.mjs qwen --headless
//
// 不带 `--target` 时，对**每一个**声明过的档位各下发一次（从最后一档倒着走，保证每次都
// 真的发生一次切换，而不是「已经是它所以跳过」）。
//
// 输出：test-mock/out/think-effort-live-<site>-<ts>.json（含每一步读数与截图路径）。
//
// # 安全边界
//
// 只点「输入框附近的档位控件」，不填输入框、不发送消息；用落盘 profile 的**临时副本**
// （与 probe-think-control.mjs 同一套拷贝逻辑），杀进程不会污染登录态。

import { chromium } from '../node_modules/playwright-core/index.mjs';
import { getSite } from '../lib/providers.js';
import { applyEffort, thinkEffortFor } from '../lib/think-effort.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const allOf = (flag) => argv.reduce((acc, a, i) => (a === flag && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const siteId = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--target' && argv[i - 1] !== '--profile' && argv[i - 1] !== '--settle');
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HEADLESS = argv.includes('--headless');
const KEEP = argv.includes('--keep');
const TARGETS = allOf('--target');
const SETTLE_MS = Number(argOf('--settle', '6000'));
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!siteId) {
  console.error('用法: node test-mock/probe-think-effort-live.mjs <siteId> [--target 档位]... [--headless] [--keep]');
  process.exit(1);
}
const site = getSite(siteId);
if (!site) { console.error('未知站点: ' + siteId); process.exit(1); }
const def = thinkEffortFor(siteId);
if (!def) { console.error(`✗ 站点 ${siteId} 没有声明思考等级（think-effort.js 里没有它的读数）`); process.exit(1); }

const OUT_DIR = path.join(PKG, 'test-mock', 'out');
const SHOT_DIR = path.join(PKG, '.tmp', 'shots');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const report = { siteId, at: new Date().toISOString(), headless: HEADLESS, declared: def.efforts.map((e) => e.id), steps: [] };

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
      } catch { /* 单文件失败不阻断 */ }
    }
  };
  walk(src, dst);
}

const realProfileRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'webcode-edge-profile');
const siteProfileSrc = site.mountAtRelayRoot === true ? realProfileRoot : path.join(realProfileRoot, 'sites', siteId);
const workRoot = path.join(PKG, '.tmp-probe', 'profiles', 'effort-live-' + siteId + '-' + TS);
const userDataDir = path.join(workRoot, 'profile');
if (!fs.existsSync(siteProfileSrc)) {
  console.error('✗ 站点 profile 不存在: ' + siteProfileSrc + '（先在桥里打开一次该站点的独立窗口完成登录）');
  process.exit(1);
}
copyProfile(siteProfileSrc, userDataDir);
report.profileSource = siteProfileSrc;

const exe = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1232', 'chrome-win64', 'chrome.exe');
const hasExe = fs.existsSync(exe);

/**
 * 把一个真 Playwright Page 适配成 applyEffort 认的形状。
 *
 * 只做「同名同义」转发，不加任何判据——判据全在 lib/think-effort.js 里，本文件只是插座。
 * `filter({ hasText })` / `.first()` 的语义与 Playwright 一致（同族 locator）。
 */
function realPage(page, log) {
  const wrap = (loc) => ({
    first: () => wrap(loc.first()),
    filter: (o) => wrap(loc.filter(o)),
    count: () => loc.count(),
    isVisible: () => loc.isVisible().catch(() => false),
    click: async (o) => { log('click', o?.timeout ? '(timeout ' + o.timeout + ')' : ''); await loc.click(o); },
  });
  return {
    evaluate: async (fn, arg) => {
      const out = await page.evaluate(fn, arg);
      // 只记「有返回值」的那几个页面函数，避免刷屏；读数直接进证据文件。
      if (fn?.name === 'CLICK_EFFORT_OPTION' || fn?.name === 'READ_CHECKED_EFFORT' || fn?.name === 'FIND_EFFORT_CONTROL') {
        log('evaluate', fn.name, JSON.stringify(out)?.slice(0, 220));
      }
      // CLICK_EFFORT_OPTION 返回 false（菜单里没有那一条）时，把**整个可见浮层**的文本与
      // 可点元素 dump 出来：真机上「菜单明明开着却找不到条目」只有两种真因——菜单没开，
      // 或者候选判据把它排除了。没有这份现场，两者分不开。
      if (fn?.name === 'CLICK_EFFORT_OPTION' && out === false) {
        const dump = await page.evaluate(() => {
          const vis = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          };
          const txt = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
          const overlays = [...document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"]')].filter(vis);
          return {
            overlays: overlays.length,
            overlayText: overlays.map((o) => txt(o).slice(0, 120)),
            clickables: [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [data-state]')]
              .filter(vis).map((el) => txt(el).slice(0, 30)).filter(Boolean).slice(0, 30),
          };
        }).catch(() => null);
        log('menu-if-missing', JSON.stringify(dump)?.slice(0, 400));
      }
      return out;
    },
    locator: (sel) => wrap(page.locator(sel)),
    getByText: (t, o) => wrap(page.getByText(t, o)),
    mouse: { click: async (x, y) => { log('mouse.click', Math.round(x) + ',' + Math.round(y)); await page.mouse.click(x, y); } },
    waitForTimeout: (ms) => page.waitForTimeout(ms),
  };
}

/**
 * 失败现场：把可见浮层与「输入框附近的可见可点节点」连**坐标**一起 dump 出来。
 *
 * 真机上「菜单明明开着却找不到条目」只有两种真因——菜单没开，或者候选判据把它排除了。
 * 没有坐标的现场分不开这两者（`--dump` 那次就是靠坐标才看出命中的是菜单行而不是 pill）。
 */
async function dumpScene(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const txt = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return `@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    const overlays = [...document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"]')].filter(vis);
    return {
      overlayCount: overlays.length,
      overlays: overlays.map((o) => ({ role: o.getAttribute('role'), text: txt(o).slice(0, 80), box: box(o) })),
      clickables: [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [data-state]')]
        .filter(vis).map((el) => ({ t: txt(el).slice(0, 40), box: box(el), st: el.getAttribute('data-state') })).slice(0, 25),
    };
  }).catch(() => null);
}

const browser = await chromium.launchPersistentContext(userDataDir, {
  executablePath: hasExe ? exe : undefined,
  headless: HEADLESS,
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  args: ['--disable-blink-features=AutoMathControlled', '--no-first-run', '--no-default-browser-check'],
});
const page = browser.pages()[0] ?? await browser.newPage();

try {
  await page.goto(site.origin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(SETTLE_MS);
  report.url = page.url();
  report.title = await page.title().catch(() => '');

  const shot0 = path.join(SHOT_DIR, `effort-live-${siteId}-base-${TS}.png`);
  await page.screenshot({ path: shot0 }).catch(() => {});
  report.baseShot = shot0;

  // 目标序列：显式 --target 优先；否则**倒序**跑全部声明档位（保证每次都真发生一次切换）
  const targets = TARGETS.length ? TARGETS : [...def.efforts].reverse().map((e) => e.id);
  for (const target of targets) {
    const traces = [];
    const log = (...a) => traces.push(a.join(' '));
    const step = { target, traces };
    try {
      const r1 = await applyEffort(realPage(page, log), { siteId, target });
      step.applied = r1;
      // 第二次下发同一档位：应当**一眼判定为已生效**（不白点一遍）
      const before = traces.length;
      const r2 = await applyEffort(realPage(page, log), { siteId, target });
      step.idempotent = { applied: r2, extraActions: traces.length - before };
      step.ok = r1.applied === true;
    } catch (err) {
      step.ok = false;
      step.error = { code: err?.code ?? null, message: String(err?.message || err) };
      step.scene = await dumpScene(page);
    }
    step.shot = path.join(SHOT_DIR, `effort-live-${siteId}-${target}-${TS}.png`);
    await page.screenshot({ path: step.shot }).catch(() => {});
    report.steps.push(step);
    console.log(`\n· ${siteId} → 「${target}」 ` + (step.ok ? '✔ 已下发' : '✗ ' + JSON.stringify(step.error)));
    if (step.applied) console.log('    回读：' + JSON.stringify(step.applied.readback) + '（' + step.applied.reason + '）');
    console.log('    幂等性：再下发一次追加动作 ' + step.idempotent?.extraActions + ' 步');
    for (const t of traces) console.log('      ' + t);
    if (step.scene) {
      console.log('    现场：浮层 ' + step.scene.overlayCount + ' 个；可点节点 ' + step.scene.clickables.length + ' 个');
      for (const o of step.scene.overlays) console.log('      [overlay ' + o.role + '] ' + JSON.stringify(o.text) + ' ' + o.box);
      for (const c of step.scene.clickables) console.log('      [clickable' + (c.st ? ' state=' + c.st : '') + '] ' + JSON.stringify(c.t) + ' ' + c.box);
    }
  }
} catch (err) {
  report.error = String(err?.stack || err?.message || err);
  console.error('✗ ' + report.error);
} finally {
  const outFile = path.join(OUT_DIR, `think-effort-live-${siteId}-${TS}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('\n证据: ' + outFile);
  const failed = report.steps.filter((s) => !s.ok);
  console.log(`PROBE RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${report.steps.length - failed.length}/${report.steps.length} 档位下发成功）`);
  await browser.close().catch(() => {});
  if (!KEEP) { try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* 磁盘代价 */ } }
}
