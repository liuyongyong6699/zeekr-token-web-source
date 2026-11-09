'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OfficialBrowser } = require('./official.cjs');
const { withDeadline, boundedClose } = require('./deadline.cjs');
const { createApplication } = require('./server.cjs');
const never = () => new Promise(() => {});
const PHONE = '13900000000'; // synthetic localhost only
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

test('独立 watchdog 在任务永久挂起时按时返回', async () => {
  const start = Date.now();
  await assert.rejects(withDeadline(never, 30, () => Object.assign(new Error('late'),
    {code:'TEST_TIMEOUT'})), e => e.code === 'TEST_TIMEOUT');
  assert.ok(Date.now() - start < 800);
});
test('清理永久挂起不会拖住调用者', async () => {
  const start = Date.now(); await boundedClose(never, 20);
  assert.ok(Date.now() - start < 800);
});
test('启动挂起即使 Playwright 不 reject 也会报告启动超时', async () => {
  let calls = 0;
  const b = new OfficialBrowser({driver:{launch:() => {calls++; return never();}},
    resolvePath:() => '/fake/browser', startMs:25, prepareMs:150});
  await assert.rejects(b.prepare('unit'), e => e.code === 'BROWSER_START_TIMEOUT');
  await assert.rejects(b.prepare('unit2'), e => e.code === 'BROWSER_START_TIMEOUT');
  assert.equal(calls,1); // cannot storm failing browser launches
  await b.close();
});
test('迟到启动结果不能变为可用登录状态', async () => {
  let finish, closed = 0;
  const b = new OfficialBrowser({driver:{launch:() => new Promise(r=>finish=r)},
    resolvePath:() => '/fake/browser', startMs:20});
  await assert.rejects(b.launch(), e => e.code === 'BROWSER_START_TIMEOUT');
  finish({close:async()=>{closed++;},isConnected:()=>true,on:()=>{}});
  await new Promise(setImmediate);
  assert.equal(b.browser,null);assert.equal(closed,1);
});
test('开标签页挂起也在整体准备时间内停止', async () => {
  const browser={isConnected:()=>true,on:()=>{},newContext:never,close:async()=>{}};
  const b=new OfficialBrowser({driver:{launch:async()=>browser},resolvePath:()=>'/fake',
    startMs:50,prepareMs:30});
  await assert.rejects(b.prepare('tab'),e=>e.code==='PREPARE_TIMEOUT');await b.close();
});
test('官网加载挂起且 close 挂起仍不阻塞错误响应', async () => {
  const page={goto:never,isClosed:()=>false};
  const context={newPage:async()=>page,close:never};
  const browser={isConnected:()=>true,on:()=>{},newContext:async()=>context,close:async()=>{}};
  const b=new OfficialBrowser({driver:{launch:async()=>browser},resolvePath:()=>'/fake',
    startMs:50,prepareMs:30});
  const start=Date.now();await assert.rejects(b.prepare('page'),e=>e.code==='PREPARE_TIMEOUT');
  assert.ok(Date.now()-start<800);await b.close();
});
test('准备阶段不能把未加载完的标签页当 ready', async () => {
  let finish;let contexts=0;
  const page={goto:()=>new Promise(r=>finish=r),waitForFunction:async()=>{},
    evaluate:async()=>true,isClosed:()=>false};
  const browser={isConnected:()=>true,on:()=>{},newContext:async()=>{
    contexts++;return{newPage:async()=>page,close:async()=>{}};},close:async()=>{}};
  const b=new OfficialBrowser({driver:{launch:async()=>browser},resolvePath:()=>'/fake',
    startMs:50,prepareMs:500});
  const a=b.prepare('ready');await new Promise(setImmediate);
  const z=b.prepare('ready');finish();await Promise.all([a,z]);
  assert.equal(contexts,1);assert.equal(b.contexts.get('ready').ready,true);await b.close();
});

async function setup(adapter) {
  const app=createApplication(adapter,{captchaMs:45,writeMs:45});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+app.server.address().port;
  const boot=await fetch(origin+'/api/bootstrap');const body=await boot.json();
  const headers={Origin:origin,'X-CSRF-Token':body.csrf,'Content-Type':'application/json',
    Cookie:boot.headers.get('set-cookie').split(';')[0]};
  const post=async(path,b)=>{const r=await fetch(origin+path,{method:'POST',headers,
    body:JSON.stringify(b)});return{status:r.status,data:await r.json()};};
  return{app,origin,headers,post};
}
test('整次验证码 HTTP 请求挂起返回超时并恢复非忙状态', async () => {
  let calls=0;
  const adapter={request:()=>{calls++;return never();},release:async()=>{},close:async()=>{},
    phase:()=> 'browser_start'};
  const s=await setup(adapter);
  try{
    const r=await s.post('/api/captcha',{phone:PHONE,consent:true});
    assert.equal(r.status,504);assert.equal(r.data.code,'CAPTCHA_TIMEOUT');
    assert.equal([...s.app.sessions.values()][0].busy,false);
    const again=await s.post('/api/captcha',{phone:PHONE,consent:true});
    assert.equal(again.data.code,'RESTART_REQUIRED');assert.equal(calls,1);
  }finally{await s.app.close();}
});
test('验证码进度只返回白名单阶段不泄露手机号', async () => {
  const adapter={request:never,release:async()=>{},close:async()=>{},phase:()=>PHONE};
  const s=await setup(adapter);
  try{
    const r=await fetch(s.origin+'/api/progress',{headers:s.headers});const d=await r.json();
    assert.equal(d.phase,'idle');assert.ok(!JSON.stringify(d).includes(PHONE));
    const invalid=await fetch(s.origin+'/api/progress');assert.equal(invalid.status,401);
  }finally{await s.app.close();}
});
test('短信挂起不自动重发并保留发送冷却', async () => {
  const calls=[];
  const adapter={request:async(id,op)=>{calls.push(op);if(op==='captcha')return{
    code:'000000',success:true,data:{key:'fake-key',imageBase64:PNG}};return never();},
    release:async()=>{},close:async()=>{}};
  const s=await setup(adapter);
  try{
    await s.post('/api/captcha',{phone:PHONE,consent:true});
    const body={phone:PHONE,consent:true,captchaCode:'AB12'};
    const r=await s.post('/api/send',body);assert.equal(r.data.code,'SMS_UNCERTAIN');
    assert.equal((await s.post('/api/send',body)).data.code,'SMS_COOLDOWN');
    assert.deepEqual(calls,['captcha','sms']);
  }finally{await s.app.close();}
});
