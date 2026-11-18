(() => {
  const root=document.getElementById('booking-assistant'), booking=document.getElementById('interview-form');
  if(!root||!booking)return;
  const fields=booking.elements, log=root.querySelector('[role=log]'), composer=root.querySelector('form');
  const input=composer.querySelector('textarea'), send=composer.querySelector('button');
  const suggestions=root.querySelector('.assistant-suggestions'), summary=root.querySelector('#assistant-selection');
  const controls=document.createElement('div');controls.className='assistant-controls';log.after(controls);
  const progress=document.createElement('p');progress.className='assistant-progress';controls.before(progress);
  let state='welcome', duration=30, generation=0, sending=false, busy=false;
  let selectedDate='', selectedStart=null, selectedEnd=null, signTimer=null, reviewSnapshot='';
  const clock=n=>new Date(Date.UTC(2000,0,1,Math.floor(n/60),n%60)).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'UTC'});
  const time=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
  const pretty=date=>new Date(date+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});
  const api=()=>window.interviewCalendar;
  function message(role,text){
    const item=document.createElement('div');item.className='assistant-message';item.dataset.role=role;item.textContent=text;
    log.append(item);log.scrollTop=log.scrollHeight;
  }
  function action(label,fn,primary=false){
    const b=document.createElement('button');b.type='button';b.textContent=label;if(primary)b.className='assistant-primary';
    b.addEventListener('click',()=>{if(!sending&&!busy)fn();});controls.append(b);return b;
  }
  function field(label,type='text',value=''){
    const wrapper=document.createElement('label'), title=document.createElement('span'), el=document.createElement('input');
    title.textContent=label;el.type=type;el.value=value;wrapper.append(title,el);controls.append(wrapper);return el;
  }
  function enter(next,label){
    generation++;busy=false;state=next;controls.replaceChildren();
    progress.textContent=label||'';
    if(signTimer){clearInterval(signTimer);signTimer=null;}
    send.disabled=!input.value.trim();
    return generation;
  }
  function updateSummary(){
    const f=fields, date=f.date.value;
    summary.textContent=date?pretty(date)+' · '+(f.start.value||'—')+'–'+(f.end.value||'—')+' ET · '+f.format.value:'No time selected yet · all times Eastern';
  }
  function fingerprint(){return ['date','start','end','format','address','phone','teams'].map(k=>fields[k]?.disabled?'':fields[k]?.value||'').join('|');}
  function sync(){booking.dispatchEvent(new Event('input',{bubbles:true}));updateSummary();}
  function back(label,fn){action('← '+label,fn);}
  function failure(text,retry){busy=false;message('assistant',text);controls.replaceChildren();action('Try again',retry,true);action('Start over',welcome);}
  function welcome(){
    enter('welcome','Ready when you are');log.replaceChildren();
    message('assistant','Let’s book a conversation with Patrick. I’ll check the live calendar and guide you through each step—no AI needed.');
    action('Book a meeting',chooseDuration,true);
    updateSummary();
  }
  function chooseDuration(){
    enter('duration','Step 1 of 6 · Duration');
    message('assistant','How long would you like to meet?');
    for(const n of [15,30,45,60])action(n+' min',()=>setDuration(n),n===30);
    const custom=field('Custom duration (5–180 minutes)','number',String(duration));custom.min='5';custom.max='180';custom.step='5';
    action('Use duration',()=>setDuration(Number(custom.value)));
  }
  function setDuration(n){
    if(!Number.isInteger(n)||n<5||n>180||n%5){message('assistant','Choose 5–180 minutes in 5-minute increments.');return;}
    duration=n;message('user',n+' minutes');chooseDate();
  }
  async function chooseDate(fromWeek=0){
    const id=enter('date','Step 2 of 6 · Date');message('assistant','Checking live openings for a '+duration+'-minute meeting…');busy=true;
    try{
      if(!api())throw Error('Calendar is still starting. Please try again.');
      const dates=new Map();let next=fromWeek;
      for(;next<=12;next++){
        const data=await api().getWindows(next);
        if(id!==generation)return;
        for(const w of data.openings)if(w.date>=api().today&&Math.ceil(w.start/5)*5+duration<=w.end)dates.set(w.date,true);
        if(dates.size>=4){next++;break;}
      }
      busy=false;
      message('assistant',dates.size?'Here are available dates. All times are Eastern.':'No matching openings were found in this part of the calendar. Try a shorter duration.');
      for(const date of [...dates.keys()].sort())action(pretty(date),()=>selectDate(date));
      if(next<=12)action('Later dates',()=>chooseDate(next));
      const date=field('Or choose a date','date');date.min=api().today;date.max=api().maxDate;
      action('Check date',()=>selectDate(date.value));
      back('Duration',chooseDuration);
    }catch(err){if(id===generation)failure('I couldn’t read the live calendar. No booking has been made.',()=>chooseDate(fromWeek));}
  }
  async function selectDate(date){
    if(!api()||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<api().today||date>api().maxDate){message('assistant','Choose a date inside the booking window.');return;}
    const id=enter('time','Step 3 of 6 · Time');busy=true;
    try{
      const data=await api().getWindows(api().weekFor(date),true);if(id!==generation)return;
      const slots=[];
      for(const w of data.openings.filter(w=>w.date===date)){
        for(let start=Math.ceil(w.start/5)*5;start+duration<=w.end;start+=5)slots.push(start);
      }
      busy=false;
      if(!slots.length){message('assistant','No '+duration+'-minute openings on '+pretty(date)+'. Choose another date or a shorter meeting.');action('Choose another date',()=>chooseDate(),true);back('Duration',chooseDuration);return;}
      selectedDate=date;message('user',pretty(date));
      message('assistant','Choose a start time for '+duration+' minutes.');
      for(const start of slots.slice(0,6))action(clock(start),()=>selectTime(start));
      const label=document.createElement('label'), title=document.createElement('span'), list=document.createElement('select');
      title.textContent='All available start times';for(const start of slots){const o=document.createElement('option');o.value=String(start);o.textContent=clock(start)+' – '+clock(start+duration);list.append(o);}
      label.append(title,list);controls.append(label);action('Use selected time',()=>selectTime(Number(list.value)),true);back('Dates',()=>chooseDate());
    }catch(err){if(id===generation)failure('The calendar could not be checked. Please try again.',()=>selectDate(date));}
  }
  async function selectTime(start){
    if(!Number.isFinite(start))return;
    const id=enter('selecting','Checking that time…');busy=true;
    try{
      await api().selectRange(selectedDate,start,start+duration);if(id!==generation)return;
      busy=false;selectedStart=start;selectedEnd=start+duration;
      message('user',clock(start)+' – '+clock(start+duration)+' Eastern');sync();chooseFormat();
    }catch(err){if(id===generation)failure('That time is no longer available. Choose another opening.',()=>selectDate(selectedDate));}
  }
  function chooseFormat(){
    enter('format','Step 4 of 6 · Meeting format');message('assistant','How would you like to meet?');
    for(const option of fields.format.options)if(!option.disabled)action(option.value,()=>setFormat(option.value));
    const pending=[...fields.format.options].filter(o=>o.disabled).map(o=>o.value);
    if(pending.length){const note=document.createElement('small');note.textContent='Setup pending: '+pending.join(', ');controls.append(note);}
    back('Times',()=>selectDate(selectedDate));
  }
  function setFormat(value){
    const option=[...fields.format.options].find(o=>o.value===value&&!o.disabled);
    if(!option){message('assistant','That format is not available yet.');return;}
    fields.format.value=value;sync();message('user',value);details();
  }
  function details(){
    enter('details','Step 4 of 6 · Contact details');const format=fields.format.value;
    if(format==='Phone call'){
      message('assistant','What number should Patrick call? Include the country code.');
      const phone=field('Your phone number','tel',fields.phone.value);phone.autocomplete='tel';phone.maxLength=40;
      action('Continue',()=>{
        const value=phone.value.trim(),digits=value.replace(/\D/g,'');
        if(!/^[+\d\s().-]{7,40}$/.test(value)||digits.length<7||digits.length>15){message('assistant','Enter a valid phone number with country code.');phone.focus();return;}
        fields.phone.value=value;sync();signIn();
      },true);
    }else if(format==='In person'){
      message('assistant','Where should the meeting take place?');
      const address=field('Meeting address','text',fields.address.value);address.maxLength=300;address.name='street-address';address.autocomplete='street-address';
      action('Continue',()=>{if(!address.value.trim()){message('assistant','Please enter the meeting address.');address.focus();return;}fields.address.value=address.value.trim();sync();signIn();},true);
    }else if(format==='Microsoft Teams'){
      message('assistant','Have a Teams meeting link? Add it below, or skip and Patrick will email joining details separately.');
      const teams=field('Teams link (optional)','url',fields.teams.value);teams.maxLength=2000;
      action('Continue',()=>{
        const value=teams.value.trim();
        if(value&&!/^https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\/(?:l\/meetup-join\/|meet\/)[^\s<>"']+$/i.test(value)){message('assistant','Use a Microsoft Teams meeting link, or leave it blank.');return;}
        fields.teams.value=value;sync();signIn();
      },true);
    }else{signIn();return;}
    back('Meeting format',chooseFormat);
  }
  function signedIn(){
    if(!fields.token.value)return false;
    try{return JSON.parse(atob(fields.token.value.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).exp*1000>Date.now()+30000;}catch{return false;}
  }
  function signIn(){
    if(signedIn()){review();return;}
    const id=enter('signin','Step 5 of 6 · Google sign-in');
    message('assistant','Sign in with Google so your booking and invitation go to a verified email address.');
    const slot=document.createElement('div');slot.className='assistant-google';controls.append(slot);
    let rendered=false;
    function render(){
      if(id!==generation)return;
      if(signedIn()){review();return;}
      if(!rendered&&window.google?.accounts?.id){
        try{window.google.accounts.id.renderButton(slot,{theme:document.documentElement.dataset.theme==='dark'?'filled_black':'outline',size:'large',text:'signin_with',width:Math.max(200,Math.min(280,root.clientWidth-48))});rendered=true;}catch{}
      }
    }
    signTimer=setInterval(render,500);render();
    action('Use sign-in in the form',()=>{booking.querySelector('.g_id_signin').scrollIntoView({behavior:'smooth',block:'center'});});
    back('Meeting format',chooseFormat);
  }
  function review(){
    if(!fields.date.value||!fields.start.value||!fields.end.value){message('assistant','Let’s choose a time first.');chooseDuration();return;}
    if(!signedIn()){signIn();return;}
    if(fields.date.validity?.valid===false||fields.end.validity?.valid===false){
      message('assistant','Your current selection is not inside an available opening. Let’s choose a live time.');chooseDate();return;
    }
    if((fields.format.value==='Phone call'&&!fields.phone.value.trim())||(fields.format.value==='In person'&&!fields.address.value.trim())){details();return;}
    enter('review','Step 6 of 6 · Review & confirm');sync();reviewSnapshot=fingerprint();
    message('assistant','Review your meeting below. Nothing is reserved until you confirm and the server accepts the booking.');
    const card=document.createElement('dl');card.className='assistant-review';
    const rows=[['Date',pretty(fields.date.value)],['Time',fields.start.value+' – '+fields.end.value+' Eastern'],['Format',fields.format.value]];
    for(const [name,label]of [['address','Address'],['phone','Phone number'],['teams','Teams link']])if(!fields[name].disabled&&fields[name].value)rows.push([label,fields[name].value]);
    if(fields.format.value==='Microsoft Teams'&&!fields.teams.value)rows.push(['Joining details','Link will be emailed separately.']);
    for(const [label,value]of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;card.append(dt,dd);}controls.append(card);
    action('Confirm and schedule',confirm,true);action('Change time',()=>chooseDate());action('Change format',chooseFormat);
  }
  async function confirm(){
    if(state!=='review'||sending||busy)return;
    if(fingerprint()!==reviewSnapshot){message('assistant','Your form selection changed. Please review the updated details.');review();return;}
    if(!signedIn()){signIn();return;}
    const snapshot=reviewSnapshot,id=generation;busy=true;controls.querySelectorAll('button').forEach(b=>b.disabled=true);
    message('assistant','Rechecking availability before sending…');
    try{
      if(!api())throw Error('Calendar unavailable');
      await api().verifySelection();
      if(id!==generation)return;
      if(snapshot!==fingerprint()){busy=false;review();return;}
      busy=false;
      if(![...fields.format.options].some(o=>o.value===fields.format.value&&!o.disabled)){
        message('assistant','That meeting format is no longer available. Please choose another.');chooseFormat();return;
      }
      // Use the existing validated form POST and server receipt, never a simulated success.
      if(!window.submitReviewedInterview||!window.submitReviewedInterview(snapshot)){
        message('assistant','Please check the required details in the booking form before confirming.');
        details();return;
      }
    }catch(err){if(id===generation){busy=false;message('assistant','That time could not be verified. No booking was sent. Choose a fresh opening.');chooseDate();}}
  }
  function ask(value){
    const text=value.trim().slice(0,1000);if(!text||sending||busy)return;message('user',text);input.value='';send.disabled=true;
    const q=text.toLowerCase();
    if(/^(start over|reset|restart)$/.test(q)){welcome();return;}
    if(/^(book|book a meeting|schedule|schedule a meeting|reserve)$/.test(q)){chooseDuration();return;}
    if(/change.*(time|date)|available|availability|opening/.test(q)){chooseDate();return;}
    if(state==='duration'&&/^\d+(?:\s*(?:min|minutes))?$/.test(q)){setDuration(parseInt(q,10));return;}
    if(state==='date'&&/^\d{4}-\d{2}-\d{2}$/.test(q)){selectDate(q);return;}
    if(state==='format'){
      const aliases={'zoom':'Zoom','teams':'Microsoft Teams','microsoft teams':'Microsoft Teams','phone':'Phone call','phone call':'Phone call','in person':'In person','google meet':'Google Meet'};
      if(aliases[q]){setFormat(aliases[q]);return;}
    }
    if(/review|summary/.test(q)){review();return;}
    if(/duration|long|minutes/.test(q)){chooseDuration();return;}
    if(/format/.test(q)){chooseFormat();return;}
    if(/zone|eastern|local time/.test(q)){message('assistant','Every time here is Eastern Time (America/New_York). Your calendar invitation adapts to your calendar’s time zone.');return;}
    if(/cancel|reschedul/.test(q)){message('assistant','To change an existing booking, contact Patrick using Contact above. Start over only resets this chat; it never cancels a booked meeting.');return;}
    message('assistant','Use the choices below to continue. You can also type “book,” “available times,” “change format,” or “review.” This assistant follows a guided workflow; it does not use AI.');
  }
  composer.addEventListener('submit',e=>{e.preventDefault();ask(input.value);});
  input.addEventListener('input',()=>{send.disabled=busy||sending||!input.value.trim();});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();ask(input.value);}});
  suggestions.replaceChildren();
  for(const [label,prompt]of [['Book a meeting','book'],['Available times','available times'],['Review','review']]){
    const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',()=>ask(prompt));suggestions.append(b);
  }
  root.querySelector('.assistant-reset').addEventListener('click',()=>{if(!sending)welcome();});
  booking.addEventListener('signin',()=>{if(state==='signin')review();});
  booking.addEventListener('input',updateSummary);booking.addEventListener('change',updateSummary);
  booking.addEventListener('submit',e=>{
    if(e.defaultPrevented)return;
    sending=true;generation++;if(signTimer)clearInterval(signTimer);
    root.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=true);
    message('assistant','Sending your booking securely. The next page will show the server’s confirmation or any issue. Please don’t submit again.');
  });
  window.addEventListener('pageshow',e=>{if(e.persisted){sending=false;busy=false;root.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=false);welcome();}});
  welcome();
})();

