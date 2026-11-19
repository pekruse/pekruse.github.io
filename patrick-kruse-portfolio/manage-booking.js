(() => {
  const ENDPOINT='https://script.google.com/macros/s/AKfycbwL6Ai7tqXTs6gc_29alKRTHFxbMTsb1Meg4zW9dizNchMgDtlQ-IYRosy-UNsMWBvoHw/exec';
  const get=id=>document.getElementById(id),form=get('manage-form'),fields=form.elements,status=get('manage-status'),dialog=get('manage-confirm');
  const params=new URLSearchParams(location.hash.slice(1)),credentials={id:params.get('id')||'',key:params.get('key')||''};
  let booking=null,busy=false,availability=[],availabilityVersion=0,reviewed=null;
  // Keep the private link out of referrers and network URLs. Never log it.
  function message(text,error=false){status.textContent=text;status.dataset.error=String(error);}
  function controls(disabled){busy=disabled;for(const el of document.querySelectorAll('button,input,select'))el.disabled=disabled;updateSaveState();}
  function minutes(value){return Number(value.slice(0,2))*60+Number(value.slice(3));}
  function time(value){return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');}
  function readable(value){const n=minutes(value);return (Math.floor(n/60)%12||12)+':'+String(n%60).padStart(2,'0')+' PM';}
  async function request(action,extra={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
    try{
      const response=await fetch(ENDPOINT,{method:'POST',body:new URLSearchParams({...credentials,management:action,...extra}),redirect:'follow',cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error('The booking service could not be reached.');
      let result;try{result=await response.json();}catch(_){throw Error('The booking service needs the latest Apps Script deployment.');}
      if(result.error)throw Error(result.error);return result;
    }finally{clearTimeout(timer);}
  }
  function details(){
    const format=fields.format.value;
    for(const [name,value] of [['address','In person'],['phone','Phone call'],['teams','Microsoft Teams']]){
      const active=format===value;get('manage-'+name).hidden=!active;fields[name].disabled=!active;fields[name].required=active&&name!=='teams';
    }
    updateSaveState();
  }
  function render(){
    get('booking-content').hidden=!booking||booking.status==='cancelled';
    if(!booking)return;
    if(booking.status==='cancelled'){message('Your booking is cancelled. This time is available for someone else.');return;}
    const list=get('booking-summary');list.replaceChildren();
    for(const [label,value] of [['Date',new Date(booking.date+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'UTC'})],['Time',readable(booking.start)+' – '+readable(booking.end)+' Eastern'],['Format',booking.format],['Booked by',booking.email]]){
      const term=document.createElement('dt'),description=document.createElement('dd');term.textContent=label;description.textContent=value;list.append(term,description);
    }
    const links=get('booking-links');links.replaceChildren();
    for(const [text,url] of [['Join '+booking.format+' meeting',booking.join],['View calendar event',booking.calendar]]){
      if(!url||!/^https:\/\//.test(url))continue;const link=document.createElement('a');link.textContent=text;link.href=url;link.target='_blank';link.rel='noopener noreferrer';links.append(link,document.createElement('br'));
    }
    for(const name of ['date','start','end','format','address','phone','teams'])fields[name].value=booking[name]||'';
    fields.date.min=booking.today;fields.date.max=booking.maxDate;
    form.hidden=!booking.editable;get('cancel-area').hidden=!booking.editable&&!booking.cancellationPending;
    get('manage-cancel').textContent=booking.cancellationPending?'Finish cancellation':'Cancel booking';details();
    if(booking.cancellationPending)message('Cancellation is pending. Please finish cancellation below.',true);
    else if(!booking.editable)message('This meeting has started. Please contact Patrick to make changes.');
    else message(booking.cleanupPending?'Your booking was saved, but the previous Zoom link still needs cleanup. Save again to retry, or contact Patrick.':'Choose a new time or update your details below.',booking.cleanupPending);
  }
  async function loadOpenings(){
    const version=++availabilityVersion,date=fields.date.value,box=get('manage-openings');availability=[];box.replaceChildren();box.textContent='Checking available times…';
    if(!booking?.editable)return;
    try{
      const result=await request('windows',{date});if(version!==availabilityVersion||date!==fields.date.value)return;
      availability=result.openings||[];box.replaceChildren();
      if(!availability.length){box.textContent='No openings on this date. Choose another Tuesday or Thursday.';return;}
      for(const opening of availability){
        const button=document.createElement('button');button.type='button';button.textContent=readable(opening.start)+' – '+readable(opening.end);button.disabled=busy;
        button.addEventListener('click',()=>{fields.start.value=opening.start;fields.end.value=time(Math.min(minutes(opening.end),minutes(opening.start)+30));updateSaveState();});box.append(button);
      }
    }catch(error){if(version===availabilityVersion)box.textContent=error.message;}
  }
  async function load(){
    controls(true);message('Loading your booking…');
    try{const result=await request('read');booking=result.booking;render();}
    catch(error){message(error.message,true);}
    finally{controls(false);if(booking?.status==='confirmed')details();}
    if(booking?.editable)await loadOpenings();
  }
  function selection(value){
    const format=String(value.format||'').trim();
    return {date:String(value.date||''),start:String(value.start||''),end:String(value.end||''),format,
      address:format==='In person'?String(value.address||'').trim():'',
      phone:format==='Phone call'?String(value.phone||'').trim():'',
      teams:format==='Microsoft Teams'?String(value.teams||'').trim():''};
  }
  function snapshot(){return selection(Object.fromEntries(['date','start','end','format','address','phone','teams'].map(name=>[name,fields[name].value])));}
  function changed(){return Boolean(booking&&JSON.stringify(snapshot())!==JSON.stringify(selection(booking)));}
  function updateSaveState(){
    const retry=Boolean(booking?.cleanupPending&&!changed());
    get('manage-save').disabled=busy||!booking?.editable||(!changed()&&!retry);
    get('manage-save').textContent=retry?'Retry cleanup':'Review changes';
  }
  form.addEventListener('submit',event=>{
    event.preventDefault();if(busy||!booking?.editable||!form.reportValidity())return;
    if(!changed()&&!booking.cleanupPending){message('No changes to save. Your booking is already up to date.');updateSaveState();return;}
    const selected=snapshot();
    if(!availability.some(o=>o.start<=selected.start&&selected.start<selected.end&&selected.end<=o.end)){message('Choose a time within one available opening.',true);return;}
    reviewed={...selected,version:booking.version,action:'save'};
    get('manage-confirm-title').textContent='Save these changes?';
    get('manage-confirm-detail').textContent=selected.date+' · '+readable(selected.start)+' – '+readable(selected.end)+' Eastern · '+selected.format+'. An updated confirmation will be emailed to you.';
    get('manage-confirm-yes').textContent='Save changes';dialog.showModal();
  });
  get('manage-cancel').addEventListener('click',()=>{
    if(busy||!booking)return;reviewed={version:booking.version,action:'cancel'};
    get('manage-confirm-title').textContent='Cancel this booking?';get('manage-confirm-detail').textContent='This removes your reservation and its Zoom meeting. You will receive a cancellation confirmation.';
    get('manage-confirm-yes').textContent='Yes, cancel booking';dialog.showModal();
  });
  get('manage-confirm-no').addEventListener('click',()=>{reviewed=null;dialog.close();});
  get('manage-confirm-yes').addEventListener('click',async()=>{
    if(busy||!reviewed)return;const current=reviewed;reviewed=null;dialog.close();controls(true);message(current.action==='cancel'?'Cancelling your booking…':'Saving your changes…');
    try{
      const result=await request(current.action,current);booking=result.booking;render();
      message(result.warning||(booking.status==='cancelled'?'Your booking is cancelled. A confirmation has been sent.':result.unchanged?'Your booking is already up to date. No new confirmation email was sent.':'Your changes are saved. Check your email for the updated details.'),!!result.warning);
    }catch(error){
      message(error.name==='AbortError'?'The request timed out. Reload this page to check whether your change was saved before retrying.':error.message,true);
      // Refresh the version after partial failures, but never silently repeat a mutation.
      try{const result=await request('read');booking=result.booking;render();message(error.message+' Reloaded the latest booking details.',true);}catch(_){}
    }finally{controls(false);if(booking?.status==='confirmed')details();}
    if(booking?.editable)await loadOpenings();
  });
  get('manage-reload').addEventListener('click',()=>{if(!busy)load();});
  form.addEventListener('input',updateSaveState);form.addEventListener('change',updateSaveState);
  fields.date.addEventListener('change',loadOpenings);fields.format.addEventListener('change',details);
  window.addEventListener('pageshow',event=>{if(event.persisted)load();});
  if(!/^[a-v0-9]{5,1024}$/.test(credentials.id)||!/^[a-f0-9]{64}$/.test(credentials.key)){
    message('Open the full “Manage booking” link from your confirmation email.',true);return;
  }
  load();
})();