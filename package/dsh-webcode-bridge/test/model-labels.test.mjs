// model-labels.test.mjs — 模型显示名必须是「站点短键/模型 id」（0.14.0）。
//
// 为什么需要这个护栏：DSH 的模型选择器**只渲染 model.name**，不拼 provider
// （dsh-client-ui-model-selection 的 option 渲染只读 model.name）。
//
// 2026-09-28 更新：分组标题来自 providerInfo(provider).name，而它**不再**是整包
// 共用的「Harness Web Bridge」——模型目录已按站点拆成多个 provider，每组标题
// 取站点短键/域（chatglm / deepseek / z.ai …）。本文件末尾那三条测试钉住拆分
// 本身：组名、组内裸名、以及旧 provider 兼容空壳仍然可解析。
// 旧目录里 8 个站点都叫 `auto`、GLM 有两个站点都叫 `glm-5.3`，选择器上根本
// 分不出这一行是哪个网站——用户的原话就是「不能只有模型名不知道哪个网站的」。
//
// 本文件同时钉住两件容易一起改坏的事：
//   ① 显示名与 id 必须一一对应（`z.ai/glm-5.3` ↔ `zai:glm-5.3`），
//      否则 UI 上选的和实际路由到的不是同一个东西；
//   ② 带站点前缀的名字**绝不能**回流到网页（model-picker 的目标名必须仍是
//      网页上的原始名字）——网页上永远不会出现 `z.ai/` 这个前缀。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITES, listAllModels, resolveWebModel, MODEL_ALIAS_IDS, MODEL_PROVIDER_COMPAT_ID, providerIdForSite, siteIdForProvider, providerGroupName, providerIdsForRegistration } from '../lib/providers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.resolve(here, '..', p), 'utf8');

/** 兼容别名条目：与 deepseek:deepseek 指向同一个模型，故意同名同形。
 *  集合来自 providers 的唯一定义处——这里**不再**本地写一份字面量（两处定义
 *  必然漂移，而漂移的后果是别名条目要么漏过滤、要么被误删）。 */
const ALIAS_IDS = MODEL_ALIAS_IDS;

test('每个模型名都是「站点短键/模型 id」，且与 id 一一对应', () => {
  const all = listAllModels();
  assert.ok(all.length >= 10, '目录不应为空');
  for (const m of all) {
    // 形态：小写站点键 + '/' + 模型 id（模型 id 本身可含点/连字符）
    assert.match(m.name, /^[a-z0-9.-]+\/[a-z0-9.-]+$/, `${m.id} 名字不是「站点/模型」形态: ${m.name}`);
    const [key, modelPart] = m.name.split('/');
    // 别名条目没有 ':'（它是不带站点前缀的历史 id），名字仍指向同一个模型。
    const wantModel = ALIAS_IDS.has(m.id) ? 'deepseek' : m.id.split(':')[1];
    assert.equal(modelPart, wantModel, `${m.id} 的名字后段必须逐字等于模型 id: ${m.name}`);
    // 站点键默认等于站点 id；zai 是唯一例外（真实身份是 z.ai 这个域名）。
    const st = SITES.find((s) => s.id === m.siteId);
    assert.equal(key, st.shortKey || st.id, `${m.id} 的站点键不对: ${m.name}`);
  }
});

test('DeepSeek 只有一个模型，显示名就是 deepseek/deepseek', () => {
  const all = listAllModels();
  const ds = all.filter((m) => m.siteId === 'deepseek');
  // deepseek-web 是兼容别名条目，与 deepseek:deepseek 指向同一个模型。
  assert.deepEqual(ds.map((m) => m.id).sort(), ['deepseek-web', 'deepseek:deepseek']);
  assert.equal(all.find((m) => m.id === 'deepseek:deepseek').name, 'deepseek/deepseek');
  assert.equal(all.find((m) => m.id === 'deepseek-web').name, 'deepseek/deepseek');
});

test('显示名全局唯一（选择器上不可能出现两行同名）', () => {
  const seen = new Map();
  for (const m of listAllModels()) {
    if (ALIAS_IDS.has(m.id)) continue;   // 兼容别名与本体同形，是设计如此
    assert.ok(!seen.has(m.name), `${m.id} 与 ${seen.get(m.name)} 同名: ${m.name}`);
    seen.set(m.name, m.id);
  }
});

test('每个显示名都能被 resolveWebModel 解析回同一个模型（显示名不是死文字）', () => {
  for (const m of listAllModels()) {
    const r = resolveWebModel(m.id);
    assert.equal(r.siteId, m.siteId, m.id + ' 解析出的站点不对');
    // 带站点短键的显示名**不得**作为 id 反查（它不是 id，只是标签）
    assert.equal(r.name, m.name, m.id + ' 解析回来的显示名应一致');
    // 兼容别名条目（deepseek-web）没有 ':'，它指向 DeepSeek 的唯一模型。
    const modelPart = m.id.includes(':') ? m.id.split(':')[1] : 'deepseek';
    assert.equal(r.id, modelPart, m.id + ' 解析出的模型 id 不对');
  }
});

test('网页侧目标名（webName / labels）永远不含站点前缀', () => {
  // 这是 model-picker 的成败线：网页上只认 GLM-5.3 / GLM-Flash / K3 这些名字，
  // 拿 `z.ai/glm-5.3` 去比对必然 option-not-in-list。
  for (const st of SITES) {
    for (const m of st.models) {
      if (m.labels) for (const l of m.labels) assert.ok(!l.includes('/'), `${st.id}:${m.id} 的 label 含 '/'：${l}`);
    }
  }
  for (const id of ['zai:glm-5.3', 'glm:glm-5.3', 'kimi:k3', 'doubao:chat']) {
    const r = resolveWebModel(id);
    assert.ok(r.webName && !r.webName.includes('/'), id + ' 缺少干净的 webName');
    assert.notEqual(r.name, r.webName, id + ' 的显示名与网页名不应该相同（那说明站点前缀丢了）');
  }
});

test('别名 deepseek-web 仍可解析，但不作为选择器里的第二行', () => {
  // 别名的存在意义是「历史值仍可解析」：旧会话、旧设置的 agent-default-model、
  // 以及 OpenAI 前端的 model:'deepseek-web' 都依赖它。
  assert.equal(resolveWebModel('deepseek-web').id, 'deepseek');
  // 但它与 deepseek:deepseek 显示名逐字相同 → 下拉里必须过滤掉（否则两行同名）。
  const alias = listAllModels().find((m) => m.id === 'deepseek-web');
  const primary = listAllModels().find((m) => m.id === 'deepseek:deepseek');
  assert.equal(alias.name, primary.name, '别名与本体同名是过滤的前提，不是 bug');
  assert.ok(ALIAS_IDS.has('deepseek-web'), 'MODEL_ALIAS_IDS 必须包含 deepseek-web');
});

test('选择器去重落在三处，且前端字面量与 providers 集合一致', () => {
  // 后端适配器：listModels 必须过滤别名。
  const indexSrc = read('lib/index.js');
  assert.match(indexSrc, /MODEL_ALIAS_IDS\.has\(m\.id\)/,
    'lib/index.js 的 listModels 必须用 MODEL_ALIAS_IDS 过滤别名');
  // 前端（浏览器侧 bundle）：无法 import providers，只能重复一份字面量——
  // 这里把它与 providers 的集合**钉在一起**，任何一边改了另一边没改就失败。
  const clientSrc = read('lib/client.cjs');
  const m = /const aliasIds = new Set\(\[([^\]]*)\]\)/.exec(clientSrc);
  assert.ok(m, 'lib/client.cjs 的 ModelSelect 必须有 aliasIds 过滤（否则下拉出现重复行）');
  const frontendIds = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepEqual(new Set(frontendIds), new Set([...ALIAS_IDS]),
    '前端别名字面量与 providers.MODEL_ALIAS_IDS 必须一致: ' + frontendIds.join(','));
});

test('z.ai 的显示名用域名短键，内部路由 id 不变（历史设置值仍解析）', () => {
  assert.equal(resolveWebModel('zai:glm-5.3').name, 'z.ai/glm-5.3');
  // 别名与历史写法全部仍解析到同一个模型（内部 id 不变）
  for (const alias of ['z.ai-glm5.3', 'zai-glm-5.3', 'glm-zai-5.3']) {
    const r = resolveWebModel(alias);
    assert.equal(r.siteId, 'zai', alias + ' 必须解析到 zai（内部 id 不变）');
    assert.equal(r.id, 'glm-5.3', alias + ' 必须解析到 glm-5.3');
  }
  // glm-4.x 是**国内站点**的历史写法，收敛到 chatglm.cn 而不是 z.ai
  assert.equal(resolveWebModel('glm-4.6').siteId, 'glm');
  assert.equal(resolveWebModel('glm-4.6').name, 'glm/glm-5.3');
});

// ---------------------------------------------------------------------------
// 分组（2026-09-28）：模型选择器「一个网站一层」
//
// DSH 侧机制（实读 dsh-api-session-controller 的 buildModelCatalog）：
//   一个 provider = 一组；组标题取 providerInfo(provider).name；组 id 必须逐字
//   等于 provider id；且 `group.models.length > 0` 的组才会出现在目录里。
// 因此本文件的判据就是那三条的直接推论。
// ---------------------------------------------------------------------------

/** 期望的组名（2026-09-28 用户指定：站点短键/域）。手写对照表，见下方断言注释。 */
const EXPECTED_GROUP_NAMES = Object.freeze({
  deepseek: 'deepseek',
  glm: 'chatglm',          // 站点 id 是 glm，但真实域名是 chatglm.cn
  chatgpt: 'chatgpt',
  kimi: 'kimi',
  qwen: 'qwen',
  doubao: 'doubao',
  grok: 'grok',
  claude: 'claude',
  zai: 'z.ai',             // 短键即真实域名
  gemini: 'gemini',
});

test('注册表里每个站点各占一个 provider，且组名是站点短键/域', () => {
  const ids = providerIdsForRegistration();
  // 兼容空壳必须在，且必须**只有一个** —— 多注册一个不存在的 provider 会让
  // DSH 的 prepareRoutes 抛 DUPLICATE_ADAPTER，整个插件起不来。
  assert.equal(ids.filter((x) => x === MODEL_PROVIDER_COMPAT_ID).length, 1, '兼容空壳必须恰好一次');
  assert.equal(new Set(ids).size, ids.length, 'provider id 不得重复（重复 = 插件无法加载）');
  for (const st of SITES) {
    const pid = providerIdForSite(st.id);
    assert.ok(ids.includes(pid), `${st.id} 必须有自己的 provider`);
    // 反查必须闭合：providerIdForSite -> siteIdForProvider -> 同一站点
    assert.equal(siteIdForProvider(pid), st.id, pid + ' 反查不回原站点');
    // 组名 = 站点短键/域。写成**显式对照表**而不是复用实现里的 shortKey||id：
    // 复用实现等于用实现验证实现，覆盖表改了它也跟着改，等于没护栏。
    assert.equal(providerGroupName(st.id), EXPECTED_GROUP_NAMES[st.id], st.id + ' 的组名不对');
  }
  // 反向：不认识的 provider 一律 null，不许猜站点
  assert.equal(siteIdForProvider('webcode-nope'), null);
  assert.equal(siteIdForProvider('deepseek-official'), null);
});

test('GLM 与 Z.ai 各自成组，组名可分辨（同名模型不再混在一起）', () => {
  // 用户原话：「glm5.3 和 flash 例如这样放在 chatglm 一组内」。
  // 而 z.ai 是**另一个网站**，必须自成一组、组名不同 —— 否则两条 glm-5.3
  // 在选择器上看起来仍是同一个网站的重复项。
  assert.equal(providerGroupName('glm'), 'chatglm');
  assert.equal(providerGroupName('zai'), 'z.ai');
  assert.notEqual(providerIdForSite('glm'), providerIdForSite('zai'));
  // 两个站点确实各有一个 glm-5.3（同名），这正是必须分组的原因
  const g = resolveWebModel('glm:glm-5.3');
  const z = resolveWebModel('zai:glm-5.3');
  assert.equal(g.id, z.id, '两个站点的模型 id 同名，是分组要解决的问题');
  assert.notEqual(g.siteId, z.siteId);
});

test('旧 provider webcode 仍解析得开（否则所有历史会话当场报 session/model-unavailable）', () => {
  // 真机证据（~/.dsh/settings.yaml）：agent-default-model.provider = webcode，
  // 以及 subagent-model-selection.allowedModels 里 20 条 provider: webcode。
  // DSH 在每次发消息前校验 routeServed(selection.provider)；webcode 必须仍在
  // 注册表里。这里钉住「兼容空壳存在」，而它 listModels 为空（不生成组）由
  // regression.test.mjs 钉住。
  assert.ok(providerIdsForRegistration().includes('webcode'), '兼容空壳 webcode 必须在注册表里');
  // 它承载的是**全站点**语义：不限定站点，所以反查刻意返回 null（哨兵）
  assert.equal(siteIdForProvider('webcode'), null);
});