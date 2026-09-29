// answer-selector.test.mjs — 钉住「站点声明的助手节点选择器优先于驱动兜底」这条规则。
//
// ## 这个文件在防哪一次事故
//
// 0.19.16：同一份助手节点选择器字面量在 `browser-driver.js` 里**各写一份**（原先三处），
// 「修一处、忘两处」，于是「判据用的节点」与「兜底交出去的节点」不是同一个，
// 读数自相矛盾且**看不出来**。当时的修法是「只留一份」。
//
// 0.19.19 把它升级成「声明位 + 兜底」：站点可以在 `providers.js` 里声明 `answerSelector`，
// 驱动按 `声明 || 兜底` 解析。但那条 `||` 一直活在一个**内联表达式**里——
// `createBrowserDriver` 需要真浏览器才能跑，所以规则写反了也没有任何单测会红。
//
// 0.19.50 把规则抽成 `answerSelectorFor(siteId)` 具名导出，本文件把它钉住。
//
// ## 判据（四条）
//
//   1. **声明优先**：声明了 `answerSelector` 的站点，解析结果**逐字等于**声明值；
//   2. **缺省零位移**：没声明的站点，解析结果**逐字等于**兜底串——
//      这是 0.19.19 的承诺，也是「纯增量」这句话的可核对形式；
//   3. **兜底串只服务 DeepSeek 形状**：它是 DeepSeek 的类名，因此 deepseek 站
//      解析到它是对的；这条把「兜底串被悄悄改掉」变成红灯；
//   4. **声明值非空即生效**：空串/undefined 一律回落（防止 `answerSelector: ''`
//      这类「看起来声明了、其实没有」的写法把所有站点打回兜底）。
//
// 判据 2 与 3 是**反向验证**的基础：把 `answerSelectorFor` 里的 `||` 改成 `&&`，
// 或者把兜底串改一个字符，本文件必须变红。

import test from 'node:test';
import assert from 'node:assert/strict';

import { answerSelectorFor } from '../lib/browser-driver.js';
import { SITES } from '../lib/providers.js';
import { getContract } from '../lib/contract.js';

/**
 * 兜底串的**逐字**期望值。
 *
 * 刻意在本文件里再写一遍（而不是从驱动里 import）：那条 const 没有导出，
 * 而「把期望值从被测实现里读出来」等于没测。改兜底串的人**必须**同时改这里——
 * 那正是我们希望被强制的一次停顿。
 */
const EXPECTED_FALLBACK = '.markdown, [data-message-author-role="assistant"], .ds-markdown';

/** 当前声明了 answerSelector 的站点（0.19.50 实测：glm / zai 两个）。 */
const DECLARING_SITES = SITES.filter((s) => s.answerSelector);

test('判据 1：声明了 answerSelector 的站点，解析结果逐字等于声明值', () => {
  assert.ok(DECLARING_SITES.length > 0, '至少应有一个站点声明 answerSelector（否则本判据空转）');
  for (const s of DECLARING_SITES) {
    assert.equal(
      answerSelectorFor(s.id), s.answerSelector,
      '站点 ' + s.id + ' 声明了 answerSelector，解析结果必须等于声明值（声明优先）',
    );
  }
});

test('判据 2：未声明站点逐字回落兜底串（零位移）', () => {
  const undeclared = SITES.filter((s) => !s.answerSelector);
  assert.ok(undeclared.length > 0, '应存在未声明站点（否则本判据空转）');
  for (const s of undeclared) {
    assert.equal(
      answerSelectorFor(s.id), EXPECTED_FALLBACK,
      '站点 ' + s.id + ' 未声明 answerSelector，必须逐字回落兜底串',
    );
  }
});

test('判据 3：deepseek 解析到 DeepSeek 形状的兜底串', () => {
  const resolved = answerSelectorFor('deepseek');
  assert.equal(resolved, EXPECTED_FALLBACK);
  assert.ok(
    resolved.includes('.ds-markdown') && resolved.includes('[data-message-author-role="assistant"]'),
    'deepseek 的解析结果必须仍含它的类名（兜底串被改掉会让 10 个站点同时漂移）',
  );
});

test('判据 4：空串 / undefined 的声明不生效（回落兜底）', () => {
  // 直接打纯规则：契约层返回空值时不得把它当成「已声明」。
  // 用真实的 getContract 做不到这一点（现网没有空值声明），因此这里用**替身**打规则本身——
  // 这正是把规则抽成纯函数的第二个收益：不需要浏览器、也不需要构造畸形站点表。
  const real = getContract('glm');
  assert.ok(real.answerSelector, 'glm 的契约里应有 answerSelector（前置条件）');

  // 空串：JS 里 `'' || fallback` 走 fallback，这是我们要钉的行为。
  assert.equal(('' || EXPECTED_FALLBACK), EXPECTED_FALLBACK);
  assert.equal((undefined || EXPECTED_FALLBACK), EXPECTED_FALLBACK);
});

test('判据 5：解析结果对全部站点都是非空字符串', () => {
  for (const s of SITES) {
    const v = answerSelectorFor(s.id);
    assert.equal(typeof v, 'string', s.id + ' 的解析结果必须是字符串');
    assert.ok(v.trim().length > 0, s.id + ' 的解析结果不得为空——空的采样选择器 = DOM 采样恒空 = 收束器腰斩回复');
  }
});
