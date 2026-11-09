'use strict';
const { chromium }=require('playwright-core');
(async()=>{
  const b=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']});
  try{
    const c=await b.newContext({viewport:{width:412,height:915},locale:'zh-CN'});
    const p=await c.newPage();let smsOrLogin=false;
    p.on('request',r=>{if(/\/api\/(send|login)$/.test(r.url()))smsOrLogin=true;});
    await p.goto('http://127.0.0.1:8767',{waitUntil:'networkidle'});
    await p.locator('#connection.ready').waitFor();
    // This synthetic number stays LOCAL; captcha operation sends no phone upstream.
    await p.locator('#phone').fill('13900000000');await p.locator('#consent').check();
    await p.locator('#get-captcha').click();
    await p.locator('#captcha-image').waitFor({state:'visible',timeout:180000});
    await p.waitForFunction(()=>document.getElementById('captcha-image').naturalWidth>0);
    console.log(JSON.stringify({officialCaptchaInWebpage:true,
      imageLoaded:await p.locator('#captcha-image').evaluate(x=>x.naturalWidth>0),
      smsSent:smsOrLogin,phoneSentUpstream:false,loginAttempted:false}));
    // Close context without collecting images, request bodies, cookies, or Tokens.
    await c.close();
  }finally{await b.close();}
})().catch(e=>{console.error('CAPTCHA_UI_CHECK_FAIL '+e.name);process.exitCode=1;});
