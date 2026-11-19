const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.listeners={};this.attributes={};this.dataset={};this.value='';this.textContent='';this.disabled=false;this.hidden=false;this.clientWidth=350;this.scrollHeight=100;}
  append(...nodes){this.children.push(...nodes);}
  after(node){this.afterNode=node;}
  before(node){this.beforeNode=node;}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  async dispatchEvent(event){for(const fn of this.listeners[event.type]||[])await fn(event);return !event.defaultPrevented;}
  click(){if(this.disabled)return;return this.dispatchEvent({type:'click'});}
  focus(){} scrollIntoView(){}
  querySelectorAll(selector){const tags=selector.split(',');return this.children.flatMap(c=>[...(tags.includes(c.tagName)?[c]:[]),...c.querySelectorAll(selector)]);}
  querySelector(selector){return this.map?.[selector]||this.querySelectorAll(selector)[0]||null;}
}
function setup({signed=true,formats=true,failVerify=false,deferDates=false}={}){
  const root=new Element(),booking=new Element('form'),log=new Element(),composer=new Element('form'),input=new Element('textarea'),send=new Element('button'),suggestions=new Element(),summary=new Element(),reset=new Element('button');
  composer.map={textarea:input,button:send};root.map={'[role=log]':log,form:composer,'.assistant-suggestions':suggestions,'#assistant-selection':summary,'.assistant-reset':reset};root.append(log,suggestions,composer,reset);composer.append(input,send);
  const values={date:'2026-11-24',start:'14:00',end:'14:30',format:'Google Meet',address:'',phone:'',teams:'',token:signed?'header.'+Buffer.from(JSON.stringify({exp:9999999999})).toString('base64')+'.sig':''};
  booking.elements=Object.fromEntries(Object.entries(values).map(([k,v])=>{const el=new Element('input');el.value=v;return[k,el];}));
  booking.elements.format.options=['Google Meet','Zoom','Microsoft Teams','Phone call','In person'].map(value=>({value,disabled:!formats&&value!=='Google Meet'&&value!=='In person'}));
  let submits=0,verifies=0,ranges=0,releaseDates;
  const data={openings:[{date:'2026-11-24',start:840,end:1020}]};
  const datesPromise=deferDates?new Promise(resolve=>releaseDates=()=>resolve(data)):null;
  const win={interviewCalendar:{today:'2026-11-18',maxDate:'2027-02-14',weekFor:()=>1,
    getWindows:async()=>datesPromise||data,
    selectRange:async(date,a,b)=>{ranges++;Object.assign(booking.elements.date,{value:date});booking.elements.start.value=String(Math.floor(a/60)).padStart(2,'0')+':'+String(a%60).padStart(2,'0');booking.elements.end.value=String(Math.floor(b/60)).padStart(2,'0')+':'+String(b%60).padStart(2,'0');},
    verifySelection:async()=>{verifies++;if(failVerify)throw Error('Unavailable');}},
    submitReviewedInterview:()=>{submits++;return true;},addEventListener:()=>{}};
  booking.addEventListener('input',()=>{for(const k of ['address','phone','teams'])booking.elements[k].disabled=!({address:'In person',phone:'Phone call',teams:'Microsoft Teams'}[k]===booking.elements.format.value);});
  const doc={getElementById:id=>id==='booking-assistant'?root:booking,createElement:tag=>new Element(tag),documentElement:{dataset:{theme:'light'}}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/booking-assistant.js','utf8'),{document:doc,window:win,Event:class{constructor(type){this.type=type;}},Date,console,atob:s=>Buffer.from(s,'base64').toString(),setInterval:()=>1,clearInterval:()=>{}});
  const controls=log.afterNode;
  const click=async label=>{const b=controls.children.find(x=>x.tagName==='button'&&x.textContent===label);assert.ok(b,'Missing choice '+label);await b.click();await new Promise(setImmediate);};
  const text=()=>log.children.map(c=>c.textContent).join('\n');
  const labels=()=>controls.children.filter(x=>x.tagName==='button').map(x=>x.textContent);
  return{root,booking,controls,click,text,labels,reset,win,releaseDates:()=>releaseDates?.(),counts:()=>({submits,verifies,ranges})};
}
async function toFormat(h){await h.click('Book a meeting');await h.click('30 min');await h.click('Tue, Nov 24');await h.click('2:00 PM');}
test('Google Meet guided booking checks live time before final submission',async()=>{
  const h=setup();await toFormat(h);await h.click('Google Meet');assert.match(h.text(),/Nothing is reserved/);
  assert.equal(h.counts().submits,0);await h.click('Confirm and schedule');assert.equal(h.counts().verifies,1);assert.equal(h.counts().submits,1);
});
test('phone format requires a valid number and keeps it in booking fields',async()=>{
  const h=setup();await toFormat(h);await h.click('Phone call');await h.click('Continue');assert.match(h.text(),/valid phone number/);assert.equal(h.counts().submits,0);
  const phone=h.controls.children.find(x=>x.tagName==='label').children[1];phone.value='+1 555 123 4567';await h.click('Continue');assert.equal(h.booking.elements.phone.value,'+1 555 123 4567');assert.ok(h.labels().includes('Confirm and schedule'));
});
test('disabled backend formats are not offered',async()=>{
  const h=setup({formats:false});await toFormat(h);assert.ok(!h.labels().includes('Zoom'));assert.ok(!h.labels().includes('Phone call'));
});
test('Google sign-in is required before a booking can be confirmed',async()=>{
  const h=setup({signed:false});await toFormat(h);await h.click('Google Meet');assert.match(h.text(),/Sign in with Google/);assert.ok(!h.labels().includes('Confirm and schedule'));assert.equal(h.counts().submits,0);
});
test('a conflict at confirmation prevents submission',async()=>{
  const h=setup({failVerify:true});await toFormat(h);await h.click('Google Meet');await h.click('Confirm and schedule');assert.equal(h.counts().submits,0);assert.match(h.text(),/No booking was sent/);
});
test('changing the form forces a new review',async()=>{
  const h=setup();await toFormat(h);await h.click('Google Meet');h.booking.elements.end.value='15:00';await h.click('Confirm and schedule');assert.equal(h.counts().submits,0);assert.match(h.text(),/form selection changed/);
});
test('starting over ignores a stale availability response',async()=>{
  const h=setup({deferDates:true});await h.click('Book a meeting');const pending=h.click('30 min');await h.reset.click();h.releaseDates();await pending;assert.ok(h.labels().includes('Book a meeting'));assert.ok(!h.labels().includes('Tue, Nov 24'));
});
test('in-person booking requires an address',async()=>{
  const h=setup();await toFormat(h);await h.click('In person');await h.click('Continue');assert.match(h.text(),/enter the meeting address/);
  h.controls.children.find(x=>x.tagName==='label').children[1].value='123 Main Street';await h.click('Continue');assert.equal(h.booking.elements.address.value,'123 Main Street');assert.ok(h.labels().includes('Confirm and schedule'));
});
test('Teams rejects unrelated links and allows joining details to be sent separately',async()=>{
  const h=setup();await toFormat(h);await h.click('Microsoft Teams');const el=h.controls.children.find(x=>x.tagName==='label').children[1];el.value='https://example.com/meeting';await h.click('Continue');assert.match(h.text(),/Microsoft Teams meeting link/);assert.equal(h.counts().submits,0);
  el.value='';await h.click('Continue');assert.ok(h.labels().includes('Confirm and schedule'));
});
test('format disabled during availability recheck cannot be submitted',async()=>{
  const h=setup();await toFormat(h);await h.click('Google Meet');h.booking.elements.format.options[0].disabled=true;await h.click('Confirm and schedule');assert.equal(h.counts().submits,0);assert.match(h.text(),/no longer available/);
});

test('Zoom requires Zoom sign-in even when a Google token is present',async()=>{
  const h=setup();h.win.bookingAuth={zoomReady:()=>false,startZoom:async()=>{}};
  await toFormat(h);await h.click('Zoom');assert.match(h.text(),/Sign in with your Zoom account/);
  assert.ok(h.labels().includes('Sign in with Zoom'));assert.ok(!h.labels().includes('Confirm and schedule'));
});
test('Zoom sign-in completes the chat identity step',async()=>{
  const h=setup({signed:false});let ready=false;
  h.win.bookingAuth={zoomReady:()=>ready,startZoom:async()=>{ready=true;h.booking.dispatchEvent({type:'signin'});}};
  await toFormat(h);await h.click('Zoom');await h.click('Sign in with Zoom');
  assert.ok(h.labels().includes('Confirm and schedule'));
});
test('Zoom identity cannot satisfy Google Meet sign-in',async()=>{
  const h=setup({signed:false});h.win.bookingAuth={zoomReady:()=>true,startZoom:async()=>{}};
  await toFormat(h);await h.click('Zoom');await h.click('Change format');await h.click('Google Meet');
  assert.match(h.text(),/Sign in with Google/);assert.ok(!h.labels().includes('Confirm and schedule'));
});
