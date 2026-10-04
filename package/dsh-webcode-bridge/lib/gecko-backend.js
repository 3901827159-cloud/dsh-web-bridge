// gecko-backend.js — DSHA Android backend: use the App's native GeckoView session
// instead of Playwright Chromium. Channel = HttpShellService(:3090) /browser/* routes
// (GET-only, X-Token auth). Decoder / rate-limit judgement / thinking chain all reuse
// lib/decoder.js; this file only does the transport.
import fs from 'node:fs';
import vm from 'node:vm';

// Load the decoder registry (same style as browser-driver.js)
vm.runInThisContext(fs.readFileSync(new URL('./decoder.js', import.meta.url), 'utf8'));
const DeepSeekDecoder = globalThis.WebCodeStreamDecoders.deepseek;

const SITE_URL = 'https://chat.deepseek.com/';
const TOKEN_FILE = process.env.DSHA_BRIDGE_TOKEN_FILE || '/root/.dsh/.bridge_token';

async function bridgeBase() {
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  for (const host of ['127.0.0.1', '[::1]']) {
    const base = `http://${host}:3090`;
    try {
      const r = await fetch(base + '/health', { headers: { 'X-Token': token }, signal: AbortSignal.timeout(3000) });
      if (r.ok) return { base, token };
    } catch { /* try next address family */ }
  }
  throw new Error('DSHA_BRIDGE_UNREACHABLE: 3090 App bridge unreachable');
}

let conn = null;
async function call(path) {
  if (!conn) conn = await bridgeBase();
  const r = await fetch(conn.base + path, { headers: { 'X-Token': conn.token }, signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error('BRIDGE_BAD_RESPONSE: ' + text.slice(0, 200)); }
}
const q = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGeckoDriver(options = {}) {
  const siteId = options.siteId || 'deepseek';
  const log = options.logger || console;
  const requestTimeoutMs = Number(options.requestTimeoutMs) || 240000;
  const loginTimeoutMs = Number(options.loginTimeoutMs) || 300000;
  let busy = false;
  const conversations = new Map();

  async function loginStatus() {
    const st = await call('/browser/login/status');
    return st.loggedIn === true;
  }

  async function ensurePage() {
    const st = await call('/browser/status');
    if (!st.activity || !st.portConnected) {
      await call('/browser/open?url=' + q(SITE_URL));
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        const s2 = await call('/browser/status');
        if (s2.portConnected) return;
      }
      throw new Error('WEB_PAGE_NOT_READY: Gecko page content script not ready in 30s');
    }
  }

  async function connect() {
    await ensurePage();
    const loggedIn = await loginStatus();
    return { ok: true, loggedIn };
  }

  async function openLogin() {
    const t0 = Date.now();
    await call('/browser/login/show');
    for (;;) {
      if (Date.now() - t0 > loginTimeoutMs) throw new Error('LOGIN_TIMEOUT: waiting for manual login timed out');
      await sleep(2000);
      if (await loginStatus()) break;
    }
    await call('/browser/login/hide').catch(() => {});
    log.log?.('[gecko] login done, session moved to background');
    return { ok: true, loggedIn: true, siteId, ms: Date.now() - t0 };
  }

  async function runTurn(message, { fresh = false, signal, onDelta, onThink, onImage } = {}) {
    if (busy) throw new Error('BRIDGE_BUSY: previous turn still running');
    busy = true;
    try {
      await ensurePage();
      if (!(await loginStatus())) {
        throw new Error('NEED_LOGIN: DeepSeek web login expired, please log in again');
      }
      if (fresh) { await call('/browser/open?url=' + q(SITE_URL)); await sleep(4000); await ensurePage(); }

      const cursor0 = await call('/browser/events?since=999999999&wait=0');
      let since = cursor0.lastSeq ?? 0;
      await call('/browser/send?text=' + q(String(message)));

      const decoder = new DeepSeekDecoder({ onDelta, onThink, onImage });
      let captureId = null;
      let sendFailed = null;
      const t0 = Date.now();
      const onAbort = () => { call('/browser/click?what=stop').catch(() => {}); };
      signal?.addEventListener('abort', onAbort);
      try {
        for (;;) {
          if (signal?.aborted) break;
          if (Date.now() - t0 > requestTimeoutMs) { decoder.failed = true; break; }
          const r = await call(`/browser/events?since=${since}&wait=20000`);
          since = r.lastSeq ?? since;
          for (const ev of r.events || []) {
            if (ev.type === 'wb-send-result' && ev.ok === false) sendFailed = ev.error || 'send failed';
            if (ev.type !== 'wb-chunk') continue;
            if (captureId === null && ev.phase === 'start') captureId = ev.id;
            if (captureId !== null && ev.id === captureId) {
              if (ev.phase === 'chunk') decoder.push(String(ev.text || ''));
              if (ev.phase === 'end') {
                const result = decoder.finish();
                return finishResult(result, sendFailed);
              }
            }
          }
        }
        const result = decoder.finish();
        return finishResult(result, sendFailed || (signal?.aborted ? 'aborted' : 'timeout'));
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    } finally { busy = false; }
  }

  function finishResult(result, forcedReason) {
    if (forcedReason === 'send failed' || forcedReason === 'send button not found' || (forcedReason && !result.text)) {
      throw new Error('WEB_SEND_FAILED: ' + (result.hint || forcedReason));
    }
    if (!result.complete && result.reason === 'rate_limited') {
      throw new Error('RATE_LIMITED: ' + (result.hint || 'messages sent too frequently'));
    }
    return {
      text: result.text,
      thinking: result.thinking || '',
      images: Array.isArray(result.images) ? result.images : [],
      sessionId: 'gecko-main',
      metrics: { endReason: result.complete ? 'finished' : 'partial:' + (result.reason || forcedReason || 'unknown'), chars: (result.text || '').length, backend: 'gecko-native' },
    };
  }

  async function sendPrompt(prompt, { signal, onDelta, onThink, onImage } = {}) {
    return runTurn(prompt, { fresh: true, signal, onDelta, onThink, onImage });
  }
  async function sendTurn(key, message, opts = {}) {
    const k = String(key || 'main');
    if (!conversations.has(k)) conversations.set(k, { webSessionId: null, landedUrl: SITE_URL });
    return runTurn(message, { fresh: false, ...opts });
  }

  function status() {
    return {
      siteId, running: true, busy, initialized: true,
      loggedIn: null, loggedInCached: false, needLogin: false,
      loginState: 'idle', selectedModel: 'deepseek', window: null,
      browserSource: 'gecko-native', executablePath: null, lastLogin: null,
    };
  }

  const notImpl = (name) => () => { throw new Error('GECKO_NOT_IMPLEMENTED: ' + name + ' (M3.5 MVP)'); };
  return {
    sendPrompt, sendTurn, connect, openLogin, status,
    conversationFor: (key) => conversations.get(String(key || 'main')) || null,
    conversationForSession: (key) => conversations.get(String(key || 'main')) || null,
    resetConversation: (key) => { conversations.delete(String(key || 'main')); },
    sessionSlot: () => 'default',
    close: async () => { await call('/browser/login/hide').catch(() => {}); },
    diagnostics: async () => ({ backend: 'gecko-native' }),
    interact: notImpl('interact'), openWindow: notImpl('openWindow'), closeWindow: notImpl('closeWindow'),
    importStorageFromProfile: notImpl('importStorageFromProfile'), getToken: async () => null,
    profileCookies: async () => [], writeProfileCookies: async () => {}, userAgent: () => 'gecko-native',
    probeAttachment: notImpl('probeAttachment'), readAccountIdentity: () => null,
    get page() { return null; }, webApi: notImpl('webApi'), listSessions: async () => [],
    fetchHistory: notImpl('fetchHistory'), screenshotBase64: notImpl('screenshotBase64'),
    setImageLimitsProvider: () => {},
  };
}
