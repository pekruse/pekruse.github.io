const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname+'/Code.gs','utf8');

function harness(options={}) {
  const calls=[], events=[], emails=[];
  const properties = options.properties || {ZOOM_ACCOUNT_ID:'account',ZOOM_CLIENT_ID:'client',ZOOM_CLIENT_SECRET:'secret',ZOOM_HOST_USER_ID:'host@example.com'};
  let count=0, released=0;
  const response=(status,body)=>({getResponseCode:()=>status,getContentText:()=>JSON.stringify(body)});
  const fixedDate = class extends Date { static now(){return Date.parse('2026-11-18T12:00:00Z')} };
  const ctx = {
    Date:fixedDate,console:{error:()=>{}},
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>properties[key]})},
    Utilities:{base64Encode:s=>Buffer.from(s).toString('base64'),getUuid:()=> 'request-id',
      parseDate:s=>new Date(s.replace(' ','T')+':00-05:00'),
      formatDate:(d,z,f)=>f==='yyyy-MM-dd'?d.toISOString().slice(0,10):f==='EEE'?'Tue':'Tuesday'},
    LockService:{getScriptLock:()=>({waitLock:()=>{},releaseLock:()=>released++})},
    UrlFetchApp:{fetch:(url,opts={})=>{
      calls.push({url,opts});
      if(url.includes('tokeninfo'))return response(200,{aud:'970227434245-4cfu822ti8gc29jcjplmshpekqae4gfa.apps.googleusercontent.com',iss:'accounts.google.com',exp:9999999999,email_verified:true,email:'guest@example.com'});
      if(url.includes('/oauth/token'))return response(options.authFail?401:200,{access_token:'private-token'});
      if(opts.method==='delete')return response(204,{});
      if(url.endsWith('/meetings')){count++;return response(options.createFail?429:201,{id:123450+count,join_url:options.badLink?'https://evil.example/j/123':'https://zoom.us/j/'+(123450+count),start_url:'host-secret'});}
      throw Error('Unexpected fetch');
    }},
    Calendar:{Freebusy:{query:()=>({calendars:{'pekruse504@gmail.com':{busy:options.busy?[{}]:[]}}})},
      Events:{insert:event=>{if(options.calendarFail)throw Error('Calendar rejected');events.push(event);return {id:'event',htmlLink:'https://calendar.google.com/event',hangoutLink:event.conferenceData?'https://meet.google.com/abc':''}}}},
    MailApp:{sendEmail:(...args)=>{if(options.mailFail)throw Error('Mail failed');emails.push(args)}}
  };
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const book=(format='Zoom')=>ctx.reserve({token:'google-token',date:'2026-11-24',start:'14:00',end:'14:30',format,address:'Office'});
  return {ctx,book,calls,events,emails,released:()=>released};
}

test('each booking receives a new scheduled meeting and the same attendee link everywhere',()=>{
  const h=harness(), a=h.book(), b=h.book();
  assert.notEqual(a.zoom,b.zoom);
  assert.equal(h.events[0].location,a.zoom);
  assert.ok(h.events[0].description.includes(a.zoom));
  assert.ok(h.emails[0][2].includes(a.zoom));
  assert.ok(!JSON.stringify([a,h.events,h.emails]).includes('host-secret'));
  assert.ok(!JSON.stringify(a).includes('private-token'));
  const payload=JSON.parse(h.calls.find(c=>c.url.endsWith('/meetings')).opts.payload);
  assert.equal(payload.type,2);assert.equal(payload.settings.use_pmi,false);
  assert.equal(payload.duration,30);assert.equal(payload.start_time,'2026-11-24T19:00:00.000Z');
  assert.equal(h.released(),2);
});
test('a shared Zoom link alone no longer enables Zoom',()=>{
  const h=harness({properties:{ZOOM_JOIN_URL:'https://zoom.us/j/111'}});
  assert.equal(h.ctx.zoomConfiguration(),null);assert.throws(()=>h.book(),/not available/);
  assert.equal(h.events.length,0);
});
for(const flag of ['authFail','createFail','badLink']) test(flag+' prevents calendar insertion',()=>{
  const h=harness({[flag]:true});assert.throws(()=>h.book());
  assert.equal(h.events.length,0);assert.equal(h.emails.length,0);assert.equal(h.released(),1);
  if(flag==='badLink')assert.equal(h.calls.at(-1).opts.method,'delete');
});
test('conflicting time does not create a Zoom meeting',()=>{
  const h=harness({busy:true});assert.throws(()=>h.book(),/overlaps/);
  assert.ok(!h.calls.some(c=>c.url.includes('zoom.us')));
});
test('calendar failure deletes the unused Zoom meeting',()=>{
  const h=harness({calendarFail:true});assert.throws(()=>h.book(),/calendar booking/);
  assert.equal(h.calls.at(-1).opts.method,'delete');assert.equal(h.emails.length,0);
});
for(const format of ['Google Meet','In person']) test(format+' works without Zoom configured',()=>{
  const h=harness({properties:{}}), result=h.book(format);
  assert.equal(result.zoom,'');assert.equal(h.events.length,1);
  assert.ok(!h.calls.some(c=>c.url.includes('zoom.us')));
  if(format==='Google Meet')assert.ok(h.events[0].conferenceData);
  else assert.equal(h.events[0].location,'Office');
});
test('email failure does not undo a successful booking',()=>{
  const h=harness({mailFail:true});assert.ok(h.book().zoom);
  assert.equal(h.events.length,1);assert.ok(!h.calls.some(c=>c.opts.method==='delete'));
});
