'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OfficialBrowser, ToolError, jwtInfo, sanitize, captchaImage } = require('./official.cjs');
const { withDeadline, boundedClose } = require('./deadline.cjs');

const TTL = 15 * 60 * 1000;
const SMS_COOLDOWN = 60000;
const CAPTCHA_TTL = 5 * 60 * 1000;
const SMS_TTL = 10 * 60 * 1000;
const PHONE = /^1[3-9]\d{9}$/;
const COOKIE = 'zeekr_local_session';
const STATIC = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
});

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function isOK(r) { return r && r.code === '000000' && r.success !== false; }
function validPhone(body) {
  if (body.consent !== true) throw new ToolError('请先阅读条款并确认只登录自己的账号。');
  if (typeof body.phone !== 'string' || !PHONE.test(body.phone)) {
    throw new ToolError('请输入中国大陆 11 位手机号。', 400, 'PHONE_FORMAT');
  }
  return body.phone;
}
function readJSON(req) {
  return new Promise((resolve, reject) => {
    if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/json') {
      req.resume();
      return reject(new ToolError('请求必须是 JSON。', 415, 'CONTENT_TYPE'));
    }
    const chunks = [];
    let size = 0, failed = false;
    const timer = setTimeout(() => {
      failed = true; req.resume();
      reject(new ToolError('请求正文超时。', 408, 'BODY_TIMEOUT'));
    }, 5000);
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > 4096) {
        failed = true; clearTimeout(timer);
        reject(new ToolError('请求正文过大。', 413, 'BODY_TOO_LARGE'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (failed) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch (_) { reject(new ToolError('JSON 格式错误。', 400, 'JSON_FORMAT')); }
    });
    req.on('error', () => {
      clearTimeout(timer); reject(new ToolError('连接中断。', 400, 'DISCONNECTED'));
    });
  });
}

function createApplication(adapter = new OfficialBrowser(), options = {}) {
  const sessions = new Map();
  const rates = new Map();
  const now = options.now || Date.now;
  const captchaMs = options.captchaMs ?? 70000;
  const writeMs = options.writeMs ?? 70000;
  async function release(id) { await boundedClose(() => adapter.release(id)); }
  async function dispatch(s, operation, data) {
    let expired = false;
    const timeout = () => operation === 'captcha' ?
      new ToolError('验证码加载已超时，尚未发送短信。' +
        '后台浏览器可能卡住，请检查启动环境；不要一直等待或连续重试。',
        504, 'CAPTCHA_TIMEOUT') :
      new ToolError('官方操作超时，结果不明。请先检查短信或账号状态，不要立即重复操作。',
        504, 'UPSTREAM_UNCERTAIN');
    const pending = Promise.resolve().then(() => adapter.request(s.id, operation, data));
    pending.then(() => { if (expired && operation === 'captcha') void release(s.id); }, () => {});
    try {
      return await withDeadline(pending, operation === 'captcha' ? captchaMs : writeMs,
        timeout, () => { expired = true; if (operation === 'captcha') s.stalled = true; });
    } catch (error) {
      if (operation === 'captcha') void release(s.id);
      throw error;
    }
  }
  // HMAC keeps phone numbers out of the rate-limit map; all state is memory-only.
  const salt = crypto.randomBytes(32);
  const rateKey = phone => crypto.createHmac('sha256', salt).update(phone).digest('hex');
  let address;

  const securityHeaders = {
    'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; " +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
      "base-uri 'none'; form-action 'self'; object-src 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  function send(res, status, body, extra = {}) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { ...securityHeaders, 'Content-Type':
      'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify(body));
  }
  function originFor(req) {
    const port = address?.port;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(req.headers.host)) throw new ToolError(
      '此工具仅接受本机 localhost / 127.0.0.1 访问。', 403, 'HOST_BLOCKED');
    const origin = `http://${req.headers.host}`;
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ToolError(
      '禁止跨站请求。', 403, 'CROSS_SITE');
    if (req.headers.origin && req.headers.origin !== origin) throw new ToolError(
      '禁止跨站请求。', 403, 'ORIGIN_BLOCKED');
    return origin;
  }
  function session(req) {
    const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim());
    const value = cookies.find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    const s = value && /^[a-f0-9]{48}$/.test(value) && sessions.get(value);
    if (!s || s.expires <= now()) throw new ToolError(
      '本地会话已过期，请刷新页面。', 401, 'SESSION_EXPIRED');
    return s;
  }
  function requireCSRF(req, s, origin) {
    if (req.headers.origin !== origin || !equal(req.headers['x-csrf-token'], s.csrf)) {
      throw new ToolError('安全校验失败，请刷新本地页面。', 403, 'CSRF_FAILED');
    }
  }
  function phoneRate(phone) {
    const key = rateKey(phone);
    let r = rates.get(key);
    if (!r || now() - r.start >= 60 * 60 * 1000) {
      r = { start: now(), sms: 0, nextSend: 0, logins: [] };
      rates.set(key, r);
    }
    r.logins = r.logins.filter(t => now() - t < SMS_TTL);
    return r;
  }
  function upstreamError(r, sensitive = []) {
    if (r?.transportError) throw new ToolError(
      '官方请求结果不明，请检查网络。', 502, 'UPSTREAM_UNCERTAIN');
    const code = /^[A-Za-z0-9_-]{1,32}$/.test(String(r?.code || '')) ? r.code : 'UNKNOWN';
    throw new ToolError(sanitize(r?.msg, sensitive) ||
      '官方拒绝了此操作，请检查验证码或稍后再试。', 400, 'OFFICIAL_' + code);
  }
  const sweep = setInterval(() => {
    for (const [id, s] of sessions) {
      if (s.expires <= now() && !s.busy) {
        sessions.delete(id); void release(id);
      }
    }
    for (const [key, r] of rates) if (now() - r.start > 60 * 60 * 1000) rates.delete(key);
  }, 30000);
  sweep.unref();

  const server = http.createServer(async (req, res) => {
    let s;
    try {
      const origin = originFor(req);
      const url = new URL(req.url, origin);
      if (url.search) throw new ToolError('不接受 URL 查询参数。', 400, 'QUERY_BLOCKED');
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const contents = fs.readFileSync(path.join(__dirname, 'public', file));
        res.writeHead(200, { ...securityHeaders, 'Content-Type': type });
        res.end(contents); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        try { s = session(req); } catch (_) { /* New tab/session. */ }
        if (!s) {
          for (const [id, old] of sessions) if (old.expires <= now() && !old.busy) {
            sessions.delete(id); await release(id);
          }
          if (sessions.size >= 4) throw new ToolError(
            '最多同时打开 4 个本地会话，请关闭旧页面并等待过期。', 429, 'SESSION_LIMIT');
          const id = crypto.randomBytes(24).toString('hex');
          s = { id, csrf: crypto.randomBytes(24).toString('hex'), expires: now() + TTL,
            busy: false, captchaTimes: [], phone: '', captchaKey: '', captchaAt: 0,
            smsPhone: '', smsAt: 0, nextSend: 0 };
          sessions.set(id, s);
        }
        send(res, 200, { ok: true, csrf: s.csrf, expires: s.expires,
          cooldown: Math.max(0, Math.ceil((s.nextSend - now()) / 1000)),
          smsReady: !!s.smsPhone, runtime: 'local-only', version: '1.0.1',
          note: '仅本机运行，不跳过图形验证或短信验证。' }, {
          'Set-Cookie': `${COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900`,
        }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/progress') {
        s = session(req);
        if (!equal(req.headers['x-csrf-token'], s.csrf)) {
          throw new ToolError('安全校验失败，请刷新本地页面。', 403, 'CSRF_FAILED');
        }
        const allowed = ['idle', 'browser_start', 'opening_tab', 'official_page',
          'official_sdk', 'ready', 'official_captcha', 'official_sms', 'official_login'];
        const phase = typeof adapter.phase === 'function' ? adapter.phase(s.id) : 'idle';
        send(res, 200, { ok: true, phase: allowed.includes(phase) ? phase : 'idle', busy: s.busy });
        return;
      }
      if (req.method !== 'POST' || !['/api/captcha', '/api/send', '/api/login',
        '/api/clear'].includes(url.pathname)) {
        throw new ToolError('接口不存在。', 404, 'NOT_FOUND');
      }
      s = session(req); requireCSRF(req, s, origin);
      const body = await readJSON(req);
      if (s.busy) throw new ToolError('已有操作进行中，请等待完成，不要重复点击。',
        409, 'OPERATION_BUSY');
      s.busy = true;
      try {
        if (url.pathname === '/api/clear') {
          await release(s.id);
          s.phone = ''; s.captchaKey = ''; s.smsPhone = ''; s.smsAt = 0;
          send(res, 200, { ok: true }); return;
        }
        const phone = validPhone(body);
        if (url.pathname === '/api/captcha') {
          if (s.stalled) throw new ToolError('上一轮后台初始化未能退出。' +
            '为避免重复启动浏览器，请重启本地服务后再试。', 503, 'RESTART_REQUIRED');
          s.captchaTimes = s.captchaTimes.filter(t => now() - t < 60000);
          if (s.captchaTimes.length >= 4) throw new ToolError(
            '图形验证码刷新过于频繁，请等 1 分钟。', 429, 'CAPTCHA_LIMIT');
          s.captchaTimes.push(now());
          const r = await dispatch(s, 'captcha', {});
          if (!isOK(r)) upstreamError(r);
          const key = r.data?.key, image = r.data?.imageBase64;
          if (typeof key !== 'string' || !key || key.length > 1024) {
            throw new ToolError('官方图形验证码字段变化，请更新工具。', 502, 'CAPTCHA_FORMAT');
          }
          const imageURL = captchaImage(image);
          s.phone = phone; s.captchaKey = key; s.captchaAt = now();
          send(res, 200, { ok: true, image: imageURL,
            message: '请手动输入图片中的字符；此步骤不会发送短信。' }); return;
        }
        if (url.pathname === '/api/send') {
          const rate = phoneRate(phone);
          const wait = Math.max(rate.nextSend, s.nextSend) - now();
          if (wait > 0) throw new ToolError('请等待短信冷却结束，先检查是否已收到验证码。',
            429, 'SMS_COOLDOWN', { cooldown: Math.ceil(wait / 1000) });
          if (rate.sms >= 3) throw new ToolError('本工具同一号码每小时最多发送 3 次，稍后再试。',
            429, 'SMS_LIMIT');
          const code = body.captchaCode;
          if (phone !== s.phone || !s.captchaKey || now() - s.captchaAt > CAPTCHA_TTL) {
            throw new ToolError('请为这个手机号重新获取图形验证码。', 400, 'CAPTCHA_EXPIRED');
          }
          if (typeof code !== 'string' || !/^[A-Za-z0-9]{1,6}$/.test(code)) {
            throw new ToolError('请输入图片中的 1～6 位字母或数字。', 400, 'CAPTCHA_INPUT');
          }
          // Record a cooldown BEFORE dispatch. No automatic SMS retry, even on timeout.
          const key = s.captchaKey;
          s.captchaKey = ''; s.nextSend = now() + SMS_COOLDOWN;
          s.smsAt = now(); s.smsPhone = phone;
          rate.nextSend = s.nextSend; rate.sms++;
          let r;
          try { r = await dispatch(s, 'sms', {
            mobile: phone, userInputCode: code, key,
          }); } catch (_) {
            throw new ToolError('发送结果不明。请先检查短信，60 秒内不要重复发送；收到短信后可直接登录。',
              502, 'SMS_UNCERTAIN', { cooldown: 60, smsReady: true });
          }
          if (r?.transportError) throw new ToolError(
            '发送结果不明。请先检查短信，60 秒内不要重复发送；收到短信后可直接登录。',
            502, 'SMS_UNCERTAIN', { cooldown: 60, smsReady: true });
          if (!isOK(r)) {
            s.smsPhone = ''; s.smsAt = 0;
            const message = sanitize(r?.msg, [phone, code]) || '图形验证码错误或官方拒绝发送。';
            throw new ToolError(message + ' 请等冷却结束后刷新图形验证码。',
              400, 'SMS_REJECTED', { cooldown: 60, smsReady: false });
          }
          const left = Number(r.data?.leftTime);
          const cooldown = Math.max(60, Math.min(600, Number.isFinite(left) ?
            Math.ceil(left / 1000) : 60));
          s.nextSend = now() + cooldown * 1000; rate.nextSend = s.nextSend;
          send(res, 200, { ok: true, cooldown, smsReady: true,
            message: '官方已接受发送请求，请查看手机短信。' }); return;
        }
        if (url.pathname === '/api/login') {
          const code = body.smsCode;
          if (typeof code !== 'string' || !/^\d{4,6}$/.test(code)) {
            throw new ToolError('请输入收到的 4～6 位短信验证码。', 400, 'SMS_INPUT');
          }
          if (s.smsPhone !== phone || !s.smsAt || now() - s.smsAt > SMS_TTL) {
            throw new ToolError('请先在本页获取短信验证码，收到后再登录。', 400, 'SMS_REQUIRED');
          }
          const rate = phoneRate(phone);
          if (rate.logins.length >= 5) throw new ToolError(
            '验证码尝试过多，10 分钟后再试。不支持猜测或循环尝试验证码。', 429, 'LOGIN_LIMIT');
          rate.logins.push(now());
          const r = await dispatch(s, 'login', {
            channel: 4, businessType: '510001', deviceId: '0', deviceName: '官网PC端',
            ip: '0.0.0.0', mobile: phone, regionCode: '+86', smsCode: code,
          });
          if (!isOK(r)) upstreamError(r, [phone, code]);
          const result = jwtInfo(r.data?.jwtToken);
          s.phone = ''; s.smsPhone = ''; s.smsAt = 0; s.captchaKey = '';
          await release(s.id);
          // Token goes only in this no-store response; never in a URL or log.
          send(res, 200, { ok: true, ...result,
            message: '登录成功。请复制到青龙环境变量 ZEEKR_TOKEN，然后清除本页。',
            warning: '此 Token 来自官网登录。是否适用 App 签到须首次手动运行验证，' +
              '本工具不会自动签到或领奖。' }); return;
        }
      } finally { s.busy = false; }
    } catch (error) {
      if (error instanceof ToolError) send(res, error.status, {
        ok: false, code: error.code, message: error.message, ...error.extra,
      });
      else send(res, 500, { ok: false, code: 'INTERNAL_ERROR',
        message: '本地操作异常，请检查安装或更新工具。未输出任何账号信息。' });
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.timeout = 90000;
  server.maxHeadersCount = 40;
  server.on('listening', () => { address = server.address(); });
  async function close() {
    clearInterval(sweep);
    sessions.clear(); rates.clear();
    await boundedClose(() => adapter.close(), 2000);
    if (server.listening) {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
  return { server, close, sessions, rates };
}

if (require.main === module) {
  const port = Number(process.env.ZEEKR_WEB_PORT || 8767);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('ZEEKR_WEB_PORT 必须是 1024～65535 的端口号。'); process.exit(1);
  }
  const app = createApplication();
  app.server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '端口被占用，请修改 ZEEKR_WEB_PORT。' :
      '本地服务启动失败。');
    app.close().finally(() => { process.exitCode = 1; });
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`极氪 Token 本地网页：http://127.0.0.1:${port}`);
    console.log('仅本机访问，不记录手机号 / 验证码 / Token。Ctrl+C 停止。');
  });
  const stop = () => app.close().finally(() => process.exit(0));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
module.exports = { createApplication, equal, isOK };
