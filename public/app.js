'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const view = Object.fromEntries(['phone','consent','get-captcha','captcha-section',
    'refresh-captcha','captcha-code','captcha-image','send-sms','sms-section','sms-code',
    'submit-login','status','connection','result','token','token-hidden','token-meta',
    'copy-token','show-token','download-env','clear-token','step-one','step-two','step-three',
    'login-form','cancel-load'].map(id => [id, $(id)]));
  let csrf = '', ready = false, busy = false, token = '', phoneSnapshot = '',
    captchaReady = false, smsReady = false, until = 0, finished = false, expires = 0;
  let currentController = null, currentRoute = '', activeProgress = null;

  function status(message, kind = '') {
    view.status.textContent = message;
    view.status.className = 'status' + (kind ? ' ' + kind : '');
  }
  const valid = () => /^1[3-9]\d{9}$/.test(view.phone.value) && view.consent.checked;
  const cooldown = () => Math.max(0, Math.ceil((until - Date.now()) / 1000));
  function update() {
    const wait = cooldown(), base = ready && !busy && valid() && !finished;
    view['get-captcha'].disabled = !base;
    view['refresh-captcha'].disabled = !base;
    view['send-sms'].disabled = !base || !captchaReady || wait > 0 ||
      !/^[A-Za-z0-9]{1,6}$/.test(view['captcha-code'].value);
    view['send-sms'].textContent = wait ? `请稍候 ${wait} 秒` : '发送短信验证码';
    view['submit-login'].disabled = !base || !smsReady ||
      !/^\d{4,6}$/.test(view['sms-code'].value);
    view.phone.disabled = busy || finished;
    view.consent.disabled = busy || finished;
    view['captcha-code'].disabled = busy || finished;
    view['sms-code'].disabled = busy || finished;
    view['cancel-load'].hidden = !(busy && currentRoute === '/api/captcha');
    view['cancel-load'].disabled = !currentController;
    ['copy-token','show-token','download-env','clear-token'].forEach(id => {
      view[id].disabled = !token || busy;
    });
  }
  function step(number) {
    ['step-one','step-two','step-three'].forEach((id, i) => {
      view[id].className = i + 1 < number ? 'done' : (i + 1 === number ? 'active' : '');
    });
  }
  function changePhone() {
    view.phone.value = view.phone.value.replace(/\D/g, '').slice(0,11);
    if (phoneSnapshot && view.phone.value !== phoneSnapshot) {
      phoneSnapshot = ''; captchaReady = false; smsReady = false;
      view['captcha-section'].hidden = true; view['sms-section'].hidden = true;
      view['captcha-code'].value = ''; view['sms-code'].value = '';
      view['captcha-image'].removeAttribute('src'); step(1);
    }
    update();
  }
  async function request(route, body) {
    const controller = new AbortController();
    currentController = controller; currentRoute = route; update();
    const limit = route === '/api/clear' ? 6000 : 75000;
    let timer;
    try {
      const fetchResponse = fetch(route, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(body), signal: controller.signal,
      }).then(async res => ({ res, data: await res.json() }));
      const cancelled = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          const error = new Error('已停止本次等待'); error.name = 'AbortError'; reject(error);
        }, { once: true });
      });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
        const error = new Error(route === '/api/captcha' ?
          '验证码等待超过 75 秒，后台浏览器可能卡住。此步骤未发送短信；请重启服务或换到电脑本地运行。' :
          '官方请求超时，结果不明，请先查看短信或账号状态，不要重复操作。');
        error.code = 'CLIENT_TIMEOUT'; reject(error); controller.abort();
      }, limit); });
      const { res, data } = await Promise.race([fetchResponse, cancelled, timeout]);
      if (data.cooldown) until = Date.now() + data.cooldown * 1000;
      if (typeof data.smsReady === 'boolean') {
        smsReady = data.smsReady;
        view['sms-section'].hidden = !smsReady;
      }
      if (!res.ok || !data.ok) {
        const error = new Error(data.message || '本地服务未完成请求。');
        error.code = data.code; throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
      if (currentController === controller) currentController = null;
      update();
    }
  }
  async function run(action) {
    if (busy || !ready) return;
    busy = true; update();
    try { await action(); }
    catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) {
        status(currentRoute === '/api/captcha' ?
          '本次验证码等待已停止，未发送短信。后台操作会按时限结束；不要连续重试，必要时重启本地服务。' :
          '连接中断，操作结果不明。若刚发送短信，请先查看手机，不要连续重发。', 'error');
      } else status(error.message || '操作失败，请稍后再试。', 'error');
      if (error.code === 'SESSION_EXPIRED') {
        ready = false; view.connection.textContent = '会话过期';
        view.connection.className = 'connection failed';
      }
    } finally {
      if (activeProgress) clearInterval(activeProgress.timer);
      activeProgress = null; currentRoute = ''; busy = false; update();
    }
  }
  const phases = {
    browser_start: '正在启动后台 Chromium', opening_tab: '正在打开后台标签页',
    official_page: '正在加载极氪官网', official_sdk: '正在加载官方请求模块',
    ready: '官方浏览器已就绪', official_captcha: '正在请求官方图形验证码',
  };
  function startProgress() {
    const state = { started: Date.now(), phase: 'browser_start', polling: false, timer: null };
    activeProgress = state;
    const tick = async () => {
      if (activeProgress !== state || !busy) return;
      const seconds = Math.floor((Date.now() - state.started) / 1000);
      status((phases[state.phase] || '正在准备图形验证码') + ` · 已等待 ${seconds} 秒。` +
        (seconds >= 15 && state.phase === 'browser_start' ?
          '启动比预期慢，可能是手机环境兼容问题；不要重复点击。' :
          '本步不发送短信，最多等待 75 秒。'));
      if (seconds % 3 !== 0 || state.polling) return;
      state.polling = true;
      const control = new AbortController();
      const timeout = setTimeout(() => control.abort(), 2000);
      try {
        const r = await fetch('/api/progress', { cache: 'no-store', credentials: 'same-origin',
          headers: { 'X-CSRF-Token': csrf }, signal: control.signal });
        const d = await r.json();
        if (activeProgress === state && d.ok && phases[d.phase]) state.phase = d.phase;
      } catch (_) { /* Progress must not hide the real operation result. */ }
      finally { clearTimeout(timeout); state.polling = false; }
    };
    state.timer = setInterval(tick, 1000);
  }
  async function getCaptcha() {
    if (!valid()) return;
    await run(async () => {
      captchaReady = false;
      status('正在启动后台浏览器，最多等待 75 秒。此步骤不会发送短信…');
      startProgress();
      const data = await request('/api/captcha', { phone: view.phone.value, consent: true });
      if (activeProgress) clearInterval(activeProgress.timer);
      activeProgress = null;
      phoneSnapshot = view.phone.value; captchaReady = true;
      view['captcha-image'].src = data.image;
      view['captcha-code'].value = '';
      view['captcha-section'].hidden = false;
      step(2); status(data.message, 'good');
    });
    view['captcha-code'].focus();
  }
  async function sendSMS() {
    if (view['send-sms'].disabled) return;
    await run(async () => {
      // Block frontend repeat as well as server repeat BEFORE dispatch.
      until = Date.now() + 60000; update();
      status('请求发送短信验证码，请不要重复点击…');
      try {
        const data = await request('/api/send', { phone: view.phone.value, consent: true,
          captchaCode: view['captcha-code'].value });
        status(data.message, 'good');
      } catch (error) {
        if (error.name === 'AbortError' || error instanceof TypeError || error.code === 'CLIENT_TIMEOUT') {
          smsReady = true; view['sms-section'].hidden = false;
        }
        throw error;
      } finally {
        captchaReady = false; view['captcha-code'].value = '';
      }
    });
    if (smsReady) view['sms-code'].focus();
  }
  function clearLocal() {
    token = ''; finished = false; captchaReady = false; smsReady = false; phoneSnapshot = '';
    view.token.value = ''; view.token.hidden = true; view['token-hidden'].hidden = false;
    view['show-token'].textContent = '显示'; view['token-meta'].textContent = '';
    view['result'].hidden = true; view['captcha-section'].hidden = true;
    view['sms-section'].hidden = true; view['captcha-image'].removeAttribute('src');
    view.phone.value = ''; view['captcha-code'].value = ''; view['sms-code'].value = '';
    view.consent.checked = false; step(1); update();
  }
  async function submitLogin(event) {
    event.preventDefault();
    if (view['submit-login'].disabled) return;
    await run(async () => {
      status('验证短信并登录…');
      let data;
      try { data = await request('/api/login', { phone: view.phone.value, consent: true,
        smsCode: view['sms-code'].value }); }
      finally { view['sms-code'].value = ''; }
      token = data.token; finished = true;
      const info = data.info || {};
      const when = info.expires ? new Date(info.expires).toLocaleString('zh-CN') : '以实际使用为准';
      view['token-meta'].textContent = `账号 ${info.account || '未解析'} · 到期 ${when}`;
      view.token.value = token; view.token.hidden = true;
      view['result'].hidden = false; view['captcha-section'].hidden = true;
      view['sms-section'].hidden = true; view['captcha-image'].removeAttribute('src');
      view['captcha-code'].value = ''; view.phone.value = ''; phoneSnapshot = '';
      step(3); status(data.message, 'good');
      if (!info.hasAccountId || !info.hasDeviceId) {
        status(data.message + ' 此 JWT 缺少部分签到脚本使用的账号 / 设备字段，须手动验证兼容性。', 'good');
      }
    });
  }
  async function copyToken() {
    if (!token) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(token);
      status('已复制完整变量值（包含 Bearer 前缀）。请粘贴到青龙 ZEEKR_TOKEN；用完清除剪贴板。', 'good');
    } catch (_) {
      view.token.hidden = false; view['token-hidden'].hidden = true;
      view['show-token'].textContent = '隐藏'; view.token.select();
      status('浏览器未允许剪贴板访问，已选中 Token，请手动复制。');
    }
  }
  function downloadEnv() {
    if (!token) return;
    const blob = new Blob([`ZEEKR_TOKEN="${token}"\n`], {type:'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'zeekr-token.env'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('已下载明文 .env 文件，导入后请妥善保管或删除。', 'good');
  }
  view.phone.addEventListener('input', changePhone);
  view.consent.addEventListener('change', update);
  view['captcha-code'].addEventListener('input', () => {
    view['captcha-code'].value = view['captcha-code'].value.replace(/[^A-Za-z0-9]/g,'').slice(0,6);
    update();
  });
  view['sms-code'].addEventListener('input', () => {
    view['sms-code'].value = view['sms-code'].value.replace(/\D/g,'').slice(0,6); update();
  });
  view['get-captcha'].addEventListener('click', getCaptcha);
  view['cancel-load'].addEventListener('click', () => {
    if (currentRoute === '/api/captcha') currentController?.abort();
  });
  view['refresh-captcha'].addEventListener('click', getCaptcha);
  view['send-sms'].addEventListener('click', sendSMS);
  view['login-form'].addEventListener('submit', submitLogin);
  view['copy-token'].addEventListener('click', copyToken);
  view['download-env'].addEventListener('click', downloadEnv);
  view['show-token'].addEventListener('click', () => {
    view.token.hidden = !view.token.hidden;
    view['token-hidden'].hidden = !view.token.hidden;
    view['show-token'].textContent = view.token.hidden ? '显示' : '隐藏';
  });
  view['clear-token'].addEventListener('click', () => run(async () => {
    clearLocal(); await request('/api/clear', {});
    status('已清除当前页凭据。系统剪贴板和已下载文件请自行清除。', 'good');
  }));
  window.addEventListener('pagehide', clearLocal);
  setInterval(() => {
    if (ready && expires && Date.now() >= expires) {
      ready = false; clearLocal();
      view.connection.textContent = '会话过期'; view.connection.className = 'connection failed';
      status('本地会话已过期，请刷新页面。已清除页面内存中的 Token。');
    }
    update();
  }, 1000);
  async function init() {
    const local = ['127.0.0.1','localhost'].includes(location.hostname) &&
      location.protocol === 'http:';
    if (!local) {
      view.connection.textContent = '需要本地服务';
      view.connection.className = 'connection failed';
      status('这是网页预览，不能直接获取 Token。请先运行 npm start，再访问 http://127.0.0.1:8767。');
      update(); return;
    }
    try {
      const res = await fetch('/api/bootstrap', {cache:'no-store', credentials:'same-origin'});
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || '无法初始化本地会话。');
      csrf = data.csrf; expires = data.expires; ready = true;
      if (data.cooldown) until = Date.now() + data.cooldown * 1000;
      view.connection.textContent = '服务已连接';
      view.connection.className = 'connection ready';
      status('输入你自己的手机号。需要先完成图形验证，再接收短信验证码。');
    } catch (error) {
      view.connection.textContent = '连接失败';
      view.connection.className = 'connection failed';
      status(error.message || '请确认本地 Node.js 服务已经启动。', 'error');
    }
    update();
  }
  init();
})();
