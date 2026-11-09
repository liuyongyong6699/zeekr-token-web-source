'use strict';
// UI test: every endpoint is intercepted with synthetic fixtures. No SMS/API/account.
const { chromium }=require('playwright-core');
const assert=require('node:assert/strict');
const fs=require('fs');
const synthetic='Bearer '+Buffer.from('{"alg":"none"}').toString('base64url')+'.'+
  Buffer.from('{"sub":"{\\"accountInfoDTO\\":{\\"accountId\\":12345}}"}').toString('base64url')+'.DEMO_NOT_REAL';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.ZEEKR_CHROMIUM_PATH||'/usr/bin/chromium',
    headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']});
  let context;
  try{
    context=await browser.newContext({viewport:{width:412,height:915},locale:'zh-CN'});
    const page=await context.newPage();const errors=[];const steps=[];
    page.on('pageerror',e=>errors.push(e.name));
    await context.route('http://127.0.0.1:8767/api/**',async route=>{
      const url=new URL(route.request().url());const name=url.pathname.split('/').pop();
      let d;
      if(name==='bootstrap')d={ok:true,csrf:'synthetic-ui-csrf',expires:Date.now()+900000};
      if(name==='captcha'){steps.push('captcha');d={ok:true,image,message:'图形验证码测试'};}
      if(name==='send'){steps.push('sms');d={ok:true,cooldown:60,smsReady:true,message:'短信测试'};}
      if(name==='login'){steps.push('login');d={ok:true,token:synthetic,
        info:{account:'12***45',expires:'2027-01-01T00:00:00Z',hasAccountId:true,hasDeviceId:true},
        message:'模拟登录成功（无真实账号）'};}
      if(name==='clear')d={ok:true};
      await route.fulfill({json:d});
    });
    await page.goto('http://127.0.0.1:8767',{waitUntil:'networkidle'});
    await page.locator('#connection.ready').waitFor();
    assert.equal(await page.locator('#get-captcha').isEnabled(),false);
    await page.locator('#phone').fill('13900000000');
    await page.locator('#consent').check();
    assert.equal(await page.locator('#get-captcha').isEnabled(),true);
    await page.locator('#get-captcha').click();
    await page.locator('#captcha-code').waitFor({state:'visible'});
    await page.locator('#captcha-code').fill('AB12');
    await page.locator('#send-sms').click();
    await page.locator('#sms-code').waitFor({state:'visible'});
    assert.equal(await page.locator('#send-sms').isEnabled(),false);
    await page.locator('#sms-code').fill('1234');
    await page.locator('#submit-login').click();
    await page.locator('#result').waitFor({state:'visible'});
    assert.equal(await page.locator('#token').isVisible(),false);
    assert.equal(await page.locator('#token').inputValue(),synthetic);
    assert.equal(await page.locator('#sms-code').inputValue(),'');
    await page.locator('#show-token').click();assert.equal(await page.locator('#token').isVisible(),true);
    await page.locator('#show-token').click();assert.equal(await page.locator('#token').isVisible(),false);
    await page.locator('#clear-token').click();await page.locator('#result').waitFor({state:'hidden'});
    assert.equal(await page.locator('#token').inputValue(),'');
    assert.deepEqual(steps,['captcha','sms','login']);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({uiTest:'pass',smsOrLoginToOfficial:false,jsErrors:0,
      steps:3,tokenHiddenByDefault:true,clearWorks:true}));
    if(process.env.ZEEKR_PREVIEW_DIR){
      fs.mkdirSync(process.env.ZEEKR_PREVIEW_DIR,{recursive:true});
      // Screenshots contain no phone, OTP, CAPTCHA, or Token.
      await page.reload({waitUntil:'networkidle'});
      await page.screenshot({path:process.env.ZEEKR_PREVIEW_DIR+'/mobile.png',fullPage:true});
      await page.setViewportSize({width:1200,height:900});
      await page.screenshot({path:process.env.ZEEKR_PREVIEW_DIR+'/desktop.png',fullPage:true});
    }
  }finally{await context?.close();await browser.close();}
})().catch(e=>{console.error('UI_TEST_FAIL '+e.name+': '+e.message);process.exitCode=1;});
