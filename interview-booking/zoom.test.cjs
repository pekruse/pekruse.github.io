const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const source=fs.readFileSync(__dirname+'/Code.gs','utf8');
function setup(options={}){
  let now=Date.parse('2026-11-18T12:00:00Z'),uuid=0;
  const cache=new Map(),calls=[],events=[],emails=[];
  const props={ZOOM_OAUTH_CLIENT_ID:'client',ZOOM_OAUTH_CLIENT_SECRET:'secret',ZOOM_HOST_USER_ID:'host@example.com',...options.props};
  const response=(status,body)=>({getResponseCode:()=>status,getContentText:()=>JSON.stringify(body)});
  const user=options.user||{id:'guest-id',email:'guest@example.com',display_name:'Guest'};
  const ctx={
    Date:class extends Date{static now(){return now;}},console:{log:()=>{},error:()=>{}},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null,setProperties:values=>Object.assign(props,values)})},
    CacheService:{getScriptCache:()=>({put:(k,v,ttl)=>cache.set(k,{v,until:now+ttl*1000}),get:k=>cache.has(k)&&cache.get(k).until>now?cache.get(k).v:null})},
    LockService:{getScriptLock:()=>({waitLock:()=>{},releaseLock:()=>{}})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},
      computeDigest:(a,s)=>[...crypto.createHash('sha256').update(s).digest()],base64Encode:s=>Buffer.from(s).toString('base64'),
      getUuid:()=>String(++uuid).padStart(32,'0'),
      parseDate:s=>new Date(s.replace(' ','T')+':00-05:00'),
      formatDate:(d,z,f)=>f==='yyyy-MM-dd'?d.toISOString().slice(0,10):f==='EEE'?'Tue':'Tuesday'},
    HtmlService:{createHtmlOutput:s=>({html:s})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({text:s,setMimeType(){return this;}})},
    UrlFetchApp:{fetch:(url,opts={})=>{
      calls.push({url,opts});
      if(url.includes('tokeninfo'))return response(options.badGoogle?401:200,{aud:'970227434245-4cfu822ti8gc29jcjplmshpekqae4gfa.apps.googleusercontent.com',iss:'accounts.google.com',exp:9999999999,email_verified:true,email:'google@example.com'});
      if(url.endsWith('/oauth/token'))return response(options.tokenFail?401:200,{access_token:'access-private',refresh_token:'refresh-private',expires_in:3600});
      if(url.endsWith('/users/me'))return response(200,user);
      if(opts.method==='delete')return response(204,{});
      if(url.endsWith('/users/me/meetings'))return response(options.createFail?429:201,{id:123456789,join_url:options.badJoin?'https://evil.example/meeting':'https://zoom.us/j/123456789',start_url:'host-start-private'});
      throw Error('Unexpected fetch '+url);
    }},
    Calendar:{Freebusy:{query:()=>({calendars:{'pekruse504@gmail.com':{busy:options.busy?[{}]:[]}}})},Events:{insert:e=>{if(options.calendarFail)throw Error('calendar failure');events.push(e);return{id:'event',htmlLink:'https://calendar.google.com/event',hangoutLink:e.conferenceData?'https://meet.google.com/abc':''};}}},
    MailApp:{sendEmail:(...args)=>emails.push(args)}
  };
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const verifier='a'.repeat(64),challenge=ctx.zoomHash(verifier);
  const login=()=>{
    const flow=ctx.zoomStartFlow(challenge,'visitor');
    const result=ctx.zoomOAuthCallback({state:flow.state,code:'code'});
    const status=ctx.zoomFlowStatus({state:flow.state,verifier});
    return{flow,result,status};
  };
  const host=()=>ctx.zoomStoreHost({access_token:'host-access',refresh_token:'host-refresh',expires_in:3600},{id:'host-id',email:'host@example.com',name:'Host'});
  const book=(format='Zoom',extra={})=>ctx.reserve({format,date:'2026-11-24',start:'14:00',end:'14:30',token:'google-token',address:'Office',...extra});
  return{ctx,cache,calls,events,emails,props,verifier,challenge,login,host,book,advance:ms=>now+=ms};
}
test('visitor sign-in verifies identity and issues only a browser-bound session',()=>{
  const h=setup(),{status}=h.login();assert.equal(status.status,'complete');assert.equal(status.email,'guest@example.com');
  assert.ok(!JSON.stringify(status).includes('access-private'));assert.ok(!JSON.stringify(status).includes('refresh-private'));
  assert.equal(h.ctx.zoomBookingIdentity({zoomSession:status.session,zoomVerifier:h.verifier}).id,'guest-id');
  assert.equal(h.props.ZOOM_OAUTH_HOST_REFRESH_TOKEN,undefined);
});
test('wrong proof cannot redeem a Zoom session',()=>{
  const h=setup(),{flow,status}=h.login();
  assert.throws(()=>h.ctx.zoomFlowStatus({state:flow.state,verifier:'b'.repeat(64)}),/expired/);
  assert.throws(()=>h.ctx.zoomBookingIdentity({zoomSession:status.session,zoomVerifier:'b'.repeat(64)}),/expired/);
});
test('expired session is rejected',()=>{
  const h=setup(),{status}=h.login();h.advance(1800001);
  assert.throws(()=>h.ctx.zoomBookingIdentity({zoomSession:status.session,zoomVerifier:h.verifier}),/expired/);
});
test('callback state cannot be replayed',()=>{
  const h=setup(),{flow}=h.login(),before=h.calls.length;
  const replay=h.ctx.zoomOAuthCallback({state:flow.state,code:'code'});assert.match(replay.html,/already used/);assert.equal(h.calls.length,before);
});
test('canceled authorization produces a recoverable failure',()=>{
  const h=setup(),f=h.ctx.zoomStartFlow(h.challenge,'visitor');
  h.ctx.zoomOAuthCallback({state:f.state,error:'access_denied'});
  assert.equal(h.ctx.zoomFlowStatus({state:f.state,verifier:h.verifier}).status,'error');assert.equal(h.calls.length,0);
});
test('unknown OAuth state never exchanges a code',()=>{
  const h=setup();assert.match(h.ctx.zoomOAuthCallback({state:'f'.repeat(64),code:'bad'}).html,/expired/);assert.equal(h.calls.length,0);
});
test('only the configured host can authorize meeting creation',()=>{
  const h=setup();assert.throws(()=>h.ctx.zoomStoreHost({access_token:'bad',refresh_token:'bad'},{id:'attacker',email:'attacker@example.com'}),/host account/);
  assert.equal(h.props.ZOOM_OAUTH_HOST_REFRESH_TOKEN,undefined);h.host();assert.equal(h.ctx.zoomHostReady(),true);
});
test('host refresh authorization rotates and retains the new token',()=>{
  const h=setup();h.host();h.advance(3600001);assert.equal(h.ctx.zoomHostAccessToken(),'access-private');
  assert.equal(h.props.ZOOM_OAUTH_HOST_REFRESH_TOKEN,'refresh-private');
  assert.equal(h.calls[0].opts.payload.grant_type,'refresh_token');
});
test('Zoom booking rejects Google-only authentication',()=>{
  const h=setup();h.host();assert.throws(()=>h.book(),/Sign in with Zoom/);assert.equal(h.events.length,0);
});
test('Zoom session books as visitor while meeting uses the authorized host',()=>{
  const h=setup();h.host();const {status}=h.login();
  const receipt=h.book('Zoom',{zoomSession:status.session,zoomVerifier:h.verifier});
  assert.equal(receipt.email,'guest@example.com');assert.equal(h.events[0].attendees[0].email,'guest@example.com');
  const request=h.calls.find(c=>c.url.endsWith('/users/me/meetings'));
  assert.equal(request.opts.headers.Authorization,'Bearer host-access');assert.equal(JSON.parse(request.opts.payload).settings.use_pmi,false);
  assert.ok(!JSON.stringify(receipt).includes('host-access'));assert.ok(!JSON.stringify(h.emails).includes('host-start-private'));
  assert.ok(!h.calls.some(c=>c.url.includes('tokeninfo')));
});
test('Google Meet retains Google identity verification',()=>{
  const h=setup();assert.equal(h.book('Google Meet').email,'google@example.com');assert.ok(h.events[0].conferenceData);
});
test('invalid Google identity is rejected for Google Meet',()=>{
  const h=setup({badGoogle:true});assert.throws(()=>h.book('Google Meet'),/Sign in again/);assert.equal(h.events.length,0);
});
test('conflicts do not create meetings',()=>{
  const h=setup({busy:true});h.host();const {status}=h.login();assert.throws(()=>h.book('Zoom',{zoomSession:status.session,zoomVerifier:h.verifier}),/overlaps/);
  assert.ok(!h.calls.some(c=>c.url.endsWith('/meetings')));
});
for(const option of ['createFail','badJoin','calendarFail'])test(option+' does not confirm a failed Zoom booking',()=>{
  const h=setup({[option]:true});h.host();const {status}=h.login();assert.throws(()=>h.book('Zoom',{zoomSession:status.session,zoomVerifier:h.verifier}));
  assert.equal(h.emails.length,0);if(option!=='createFail')assert.ok(h.calls.some(c=>c.opts.method==='delete'));
});
test('public OAuth start cannot request host authorization',()=>{
  const h=setup();const result=h.ctx.doGet({parameter:{auth:'zoom-start',challenge:h.challenge,kind:'host'}});
  const flow=JSON.parse(result.text),saved=JSON.parse(h.cache.get('zoom-flow:'+flow.state).v);assert.equal(saved.kind,'visitor');
});

test('missing create permission reports scope fix and safe diagnostic codes',()=>{
  const h=setup();
  const err=h.ctx.zoomMeetingFailure({getResponseCode:()=>400,getContentText:()=>JSON.stringify({code:4711,message:'Invalid access token SECRET does not contain scopes:[meeting:write:meeting]'})});
  assert.match(err.message,/HTTP 400, Zoom code 4711/);assert.match(err.message,/meeting:write:meeting/);assert.ok(!err.message.includes('SECRET'));
});
test('invalid token, rate limiting and unexpected responses have useful safe errors',()=>{
  const h=setup();
  for(const [status,body,pattern] of [[401,'{"code":124}',/authorizeZoomHost/],[429,'{}',/try again later/],[502,'<html>SECRET<\/html>',/HTTP 502/]]){
    const err=h.ctx.zoomMeetingFailure({getResponseCode:()=>status,getContentText:()=>body});
    assert.match(err.message,pattern);assert.match(err.message,/No booking was made/);assert.ok(!err.message.includes('SECRET'));
  }
});

test('host signing in as a visitor replaces the superseded host token pair',()=>{
  const h=setup({user:{id:'host-id',email:'host@example.com',display_name:'Host'}});
  h.host();const {status}=h.login();
  assert.equal(status.status,'complete');
  assert.equal(h.props.ZOOM_OAUTH_HOST_ACCESS_TOKEN,'access-private');
  assert.equal(h.props.ZOOM_OAUTH_HOST_REFRESH_TOKEN,'refresh-private');
  h.book('Zoom',{zoomSession:status.session,zoomVerifier:h.verifier});
  const call=h.calls.find(c=>c.url.endsWith('/users/me/meetings'));
  assert.equal(call.opts.headers.Authorization,'Bearer access-private');
});
test('another visitor cannot replace an existing host token pair',()=>{
  const h=setup();h.host();h.login();
  assert.equal(h.props.ZOOM_OAUTH_HOST_ID,'host-id');
  assert.equal(h.props.ZOOM_OAUTH_HOST_ACCESS_TOKEN,'host-access');
  assert.equal(h.props.ZOOM_OAUTH_HOST_REFRESH_TOKEN,'host-refresh');
});
test('host email alone cannot establish a host connection through visitor login',()=>{
  const h=setup({user:{id:'host-id',email:'host@example.com',display_name:'Host'}});
  assert.equal(h.login().status.status,'complete');
  assert.equal(h.props.ZOOM_OAUTH_HOST_ID,undefined);
  assert.equal(h.props.ZOOM_OAUTH_HOST_REFRESH_TOKEN,undefined);
});
