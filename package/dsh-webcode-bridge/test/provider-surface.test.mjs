// provider-surface.test.mjs — 钉住「对外的 provider / 模型目录面」逐字不变。
//
// ## 这个文件在防什么
//
// 0.19.50 起本项目要把散落的「站点知识」收成 `lib/sites/<siteId>.js`（每站点一个文件、
// 导出同一形状的对象），**逐站点迁移、DeepSeek 先行**。这类重构最危险的不是写错新代码，
// 而是**在搬家的过程中悄悄改变了对外可观测的形状**——比如少了一个 provider、
// 模型 id 变了一个字符、分组名多了一个前缀。它们都不会让任何现有单测变红，
// 却会让**历史设置值、旧会话、OpenAI 前端**同时失配。
//
// 因此本文件先于迁移存在（test-first）：它把「迁移前的对外面」逐字记下来，
// 之后每一次搬家都必须证明自己没有动它。
//
// ## 判据
//
//   1. **站点表**：id 列表与顺序逐字不变（顺序即 /models 列表顺序）；
//   2. **provider id 表**：`providerIdsForRegistration()` 逐字不变（含兼容空壳 `webcode`）；
//   3. **模型目录**：`listAllModels()` 的 (provider, id) 对逐字不变；
//   4. **分组名**：每站点的分组名逐字不变（GLM → `chatglm` 这条覆盖不能被吞掉）；
//   5. **可逆**：`siteIdForProvider(providerIdForSite(s)) === s` 对全部站点成立。
//
// ⚠ **改这些期望值时必须停下来问一句「这是有意的对外变更吗」**——
// 本文件的全部价值就在于改它需要一次停顿。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SITES, providerIdsForRegistration, providerIdForSite, siteIdForProvider,
  providerGroupName, listAllModels,
} from '../lib/providers.js';

/** 站点 id 与顺序（顺序即 OpenAI /models 的列表顺序）。 */
const EXPECTED_SITE_IDS = [
  'deepseek', 'glm', 'chatgpt', 'kimi', 'qwen', 'doubao', 'grok', 'claude', 'gemini', 'zai',
];

/**
 * 注册的 provider id。**11 个**：十个站点各一个 + 一个兼容空壳 `webcode`。
 *
 * 空壳必须存在：旧设置值（默认模型、20 条子代理白名单）里存的是 `provider: webcode`，
 * 而 DSH 每次发消息前会校验存储的 provider 是否仍被服务——缺了它，旧会话一律
 * `session/model-unavailable`。它的 `listModels` 返回空数组，所以选择器里不显示成空组。
 */
const EXPECTED_PROVIDER_IDS = [
  'webcode',
  'webcode-deepseek', 'webcode-glm', 'webcode-chatgpt', 'webcode-kimi', 'webcode-qwen',
  'webcode-doubao', 'webcode-grok', 'webcode-claude', 'webcode-gemini', 'webcode-zai',
];

/**
 * 每站点的分组名。
 *
 * `glm → chatglm` 是 `PROVIDER_GROUP_NAME_OVERRIDES` 给出的覆盖，**不能被吞掉**：
 * GLM 的 `shortKey` 故意没改成 `chatglm`（它同时被 `modelDisplayName` 用，
 * 改了会变成 `glmglm-5.3`），组名因此必须走覆盖表。
 *
 * 组名带 `webcode-` 前缀（0.19.43）：`MODEL_PROVIDER_COMPAT_ID + '-' + 短键`。
 */
const EXPECTED_GROUP_NAMES = {
  deepseek: 'webcode-deepseek', glm: 'webcode-chatglm', chatgpt: 'webcode-chatgpt',
  kimi: 'webcode-kimi', qwen: 'webcode-qwen', doubao: 'webcode-doubao',
  grok: 'webcode-grok', claude: 'webcode-claude', gemini: 'webcode-gemini', zai: 'webcode-z.ai',
};

test('判据 1：站点 id 与顺序逐字不变', () => {
  assert.deepEqual(SITES.map((s) => s.id), EXPECTED_SITE_IDS);
});

test('判据 2：注册的 provider id 逐字不变（含兼容空壳）', () => {
  assert.deepEqual(providerIdsForRegistration(), EXPECTED_PROVIDER_IDS);
  assert.ok(
    providerIdsForRegistration().includes('webcode'),
    '兼容空壳 `webcode` 必须仍在注册表里——缺了它旧会话一律 session/model-unavailable',
  );
});

test('判据 3：分组名逐字不变（GLM 的 chatglm 覆盖不能被吞掉）', () => {
  const got = {};
  for (const s of SITES) got[s.id] = providerGroupName(s.id);
  assert.deepEqual(got, EXPECTED_GROUP_NAMES);
});

test('判据 4：provider id ↔ siteId 可逆', () => {
  for (const s of SITES) {
    assert.equal(siteIdForProvider(providerIdForSite(s.id)), s.id,
      '站点 ' + s.id + ' 的 provider id 必须能解析回它自己');
  }
  // 空壳不是任何站点，必须解析不出来（或解析成 null），不能凭空造一个站点。
  assert.ok(!EXPECTED_SITE_IDS.includes(siteIdForProvider('webcode')),
    '兼容空壳 webcode 不得被解析成某个站点');
});

test('判据 5：模型目录非空，且每行都带得出站点与 id', () => {
  const models = listAllModels();
  assert.ok(Array.isArray(models), 'listAllModels 返回数组');
  assert.ok(models.length > 0, '模型目录不得为空');
  for (const m of models) {
    assert.equal(typeof m.id, 'string', '模型行的 id 必须是字符串');
    assert.ok(m.id.length > 0, '模型行的 id 不得为空');
    assert.ok(EXPECTED_SITE_IDS.includes(m.siteId), `模型行 ${m.id} 的 siteId 必须是已知站点`);
  }
});

test('判据 6：模型目录的形状快照（防「少了一行」这类静默缩水）', () => {
  const models = listAllModels();
  // 17 行是 0.19.50 迁移前的实测读数（10 站点各 1 + glm/zai 的多模型 + 1 条兼容别名）。
  // 这是**对外面**的一部分：少一行意味着某个模型从选择器里消失。
  assert.equal(models.length, 17,
    '模型目录共 17 行（迁移前实测）。实际：' + models.length + ' 行 —— 若这是有意的变更，请同时更新本期望值并说明理由');
  // 兼容别名必须仍在（历史会话与 OpenAI 前端的 `model: 'deepseek-web'` 依赖它）。
  assert.ok(models.some((m) => m.id === 'deepseek-web'),
    '兼容别名 `deepseek-web` 必须仍在目录里——历史设置值与 OpenAI 前端依赖它解析');
});
