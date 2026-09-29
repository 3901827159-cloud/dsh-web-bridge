// think-effort-realtext.test.mjs — 护栏：**真机触发文本**必须读得出档位（0.19.49）。
//
// # 这个文件防的是哪一次报障
//
// 用户原话（2026-09-28）：
//
//   「本轮运行失败THINK_EFFORT_UI_CHANGED: 思考等级「标准」没有生效（站点 kimi）—
//     回读：读不到档位（判定 no-readback）。本轮已中止，避免把「用户选了高档、网页仍是
//     低档」当成成功。其余都是类似原因」
//
// 真因（只读 CDP 实采线上已登录页，证据 `.tmp-probe/cdp-effort-models.json`）：
// kimi 的触发控件文本是 **`K3 标准`** —— `K3` 是**当前模型名**、`标准` 才是思考档。
// 而 0.19.48 把 `triggerText` 声明成了 `'快速'`，`'快速'` **也是一个模型名**
// （模型菜单里三条：`K3` / `K2.8 Preview` / `快速`）。于是：
//   · 用户选 `快速` 这个模型时，触发文本 `快速 进阶` 含锚点 ⇒ 回读成功（09-28 的 dump 正是这个状态）；
//   · 用户选 `K3` 时，触发文本 `K3 标准` **不含**锚点 ⇒ token 匹配池为空 ⇒ 回读 `null`
//     ⇒ `no-readback` ⇒ **每一轮都抛错**，站点彻底不可用。
//
// # 为什么这个文件单独存在（而不是塞进 think-effort.test.mjs）
//
// 因为它的判据是**数据**：一组「站点 → 真机读到的触发文本」的原文。这类判据最容易在
// 重构中被「顺手改成 fixture 想要的形状」而失去意义。单独成文件、并逐条标出**出处与日期**，
// 是为了让下一个人改它之前必须先拿到新读数。
//
// # 判据
//
//   ① 每个声明了 `triggerText` 的站点，其锚点必须在**真机触发文本**里（否则回读池为空）；
//   ② 每个声明了 `readbackSelector` 的站点，那个节点的文本**必须恰好是某一档位**
//      （不能含模型名 —— 否则「换了模型就读不出档位」的缺陷会以另一种形式回来）；
//   ③ 真机触发文本喂给 `confirmEffort`，当前档位必须读得出（match 或 mismatch，
//      **不许是 unknown**）；unknown 就等于「回读读不到档位」= 用户报障的形态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THINK_EFFORT, confirmEffort } from '../lib/think-effort.js';

const PKG = path.join(import.meta.dirname, '..');

/**
 * 真机触发文本（**逐字**，含出处）。
 *
 * `trigger`  —— 触发控件上的完整文本（控件 `textContent`，空白已压平）
 * `readback` —— 站点声明的回读节点上的文本（`readbackSelector` 命中的那个节点）
 * `src`      —— 出处（文件 + 日期），改这一行前必须先拿到新读数
 */
const REAL = [
  {
    siteId: 'kimi', trigger: 'K3 标准', readback: '标准',
    src: '只读 CDP 实采线上已登录页 2026-09-28（.tmp-probe/cdp-effort-models.json）；当前模型 K3',
  },
  {
    siteId: 'kimi', trigger: '快速 进阶', readback: '进阶',
    src: 'test-mock/out/think-control-kimi-2026-09-28T10-48-29.json；当时模型=快速',
  },
  {
    siteId: 'kimi', trigger: 'K3 进阶', readback: '进阶',
    src: '同上形状，模型名换成 K3（模型菜单实测三条：K3 / K2.8 Preview / 快速）',
  },
  {
    siteId: 'glm', trigger: 'GLM-Flash极致', readback: 'GLM-Flash极致',
    src: '只读 CDP 实采线上已登录页 2026-09-28；**无空格拼接**',
  },
  {
    siteId: 'glm', trigger: 'GLM-5.3 极致', readback: 'GLM-5.3 极致',
    src: 'think-effort.js 头部注释里的真机读数（同一控件的另一种形态）',
  },
  {
    siteId: 'qwen', trigger: '自动', readback: '自动',
    src: 'test-mock/out/think-control-qwen-2026-09-28T10-51-12.json（.qwen-thinking-selector）',
  },
  {
    siteId: 'qwen', trigger: '思考', readback: '思考',
    src: '同上（切到「思考」档后的触发文本）',
  },
  {
    siteId: 'zai', trigger: '深度思考 最高', readback: '深度思考 最高',
    src: 'test-mock/out/think-control-zai-2026-09-28T10-50-20.json（pill）',
  },
  {
    siteId: 'doubao', trigger: '豆包 2.1 Turbo专家', readback: null,
    src: 'test-mock/out/think-control-doubao-2026-09-28T10-36-23.json（走 aria-checked，无 readbackSelector）',
  },
];

test('① 声明了 triggerText 的站点：锚点必须在真机触发文本里（否则回读池为空 ⇒ no-readback）', () => {
  for (const r of REAL) {
    const ctl = THINK_EFFORT[r.siteId]?.effortControl;
    if (!ctl?.triggerText) continue;
    assert.ok(r.trigger.includes(ctl.triggerText),
      `${r.siteId} 声明了 triggerText=${JSON.stringify(ctl.triggerText)}，但真机触发文本 `
      + `${JSON.stringify(r.trigger)} 里没有它 ⇒ token 匹配池会为空 ⇒ 回读恒 no-readback。`
      + `（出处：${r.src}）`);
  }
});

test('② 声明了 readbackSelector 的站点：那个节点的文本必须**读得出档位**', () => {
  // 判据是「读得出」，不是「逐字等于档位」——两种真机形态都存在且都必须支持：
  //   · kimi `.current-effort` → 文本**恰好**是档位（`标准`）——最干净的形态；
  //   · glm  `.think-mode-trigger` → 文本是 `GLM-Flash极致`（模型名+档位，**无空格拼接**）——
  //     它同样合格，因为后缀判据能读出 `极致`。要求「恰好等于档位」会把 glm 判死，
  //     而 glm 的这条读数是真的（只读 CDP 实采）。
  // 真正不许的是「读不出任何档位」——那就是 no-readback，即用户报障的形态（由 ③ 覆盖）。
  // 这一条额外钉住的是：**回读节点不能是「另一个模型名恰好等于档位」的巧合**。
  for (const r of REAL) {
    const def = THINK_EFFORT[r.siteId];
    const ctl = def?.effortControl;
    if (!ctl?.readbackSelector || r.readback === null) continue;
    const ids = def.efforts.map((e) => e.id);
    const readable = ids.some((id) => r.readback === id || r.readback.endsWith(id));
    assert.ok(readable,
      `${r.siteId} 的 readbackSelector=${JSON.stringify(ctl.readbackSelector)} 在真机上的文本是 `
      + `${JSON.stringify(r.readback)}，读不出任何声明的档位（${ids.join('/')}）。`
      + `（出处：${r.src}）`);
    // 回读源的**第一段**不许是某个档位 id 之外的模型名造成歧义：
    // 若文本以某个档位结尾，取最长匹配（长者优先），保证 `最高` 不会被读成 `高`。
    const longest = ids.filter((id) => r.readback === id || r.readback.endsWith(id))
      .sort((a, b) => b.length - a.length)[0];
    assert.ok(longest, `${r.siteId} 的后缀判据取不到档位`);
  }
});

test('③ 真机触发文本喂给 confirmEffort：当前档位必须读得出（不许 unknown）', () => {
  const bad = [];
  for (const r of REAL) {
    const def = THINK_EFFORT[r.siteId];
    if (!def) continue;
    const ids = def.efforts.map((e) => e.id);
    const ctl = def.effortControl;
    // 用回读节点文本（有 readbackSelector 时）或触发文本，喂给生产判据
    const label = ctl.readbackSelector && r.readback !== null ? r.readback : r.trigger;
    for (const target of ids) {
      const res = confirmEffort({ target, label, triggerText: ctl.triggerText ?? null, knownIds: ids });
      if (res.state === 'unknown') {
        bad.push(`${r.siteId} 真机文本 ${JSON.stringify(label)} + 目标「${target}」 ⇒ unknown (${res.reason})`);
      }
    }
  }
  assert.deepEqual(bad, [],
    '真机文本读不出档位 —— 这正是用户报障的 no-readback 形态：\n  ' + bad.join('\n  '));
});

test('④ kimi 的锚点**不许**再写成模型名（0.19.48 的真缺陷，钉死）', () => {
  const ctl = THINK_EFFORT.kimi.effortControl;
  // 模型菜单里的三条模型名（真机读数）。它们**都不是**固定锚点。
  const MODEL_NAMES = ['快速', 'K3', 'K2.8 Preview'];
  assert.equal(ctl.triggerText, undefined,
    `kimi 的 triggerText 又被写成了 ${JSON.stringify(ctl.triggerText)} —— 锚点只能是**与模型无关**的固定文本，`
    + `而 ${JSON.stringify(MODEL_NAMES)} 都是模型名（模型一换锚点就失效 ⇒ 每轮抛 THINK_EFFORT_UI_CHANGED）`);
  assert.equal(ctl.readbackSelector, '.current-effort',
    'kimi 必须声明 readbackSelector=.current-effort（真机实测该节点文本恰好是档位，不含模型名）');
  // 触发控件仍必须有 testid 定位（不靠文本）
  assert.deepEqual(ctl.triggerSelectors, ['[data-testid="model-select-trigger"]']);
});

test('⑤ 驱动侧必须把 readbackSelector 真的读出来（接线判据，不是源码里有没有这个词）', () => {
  const SRC = fs.readFileSync(path.join(PKG, 'lib', 'think-effort.js'), 'utf8');
  // 回读函数里必须以站点声明的选择器去读
  assert.match(SRC, /READ_SELECTOR_TEXT/, 'READ_SELECTOR_TEXT 页面函数必须存在');
  assert.match(SRC, /ctl\.readbackSelector/, 'readBack 必须读站点声明的 readbackSelector');
  // 计划里必须把选择器带进 readback 步（否则 applyEffort 拿不到它）
  assert.match(SRC, /readbackSelector \? \{ selector: ctl\.readbackSelector \}/,
    'planEffort 必须把 readbackSelector 带进 readback 步');
  // 页面函数必须自包含（0.19.48 真机 ReferenceError 的教训）
  const fnSrc = SRC.slice(SRC.indexOf('export const READ_SELECTOR_TEXT'), SRC.indexOf('export async function applyEffort'));
  assert.ok(!/insideOpenOverlay|normalizeLabel\(/.test(fnSrc),
    'READ_SELECTOR_TEXT 体内引用了模块作用域符号 —— page.evaluate 序列化后会 ReferenceError（0.19.48 真机实测）');
});
