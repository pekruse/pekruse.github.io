const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const source=fs.readFileSync(__dirname+'/Code.gs','utf8');
const watchKey=id=>'BOOKING_WATCH_V1:'+id;

for(const [response,label] of [['accepted','Yes'],['tentative','Maybe'],['declined','No']])test('Calendar '+response+' emails the organizer without cancelling anything',()=>{
  const h=managed(),id=h.credentials.id,n=h.emails.length,initial=h.records.get(id),deletes=h.calls.filter(c=>c.opts.method==='delete').length;
  initial.attendees[0].responseStatus=response;
  h.ctx.Calendar.Events.patch=()=>{throw Error('Watcher must never edit Calendar');};
  h.ctx.Calendar.Events.remove=()=>{throw Error('Watcher must never remove Calendar events');};
  h.ctx.reconcileBookingResponses();
  assert.equal(h.records.get(id),initial);assert.notEqual(initial.status,'cancelled');
  assert.equal(h.calls.filter(c=>c.opts.method==='delete').length,deletes);
  assert.equal(h.emails.length,n+1);assert.equal(h.emails.at(-1)[0],'pekruse504@gmail.com');
  assert.match(h.emails.at(-1)[1],new RegExp(label));assert.match(h.emails.at(-1)[2],/guest@example.com/);
  h.ctx.reconcileBookingResponses();assert.equal(h.emails.length,n+1);
});
test('changed response sends a new update while repeated unchanged responses do not',()=>{
  const h=managed(),event=h.records.get(h.credentials.id),n=h.emails.length;
  for(const status of ['accepted','accepted','tentative','declined']){
    event.attendees[0].responseStatus=status;h.ctx.reconcileBookingResponses();
  }
  assert.equal(h.emails.length,n+3);assert.notEqual(event.status,'cancelled');
});
test('actual Calendar cancellation sends cancellation emails using retained booking details',()=>{
  const h=managed(),id=h.credentials.id,n=h.emails.length,calls=h.calls.length;
  h.records.set(id,{id,status:'cancelled'});h.ctx.reconcileBookingResponses();
  assert.equal(h.emails.length,n+2);assert.match(h.emails.at(-1)[1],/cancelled/);
  assert.match(h.emails.at(-1)[2],/Zoom/);assert.equal(h.calls.length,calls);
  h.ctx.reconcileBookingResponses();assert.equal(h.emails.length,n+2);
});
test('transient Calendar errors do not generate false cancellation emails',()=>{
  const h=managed(),n=h.emails.length;
  h.ctx.Calendar.Events.get=()=>{throw Error('503 service unavailable');};
  assert.throws(()=>h.ctx.reconcileBookingResponses(),/retry/);assert.equal(h.emails.length,n);
});
test('missing Calendar event generates an actual cancellation notification',()=>{
  const h=managed(),n=h.emails.length;h.records.delete(h.credentials.id);
  h.ctx.reconcileBookingResponses();assert.equal(h.emails.length,n+2);
});
test('response email failure is retried without losing the response change',()=>{
  const h=managed(),send=h.ctx.MailApp.sendEmail,n=h.emails.length;
  h.ctx.MailApp.sendEmail=()=>{throw Error('quota');};
  h.records.get(h.credentials.id).attendees[0].responseStatus='accepted';
  assert.throws(()=>h.ctx.reconcileBookingResponses(),/retry/);assert.equal(h.emails.length,n);
  h.ctx.MailApp.sendEmail=send;h.ctx.reconcileBookingResponses();assert.equal(h.emails.length,n+1);
  h.ctx.reconcileBookingResponses();assert.equal(h.emails.length,n+1);
});
test('website cancellation retries only the failed recipient and does not duplicate successful email',()=>{
  const h=managed(),send=h.ctx.MailApp.sendEmail,n=h.emails.length;
  h.ctx.MailApp.sendEmail=(...args)=>{if(args[0]==='pekruse504@gmail.com')throw Error('quota');send(...args);};
  assert.match(h.call('cancel').warning,/email/);assert.equal(h.emails.length,n+1);
  h.ctx.MailApp.sendEmail=send;h.ctx.reconcileBookingResponses();assert.equal(h.emails.length,n+2);
  assert.equal(h.emails.at(-1)[0],'pekruse504@gmail.com');
});
test('existing managed bookings report current responses on installation and unrelated events are ignored',()=>{
  const h=managed(),id=h.credentials.id,n=h.emails.length;
  delete h.props[watchKey(id)];h.records.get(id).attendees[0].responseStatus='declined';
  h.records.set('other',{id:'other',start:{dateTime:'2026-11-24T19:00:00Z'},end:{dateTime:'2026-11-24T19:30:00Z'},attendees:[{email:'guest@example.com',responseStatus:'accepted'}]});
  h.ctx.reconcileBookingResponses();assert.equal(h.emails.length,n+1);
  assert.notEqual(h.records.get(id).status,'cancelled');assert.equal(h.props[watchKey('other')],undefined);
});
test('installing notifications twice creates one Calendar trigger and one fallback timer',()=>{
  const h=managed(),triggers=[],sources={CALENDAR:'calendar',CLOCK:'clock'};
  h.ctx.ScriptApp={TriggerSource:sources,getProjectTriggers:()=>triggers,newTrigger:name=>{
    let source;const builder={forUserCalendar:()=>{source=sources.CALENDAR;return builder;},onEventUpdated:()=>builder,
      timeBased:()=>{source=sources.CLOCK;return builder;},everyMinutes:n=>{assert.equal(n,5);return builder;},
      create:()=>triggers.push({getHandlerFunction:()=>name,getTriggerSource:()=>source})};return builder;
  }};
  h.ctx.installBookingResponseNotifications();h.ctx.installBookingResponseNotifications();assert.equal(triggers.length,2);
});
function setup(options={}){
  let now=Date.parse('2026-11-18T12:00:00Z'),uuid=0;
  const cache=new Map(),calls=[],events=[],emails=[],records=new Map();let revision=0,meetingId=123456789,zoomPatchCount=0;const zoomRecords=new Map();
  const props={ZOOM_OAUTH_CLIENT_ID:'client',ZOOM_OAUTH_CLIENT_SECRET:'secret',ZOOM_HOST_USER_ID:'host@example.com',...options.props};
  const response=(status,body)=>({getResponseCode:()=>status,getContentText:()=>JSON.stringify(body)});
  const user=options.user||{id:'guest-id',email:'guest@example.com',display_name:'Guest'};
  const ctx={
    Date:class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}},console:{log:()=>{},error:()=>{}},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null,setProperties:values=>Object.assign(props,values),getProperties:()=>({...props}),deleteProperty:k=>delete props[k]})},
    CacheService:{getScriptCache:()=>({put:(k,v,ttl)=>cache.set(k,{v,until:now+ttl*1000}),get:k=>cache.has(k)&&cache.get(k).until>now?cache.get(k).v:null})},
    LockService:{getScriptLock:()=>({waitLock:()=>{},releaseLock:()=>{}})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},
      computeHmacSha256Signature:(s,key)=>[...crypto.createHmac('sha256',key).update(s).digest()],
      computeDigest:(a,s)=>[...crypto.createHash('sha256').update(s).digest()],base64Encode:s=>Buffer.from(s).toString('base64'),
      getUuid:()=>String(++uuid).padStart(32,'0'),
      parseDate:s=>new Date(s.replace(' ','T')+':00-05:00'),
      formatDate:(d,z,f)=>{
        const parts=new Intl.DateTimeFormat('en-US',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);
        const part=k=>parts.find(p=>p.type===k).value;
        if(f==='yyyy-MM-dd')return part('year')+'-'+part('month')+'-'+part('day');
        if(f==='HH:mm')return part('hour')+':'+part('minute');
        if(f==="yyyy-MM-dd'T'HH:mm:ss")return part('year')+'-'+part('month')+'-'+part('day')+'T'+part('hour')+':'+part('minute')+':00';
        if(f==='EEE')return new Intl.DateTimeFormat('en-US',{timeZone:z,weekday:'short'}).format(d);
        return new Intl.DateTimeFormat('en-US',{timeZone:z,dateStyle:'full',timeStyle:'short'}).format(d);
      }},
    HtmlService:{createHtmlOutput:s=>({html:s})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({text:s,setMimeType(){return this;}})},
    UrlFetchApp:{fetch:(url,opts={})=>{
      calls.push({url,opts});
      if(url.includes('tokeninfo'))return response(options.badGoogle?401:200,{aud:'970227434245-4cfu822ti8gc29jcjplmshpekqae4gfa.apps.googleusercontent.com',iss:'accounts.google.com',exp:9999999999,email_verified:true,email:'google@example.com'});
      if(url.endsWith('/oauth/token'))return response(options.tokenFail?401:200,{access_token:'access-private',refresh_token:'refresh-private',expires_in:3600});
      if(url.endsWith('/users/me'))return response(200,user);
      if(opts.method==='delete')return response(options.deleteFail?403:204,{});
      if(url.endsWith('/users/me/meetings')){
        const id=String(++meetingId),body={id,...(options.zoomStartTime?{start_time:options.zoomStartTime}:{}),join_url:options.badJoin?'https://evil.example/meeting':'https://zoom.us/j/'+id,start_url:'host-start-private'};
        if(!options.createFail)zoomRecords.set(id,JSON.parse(opts.payload));
        return response(options.createFail?429:201,body);
      }
      if(opts.method==='patch'&&url.includes('/meetings/')){
        zoomPatchCount++;
        if(options.zoomPatchStatus)return response(options.zoomPatchStatus,{code:options.zoomPatchStatus===400?4711:124,message:'Cannot update'});
        if(options.rollbackFail&&zoomPatchCount>1)return response(500,{});
        const id=url.split('/').at(-1);Object.assign(zoomRecords.get(id)||{},JSON.parse(opts.payload));
        if(options.zoomTimeoutOnce&&zoomPatchCount===1)throw Error('network timeout');
        return response(204,{});
      }
      throw Error('Unexpected fetch '+url);
    }},
    Calendar:{Freebusy:{query:()=>({calendars:{'pekruse504@gmail.com':{busy:options.busy?[{}]:[]}}})},Events:{
      insert:e=>{if(options.calendarFail)throw Error('calendar failure');events.push(e);const saved={...e,id:e.id||'event',etag:'v'+(++revision),htmlLink:'https://calendar.google.com/event',hangoutLink:e.conferenceData?'https://meet.google.com/abc':''};records.set(saved.id,saved);return structuredClone(saved);},
      get:(cal,id)=>{if(!records.has(id))throw Error('404 not found');return structuredClone(records.get(id));},
      patch:(patch,cal,id)=>{if(options.patchFail)throw Error('patch failed');const previous=records.get(id);const saved={...previous,...structuredClone(patch),etag:'v'+(++revision)};if(patch.conferenceData===null)saved.hangoutLink='';else if(patch.conferenceData)saved.hangoutLink='https://meet.google.com/new';records.set(id,saved);if(options.calendarAppliedTimeout&&patch.extendedProperties?.private?.bookingOperation)throw Error('calendar response lost');return structuredClone(saved);},
      remove:(cal,id)=>{if(options.removeFail)throw Error('remove failed');records.set(id,{id,status:'cancelled'});},
      list:(cal,query)=>({items:[...records.values(),...(options.conflicts||[])].filter(e=>e.status!=='cancelled'&&Date.parse(e.start.dateTime)<Date.parse(query.timeMax)&&Date.parse(e.end.dateTime)>Date.parse(query.timeMin))})
    }},
    MailApp:{sendEmail:(...args)=>emails.push(args)}
  };
  ctx.structuredClone=structuredClone;
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
  return{ctx,cache,calls,events,emails,props,records,zoomRecords,verifier,challenge,login,host,book,advance:ms=>now+=ms};
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

function managed(options={}){
  const h=setup(options);h.host();const {status}=h.login();const receipt=h.book('Zoom',{zoomSession:status.session,zoomVerifier:h.verifier});
  const credentials=Object.fromEntries(new URL(receipt.manageUrl).hash.slice(1).split('&').map(p=>p.split('=').map(decodeURIComponent)));
  const read=()=>h.ctx.manageBooking({...credentials,management:'read'});
  const call=(management,input={})=>h.ctx.manageBooking({...credentials,management,version:read().booking.version,...input});
  return {...h,receipt,credentials,read,call};
}

test('confirmation includes a website management link without a host token',()=>{
  const h=managed();assert.match(h.receipt.manageUrl,/manage-booking.html#id=/);
  assert.match(h.emails[0][2],/Manage booking/);assert.match(h.emails[0][3].htmlBody,/Manage booking/);
  const data=h.read().booking;assert.equal(data.format,'Zoom');assert.equal(data.email,'guest@example.com');
  assert.ok(!JSON.stringify(data).includes('host-access'));
});
test('management rejects wrong keys and cannot address another event',()=>{
  const h=managed();assert.throws(()=>h.ctx.manageBooking({...h.credentials,key:'a'.repeat(64),management:'cancel'}),/invalid/);
  assert.throws(()=>h.ctx.manageBooking({...h.credentials,id:'f'.repeat(32),management:'read'}),/invalid/);
  assert.equal(h.events.length,1);assert.equal(h.records.get(h.credentials.id).status,undefined);
});
test('read and openings are read-only, and own reservation remains available',()=>{
  const h=managed(),before=h.calls.length;
  const data=h.call('windows',{date:'2026-11-24'});assert.equal(data.openings[0].start,'14:00');assert.equal(data.openings[0].end,'17:00');
  assert.equal(h.calls.length,before);assert.equal(h.records.size,1);
});
test('reschedule updates the existing Zoom meeting, preserves its link and sends one update',()=>{
  const h=managed(),before=h.read().booking,oldId=h.records.get(h.credentials.id).extendedProperties.private.zoomMeetingId;
  const creates=h.calls.filter(c=>c.url.endsWith('/users/me/meetings')).length,emails=h.emails.length;
  const updated=h.call('save',{date:'2026-11-26',start:'15:00',end:'15:45',format:'Zoom'});
  assert.equal(updated.booking.date,'2026-11-26');assert.equal(updated.booking.start,'15:00');
  assert.equal(updated.booking.join,before.join);assert.equal(h.events.length,1);
  assert.equal(h.records.get(h.credentials.id).extendedProperties.private.zoomMeetingId,oldId);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/users/me/meetings')).length,creates);
  assert.ok(!h.calls.some(c=>c.opts.method==='delete'));
  const update=h.calls.find(c=>c.opts.method==='patch'&&c.url.endsWith('/'+oldId));
  assert.equal(JSON.parse(update.opts.payload).start_time,'2026-11-26T15:00:00');
  assert.equal(JSON.parse(update.opts.payload).duration,45);
  assert.equal(h.emails.length,emails+2);assert.match(h.emails.at(-1)[1],/updated/);
});
test('stale form cannot overwrite a successful edit',()=>{
  const h=managed(),version=h.read().booking.version;
  h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Zoom'});
  assert.throws(()=>h.call('save',{version,date:'2026-11-26',start:'16:00',end:'16:30',format:'Zoom'}),/another tab/);
});
test('conflicting reschedule does not create a replacement Zoom meeting',()=>{
  const conflict={id:'other',start:{dateTime:'2026-11-26T20:00:00Z'},end:{dateTime:'2026-11-26T21:00:00Z'}};
  const h=managed({conflicts:[conflict]}),before=h.calls.filter(c=>c.url.endsWith('/users/me/meetings')).length;
  assert.throws(()=>h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Zoom'}),/no longer available/);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/users/me/meetings')).length,before);
});
test('cancel deletes Zoom and Calendar and duplicate cancellation is harmless',()=>{
  const h=managed(),cancelled=h.call('cancel');assert.equal(cancelled.booking.status,'cancelled');
  assert.ok(h.calls.some(c=>c.opts.method==='delete'));assert.equal(h.read().booking.status,'cancelled');
  assert.equal(h.call('cancel').booking.status,'cancelled');assert.match(h.emails.at(-1)[1],/cancelled/);
});
test('Zoom deletion failure retains the reservation and allows a cancellation retry',()=>{
  const h=managed({deleteFail:true});
  assert.throws(()=>h.call('cancel'),/could not remove/);const data=h.read().booking;
  assert.equal(data.status,'confirmed');assert.equal(data.cancellationPending,true);assert.equal(data.editable,false);
});
test('calendar cancellation failure never claims that cancellation succeeded',()=>{
  const h=managed({removeFail:true});assert.throws(()=>h.call('cancel'),/not confirmed/);
  assert.equal(h.read().booking.cancellationPending,true);
});
test('edit can change format and validates required details',()=>{
  const h=managed();assert.throws(()=>h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'In person'}),/address/);
  const data=h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Phone call',phone:'+1 555 123 4567'});
  assert.equal(data.booking.format,'Phone call');assert.equal(data.booking.phone,'+1 555 123 4567');assert.equal(data.booking.join,'');
});
test('calendar update failure restores the original Zoom time without deleting it',()=>{
  const h=managed({patchFail:true}),before=h.read().booking;
  assert.throws(()=>h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Zoom'}),/previous booking is unchanged/);
  assert.equal(h.read().booking.date,before.date);assert.ok(!h.calls.some(c=>c.opts.method==='delete'));
  const updates=h.calls.filter(c=>c.opts.method==='patch');assert.equal(updates.length,2);
  assert.equal(JSON.parse(updates[0].opts.payload).start_time,'2026-11-26T15:00:00');
  assert.equal(JSON.parse(updates[1].opts.payload).start_time,'2026-11-24T14:00:00');
  const id=h.records.get(h.credentials.id).extendedProperties.private.zoomMeetingId;
  assert.equal(h.zoomRecords.get(id).start_time,'2026-11-24T14:00:00');
});
test('management rejects past dates, Wednesdays and invalid time ranges',()=>{
  const h=managed();
  for(const input of [{date:'2026-11-25',start:'15:00',end:'15:30'},{date:'2026-11-26',start:'15:00',end:'14:00'},{date:'2026-11-17',start:'15:00',end:'15:30'}])
    assert.throws(()=>h.call('save',{format:'Zoom',...input}),/future Tuesday/);
});
test('public POST management errors remain JSON without performing a mutation',()=>{
  const h=managed(),result=h.ctx.doPost({parameter:{management:'cancel',id:h.credentials.id,key:'0'.repeat(64)}});
  assert.match(JSON.parse(result.text).error,/invalid/);assert.equal(h.read().booking.status,'confirmed');
});

test('unchanged save performs no Zoom, Calendar or email mutations',()=>{
  const h=managed(),current=h.read().booking,emailCount=h.emails.length,callCount=h.calls.length;
  const result=h.call('save',{...current,version:'old-browser-version'});
  assert.equal(result.unchanged,true);assert.equal(h.emails.length,emailCount);assert.equal(h.calls.length,callCount);
  assert.equal(h.read().booking.version,current.version);
});
test('replaying an already saved selection with its old version does not email again',()=>{
  const h=managed(),version=h.read().booking.version;
  const input={version,date:'2026-11-26',start:'15:00',end:'15:30',format:'Zoom'};
  h.call('save',input);const emails=h.emails.length,calls=h.calls.length,updatedVersion=h.read().booking.version;
  for(let i=0;i<3;i++)assert.equal(h.call('save',input).unchanged,true);
  assert.equal(h.emails.length,emails);assert.equal(h.calls.length,calls);assert.equal(h.read().booking.version,updatedVersion);
});
test('irrelevant fields and whitespace do not produce duplicate updates',()=>{
  const h=managed(),current=h.read().booking,count=h.emails.length;
  assert.equal(h.call('save',{...current,address:'unused',phone:'unused',teams:'unused'}).unchanged,true);
  const updated=h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'In person',address:'Main Library'});
  const emails=h.emails.length;
  assert.equal(h.call('save',{...updated.booking,address:'  Main Library  '}).unchanged,true);
  assert.equal(h.emails.length,emails);assert.ok(emails>count);
});
test('cleanup retry after switching away from Zoom never recreates a meeting or emails again',()=>{
  const h=managed({deleteFail:true});
  const updated=h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Google Meet'});
  assert.equal(updated.booking.cleanupPending,true);
  const count=h.emails.length,creates=h.calls.filter(c=>c.url.endsWith('/users/me/meetings')).length;
  const retry=h.call('save',updated.booking);
  assert.equal(retry.unchanged,true);assert.ok(retry.warning);assert.equal(h.emails.length,count);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/users/me/meetings')).length,creates);
});

test('Zoom uses local Eastern time with no fractional UTC timestamp in winter',()=>{
  const h=setup({zoomStartTime:'2026-11-24T19:00:00Z'});h.host();
  h.ctx.createBookingZoom(new Date('2026-11-24T19:00:00Z'),30);
  const body=JSON.parse(h.calls.find(c=>c.url.endsWith('/users/me/meetings')).opts.payload);
  assert.equal(body.start_time,'2026-11-24T14:00:00');assert.equal(body.timezone,'America/New_York');
});
test('Zoom local Eastern time also accounts for daylight saving time',()=>{
  const h=setup({zoomStartTime:'2027-06-15T18:00:00Z'});h.host();
  h.ctx.createBookingZoom(new Date('2027-06-15T18:00:00Z'),30);
  const body=JSON.parse(h.calls.find(c=>c.url.endsWith('/users/me/meetings')).opts.payload);
  assert.equal(body.start_time,'2027-06-15T14:00:00');assert.equal(body.timezone,'America/New_York');
});
test('a mismatched Zoom scheduled time is cleaned up and never confirmed',()=>{
  const h=setup({zoomStartTime:'2026-11-25T00:00:00Z'});h.host();const {status}=h.login();
  assert.throws(()=>h.book('Zoom',{zoomSession:status.session,zoomVerifier:h.verifier}),/different meeting time/);
  assert.equal(h.events.length,0);assert.equal(h.emails.length,0);assert.ok(h.calls.some(c=>c.opts.method==='delete'));
});

test('missing Zoom update permission never falls back to creating or deleting a meeting',()=>{
  const h=managed({zoomPatchStatus:400}),before=h.read().booking,count=h.calls.length,emails=h.emails.length;
  assert.throws(()=>h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Zoom'}),/meeting:update:meeting/);
  const calls=h.calls.slice(count);assert.ok(!calls.some(c=>c.opts.method==='post'||c.opts.method==='delete'));
  assert.equal(h.emails.length,emails);assert.equal(h.read().booking.version,before.version);
});
test('missing original Zoom meeting never causes a silent replacement',()=>{
  const h=managed({zoomPatchStatus:404}),count=h.calls.length;
  assert.throws(()=>h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Zoom'}),/no longer available/);
  assert.ok(!h.calls.slice(count).some(c=>c.url.endsWith('/users/me/meetings')));
});
test('lost Zoom update response restores original time and never sends confirmation',()=>{
  const h=managed({zoomTimeoutOnce:true}),emails=h.emails.length;
  assert.throws(()=>h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Zoom'}),/could not be verified/);
  const id=h.records.get(h.credentials.id).extendedProperties.private.zoomMeetingId;
  assert.equal(h.zoomRecords.get(id).start_time,'2026-11-24T14:00:00');
  assert.equal(h.emails.length,emails);assert.ok(!h.calls.some(c=>c.opts.method==='delete'));
});
test('failed rollback is reported honestly and never confirms the edit',()=>{
  const h=managed({patchFail:true,rollbackFail:true}),emails=h.emails.length;
  assert.throws(()=>h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Zoom'}),/could not be restored/);
  assert.equal(h.emails.length,emails);assert.ok(!h.calls.some(c=>c.opts.method==='delete'));
});
test('lost Calendar patch response is verified without rolling back successful Zoom update',()=>{
  const h=managed({calendarAppliedTimeout:true});
  const result=h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Zoom'});
  assert.equal(result.booking.date,'2026-11-26');
  assert.equal(h.calls.filter(c=>c.opts.method==='patch').length,1);
  assert.ok(!h.calls.some(c=>c.opts.method==='delete'));
});
test('switching formats deletes obsolete Zoom once and switching back creates one new Zoom',()=>{
  const h=managed(),before=h.read().booking;
  h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Phone call',phone:'+1 555 123 4567'});
  assert.equal(h.calls.filter(c=>c.opts.method==='delete').length,1);
  const result=h.call('save',{date:'2026-11-26',start:'15:00',end:'15:30',format:'Zoom'});
  assert.notEqual(result.booking.join,before.join);assert.equal(h.calls.filter(c=>c.opts.method==='delete').length,1);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/users/me/meetings')).length,2);
});
test('Zoom update uses Eastern local time during daylight saving time',()=>{
  const h=setup();h.host();h.ctx.updateBookingZoom('123456789',new Date('2027-06-15T18:00:00Z'),45);
  const body=JSON.parse(h.calls.find(c=>c.opts.method==='patch').opts.payload);
  assert.equal(body.start_time,'2027-06-15T14:00:00');assert.equal(body.timezone,'America/New_York');assert.equal(body.duration,45);
});

