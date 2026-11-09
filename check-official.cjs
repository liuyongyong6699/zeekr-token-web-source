'use strict';
const { OfficialBrowser, captchaImage } = require('./official.cjs');
(async () => {
  const browser = new OfficialBrowser();
  try {
    const r = await browser.request('public-captcha-check', 'captcha', {});
    const imageURL = captchaImage(r.data?.imageBase64);
    const valid = r.code === '000000' && typeof r.data?.key === 'string' &&
      imageURL.startsWith('data:image/');
    console.log(JSON.stringify({
      test: 'official-public-captcha', passed: valid, code: r.code,
      imageBytes: r.data?.imageBase64?.length || 0,
      smsSent: false, loginAttempted: false, accountUsed: false,
    }));
    if (!valid) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => {
  console.error('官方图形验证码检查失败：' + (error.code || 'UNAVAILABLE'));
  process.exitCode = 1;
});
