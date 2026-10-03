// probe-catalog-center.mjs — 真机量「站点目录居中」两种窗口高度下的行为（只读探针）。
//
// 为什么必须真机量：`.hwb-catalog` 的居中判据是**布局行为**（富余空间如何分配、
// 空间不足时顶部是否可滚动到达），静态读 CSS 文本只能验「写了哪几条声明」，
// 验不出渲染结果。这是本仓库记过的「断言横跨几十条规则 = 假绿」的同一类风险。
//
// 用户 2026-10-04 报的症状：「窗口够大就没问题，但是缩小窗口就能看到，顶部置顶了，
// 已经够大时候就已经是偏上了」。正确行为应当是：
//   · 容器高（富余空间足）⇒ 列表**垂直居中**（上下留白近似相等）；
//   · 容器矮（内容高于容器）⇒ 列表从顶部开始、**scrollTop 可下滚**、顶部不被裁死。
//
// 用法：node test-mock/probe-catalog-center.mjs
// 依赖：playwright-core（本机已随 profile 安装）。不联网、不开真站点、只画本地 DOM。
//
// 浏览器可执行文件走 `resolveBrowserExecutable()`（桥自己的解析器）而不是
// playwright 自带的那个：本机 `ms-playwright` 目录里没有 playwright 期望的
// `chromium_headless_shell-1243`，而桥能解析到本机真实 Chromium —— 与
// `probe-compare-layout.mjs` 同一条取法（那份探针已在本机真实跑过）。
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

// 与 client.cjs 里那条规则**逐字同源**（改源码时这里要一起改；探针的价值是量行为，
// 不是复刻真源——真源一致性由 test/client-render.test.mjs 的静态断言保证）。
const CSS = `
  html,body{margin:0;height:100%}
  .tabBody{flex-direction:column;min-width:0;height:100%;min-height:0;display:flex;overflow:hidden}
  .hwb-catalog{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:14px;min-height:100%;padding:0 clamp(8px,3vw,24px);color:inherit;overflow-y:auto}
  .hwb-catalog-list{display:flex;flex-direction:column;gap:8px;width:380px;max-width:100%;margin:auto}
  .card{box-sizing:border-box;height:56px;border-radius:24px;background:#eee;border:.5px solid #ccc;flex:none}
`;

const ROWS = 10;
const html = (h) => `<!doctype html><html><body style="height:${h}px">
  <div class="tabBody" id="host" style="height:${h}px">
    <div class="hwb-catalog" id="cat">
      <div class="hwb-catalog-list" id="list">
        ${Array.from({ length: ROWS }, (_, i) => `<div class="card">站点 ${i + 1}</div>`).join('')}
      </div>
    </div>
  </div></body></html>`;

const exe = resolveBrowserExecutable();
if (!exe || !exe.path) {
  console.error('找不到可用的浏览器可执行文件（resolveBrowserExecutable 无结果）');
  process.exit(1);
}
console.log('浏览器：' + exe.path);
const browser = await chromium.launch({ executablePath: exe.path, headless: true });
const page = await browser.newPage();
const results = [];

for (const h of [1200, 700, 420]) {
  await page.setViewportSize({ width: 420, height: h });
  await page.setContent(html(h));
  await page.addStyleTag({ content: CSS });
  const m = await page.evaluate(() => {
    const host = document.getElementById('host');
    const cat = document.getElementById('cat');
    const list = document.getElementById('list');
    const cr = cat.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    return {
      hostH: host.clientHeight,
      contentH: cat.scrollHeight,
      listTop: Math.round(lr.top - cr.top),
      listH: Math.round(lr.height),
      gapTop: Math.round(lr.top - cr.top),
      gapBottom: Math.round(cr.bottom - lr.bottom),
      scrollable: cat.scrollHeight > cat.clientHeight + 1,
      maxScroll: cat.scrollHeight - cat.clientHeight,
    };
  });
  results.push({ viewportH: h, ...m });
}

await browser.close();

// 判据①：容得下时上下留白近似相等（垂直居中）。
const roomy = results.find(r => r.viewportH === 1200);
const centered = Math.abs(roomy.gapTop - roomy.gapBottom) <= 2;

// 判据②：装不下时列表顶边不被推到容器外（gapTop >= 0），且能下滚。
const tight = results.find(r => r.viewportH === 420);
const topReachable = tight.gapTop >= 0;
const canScroll = tight.scrollable && tight.maxScroll > 0;

console.log('窗口高度  容器高  内容高  上留白  下留白  可滚  最大滚距');
for (const r of results) {
  console.log(
    String(r.viewportH).padStart(6),
    String(r.hostH).padStart(7),
    String(r.contentH).padStart(7),
    String(r.gapTop).padStart(7),
    String(r.gapBottom).padStart(7),
    String(r.scrollable).padStart(6),
    String(r.maxScroll).padStart(9),
  );
}
console.log('');
console.log((centered ? 'PASS' : 'FAIL') + ' 富余空间下垂直居中（上下留白差 ≤2px，实测 ' + Math.abs(roomy.gapTop - roomy.gapBottom) + 'px）');
console.log((topReachable ? 'PASS' : 'FAIL') + ' 空间不足时列表顶边未被推出容器（gapTop=' + tight.gapTop + '）');
console.log((canScroll ? 'PASS' : 'FAIL') + ' 空间不足时可下滚到达底部（maxScroll=' + tight.maxScroll + '）');

const ok = centered && topReachable && canScroll;
console.log('');
console.log(ok ? 'ALL PASS' : 'HAS FAILURE');
process.exit(ok ? 0 : 1);
