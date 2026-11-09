'use strict';

const fs = require('fs');
const { chromium } = require('playwright-core');
const { withDeadline, boundedClose } = require('./deadline.cjs');

const OFFICIAL_URL = 'https://www.zeekrlife.com/home';
const OPERATION = Object.freeze({
  captcha: { url: 'common.v1.captchaJPGGet', method: 'get' },
  sms: { url: 'appuser.v1.user.pub.sms.getWithCaptchaCheck', method: 'post' },
  login: { url: 'appuser.v1.user.pub.login.mobile', method: 'post' },
});

class ToolError extends Error {
  constructor(message, status = 400, code = 'TOOL_ERROR', extra = {}) {
    super(message);
    this.name = 'ToolError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function browserPath() {
  const paths = [process.env.ZEEKR_CHROMIUM_PATH, '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium', chromium.executablePath()];
  return paths.find(p => p && fs.existsSync(p));
}

// Nothing is logged here: official SDK console messages can contain risk Tokens.
// No persistent browser profile, storageState, tracing, HAR, screenshots or OTP logs.
class OfficialBrowser {
  constructor(options = {}) {
    this.browser = null;
    this.launching = null;
    this.contexts = new Map();
    this.preparing = new Map();
    this.phases = new Map();
    this.blockedError = null;
    this.driver = options.driver || chromium;
    this.resolvePath = options.resolvePath || browserPath;
    this.startMs = options.startMs ?? 15000;
    this.prepareMs = options.prepareMs ?? 45000;
    this.requestMs = options.requestMs ?? 25000;
  }

  phase(id) { return this.phases.get(id) || 'idle'; }

  async launch() {
    if (this.blockedError) throw this.blockedError;
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    const executablePath = this.resolvePath();
    if (!executablePath) throw new ToolError(
      '未找到 Chromium。请运行 npm run browser:install；Alpine / 青龙容器请安装 chromium。',
      503, 'BROWSER_MISSING');
    let raw;
    const timeoutError = () => new ToolError(
      '后台 Chromium 在 15 秒内未能启动，尚未请求验证码或发送短信。' +
      '手机 Linux 环境可能不兼容；不要反复点击，重启服务或改在电脑本地运行。',
      504, 'BROWSER_START_TIMEOUT');
    this.launching = withDeadline(() => {
      raw = this.driver.launch({ executablePath, headless: true, timeout: 10000,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
      // If a timed-out launch eventually resolves, close only this browser, not others.
      raw.then(browser => {
        if (this.blockedError) void boundedClose(() => browser.close());
      }, () => {});
      return raw;
    }, this.startMs, timeoutError, () => { this.blockedError = timeoutError(); });
    try {
      this.browser = await this.launching;
      this.browser.on('disconnected', () => { this.contexts.clear(); });
      return this.browser;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('浏览器启动失败，请检查 Chromium 安装和系统依赖。此步骤未发送短信。',
        503, 'BROWSER_START_FAILED');
    } finally { this.launching = null; }
  }

  async prepare(id) {
    if (this.blockedError) throw this.blockedError;
    const current = this.contexts.get(id);
    if (current?.ready && !current.page.isClosed()) return current;
    if (this.preparing.has(id)) return this.preparing.get(id);
    const attempt = { expired: false };
    const task = withDeadline(() => this._prepare(id, attempt), this.prepareMs,
      () => new ToolError('官网或风控服务在 45 秒内未完成加载。' +
        '此步骤未发送短信；请检查网络，若后台浏览器启动失败请改在电脑本地运行。',
        504, 'PREPARE_TIMEOUT'),
      () => { attempt.expired = true; void this.release(id); });
    this.preparing.set(id, task);
    try { return await task; }
    finally { this.preparing.delete(id); }
  }

  async _prepare(id, attempt) {
    const ensureActive = () => {
      if (attempt.expired) throw new ToolError('已停止过期的初始化操作。', 504, 'PREPARE_TIMEOUT');
    };
    this.phases.set(id, 'browser_start');
    const browser = await this.launch();
    ensureActive();
    this.phases.set(id, 'opening_tab');
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }, locale: 'zh-CN',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    });
    if (attempt.expired) {
      void boundedClose(() => context.close());
      ensureActive();
    }
    const item = { context, page: null, ready: false };
    this.contexts.set(id, item);
    try {
      const page = await context.newPage();
      ensureActive();
      item.page = page;
      this.phases.set(id, 'official_page');
      await page.goto(OFFICIAL_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      ensureActive();
      this.phases.set(id, 'official_sdk');
      await page.waitForFunction(() => !!window.webpackJsonp, null, { timeout: 10000 });
      ensureActive();
      const ready = await page.evaluate(() => {
        const id = 'local_token_tool_' + Math.random().toString(36).slice(2);
        window.webpackJsonp.push([[], {
          [id]: (module, exports, require) => { window.__localOfficialRequire = require; },
        }, [[id]]]);
        const require = window.__localOfficialRequire;
        if (typeof require !== 'function') return false;
        // Current official PC build uses b775. Discover the same wrapper on renames.
        const ids = ['b775', ...Object.keys(require.m || {}).filter(k => {
          const source = String(require.m[k]);
          return source.includes('toc_pc_zeekrlife') && source.includes('isRisk') &&
            source.includes('.request(');
        })];
        for (const key of ids) {
          if (!require.m[key]) continue;
          try {
            const exported = require(key);
            const request = exported.a || exported.default;
            if (typeof request === 'function') {
              window.__localOfficialRequest = request;
              return true;
            }
          } catch (_) { /* Only examine this one official wrapper. */ }
        }
        return false;
      });
      if (!ready) throw new ToolError(
        '官网前端已变化，未找到官方登录请求模块。请更新本工具，勿反复发送短信。',
        503, 'OFFICIAL_CHANGED');
      ensureActive();
      item.ready = true;
      this.phases.set(id, 'ready');
      return item;
    } catch (error) {
      await this.release(id);
      if (error instanceof ToolError) throw error;
      throw new ToolError('官网或风控 SDK 加载失败，请检查网络；此步骤未发送短信。',
        503, 'OFFICIAL_UNAVAILABLE');
    }
  }

  async request(id, operation, data = {}) {
    const spec = OPERATION[operation];
    if (!spec) throw new ToolError('不支持此操作。', 400, 'BAD_OPERATION');
    const { page } = await this.prepare(id);
    this.phases.set(id, operation === 'captcha' ? 'official_captcha' : 'official_' + operation);
    let timer;
    try {
      // Do not override official risk/signing functions, bypass CAPTCHA, or retry POSTs.
      return await Promise.race([
        page.evaluate(async ({ spec, data, operation }) => {
          const options = {
            url: spec.url, method: spec.method, isRisk: true,
            headers: { hideMessage: true, isRemoveRejectError: true, isNeedLoginJump: false },
          };
          if (spec.method === 'get') options.params = data;
          else options.data = data;
          try {
            const response = await window.__localOfficialRequest(options);
            if (!response || typeof response !== 'object') return { transportError: true };
            const result = { code: String(response.code ?? ''),
              success: response.success === true, msg: String(response.msg || '') };
            const d = response.data;
            if (operation === 'captcha') result.data = {
              key: d?.key, imageBase64: d?.imageBase64,
            };
            if (operation === 'sms') result.data = { leftTime: d?.leftTime };
            if (operation === 'login') result.data = { jwtToken: d?.jwtToken };
            return result;
          } catch (_) { return { transportError: true }; }
        }, { spec, data, operation }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new ToolError(
          operation === 'sms' ? '发送结果不明，请先检查短信，60 秒内不要重复发送。' :
            '官方请求超时，请稍后重试。', 504, 'UPSTREAM_TIMEOUT')), this.requestMs); }),
      ]);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(operation === 'sms' ?
        '发送结果不明，请先检查短信，60 秒内不要重复发送。' :
        '官方请求未完成，请检查网络后再试。', 502, 'UPSTREAM_UNCERTAIN');
    } finally { clearTimeout(timer); }
  }

  async release(id) {
    const item = this.contexts.get(id);
    this.contexts.delete(id);
    this.phases.delete(id);
    if (item) await boundedClose(() => item.context.close());
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.contexts.clear();
    this.phases.clear();
    if (browser) await boundedClose(() => browser.close());
  }
}

function jwtInfo(raw) {
  if (typeof raw !== 'string' || raw.length > 50000 || /[\r\n]/.test(raw)) {
    throw new ToolError('官方返回的 Token 格式异常。', 502, 'TOKEN_FORMAT');
  }
  const jwt = raw.replace(/^Bearer\s+/i, '').trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) {
    throw new ToolError('官方未返回可识别的 JWT，请勿把其他字段当作 Token。',
      502, 'TOKEN_FORMAT');
  }
  let payload, sub;
  try {
    payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    sub = typeof payload.sub === 'string' ? JSON.parse(payload.sub) : (payload.sub || {});
  } catch (_) {
    throw new ToolError('JWT 结构无法解析，请检查官网是否改版。', 502, 'TOKEN_FORMAT');
  }
  const id = sub?.accountInfoDTO?.accountId ?? sub?.accountId;
  const exp = Number(payload.exp);
  const expires = Number.isFinite(exp) && exp > 0 && exp * 1000 < 8.64e15 ?
    new Date(exp * 1000).toISOString() : null;
  const idText = id == null ? '' : String(id);
  return {
    token: 'Bearer ' + jwt,
    // Decode only; this is NOT a cryptographic verification or a successful sign-in.
    info: { account: idText ? idText.slice(0, 2) + '***' + idText.slice(-2) : '未解析',
      expires, hasDeviceId: !!sub?.accountLoginInfoDTO?.lastLoginDeviceId,
      hasAccountId: id != null, decodedOnly: true },
  };
}

function captchaImage(image) {
  if (typeof image !== 'string' || image.length > 500000 ||
    !/^[A-Za-z0-9+/=\r\n]+$/.test(image)) {
    throw new ToolError('官方验证码图片格式异常。', 502, 'CAPTCHA_FORMAT');
  }
  const bytes = Buffer.from(image, 'base64');
  let type;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) type = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = 'image/jpeg';
  else throw new ToolError('官方验证码不是支持的 PNG / JPEG 图片。', 502, 'CAPTCHA_FORMAT');
  return `data:${type};base64,` + image.replace(/[\r\n]/g, '');
}

function sanitize(message, sensitive = []) {
  let text = typeof message === 'string' ? message : '';
  for (const value of sensitive) {
    if (value) text = text.split(String(value)).join('[已隐藏]');
  }
  return text.replace(/(?:Bearer\s+)?eyJ[A-Za-z0-9_.-]+/gi, '[Token已隐藏]')
    .replace(/1[3-9]\d{9}/g, '[手机号已隐藏]').slice(0, 180);
}

module.exports = { OfficialBrowser, ToolError, jwtInfo, sanitize, captchaImage, browserPath, OPERATION };
