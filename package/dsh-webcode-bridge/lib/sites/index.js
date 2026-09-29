// sites/index.js — `lib/sites/` 的注册表：已迁移站点的唯一入口。
//
// ## 为什么需要一个注册表，而不是让 `providers.js` 直接 import 每个站点
//
// 因为**迁移是渐进的**：已迁移的站点来自本目录，未迁移的仍走 `providers.js` 里
// 的旧路径。有了一张表，「哪些站点已经搬过家」就是一个**可读、可断言**的事实
// （`migratedSiteIds()`），而不是散在 import 语句里的隐式知识。
//
// ## 边界（刻意不做的事）
//
// · **这里不做任何计算**：不摊平思考等级、不投影契约、不做校验。那些分别是
//   `providers.js`（`withEffort`）与 `contract.js` 的职责。注册表只回答
//   「这个站点声明在哪」。
// · **未迁移的站点不出现在这里**。它们仍由 `providers.js` 内联声明——
//   迁移一半时两处并存是**预期状态**，由 `test/provider-surface.test.mjs`
//   保证对外面不因此改变。
//
// ## 加一个站点时怎么做
//
// 1. 在 `lib/sites/<新站点>.js` 里导出它的声明对象（照抄一个同构站点，别新造字段名）；
// 2. 在本文件的 `SITE_MODULES` 里加一行；
// 3. 把它从 `providers.js` 的内联声明里删掉，并让 `SITES` 从本注册表取它；
// 4. 跑 `node test/provider-surface.test.mjs`——**对外面必须逐字不变**。

import { deepseekSite } from './deepseek.js';

/**
 * 已迁移站点的声明表：`siteId → 声明对象`。
 *
 * 值是**未摊平、未冻结**的原始声明；`providers.js` 负责 `withEffort` 与冻结。
 * 这条分工是刻意的：摊平会把 `think-effort.js` 的等级表复制进来，
 * 而那是本项目明令「只有一处定义」的东西。
 */
export const SITE_MODULES = Object.freeze({
  deepseek: deepseekSite,
});

/**
 * 已迁移到 `lib/sites/` 的站点 id 列表。
 *
 * 它的用途是**让迁移进度可断言**：迁移期「已搬 / 未搬」必须能从代码里读出来，
 * 否则下一次读代码的人无法判断某个站点的声明到底在哪一份里是权威。
 *
 * @returns {string[]} 已迁移的站点 id（顺序与 `SITE_MODULES` 的键一致）
 */
export function migratedSiteIds() {
  return Object.keys(SITE_MODULES);
}

/**
 * 取一个已迁移站点的声明；未迁移（或不存在）返回 `null`。
 *
 * 返回 `null` 而不是抛错：调用方（`providers.js`）的语义是
 * 「注册表里有就用它，没有就走旧路径」，把控制流交给调用方。
 *
 * @param {string} siteId 站点 id
 * @returns {object|null} 该站点的声明对象，未迁移时为 null
 */
export function siteModuleFor(siteId) {
  return SITE_MODULES[siteId] || null;
}
