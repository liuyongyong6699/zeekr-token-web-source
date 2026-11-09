'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApplication } = require('./server.cjs');
const { jwtInfo, sanitize, captchaImage } = require('./official.cjs');

// Synthetic fixtures only: no real phone/OTP/JWT. Mock numbers never leave localhost.
const PHONE = '13900000000';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
function fakeJWT() {
  const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  return enc({alg:'HS256',typ:'JWT'}) + '.' + enc({
    exp: Math.floor(Date.now()/1000)+3600,
    sub: JSON.stringify({accountInfoDTO:{accountId:123456},
      accountLoginInfoDTO:{lastLoginDeviceId:'test-device-only'}}),
  }) + '.TEST_SIGNATURE_NOT_REAL';
}
class FakeOfficial {
  constructor() { this.calls=[]; this.mode='ok'; this.gate=null; }
  async request(id, operation, data) {
    this.calls.push({operation,data});
    if (this.gate) await this.gate;
    if (operation === 'captcha') return {code:'000000',success:true,
      data:{key:'synthetic-key',imageBase64:PNG}};
    if (operation === 'sms') {
      if (this.mode==='timeout') throw new Error('mock timeout');
      if (this.mode==='wrong') return {code:'300234',success:false,msg:'wrong CAPTCHA'};
      return {code:'000000',success:true,data:{leftTime:60000}};
    }
    if (operation === 'login') {
      if (this.mode==='reject-login') return {code:'700001',success:false,
        msg:'invalid code '+data.smsCode+' for '+data.mobile};
      return {code:'000000',success:true,data:{jwtToken:fakeJWT()}};
    }
  }
  async release() {}
  async close() {}
}
async function setup() {
  const official=new FakeOfficial();
  let clock=Date.now();
  const app=createApplication(official,{now:()=>clock});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const port=app.server.address().port;
  const base=`http://127.0.0.1:${port}`;
  let cookie='', csrf='';
  async function boot() {
    const res=await fetch(base+'/api/bootstrap');
    const d=await res.json();
    cookie=res.headers.get('set-cookie').split(';')[0]; csrf=d.csrf;
    return d;
  }
  async function call(route,body={},extra={}) {
    const res=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',
      'Origin':base,'X-CSRF-Token':csrf,'Cookie':cookie,...extra},body:JSON.stringify(body)});
    return {status:res.status,data:await res.json(),headers:res.headers};
  }
  await boot();
  return {app,official,port,base,boot,call,advance:ms=>{clock+=ms;}};
}
const input={phone:PHONE,consent:true};
async function captcha(s) { return s.call('/api/captcha',input); }
async function send(s) { return s.call('/api/send',{...input,captchaCode:'AB12'}); }
async function login(s) { return s.call('/api/login',{...input,smsCode:'1234'}); }

const cases = [
  ['手机号→图形验证→短信→JWT 完整流程',async s=>{
    assert.equal((await captcha(s)).status,200);
    assert.equal(s.official.calls.length,1);
    assert.equal((await send(s)).status,200);
    const r=await login(s);
    assert.equal(r.status,200); assert.match(r.data.token,/^Bearer eyJ/);
    assert.deepEqual(s.official.calls.map(x=>x.operation),['captcha','sms','login']);
    assert.deepEqual(s.official.calls[1].data,{mobile:PHONE,userInputCode:'AB12',key:'synthetic-key'});
    assert.equal(s.official.calls[2].data.businessType,'510001');
    assert.equal(r.data.info.decodedOnly,true);
    assert.match(r.headers.get('cache-control'),/no-store/);
  }],
  ['只获取图形验证码不会发送短信',async s=>{
    await captcha(s); assert.deepEqual(s.official.calls.map(x=>x.operation),['captcha']);
  }],
  ['拒绝非法手机号',async s=>{
    assert.equal((await s.call('/api/captcha',{phone:'not-a-number',consent:true})).status,400);
    assert.equal(s.official.calls.length,0);
  }],
  ['未同意条款不请求官方接口',async s=>{
    assert.equal((await s.call('/api/captcha',{phone:PHONE,consent:false})).status,400);
    assert.equal(s.official.calls.length,0);
  }],
  ['没有图形验证码不能发短信',async s=>{
    assert.equal((await send(s)).data.code,'CAPTCHA_EXPIRED');
    assert.equal(s.official.calls.length,0);
  }],
  ['手机号改变必须重取图形验证码',async s=>{
    await captcha(s);
    const r=await s.call('/api/send',{phone:'13800000000',consent:true,captchaCode:'AB12'});
    assert.equal(r.data.code,'CAPTCHA_EXPIRED');
    assert.equal(s.official.calls.length,1);
  }],
  ['发送成功后冷却 60 秒且不重复请求',async s=>{
    await captcha(s); await send(s);
    assert.equal((await send(s)).data.code,'SMS_COOLDOWN');
    assert.equal(s.official.calls.filter(x=>x.operation==='sms').length,1);
  }],
  ['短信结果不明保护且允许收到短信后登录',async s=>{
    await captcha(s); s.official.mode='timeout';
    const r=await send(s);
    assert.equal(r.data.code,'SMS_UNCERTAIN'); assert.equal(r.data.smsReady,true);
    assert.equal((await send(s)).data.code,'SMS_COOLDOWN');
    s.official.mode='ok'; assert.equal((await login(s)).status,200);
  }],
  ['图形验证码被拒绝后不可直接登录',async s=>{
    await captcha(s); s.official.mode='wrong';
    assert.equal((await send(s)).data.code,'SMS_REJECTED');
    assert.equal((await login(s)).data.code,'SMS_REQUIRED');
  }],
  ['无短信流程不尝试登录',async s=>{
    assert.equal((await login(s)).data.code,'SMS_REQUIRED');
    assert.equal(s.official.calls.length,0);
  }],
  ['验证码格式本地拦截',async s=>{
    await captcha(s); await send(s);
    const r=await s.call('/api/login',{...input,smsCode:'12ab'});
    assert.equal(r.data.code,'SMS_INPUT');
    assert.equal(s.official.calls.filter(x=>x.operation==='login').length,0);
  }],
  ['CSRF 缺失阻止官方请求',async s=>{
    const r=await s.call('/api/captcha',input,{'X-CSRF-Token':''});
    assert.equal(r.status,403); assert.equal(s.official.calls.length,0);
  }],
  ['跨站 Origin 阻止官方请求',async s=>{
    assert.equal((await s.call('/api/captcha',input,{Origin:'https://evil.invalid'})).status,403);
    assert.equal(s.official.calls.length,0);
  }],
  ['DNS 重绑定 Host 阻止访问',async s=>{
    const result=await new Promise((resolve,reject)=>{
      const req=http.get({hostname:'127.0.0.1',port:s.port,path:'/api/bootstrap',
        headers:{Host:`evil.invalid:${s.port}`}},res=>{
        res.resume();res.on('end',()=>resolve(res.statusCode));
      });req.on('error',reject);
    });
    assert.equal(result,403);
  }],
  ['过大的 JSON 拦截',async s=>{
    assert.equal((await s.call('/api/captcha',{pad:'x'.repeat(5000)})).status,413);
  }],
  ['本地会话到期后不能请求验证码',async s=>{
    s.advance(16*60*1000);
    assert.equal((await captcha(s)).data.code,'SESSION_EXPIRED');
  }],
  ['图形验证码五分钟后过期',async s=>{
    await captcha(s); s.advance(6*60*1000);
    assert.equal((await send(s)).data.code,'CAPTCHA_EXPIRED');
  }],
  ['并发操作拦截',async s=>{
    let release; s.official.gate=new Promise(resolve=>{release=resolve;});
    const a=captcha(s);
    for(let n=0;n<50&&!s.official.calls.length;n++) await new Promise(setImmediate);
    const b=await captcha(s);
    release(); await a;
    assert.equal(b.data.code,'OPERATION_BUSY');
  }],
  ['验证码失败信息不回显号码和验证码',async s=>{
    await captcha(s); await send(s);s.official.mode='reject-login';
    const r=await login(s);
    assert.equal(r.status,400);
    assert.ok(!r.data.message.includes(PHONE)); assert.ok(!r.data.message.includes('1234'));
  }],
  ['登录每十分钟最多五次不循环猜码',async s=>{
    await captcha(s);await send(s);s.official.mode='reject-login';
    for(let n=0;n<5;n++) await login(s);
    assert.equal((await login(s)).data.code,'LOGIN_LIMIT');
    assert.equal(s.official.calls.filter(x=>x.operation==='login').length,5);
  }],
  ['同号码每小时短信次数限制',async s=>{
    for(let n=0;n<3;n++){ await captcha(s);await send(s);s.advance(61000); }
    await captcha(s);
    assert.equal((await send(s)).data.code,'SMS_LIMIT');
    assert.equal(s.official.calls.filter(x=>x.operation==='sms').length,3);
  }],
  ['清除页面后不能复用短信状态',async s=>{
    await captcha(s);await send(s);await s.call('/api/clear',{});
    assert.equal((await login(s)).data.code,'SMS_REQUIRED');
  }],
  ['静态页面与接口 no-store 和 CSP',async s=>{
    const r=await fetch(s.base+'/');
    assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);
    assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.match(await r.text(),/ZEEKR_TOKEN/);
  }],
];
for(const [name,fn] of cases) test(name,async()=>{
  const s=await setup();try{await fn(s);}finally{await s.app.close();}
});
test('JWT 仅解析元信息不假称鉴权通过',()=>{
  const result=jwtInfo(fakeJWT());
  assert.equal(result.info.hasAccountId,true);assert.equal(result.info.hasDeviceId,true);
  assert.equal(result.info.decodedOnly,true);assert.equal(result.info.account,'12***56');
});
test('拒绝非 JWT 官方返回',()=>{ assert.throws(()=>jwtInfo('not-a-token')); });
test('错误信息脱敏',()=>{
  const text=sanitize('phone '+PHONE+' token '+fakeJWT()+' otp 1234',[PHONE,'1234']);
  assert.ok(!text.includes(PHONE));assert.ok(!text.includes(fakeJWT()));assert.ok(!text.includes('1234'));
});
test('验证码识别 PNG 与 JPEG 不接受 HTML',()=>{
  assert.match(captchaImage(PNG), /^data:image\/png;base64,/);
  assert.match(captchaImage(Buffer.from([255,216,255,224,0,16]).toString('base64')),
    /^data:image\/jpeg;base64,/);
  assert.throws(()=>captchaImage(Buffer.from('<svg onload=alert(1)>').toString('base64')));
});
module.exports={FakeOfficial,PNG,fakeJWT};
