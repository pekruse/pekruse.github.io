(() => {
  const root=document.getElementById('booking-assistant');
  const booking=document.getElementById('interview-form');
  if(!root||!booking)return;
  const log=root.querySelector('[role=log]');
  const composer=root.querySelector('form');
  const input=composer.querySelector('textarea');
  const send=composer.querySelector('button');
  const selection=root.querySelector('#assistant-selection');
  let timer=null;
  const intro='Hi! I can walk you through scheduling a conversation with Patrick. What would you like help with?';
  function message(role,text){
    const item=document.createElement('div');
    item.className='assistant-message';item.dataset.role=role;item.textContent=text;
    log.append(item);log.scrollTop=log.scrollHeight;
  }
  function selected(){
    const f=booking.elements;
    const date=f.date.value;
    const time=f.start.value&&f.end.value?f.start.value+'–'+f.end.value+' Eastern':'Choose a time';
    const label=date?new Date(date+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}):'Choose a date';
    selection.textContent=label+' · '+time+' · '+f.format.value;
    return {date,time,format:f.format.value};
  }
  function reply(text){
    const q=text.toLowerCase();
    if(/summary|selected|selection|review|my booking/.test(q)){
      const s=selected();
      return (s.date?'Your current selection: '+s.date+' · '+s.time+' · '+s.format+'.':'Pick a date and time in the calendar first.')+' This is a draft selection, not a confirmed booking. Use “Review meeting details” in the form to continue.';
    }
    if(/cancel|reschedul|change.*booking/.test(q))return 'For a booking you already made, contact Patrick using the Contact link above. This preview cannot cancel or reschedule meetings.';
    if(/zone|eastern|timezone|local time/.test(q))return 'All booking times use Eastern Time (America/New_York). Convert the time to your location before confirming; the calendar invitation will reflect your calendar’s time zone.';
    if(/available|availability|when|openings|schedule|tuesday|thursday/.test(q))return 'Booking hours are Tuesday and Thursday, 2–5 PM Eastern, with at least 24 hours’ notice. Use “Jump to next opening” to check the live calendar. I can explain the process, but this preview does not look up openings.';
    if(/zoom|teams|phone|format|meet|person/.test(q))return 'Choose a format in the form: Google Meet, Zoom, Microsoft Teams, Phone call, or In person. Options marked “setup pending” are not available yet. Phone calls need your number; in-person meetings need an address. Teams accepts an optional link, otherwise joining details are sent separately.';
    if(/long|duration|minutes|hour/.test(q))return 'You can choose a time range of up to 3 hours inside one available opening. For an introduction, 30 minutes is a useful starting point. Zoom’s host-account time limit may be shorter than the booked slot.';
    if(/sign|google|account|login/.test(q))return 'Sign in with Google in the booking form to verify the email address used for your invitation. This demo chat does not handle your sign-in credentials.';
    if(/book|confirm|reserve/.test(q))return 'Choose an available date and time, select a format, fill in any required details, and sign in with Google. Click “Review meeting details,” then “Confirm and schedule.” Only the booking form can reserve a meeting.';
    return 'This is a frontend preview with preset replies, not a connected AI model. Try asking about availability, meeting formats, time zones, or reviewing your selection.';
  }
  function ask(value){
    const text=value.trim().slice(0,1000);
    if(!text||timer!==null)return;
    message('user',text);input.value='';send.disabled=true;
    log.setAttribute('aria-busy','true');
    timer=setTimeout(()=>{message('assistant',reply(text));log.setAttribute('aria-busy','false');timer=null;send.disabled=!input.value.trim();},350);
  }
  composer.addEventListener('submit',e=>{e.preventDefault();ask(input.value);});
  input.addEventListener('input',()=>{send.disabled=timer!==null||!input.value.trim();});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();ask(input.value);}});
  root.querySelectorAll('[data-prompt]').forEach(button=>button.addEventListener('click',()=>ask(button.dataset.prompt)));
  root.querySelector('.assistant-reset').addEventListener('click',()=>{
    clearTimeout(timer);timer=null;log.replaceChildren();log.setAttribute('aria-busy','false');input.value='';send.disabled=true;message('assistant',intro);input.focus();
  });
  booking.addEventListener('input',selected);
  booking.addEventListener('change',selected);
  // The calendar controls update form values programmatically.
  const interval=setInterval(selected,1500);
  window.addEventListener('pagehide',()=>{clearInterval(interval);clearTimeout(timer);},{once:true});
  message('assistant',intro);selected();
})();