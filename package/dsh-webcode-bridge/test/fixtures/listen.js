// fixtures/listen.js — 测试夹具共享 helper：给测试一个「fetch 真能连」的本地端口。
//
// ## 为什么 listen(0) 不够（两类真实 flake，都有逐字现场）
//
// `server.listen(0, '127.0.0.1', cb)` 拿到的端口有两类坑，症状都是 `fetch failed`，
// 看起来像产品缺陷，实际是夹具缺陷：
//
// ① `server.address().port` 偶发读到 **null**（回调早于地址可用；control-routes.test.mjs
//    0.16.9 实测）。null 拼进 URL = `http://127.0.0.1:null/`，undici 判 bad port。
// ② 端口本身落在 undici 的**保留坏端口**清单里（fetch 规范 79 个：1/7/9/…/2049/5060/
//    6000/6566/6665-6669/6697…）。撞上时 `fetch` 一律 `TypeError: fetch failed` /
//    `cause: Error: bad port`，与服务器状态无关（本机 Node 22 逐个探测，79/79 与规范
//    一致；2026-09-30 control-routes 的 prompt-file 用例在全量批跑中间歇红，单独跑
//    恒绿——`listen(0)` 撞清单是概率事件）。
//
// 两条的守卫判据相同：**拿到的端口必须「能连」**——数字合法且不在保留清单内，
// 否则 close 重试。重试上限到了就明确报「夹具拿不到可用端口」，绝不把 bad port
// 伪装成路由/产品失败。
//
// ## 用法
//
//   import { listen } from './fixtures/listen.js';
//   const port = await listen(server);            // 已有 server
//   const port2 = await createListener();          // 或连 server 一起建
//
// 端口保留清单来自 fetch 规范（WHATWG）§bad-port，经本机实现逐个验证后固化。
// 若 Node 未来更新清单，症状会是「偶发 bad port 红灯再现」——把那个端口号加进
// BAD_PORTS 即可（清单不匹配时守卫退化为旧行为，不会假绿）。

import http from 'node:http';

export const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
]);

/**
 * 监听一个可用回环端口并 resolve 它；拿不到（null / 越界 / 保留坏端口）就 close 重试。
 *
 * @param {import('node:http').Server} server 已创建的 http.Server
 * @param {number} [attempts=20] 重试上限；用尽后 reject，错误文本带上最后读到的端口。
 * @returns {Promise<number>}
 */
export function listen(server, attempts = 20) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address()?.port;
        const usable = Number.isInteger(port) && port > 0 && port <= 65535 && !BAD_PORTS.has(port);
        if (usable) return resolve(port);
        server.close(() => {
          if (n <= 0) return reject(new Error('listen：反复拿不到可用端口（最后一次=' + JSON.stringify(port) + '）'));
          tryOnce(n - 1);
        });
      });
      server.once('error', reject);
    };
    tryOnce(attempts);
  });
}

/** 连 server 一起建：`const { server, port } = await createListener(handler)`。 */
export async function createListener(handler, attempts = 20) {
  const server = http.createServer(handler);
  const port = await listen(server, attempts);
  return { server, port };
}

/** 关闭 listen/createListener 给出的 server（测试 finally 里用）。 */
export function closeServer(server) {
  return new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } });
}
