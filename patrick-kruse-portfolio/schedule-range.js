(() => {
  const get = id => document.getElementById(id);
  const form = interviewForm, fields = form.elements;
  const start = get('range-start'), end = get('range-end'), jump = get('jump-date');
  const format = n => String(Math.floor(n/60)).padStart(2,'0') + ':' + String(n%60).padStart(2,'0');
  const clock = n => (Math.floor(n/60)%12||12)+':'+String(n%60).padStart(2,'0')+' PM';
  const minutes = value => value ? Number(value.slice(0,2))*60 + Number(value.slice(3)) : NaN;
  const day = 86400000;
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const part = name => parts.find(p=>p.type===name).value;
  const today = part('year')+'-'+part('month')+'-'+part('day');
  const stamp = date => Date.parse(date+'T12:00:00Z');
  const iso = n => new Date(n).toISOString().slice(0,10);
  const monday = stamp(today) - ((new Date(stamp(today)).getUTCDay()+6)%7)*day;
  jump.min = fields.date.min = iso(monday);
  jump.max = fields.date.max = iso(monday+90*day);
  let week = 0, request = 0, openings = null, error = false;
  const gaps = date => (openings || []).filter(item=>item.date===date);
  function paint(windows,a,b) {
    const points = [...new Set([840,1020,a,b,...windows.flatMap(w=>[w.start,w.end])].filter(n=>Number.isFinite(n)&&n>=840&&n<=1020))].sort((x,y)=>x-y);
    const stops = points.slice(0,-1).map((x,i)=>{
      const y=points[i+1], free=windows.some(w=>w.start<=x&&y<=w.end), selected=a<=x&&y<=b;
      const color=selected?(free?'#14804c':'#ba3942'):(free?'#a4d5b8':'#969da4');
      return color+' '+(x-840)/1.8+'% '+(y-840)/1.8+'%';
    });
    return 'linear-gradient(to right,'+stops.join(',')+')';
  }
  function selection(){
    const a=minutes(fields.start.value), b=minutes(fields.end.value), windows=gaps(fields.date.value);
    start.value=Number.isFinite(a)?a:840; end.value=Number.isFinite(b)?b:1020;
    start.setAttribute('aria-valuetext',clock(+start.value)); end.setAttribute('aria-valuetext',clock(+end.value));
    const valid=!!openings && windows.some(w=>w.start<=a&&a<b&&b<=w.end);
    get('range-track').style.background=openings?paint(windows,a,b):'#969da4';
    get('selection').textContent=Number.isFinite(a)&&Number.isFinite(b)?fields.start.value+' – '+fields.end.value+' Eastern':'Choose start and end times';
    get('range-note').textContent=!openings?(error?'Availability unavailable. Retry the week.':'Loading availability…'):valid?(b-a)+' minutes available':a>=b?'End must follow start.':'Red marks selected time outside an opening.';
    fields.end.setCustomValidity(valid?'':'Choose a range within one available opening.');
    form.querySelector('[type=submit]').disabled=!valid||!fields.token.value;
  }
  function render(){
    const list=get('week-days');list.replaceChildren();
    for(let i=0;i<7;i++){
      const date=iso(monday+(week*7+i)*day), windows=gaps(date), btn=document.createElement('button');
      btn.type='button';btn.setAttribute('aria-pressed',String(date===fields.date.value));
      const name=document.createElement('strong'),track=document.createElement('span'), info=document.createElement('small');
      name.textContent=new Date(stamp(date)).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});
      track.className='day-track';track.style.background=paint(windows);
      info.textContent=!openings?(error?'Availability unknown':'Loading…'):windows.length?windows.map(w=>clock(w.start)+' – '+clock(w.end)).join(' · '):'Unavailable';
      btn.append(name,track,info);btn.onclick=()=>choose(date);list.append(btn);
    }
    selection();
  }
  function choose(date){
    if(!date||date<jump.min||date>jump.max){selection();return}
    fields.date.value=jump.value=date;
    const n=Math.floor((stamp(date)-monday)/(7*day));
    if(n!==week){loadWeek(n);return}
    const first=gaps(date)[0]; fields.start.value=format(first?.start??840);fields.end.value=format(first?Math.min(first.start+30,first.end):870);render();
  }
  async function loadWeek(n){
    week=n;const id=++request; openings=null;error=false;
    get('prev-week').disabled=n===0;get('next-week').disabled=n===12;
    get('week-status').textContent='Loading week…';render();
    try{
      const response=await fetch(form.action+'?view=windows&week='+n,{cache:'no-store'});
      if(!response.ok)throw Error();
      const body=(await response.text()).trim();
      const json=body.replace(/^window\.showInterviewWindows\(/,'').replace(/\);$/,'');
      const data=JSON.parse(json);
      if(!Array.isArray(data.openings)||data.error)throw Error();
      if(id!==request)return;
      openings=data.openings;get('week-status').textContent='Week of '+iso(monday+n*7*day)+' · Eastern time';
      choose(fields.date.value);
    }catch(e){if(id!==request)return;error=true;get('week-status').replaceChildren('Calendar could not be loaded. ');const retry=document.createElement('button');retry.type='button';retry.textContent='Retry';retry.onclick=()=>loadWeek(n);get('week-status').append(retry);render()}
  }
  for(const [id,delta] of [['prev-week',-1],['next-week',1]])get(id).onclick=()=>choose(iso(monday+(week+delta)*7*day));
  jump.onchange=()=>choose(jump.value);fields.date.onchange=()=>choose(fields.date.value);
  for(const slider of [start,end])slider.oninput=()=>{
    if(slider===start)start.value=Math.min(+start.value,+end.value-1);
    else end.value=Math.max(+end.value,+start.value+1);
    fields.start.value=format(+start.value);fields.end.value=format(+end.value);selection();
  };
  form.addEventListener('input',selection);form.addEventListener('signin',selection);
  form.addEventListener('submit',e=>{selection();if(!form.reportValidity())e.preventDefault()});
  fields.date.value=jump.value=today;loadWeek(0);
})();