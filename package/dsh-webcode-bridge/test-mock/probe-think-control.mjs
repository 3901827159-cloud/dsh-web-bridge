// probe-think-control.mjs — 真机探查「模型 / 思考等级」控件（2026-09-28）。
//
// # 为什么需要这个脚本
//
// 用户报障（原话见 doc/user-voice-log.md）两件事：
//   ① DSH 这边**没有思考等级**可选——网页端「除了 deepseek 是只有深度思考开关，
//      其他网站都有思考等级的分级」；
//   ② 豆包「不是只有对话和工作两个模式，左下角有模型和思考等级选择」。
//
// 两件事都不是猜得出来的：每个站点控件长相、逐字文本、层级都不同，而本仓库纪律是
// **站点知识必须来自真机读数**（providers.js 每个选择器后面都挂着证据文件）。
// 本脚本就是采证据那一步：在**已登录的落盘 profile 副本**上打开站点，dump 输入框
// 附近的可见可点节点，再按指定目标逐个点开，dump「点之前没有、点之后出现」的新节点。
//
// # 用法
//
//   node test-mock/probe-think-control.mjs doubao                    # 只 dump 基础读数
//   node test-mock/probe-think-control.mjs doubao --click "豆包 快速"  # 点它并 dump 弹层
//   node test-mock/probe-think-control.mjs kimi --click "进阶" --click ".model-name"
//   node test-mock/probe-think-control.mjs zai --click "[class*=think]" --headless
//
// `--click` 接受三种形态，按序尝试：CSS 选择器 / 精确或包含文本 / `x,y` 坐标。
// 可重复多次：每次点击后单独采样（弹层套弹层时按顺序给）。
//
// 输出：
//   test-mock/out/think-control-<site>-<ts>.json   全量读数（= 证据）
//   .tmp/shots/think-control-<site>-<n>-<ts>.png   每一步截图
//
// # 安全边界（刻意为之，别放宽）
//
//   · **只点选择器/开关，不填输入框、不发送任何消息**；
//   · 打开的是**落盘 profile 的临时副本**（拷到 .tmp-probe/profiles/ 下），
//     杀进程/崩溃都不会污染登录态；`--profile` 可指定真目录（默认不这么做）；
//   · 不注入绕过风控的脚本。站点弹验证就如实记进报告——那是事实，不是失败。

import { chromium } from '../node_modules/playwright-core/index.mjs';
import { getSite } from '../lib/providers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const siteId = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--click' && argv[argv.indexOf(a) - 1] !== '--profile' && argv[argv.indexOf(a) - 1] !== '--settle');
const allOf = (flag) => argv.reduce((acc, a, i) => (a === flag && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const CLICKS = allOf('--click');
const TARGETS = allOf('--target');
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HEADLESS = argv.includes('--headless');
const KEEP = argv.includes('--keep');
const DUMP = argv.includes('--dump');
const EXPLICIT_PROFILE = argOf('--profile', null);
const SETTLE_MS = Number(argOf('--settle', '6000'));
const GOTO = argOf('--goto', null);
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!siteId) {
  console.error('用法: node test-mock/probe-think-control.mjs <siteId> [--click TARGET]... [--headless] [--keep] [--profile DIR]');
  process.exit(1);
}
const site = getSite(siteId);
if (!site) { console.error('未知站点: ' + siteId); process.exit(1); }

const OUT_DIR = path.join(PKG, 'test-mock', 'out');
const SHOT_DIR = path.join(PKG, '.tmp', 'shots');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const report = { siteId, at: new Date().toISOString(), headless: HEADLESS, profileSource: null, steps: [] };

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

const realProfileRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'webcode-edge-profile');
const siteProfileSrc = EXPLICIT_PROFILE || (site.mountAtRelayRoot === true ? realProfileRoot : path.join(realProfileRoot, 'sites', siteId));
const workRoot = path.join(PKG, '.tmp-probe', 'profiles', 'think-' + siteId + '-' + TS);
const userDataDir = path.join(workRoot, 'profile');
if (!fs.existsSync(siteProfileSrc)) {
  console.error('✗ 站点 profile 不存在: ' + siteProfileSrc + '（先在桥里打开一次该站点的独立窗口完成登录）');
  process.exit(1);
}
copyProfile(siteProfileSrc, userDataDir);
report.profileSource = siteProfileSrc;
report.profileCopy = userDataDir;

const exe = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1232', 'chrome-win64', 'chrome.exe');
const hasExe = fs.existsSync(exe);
report.executablePath = hasExe ? exe : '(playwright default)';

// ---- 页面内读数函数（在浏览器里跑，必须是自包含的）---------------------------
/**
 * 一份页面读数：输入框 + 输入框附近的可见可点节点 + 全页可见「弹层类」节点。
 * 刻意不用 closest('form')：豆包等新前端没有 form，祖先链上没有稳定类名。
 */
const READ = ([sel]) => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.05;
  };
  const desc = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 200),
      id: el.id || null,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      ariaPressed: el.getAttribute('aria-pressed'),
      ariaChecked: el.getAttribute('aria-checked'),
      ariaSelected: el.getAttribute('aria-selected'),
      dataState: el.getAttribute('data-state'),
      testid: el.getAttribute('data-testid'),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
      parentCls: el.parentElement ? String(el.parentElement.className || '').slice(0, 140) : null,
    };
  };
  const CAND = 'button, [role="button"], [aria-pressed], [aria-haspopup], [aria-expanded], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [role="tab"], [role="switch"], [role="combobox"], [role="dialog"], [role="listbox"], [class*="select"], [class*="Select"], [class*="model"], [class*="Model"], [class*="think"], [class*="Think"], [class*="effort"], [class*="Effort"], [class*="mode"], [class*="Mode"], [class*="dropdown"], [class*="Dropdown"], [class*="menu"], [class*="Menu"]';
  const all = [...document.querySelectorAll(CAND)].filter(vis);
  const inputs = [...document.querySelectorAll(sel)].filter(vis);
  const input = inputs.length ? inputs[inputs.length - 1] : null;
  const ir = input ? input.getBoundingClientRect() : null;
  const near = ir ? all.filter((el) => {
    const r = el.getBoundingClientRect();
    const dx = Math.max(0, Math.max(ir.left - r.right, r.left - ir.right));
    const dy = Math.max(0, Math.max(ir.top - r.bottom, r.top - ir.bottom));
    return Math.hypot(dx, dy) <= 300;
  }).map(desc) : [];
  // 弹层候选：全页里带 dialog/listbox/menu 语义、或浮在其它内容之上的节点
  const overlay = all.filter((el) => {
    const role = el.getAttribute('role');
    if (role === 'dialog' || role === 'listbox' || role === 'menu') return true;
    const z = Number(getComputedStyle(el).zIndex);
    const pos = getComputedStyle(el).position;
    return (pos === 'absolute' || pos === 'fixed') && Number.isFinite(z) && z >= 10;
  }).map(desc);
  // 弹层里的**结构细节**：只对「浮层内」的节点取 selector / 子树 / outerHTML，
  // 用来判定「这个名字是模型名还是档位」以及能不能用一行选择器点它。
  const inside = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const role = p.getAttribute('role');
      if (role === 'menu' || role === 'listbox' || role === 'dialog') return true;
      const cs = getComputedStyle(p);
      if ((cs.position === 'absolute' || cs.position === 'fixed') && Number(cs.zIndex) >= 10) return true;
    }
    return false;
  };
  const stableSel = (el) => {
    const testid = el.getAttribute('data-testid');
    if (testid) return `[data-testid="${testid}"]`;
    const slot = el.getAttribute('data-slot');
    if (slot) return `[data-slot="${slot}"]`;
    return null;
  };
  const children = (el) => [...el.children].map((c) => ({
    tag: c.tagName.toLowerCase(),
    cls: String(c.className || '').slice(0, 90),
    text: (c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
    kids: [...c.children].map((g) => ({
      tag: g.tagName.toLowerCase(),
      cls: String(g.className || '').slice(0, 70),
      text: (g.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30),
    })).slice(0, 6),
  })).slice(0, 6);
  const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [role="tab"], [data-slot="dropdown-menu-item"], [data-slot="dropdown-menu-radio-item"]')]
    .filter(vis).map((el) => ({ ...desc(el), sel: stableSel(el), children: children(el), html: el.outerHTML.slice(0, 1500) }));
  return { url: location.href, input: input ? desc(input) : null, near, overlay, items };
};

const browser = await chromium.launchPersistentContext(userDataDir, {
  executablePath: hasExe ? exe : undefined,
  headless: HEADLESS,
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
});
const page = browser.pages()[0] ?? await browser.newPage();

async function sample(tag) {
  const r = await page.evaluate(READ, [site.input]);
  const shot = path.join(SHOT_DIR, `think-control-${siteId}-${report.steps.length}-${TS}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  const step = { tag, ...r, shot };
  report.steps.push(step);
  console.log(`\n===== [${tag}] ${r.url}`);
  console.log('输入框: ' + (r.input ? `[${r.input.tag}] cls=${JSON.stringify(r.input.cls.slice(0, 80))}` : '(未找到)'));
  console.log(`输入框附近可点节点 (${r.near.length}):`);
  for (const n of r.near) console.log('  ' + fmt(n));
  console.log(`弹层候选 (${r.overlay.length}):`);
  for (const n of r.overlay) console.log('  ' + fmt(n));
  if (r.items?.length) {
    console.log(`弹层条目 (${r.items.length}):`);
    for (const it of r.items) {
      console.log('  * ' + fmt(it) + (it.sel ? ` sel=${it.sel}` : ' sel=(none)'));
      for (const c of it.children) console.log('      > [' + c.tag + '] ' + JSON.stringify(c.text) + ' cls=' + JSON.stringify(c.cls.slice(0, 60)));
      for (const c of it.children) for (const g of c.kids) console.log('        - [' + g.tag + '] ' + JSON.stringify(g.text) + ' cls=' + JSON.stringify(g.cls.slice(0, 50)));
    }
  }
  return step;
}

function fmt(n) {
  return `[${n.tag}${n.role ? ' role=' + n.role : ''}${n.ariaLabel ? ' aria=' + JSON.stringify(n.ariaLabel) : ''}`
    + `${n.ariaPressed != null ? ' pressed=' + n.ariaPressed : ''}${n.ariaChecked != null ? ' checked=' + n.ariaChecked : ''}`
    + `${n.ariaSelected != null ? ' selected=' + n.ariaSelected : ''}${n.dataState ? ' state=' + n.dataState : ''}`
    + `${n.testid ? ' testid=' + n.testid : ''}] `
    + JSON.stringify(n.text) + ` @${n.x},${n.y} ${n.w}x${n.h} cls=${JSON.stringify(n.cls.slice(0, 70))}`;
}

/** 点一个目标：CSS 选择器 → 文本 → 坐标（按序尝试）。 */
async function clickTarget(target) {
  const coord = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(target);
  const attempts = [];
  let lastErr = null;
  if (coord) attempts.push({ how: 'coord', run: () => page.mouse.click(Number(coord[1]), Number(coord[2])) });
  if (!coord) {
    attempts.push({ how: 'css', run: async () => { const loc = page.locator(target).first(); await loc.waitFor({ state: 'visible', timeout: 4000 }); await loc.click({ timeout: 4000 }); } });
    attempts.push({ how: 'testid', run: async () => { const loc = page.locator(`[data-testid="${target}"]`).first(); await loc.waitFor({ state: 'visible', timeout: 4000 }); await loc.click({ timeout: 4000 }); } });
  }
  attempts.push({ how: 'text-exact', run: async () => { const loc = page.getByText(target, { exact: true }).first(); await loc.waitFor({ state: 'visible', timeout: 4000 }); await loc.click({ timeout: 4000 }); } });
  attempts.push({ how: 'text-contains', run: async () => { const loc = page.getByText(target, { exact: false }).first(); await loc.waitFor({ state: 'visible', timeout: 4000 }); await loc.click({ timeout: 4000 }); } });
  for (const a of attempts) {
    try { await a.run(); return a.how; } catch (e) { lastErr = String(e?.message || e); }
  }
  console.log('  (四种形态都未命中；最后一次错误: ' + lastErr + ')');
  return null;
}

try {
  await page.goto(GOTO || (site.origin + '/'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(SETTLE_MS);
  const base = await sample('base');
  // 基线集合：用于算「点之后新出现」的节点
  const baseKeys = new Set([...base.near, ...base.overlay].map((n) => n.tag + '|' + n.text + '|' + n.x + ',' + n.y));

  // --dump：枚举「输入框附近」每个可点节点，把每个都点开一次并 dump 弹层内容。
  //
  // ⚠ 刻意**不**在点完按 Escape 收回（0.19.48 实测教训）：多数站点的弹层是
  // 「再点一次同一触发就切换关闭」，于是下一轮点同一个按钮时它可能正开着——
  // 那一轮读到的 items 是**别人的**菜单。宁可让弹层自己开着（下一轮点别处会关），
  // 也不要产出一份「条目看着对、其实来源错」的假读数（本仓库记过很多次这类错）。
  if (DUMP) {
    const targets = base.near.filter((n) => n.text && n.w >= 8 && n.h >= 8);
    console.log(`\n### --dump：枚举 ${targets.length} 个候选`);
    report.dumps = [];
    for (const t of targets) {
      const rec = { target: { text: t.text, testid: t.testid, x: t.x, y: t.y, w: t.w, h: t.h } };
      try {
        await page.mouse.click(t.x + t.w / 2, t.y + t.h / 2);
        await page.waitForTimeout(1200);
        const snap = await page.evaluate(READ, [site.input]);
        rec.items = (snap.items || []).map((it) => ({
          text: it.text, role: it.role, sel: it.sel,
          leaves: it.children.flatMap((c) => [c.text, ...c.kids.map((g) => g.text)]).filter(Boolean),
        }));
        rec.overlay = snap.overlay.map((o) => ({ text: o.text.slice(0, 60), role: o.role }));
        rec.triggerAfter = (snap.near.find((n) => n.testid === t.testid) || {}).text ?? null;
      } catch (err) { rec.error = String(err?.message || err); }
      report.dumps.push(rec);
      console.log(`\n  · 点 ${JSON.stringify(t.text)}` + (rec.triggerAfter != null ? ` → 触发按钮变为 ${JSON.stringify(rec.triggerAfter)}` : '')
        + (rec.error ? ` ✗ ${rec.error}` : ''));
      for (const it of rec.items || []) console.log(`      * ${JSON.stringify(it.text)} leaves=${JSON.stringify(it.leaves)} sel=${it.sel || '-'}`);
      for (const o of rec.overlay || []) if (o.role) console.log(`      [overlay ${o.role}] ${JSON.stringify(o.text)}`);
    }
  }

  // --target：“点开某个具体控件并 dump 它的弹层”——比 --dump 全枚举快得多，
  // 用于已知控件位置后做定点取证（如 kimi 的 #model-select-trigger）。
  for (let i = 0; i < TARGETS.length; i++) {
    const target = TARGETS[i];
    console.log(`\n>>> 定点点击 ${JSON.stringify(target)}`);
    const how = await clickTarget(target);
    if (!how) { console.log('  ✗ 未命中'); report.steps.push({ tag: `target#${i}:${target}`, error: 'not-found' }); continue; }
    await page.waitForTimeout(1600);
    const step = await sample(`target#${i}:${target} (${how})`);
    step.clicked = { target, how };
    step.appeared = [...step.near, ...step.overlay, ...(step.items || [])]
      .filter((n) => !baseKeys.has(n.tag + '|' + n.text + '|' + n.x + ',' + n.y));
    console.log(`  新出现 (${step.appeared.length}):`);
    for (const n of step.appeared) console.log('   + ' + fmt(n));
    for (const it of step.items || []) {
      console.log(`   item ${JSON.stringify(it.text)} sel=${it.sel || '-'}`);
      for (const c of it.children) console.log('      > [' + c.tag + '] ' + JSON.stringify(c.text) + ' cls=' + JSON.stringify(c.cls.slice(0, 60)));
      for (const c of it.children) for (const g of c.kids) console.log('        - [' + g.tag + '] ' + JSON.stringify(g.text) + ' cls=' + JSON.stringify(g.cls.slice(0, 50)));
    }
  }

  for (let i = 0; i < CLICKS.length; i++) {
    const target = CLICKS[i];
    console.log(`\n>>> 点击 ${JSON.stringify(target)}`);
    const how = await clickTarget(target);
    if (!how) { console.log('  ✗ 四种形态都没命中（CSS/testid/精确文本/包含文本）——目标不存在或不可见'); report.steps.push({ tag: `click#${i}:${target}`, error: 'not-found' }); continue; }
    await page.waitForTimeout(1600);
    const step = await sample(`click#${i}:${target} (${how})`);
    step.clicked = { target, how };
    step.appeared = [...step.near, ...step.overlay].filter((n) => !baseKeys.has(n.tag + '|' + n.text + '|' + n.x + ',' + n.y));
    console.log(`  新出现节点 (${step.appeared.length}):`);
    for (const n of step.appeared) console.log('   + ' + fmt(n));
    // 每个「新出现」节点的 outerHTML：判断控件由哪几段文本/徽章组成（模型名 vs 档位）
    for (const n of step.appeared.slice(0, 8)) {
      const html = await page.evaluate(([d]) => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const hit = [...document.querySelectorAll('div,button,li,span')].filter(vis).find((el) => {
          const r = el.getBoundingClientRect();
          return Math.round(r.x) === d.x && Math.round(r.y) === d.y && Math.round(r.width) === d.w
            && (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) === d.text;
        });
        return hit ? hit.outerHTML.slice(0, 900) : null;
      }, [n]).catch(() => null);
      if (html) { n.html = html; console.log('     html: ' + html.replace(/\s+/g, ' ').slice(0, 400)); }
    }
  }
} catch (err) {
  report.error = String(err?.stack || err?.message || err);
  console.error('✗ ' + report.error);
} finally {
  const outFile = path.join(OUT_DIR, `think-control-${siteId}-${TS}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('\n证据: ' + outFile);
  await browser.close().catch(() => {});
  if (!KEEP) { try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* 留着的代价只是磁盘 */ } }
}
