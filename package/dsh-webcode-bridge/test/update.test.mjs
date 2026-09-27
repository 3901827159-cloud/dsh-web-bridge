// update.test.mjs — 更新判据的纯函数护栏（0.19.39）。
//
// 需求（用户原话）：「参考 dsh-store 的设置界面顶部……设计好本插件的更新和只做
// 提醒重启操作，替换现在空白的单独 github 按钮」。
//
// 这一层是**判据层**：哪个版本算更新、查不到时说什么。它不碰网络也不碰进程，
// 因此可以离线钉死。真装那一步（runInstall）不在本文件里——它有副作用，
// 由接线层与人工验证覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, compareVersions, pickLatest, updateDecision, PACKAGE_NAME, DEFAULT_REGISTRY,
} from '../lib/update.js';

// ---- parseVersion ---------------------------------------------------------

test('parseVersion：解析三段数字与预发布标记，畸形一律 null', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '' });
  assert.deepEqual(parseVersion('v0.19.39'), { major: 0, minor: 19, patch: 39, prerelease: '' });
  assert.deepEqual(parseVersion('1.2.3-rc.1'), { major: 1, minor: 2, patch: 3, prerelease: 'rc.1' });
  // 构建元数据（+build）不参与比较，但**不该**让解析失败。
  assert.equal(parseVersion('1.2.3+build.5')?.patch, 3);
  for (const bad of ['', null, undefined, '1.2', '1.2.3.4', 'abc', 'latest', '^1.2.3']) {
    assert.equal(parseVersion(bad), null, bad + ' 应解析失败');
  }
});

// ---- compareVersions ------------------------------------------------------

test('compareVersions：三段数字逐段比，无法比较时返回 0（不猜）', () => {
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.3.0', '1.2.99'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  // 段数不同不是「更大」——必须真的按数字比，不能按字符串长度。
  assert.equal(compareVersions('0.19.9', '0.19.10'), -1);
  // 无法比较 ⇒ 0，而不是抛错或当成「更新」
  assert.equal(compareVersions('abc', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', null), 0);
});

test('compareVersions：正式版胜过同号预发布，两个预发布之间不分高下', () => {
  // 这条决定了「1.2.3 与 1.2.3-rc.1 谁该被装」——正式版必须赢。
  assert.equal(compareVersions('1.2.3', '1.2.3-rc.1'), 1);
  assert.equal(compareVersions('1.2.3-rc.1', '1.2.3'), -1);
  // 两个预发布之间返回 0：本模块不实现完整 semver 优先级，只说「不分高下」。
  assert.equal(compareVersions('1.2.3-rc.1', '1.2.3-rc.2'), 0);
});

// ---- pickLatest -----------------------------------------------------------

test('pickLatest：只认正式版，预发布不进候选', () => {
  const packument = {
    'dist-tags': { latest: '9.9.9' },
    versions: { '1.0.0': {}, '1.1.0': {}, '2.0.0-rc.1': {} },
  };
  // 2.0.0-rc.1 数字段最大，但它是预发布 ⇒ 不选它；
  // dist-tags.latest 是 9.9.9，而它不在 versions 里 ⇒ 也不选它。
  assert.equal(pickLatest(packument), '1.1.0');
});

test('pickLatest：全是预发布时回落到 dist-tags.latest（不是「没有更新」）', () => {
  // 把「有得装」说成「没得装」是本项目记过的假陈述，因此这里必须有回落。
  const packument = {
    'dist-tags': { latest: '1.0.0-rc.3' },
    versions: { '1.0.0-rc.1': {}, '1.0.0-rc.3': {} },
  };
  assert.equal(pickLatest(packument), '1.0.0-rc.3');
});

test('pickLatest：畸形 packument 一律 null（不抛）', () => {
  for (const bad of [null, undefined, {}, { versions: null }, { versions: { abc: {} } }, 'nope']) {
    assert.equal(pickLatest(bad), null);
  }
});

// ---- updateDecision -------------------------------------------------------

test('updateDecision：有新版 → outdated，带上 latest', () => {
  const d = updateDecision({ current: '0.19.38', packument: { 'dist-tags': { latest: '0.19.39' }, versions: { '0.19.39': {} } } });
  assert.equal(d.status, 'outdated');
  assert.equal(d.current, '0.19.38');
  assert.equal(d.latest, '0.19.39');
});

test('updateDecision：同版 → current（不提示更新）', () => {
  const d = updateDecision({ current: '0.19.39', packument: { 'dist-tags': { latest: '0.19.39' }, versions: { '0.19.39': {} } } });
  assert.equal(d.status, 'current');
});

test('updateDecision：本地版本比 registry 新 → current，不提示「有更新」', () => {
  // 本地 tgz 比 registry 新是**真实存在**的状态（本项目常年在工作树里跑）。
  // 那时提示「更新到更旧的版本」是错的。
  const d = updateDecision({ current: '0.19.40', packument: { 'dist-tags': { latest: '0.19.39' }, versions: { '0.19.39': {} } } });
  assert.equal(d.status, 'current');
});

test('updateDecision：查不到 → unknown，**不是** current（不把没查到说成已是最新）', () => {
  const a = updateDecision({ current: '0.19.39', error: 'HTTP 502' });
  assert.equal(a.status, 'unknown');
  assert.match(a.reason, /502/);
  const b = updateDecision({ current: '0.19.39', packument: {} });
  assert.equal(b.status, 'unknown');
  // 当前版本本身不可解析也是 unknown —— 没有「可比较的两端」就没有结论。
  const c = updateDecision({ current: 'dev', packument: { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } } });
  assert.equal(c.status, 'unknown');
});

// ---- 常量与默认值 ---------------------------------------------------------

test('包名与 registry 默认值可核对（改包名会让更新指向别的包）', () => {
  assert.equal(PACKAGE_NAME, 'dsh-webcode-bridge');
  assert.match(DEFAULT_REGISTRY, /^https:\/\//);
});
