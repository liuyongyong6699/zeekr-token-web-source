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
    
