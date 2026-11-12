const CALENDAR_ID = 'pekruse504@gmail.com';
const ZONE = 'America/New_York';

function doGet(e) {
  const week = Math.min(12, Math.max(0, parseInt(e && e.parameter.week, 10) || 0));
  const today = Utilities.formatDate(new Date(), ZONE, 'yyyy-MM-dd');
  const monday = new Date(today + 'T12:00:00Z');
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay()+6)%7 + week*7);
  const days = [1,3].map(offset => {
    const day = new Date(monday);
    day.setUTCDate(day.getUTCDate()+offset);
    const date = day.toISOString().slice(0,10);
    return {date, start:Utilities.parseDate(date+' 14:00',ZONE,'yyyy-MM-dd HH:mm').getTime()};
  });
  const duration = 180*60000;
  let rows = '';
  const openings = [];
  try {
    const calendar = Calendar.Freebusy.query({timeMin:new Date(days[0].start).toISOString(),timeMax:new Date(days[1].start+duration).toISOString(),items:[{id:CALENDAR_ID}]}).calendars[CALENDAR_ID];
    if (!calendar || calendar.errors || !Array.isArray(calendar.busy)) throw Error();
    for (const day of days) {
      let cursor = Math.max(0, Math.ceil((Date.now()+86400000-day.start)/60000));
      const gaps = [];
      const busy = calendar.busy.map(b=>[Math.max(0,Math.floor((Date.parse(b.start)-day.start)/60000)),Math.min(180,Math.ceil((Date.parse(b.end)-day.start)/60000))]).filter(b=>b[1]>b[0]).sort((a,b)=>a[0]-b[0]);
      for (const [start,end] of busy.concat([[180,180]])) {
        if (cursor<start) gaps.push([cursor,start]);
        cursor=Math.max(cursor,end);
      }
      for (const [start,end] of gaps) openings.push({date:day.date,start:840+start,end:840+end});
      const clock=m=>Math.floor((840+m)/60-12)+':'+String(m%60).padStart(2,'0');
      const label=Utilities.formatDate(new Date(day.start),ZONE,'EEE, MMM d');
      rows+='<section><b>'+label+'</b><div class="track">'+gaps.map(([a,b])=>'<i style="left:'+a/1.8+'%;width:'+(b-a)/1.8+'%"></i>').join('')+'</div><small>'+ (gaps.length?gaps.map(([a,b])=>clock(a)+'–'+clock(b)+' PM').join(' · '):'No availability')+'</small></section>';
    }
  } catch(err) { openings.length=0; rows='<p>Calendar availability could not be loaded. Refresh to retry.</p>'; }
  if (e && e.parameter.view === 'windows') return ContentService.createTextOutput('window.showInterviewWindows('+JSON.stringify({openings,week})+');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark}body{font:16px system-ui;margin:8px}section{margin:.7em 0}.track{position:relative;height:14px;border-radius:4px;overflow:hidden;background:repeating-linear-gradient(135deg,#8885 0 3px,transparent 3px 6px);border:1px solid #8887;margin:4px 0}.track i{position:absolute;inset-block:0;background:#16846e}small{font-size:.85em}</style>'+rows).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  let message;
  try {
    const receipt = reserve(e.parameter);
    const esc = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const row = (label,value) => '<dt style="margin-top:1em"><strong>'+label+'</strong></dt><dd style="margin:0">'+esc(value)+'</dd>';
    message = '<h2>Booking confirmed</h2><dl>'+row('Date',receipt.date)+row('Time',receipt.time)+row('Booked by',receipt.email)+row('Format',receipt.format);
    if (receipt.address) message += row('Meeting address',receipt.address);
    message += '</dl>';
    if (/^https:\/\/meet\.google\.com\//.test(receipt.meet)) message += '<p><a target="_blank" rel="noopener" href="'+esc(receipt.meet)+'">Join Google Meet</a></p>';
    else if (receipt.format==='Google Meet') message += '<p>Your calendar invitation will contain the Google Meet details.</p>';
  } catch (error) {
    message = String(error.message || 'Booking failed.').replace(/[&<>"']/g, '');
  }
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><main style="font:18px system-ui;max-width:36em;margin:10vh auto;padding:1em"><h1>Interview booking</h1>' + message + '<a target="_top" href="https://pekruse.github.io/patrick-kruse-portfolio/self-interview.html">Return</a></main>');
}

function reserve(input) {
  const clientId = '970227434245-4cfu822ti8gc29jcjplmshpekqae4gfa.apps.googleusercontent.com';
  if (!clientId || typeof input.token !== 'string' || input.token.length > 8192) throw new Error('Google sign-in is required.');
  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(input.token), {muteHttpExceptions:true});
  if (response.getResponseCode() !== 200) throw new Error('Sign in again.');
  const claims = JSON.parse(response.getContentText());
  if (claims.aud !== clientId || !['accounts.google.com','https://accounts.google.com'].includes(claims.iss) || Number(claims.exp) <= Date.now()/1000 || String(claims.email_verified) !== 'true' || !claims.email) throw new Error('Google sign-in could not be verified.');
  const email = claims.email;
  const minutes = t => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error('Choose a valid time.');
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('Choose a date.');
  const start = minutes(input.start), end = minutes(input.end);
  if (end <= start || end - start > 180 || start < 840 || end > 1020)
    throw new Error('Choose up to three hours between 2 PM and 5 PM Eastern.');
  const parse = t => Utilities.parseDate(input.date + ' ' + t, ZONE, 'yyyy-MM-dd HH:mm');
  const from = parse(input.start), to = parse(input.end);
  if (Utilities.formatDate(from, ZONE, 'yyyy-MM-dd') !== input.date ||
      !['Tue','Thu'].includes(Utilities.formatDate(from, ZONE, 'EEE')) ||
      from.getTime() < Date.now() + 86400000)
    throw new Error('Choose a Tuesday or Thursday at least 24 hours ahead.');
  const physical = input.format === 'In person';
  const address = String(input.address || '').trim();
  if ((!physical && input.format !== 'Google Meet') || (physical && (!address || address.length > 300)))
    throw new Error('Choose a format and enter the meeting address for an in-person interview.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const timeMin = from.toISOString(), timeMax = to.toISOString();
    const cal = Calendar.Freebusy.query({timeMin, timeMax, items:[{id:CALENDAR_ID}]}).calendars[CALENDAR_ID];
    if (!cal || cal.errors || !Array.isArray(cal.busy)) throw new Error('Availability could not be checked.');
    if (cal.busy.length) throw new Error('That time overlaps another event. Choose another range.');
    const event = {summary:'Interview with Patrick Kruse', start:{dateTime:timeMin}, end:{dateTime:timeMax}, attendees:[{email}], guestsCanInviteOthers:false};
    if (physical) event.location = address;
    else event.conferenceData = {createRequest:{requestId:Utilities.getUuid(),conferenceSolutionKey:{type:'hangoutsMeet'}}};
    const booked = Calendar.Events.insert(event,CALENDAR_ID,{sendUpdates:'all',conferenceDataVersion:1});
    try {
      MailApp.sendEmail(CALENDAR_ID,'Interview booked: '+input.date+' at '+input.start+' Eastern',
        [email+' booked an interview.',input.date+' · '+input.start+'–'+input.end+' Eastern',physical?'In person: '+address:'Google Meet',booked.htmlLink].join('\n'));
    } catch(error) {
      console.error('Organizer notification failed for '+booked.id+': '+error.message);
    }
    return {date:Utilities.formatDate(from,ZONE,'EEEE, MMMM d, yyyy'),time:Utilities.formatDate(from,ZONE,'h:mm a')+' – '+Utilities.formatDate(to,ZONE,'h:mm a z')+' ('+(end-start)+' minutes)',email,format:input.format,address:physical?address:'',meet:booked.hangoutLink||''};
  } finally { lock.releaseLock(); }
}