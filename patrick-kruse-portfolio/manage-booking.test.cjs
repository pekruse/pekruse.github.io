
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
class El{
 constructor(tag='div'){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.value='';this.disabled=false;this.hidden=false;this.open=false;}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;this.textContent='';}addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
 showModal(){this.open=true;}close(){this.open=false;}reportValidity(){return true;}
 async emit(type){for(const fn of this.listeners[type]||[])await fn({type,target:this,preventDefault(){}});}
}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
async function setup({invalid=false,cancelFail=false}={}){
 const ids=new Map(),get=id=>{if(!ids.has(id))ids.set(id,new El());return ids.get(id);},form=get('manage-form');
 form.elements=Object.fromEntries(['date','start','end','format','address','phone','teams'].map(k=>[k,new El('input')]));
 const calls=[];
 const booking={status:'confirmed',editable:true,version:'v1',date:'2026-11-24',start:'14:00',end:'14:30',format:'Zoom',email:'guest@example.com',today:'2026-11-18',maxDate:'2027-02-14',join:'https://zoom.us/j/123',calendar:'https://calendar.google.com/event'};
 const context={document:{getElementById:get,createElement:tag=>new El(tag),querySelectorAll:()=>[...ids.values(),...Object.values(form.elements)]},location:{hash:invalid?'':'#id='+'a'.repeat(32)+'&key='+'b'.repeat(64)},window:{addEventListener(){}},URLSearchParams,AbortController,setTimeout,clearTimeout,Date,console,
 fetch:async(url,opts)=>{
   const action=opts.body.get('management');calls.push({action,params:Object.fromEntries(opts.body),method:opts.method});
   return{ok:true,json:async()=>action==='windows'?{openings:[{start:'14:00',end:'17:00'}]}:action==='cancel'?(cancelFail?{error:'Zoom could not remove the old meeting'}:{booking:{status:'cancelled'}}):action==='save'?{booking:{...booking,date:opts.body.get('date'),start:opts.body.get('start'),end:opts.body.get('end'),version:'v2'}}:{booking}};
 }};
 vm.runInNewContext(fs.readFileSync(__dirname+'/manage-booking.js','utf8'),context);await flush();
 return{get,form,calls,booking};
}
test('valid email link loads booking without submitting a mutation',async()=>{
 const h=await setup();assert.deepEqual(h.calls.map(c=>c.action),['read','windows']);
 assert.equal(h.get('booking-content').hidden,false);assert.equal(h.form.elements.date.value,'2026-11-24');
 assert.ok(h.calls.every(c=>c.method==='POST'));assert.match(h.get('booking-summary').children.at(-1).textContent,/guest@example.com/);
});
test('invalid link gives clear instructions and never contacts backend',async()=>{
 const h=await setup({invalid:true});assert.equal(h.calls.length,0);assert.match(h.get('manage-status').textContent,/full.*Manage booking/);
});
test('cancellation requires review plus explicit confirmation',async()=>{
 const h=await setup();await h.get('manage-cancel').emit('click');assert.equal(h.get('manage-confirm').open,true);
 assert.ok(!h.calls.some(c=>c.action==='cancel'));await h.get('manage-confirm-no').emit('click');assert.equal(h.get('manage-confirm').open,false);
 await h.get('manage-cancel').emit('click');await h.get('manage-confirm-yes').emit('click');
 assert.equal(h.calls.filter(c=>c.action==='cancel').length,1);assert.equal(h.get('booking-content').hidden,true);assert.match(h.get('manage-status').textContent,/cancelled/);
});
test('edit saves the reviewed selection and never changes invitation email',async()=>{
 const h=await setup();h.form.elements.start.value='15:00';h.form.elements.end.value='15:30';
 await h.form.emit('submit');assert.equal(h.get('manage-confirm').open,true);assert.ok(!h.calls.some(c=>c.action==='save'));
 await h.get('manage-confirm-yes').emit('click');const call=h.calls.find(c=>c.action==='save');
 assert.equal(call.params.start,'15:00');assert.equal(call.params.version,'v1');assert.equal(call.params.email,undefined);
 assert.match(h.get('manage-status').textContent,/changes are saved/);
});
test('failed cancellation stays visible and never claims success',async()=>{
 const h=await setup({cancelFail:true});await h.get('manage-cancel').emit('click');await h.get('manage-confirm-yes').emit('click');
 assert.equal(h.get('booking-content').hidden,false);assert.match(h.get('manage-status').textContent,/could not remove/);assert.equal(h.get('manage-status').dataset.error,'true');
});
test('range outside an opening cannot reach confirmation or save',async()=>{
 const h=await setup();h.form.elements.start.value='13:00';await h.form.emit('submit');
 assert.equal(h.get('manage-confirm').open,false);assert.ok(!h.calls.some(c=>c.action==='save'));assert.match(h.get('manage-status').textContent,/available opening/);
});
