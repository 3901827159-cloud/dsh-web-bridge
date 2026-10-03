// probe-compare-layout.mjs — 并发会话面板的**真布局取证**（0.19.55 改写）。
//
// ## 为什么必须真开一次浏览器
//
// 列宽同步、整列平移、观察窗裁剪、左右按钮的位置 —— 这几件事全都要**真实布局引擎**
// 算过才算数。只做字符串断言等于只证明「我写了这串字」，证明不了「这串字真的命中」。
//
// ## 0.19.55 改了探针的**对象**，不是改了判据的松紧
//
// 旧版探针量的是「本插件复刻的官方 composer」（卡片 22px 圆角、34px 圆形发送按钮、
// 官方对话框座位让位）。**那些对象已经不存在了**：0.19.55 起每一列渲染的是**官方自己的
// 会话体**（官方 `conversation.content` factory），输入框/消息/模型选择都是官方那一份。
// 所以旧版那几条断言现在只会证明「一份不存在的代码」，按本仓库「用例与样式不留在已删
// 对象上」的规矩一并撤掉。
//
// 留下并继续钉的，是**我们这一层**（列怎么摆）：面板高度确定、页签形态、三列宽度同步、
// 观察窗裁剪与整列平移、左右按钮位置与层级、列体的滚动前提。
//
// ## 本探针**不**覆盖什么（如实写明，别当成没做）
//
//   · 列里那份**官方会话体**的观感（消息、思考块、composer）——那是官方渲染器的产物，
//     本探针不重放官方 CSS，因此不对它下任何结论；
//   · 与真机的差别：`dsh web` 的页面要**进程级 token**（`?token=…`，401 就是缺它），
//     而那个 token 只存在进程内存里 ⇒ 只能「用本插件 CSS + 等价 DOM」回放，
//     不能开真 GUI 页面（能开的话，本探针早就那么做了）。
//
// ## 为什么本探针不在 CI 里
//
// 它需要 Playwright + 一个真实浏览器可执行文件。本仓库的 CI 不装浏览器；本机沙箱里
// `spawn` 任何外部程序都是 `EPERM`（`doc/progress.md`「已知环境约束」），因此它
// **默认跑不了**，只在能起浏览器的机器上手动跑。跑不了时它不会假装通过——找不到
// 浏览器可执行文件就 exit 1 并说明原因。
//
// 用法：node test-mock/probe-compare-layout.mjs
// 退出码：0 = 全部成立；1 = 有断言不成立或起不了浏览器（打印实际读数）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

/**
 * 本插件里并发会话面板那一段 CSS（从 client.cjs 的字符串数组里取）。
 *
 * 抽取必须**当场自证**：锚点变了就抛错，空 CSS 会让下面所有样式判据变成「全错」——
 * 那种红指向的是探针自己，不指向产品（本仓库把这种红叫「空转」）。
 */
function concurrentCss() {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.cjs'), 'utf8');
  const start = src.indexOf('".hwb-concurrent-panel{');
  const end = src.indexOf('].join(\'\');', start);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('找不到并发会话面板的 CSS 段（锚点 `".hwb-concurrent-panel{` / `].join(\'\')` 已变，需同步本探针）');
  }
  const out = src.slice(start, end)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'))
    .map((l) => l.replace(/^"/, '').replace(/",?$/, '').replace(/\\"/g, '"'))
    .join('\n');
  for (const must of ['.hwb-concurrent-col{', '.hwb-concurrent-columns{', '.hwb-concurrent-pan{']) {
    if (!out.includes(must)) throw new Error('CSS 抽取结果里找不到关键规则（抽取逻辑已失效）：' + must);
  }
  return out;
}

/** 一列：面板 DOM 里我们负责的那一层（列头 + 列体；会话体由官方渲染器产生）。 */
const COL = (n) => `
  <div class="hwb-concurrent-col">
    <div class="hwb-concurrent-col-head">
      <span class="hwb-concurrent-col-title">会话 ${n}</span>
      <button type="button" class="hwb-concurrent-mini">✕</button>
    </div>
    <div class="hwb-concurrent-col-body">
      <div class="hwb-concurrent-body">第 ${n} 列（真会话体由官方渲染器插入此处）</div>
    </div>
  </div>`;

const html = `<!doctype html><html><head><meta charset="utf-8">
<style id="plugin-concurrent">${concurrentCss()}</style>
<style>html,body{margin:0;height:100%}</style>
</head><body>
<div class="hwb-concurrent-panel" style="height:100vh">
  <div class="hwb-concurrent-tabs" role="tablist">
    <button type="button" role="tab" class="hwb-concurrent-tab active" aria-selected="true">并发对话</button>
    <button type="button" role="tab" class="hwb-concurrent-tab" aria-selected="false">并发轨迹</button>
  </div>
  <div class="hwb-concurrent" style="--hwb-col-width:420px">
    <div class="hwb-concurrent-bar">
      <span class="hwb-concurrent-count">3 列</span>
      <button type="button" class="hwb-concurrent-action">+ 加一列</button>
    </div>
    <div class="hwb-concurrent-viewport">
      <button type="button" class="hwb-concurrent-pan left">‹</button>
      <button type="button" class="hwb-concurrent-pan right">›</button>
      <div class="hwb-concurrent-columns" data-cols="3" style="transform:translateX(-436px)">${COL(1)}${COL(2)}${COL(3)}</div>
    </div>
  </div>
</div>
</body></html>`;

const exe = resolveBrowserExecutable();
if (!exe?.path) {
  console.error('找不到可用浏览器（Playwright 需要真实可执行文件）；本探针不在 CI 里跑，请在能起浏览器的机器上手动执行。');
  process.exit(1);
}
const tmp = path.join(os.tmpdir(), `hwb-concurrent-layout-${process.pid}.html`);
fs.writeFileSync(tmp, html, 'utf8');

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : '  →  ' + detail}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch({ executablePath: exe.path, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('file://' + tmp.replace(/\\/g, '/'));
  const r = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const cs = (el) => getComputedStyle(el);
    const cols = [...document.querySelectorAll('.hwb-concurrent-col')];
    const panel = q('.hwb-concurrent-panel');
    const inner = q('.hwb-concurrent');
    const vp = q('.hwb-concurrent-viewport').getBoundingClientRect();
    const box = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    return {
      hasSupport: CSS.supports('selector(:has(*))'),
      panel: { display: cs(panel).display, flexDirection: cs(panel).flexDirection, h: box(panel).h },
      inner: { minHeight: cs(inner).minHeight, overflow: cs(inner).overflow, h: box(inner).h },
      tabs: [...document.querySelectorAll('.hwb-concurrent-tab')].map((t) => ({
        text: t.textContent, radius: cs(t).borderRadius, active: t.classList.contains('active'),
      })),
      viewport: { overflow: cs(q('.hwb-concurrent-viewport')).overflow, w: Math.round(vp.width) },
      colWidths: cols.map((c) => Math.round(c.getBoundingClientRect().width)),
      colWidthsUniq: [...new Set(cols.map((c) => Math.round(c.getBoundingClientRect().width)))],
      colStatic: { background: cs(cols[0]).backgroundColor, borderTopWidth: cs(cols[0]).borderTopWidth },
      colBody: { minHeight: cs(q('.hwb-concurrent-col-body')).minHeight, overflow: cs(q('.hwb-concurrent-col-body')).overflow },
      // 平移到第 2 列后：第 2 列的左边缘必须贴观察窗左端（用户要的整列对齐，不是半列）。
      panAligned: Math.round(cols[1].getBoundingClientRect().left - vp.left),
      panButtons: [...document.querySelectorAll('.hwb-concurrent-pan')].map((b) => {
        const bb = b.getBoundingClientRect();
        return {
          cls: b.className,
          radius: cs(b).borderRadius,
          offsetFromEdge: b.className.includes('left') ? Math.round(bb.left - vp.left) : Math.round(vp.right - bb.right),
          vCenterDelta: Math.round((bb.top + bb.height / 2) - (vp.top + vp.height / 2)),
          zIndex: cs(b).zIndex,
        };
      }),
    };
  });

  check('浏览器支持 :has()（官方 CSS 与本插件都依赖它）', r.hasSupport === true);
  check('面板是纵向 flex 列，占满容器高度', r.panel.display === 'flex' && r.panel.flexDirection === 'column',
    JSON.stringify(r.panel));
  check('面板正文有确定的剩余高度（min-height:0 + overflow:hidden）',
    r.inner.minHeight === '0px' && r.inner.overflow === 'hidden', JSON.stringify(r.inner));
  check('页签是「并发对话 / 并发轨迹」两个，且选中态是浅色胶囊（不画下划线）',
    r.tabs.length === 2 && r.tabs[0].text === '并发对话' && r.tabs[1].text === '并发轨迹'
    && r.tabs.every((t) => t.radius === '999px') && r.tabs[0].active && !r.tabs[1].active,
    JSON.stringify(r.tabs));
  check('★ 三列宽度逐字相同（用户要的「3 个会话宽度同步」）',
    r.colWidthsUniq.length === 1, '实测宽度集合=' + JSON.stringify(r.colWidthsUniq));
  check('★ 列宽真的吃到了 --hwb-col-width（固定宽，不是 grid 等分）',
    r.colWidthsUniq[0] === 420, '实测=' + r.colWidthsUniq[0] + ' 期望=420');
  check('观察窗裁掉溢出的列（overflow:hidden —— 切换视角的前提）',
    r.viewport.overflow === 'hidden', r.viewport.overflow);
  check('★ 平移后第 2 列**左边缘贴观察窗左端**（用户要的整列对齐，不是半列）',
    r.panAligned === 0, '第2列左缘距观察窗左端=' + r.panAligned + 'px');
  check('★ 列平时无底色、无边框（用户要的「去除分界」，光只在 hover 时浮起）',
    r.colStatic.borderTopWidth === '0px', JSON.stringify(r.colStatic));
  check('列体有滚动前提（min-height:0 + overflow:hidden）',
    r.colBody.minHeight === '0px' && r.colBody.overflow === 'hidden', JSON.stringify(r.colBody));
  check('左右按钮都渲染在观察窗边缘内侧',
    r.panButtons.length === 2 && r.panButtons.every((b) => b.offsetFromEdge <= 8),
    JSON.stringify(r.panButtons.map((b) => b.offsetFromEdge)));
  check('★ 左右按钮垂直居中（用户要的「垂直居中」）',
    r.panButtons.every((b) => b.vCenterDelta === 0), JSON.stringify(r.panButtons.map((b) => b.vCenterDelta)));
  check('左右按钮浮在列体之上可点（z-index:11，与官方 DragHandle 同层）',
    r.panButtons.every((b) => b.zIndex === '11'), JSON.stringify(r.panButtons.map((b) => b.zIndex)));
  console.log('读数：', JSON.stringify(r, null, 1));
} finally {
  await browser.close();
  fs.rmSync(tmp, { force: true });
}
console.log(failed === 0 ? '✓ 布局取证通过' : `✗ 布局取证失败：${failed} 条`);
process.exit(failed === 0 ? 0 : 1);
