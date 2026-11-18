// Credentials stay in Script Properties, never in the public website or repository.
function zoomConfiguration() {
  const props = PropertiesService.getScriptProperties();
  const names = ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_HOST_USER_ID'];
  const values = names.map(name => (props.getProperty(name) || '').trim());
  return values.every(Boolean) ? {account:values[0], client:values[1], secret:values[2], host:values[3]} : null;
}

function zoomAccessToken(config) {
  const response = UrlFetchApp.fetch('https://zoom.us/oauth/token', {
    method:'post',
    headers:{Authorization:'Basic '+Utilities.base64Encode(config.client+':'+config.secret)},
    payload:{grant_type:'account_credentials',account_id:config.account},
    muteHttpExceptions:true
  });
  if (response.getResponseCode() !== 200) throw new Error('Zoom could not be connected. No booking was made. Please try another meeting format.');
  const token = JSON.parse(response.getContentText()).access_token;
  if (!token) throw new Error('Zoom could not be connected. No booking was made.');
  return token;
}

function createBookingZoom(from, duration) {
  const config = zoomConfiguration();
  if (!config) throw new Error('Zoom is not available yet. Choose another meeting format.');
  const token = zoomAccessToken(config);
  // Never retry this POST automatically: a timeout could still have created a meeting.
  const response = UrlFetchApp.fetch('https://api.zoom.us/v2/users/'+encodeURIComponent(config.host)+'/meetings', {
    method:'post',contentType:'application/json',
    headers:{Authorization:'Bearer '+token},
    payload:JSON.stringify({topic:'Interview with Patrick Kruse',type:2,
      start_time:from.toISOString(),duration,timezone:ZONE,
      settings:{use_pmi:false,waiting_room:true,join_before_host:false}}),
    muteHttpExceptions:true
  });
  if (response.getResponseCode() !== 201) throw new Error('A Zoom meeting could not be created. No booking was made. Please try another meeting format.');
  const meeting = JSON.parse(response.getContentText());
  const id = String(meeting.id || '');
  const join = meeting.join_url;
  if (!/^\d+$/.test(id) || typeof join !== 'string' || !/^https:\/\/(?:[a-z0-9-]+\.)*zoom\.(?:us|com)\/j\/\d+(?:\?[^\s<>"']*)?$/i.test(join)) {
    if (/^\d+$/.test(id)) removeBookingZoom({id,token});
    throw new Error('Zoom did not return valid joining details. No booking was made.');
  }
  // The host-only start_url must never be included in attendee messages.
  return {id,join,token};
}

function removeBookingZoom(meeting) {
  try {
    const response = UrlFetchApp.fetch('https://api.zoom.us/v2/meetings/'+encodeURIComponent(meeting.id), {
      method:'delete',headers:{Authorization:'Bearer '+meeting.token},muteHttpExceptions:true
    });
    if (![204,404].includes(response.getResponseCode())) console.error('Unused Zoom meeting cleanup failed: '+meeting.id);
  } catch (error) { console.error('Unused Zoom meeting cleanup failed: '+meeting.id); }
}

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
  if (e && e.parameter.view === 'windows') return ContentService.createTextOutput('window.showInterviewWindows('+JSON.stringify({openings,week,additionalFormats:true,zoomAvailable:Boolean(zoomConfiguration())})+');').setMimeType(ContentService.MimeType.JAVASCRIPT);
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
    if (receipt.phone) message += row('Phone number',receipt.phone);
    if (receipt.format === 'Phone call') message += row('Call details','Patrick will call the number you provided.');
    if (receipt.format === 'Microsoft Teams') message += row('Teams details',receipt.teams || 'A Microsoft Teams joining link will be emailed separately.');
    message += '</dl>';
    if (receipt.zoom) message += '<p><a target="_blank" rel="noopener" href="'+esc(receipt.zoom)+'">Join Zoom meeting</a></p>';
    else if (/^https:\/\/meet\.google\.com\//.test(receipt.meet)) message += '<p><a target="_blank" rel="noopener" href="'+esc(receipt.meet)+'">Join Google Meet</a></p>';
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
  const wantsZoom = input.format === 'Zoom';
  if (wantsZoom && !zoomConfiguration()) throw new Error('Zoom is not available yet. Choose another meeting format.');
  const physical = input.format === 'In person';
  const phoneCall = input.format === 'Phone call';
  const teamsCall = input.format === 'Microsoft Teams';
  const phone = phoneCall ? String(input.phone || '').trim() : '';
  const teams = teamsCall ? String(input.teams || '').trim() : '';
  if (phoneCall && (!/^[+\d\s().-]{7,40}$/.test(phone) || phone.replace(/\D/g,'').length < 7 || phone.replace(/\D/g,'').length > 15))
    throw new Error('Enter a valid phone number, including country code.');
  if (teams && (teams.length > 2000 || !/^https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\/(?:l\/meetup-join\/|meet\/)[^\s<>"']+$/i.test(teams)))
    throw new Error('Enter a valid Microsoft Teams meeting link, or leave it blank.');
  const teamsDetails = teams || 'A Microsoft Teams joining link will be emailed separately.';
  const address = String(input.address || '').trim();
  if ((!physical && !wantsZoom && !phoneCall && !teamsCall && input.format !== 'Google Meet') || (physical && (!address || address.length > 300)))
    throw new Error('Choose a format and enter the meeting address for an in-person interview.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const timeMin = from.toISOString(), timeMax = to.toISOString();
    const cal = Calendar.Freebusy.query({timeMin, timeMax, items:[{id:CALENDAR_ID}]}).calendars[CALENDAR_ID];
    if (!cal || cal.errors || !Array.isArray(cal.busy)) throw new Error('Availability could not be checked.');
    if (cal.busy.length) throw new Error('That time overlaps another event. Choose another range.');
    const zoomMeeting = wantsZoom ? createBookingZoom(from, end-start) : null;
    const zoom = zoomMeeting ? zoomMeeting.join : '';
    const event = {summary:'Interview with Patrick Kruse', start:{dateTime:timeMin}, end:{dateTime:timeMax}, attendees:[{email}], guestsCanInviteOthers:false};
    if (phoneCall) {
      event.location = 'Phone call';
      event.description = 'Patrick will call: '+phone;
    } else if (teamsCall) {
      event.location = teams || 'Microsoft Teams';
      event.description = 'Microsoft Teams: '+teamsDetails;
    } else if (physical) event.location = address;
    else if (zoom) {
      event.location = zoom;
      event.description = 'Join Zoom meeting: '+zoom;
      event.extendedProperties = {private:{zoomMeetingId:zoomMeeting.id}};
    }
    else event.conferenceData = {createRequest:{requestId:Utilities.getUuid(),conferenceSolutionKey:{type:'hangoutsMeet'}}};
    let booked;
    try {
      booked = Calendar.Events.insert(event,CALENDAR_ID,{sendUpdates:'all',conferenceDataVersion:1});
    } catch (error) {
      if (zoomMeeting) removeBookingZoom(zoomMeeting);
      throw new Error('The calendar booking could not be confirmed. Please check your calendar before trying again.');
    }
    const subject = 'Interview confirmed: '+input.date+' at '+input.start+' Eastern';
    const details = [
      'Interview with Patrick Kruse',
      'Booked by: '+email,
      Utilities.formatDate(from,ZONE,'EEEE, MMMM d, yyyy'),
      Utilities.formatDate(from,ZONE,'h:mm a')+' – '+Utilities.formatDate(to,ZONE,'h:mm a z')+' ('+(end-start)+' minutes)',
      phoneCall ? 'Phone call: Patrick will call '+phone : teamsCall ? 'Microsoft Teams: '+teamsDetails : physical ? 'In person: '+address : zoom ? 'Zoom: '+zoom : 'Google Meet: '+(booked.hangoutLink || 'See the Calendar invitation for joining details.'),
      booked.htmlLink
    ].join('\n');
    for (const recipient of new Set([CALENDAR_ID.toLowerCase(),email.toLowerCase()])) {
      try {
        MailApp.sendEmail(recipient,subject,details);
      } catch (error) {
        console.error('Confirmation email failed for event '+booked.id+' ('+(recipient===CALENDAR_ID.toLowerCase()?'organizer':'guest')+'): '+error.message);
      }
    }
    return {date:Utilities.formatDate(from,ZONE,'EEEE, MMMM d, yyyy'),time:Utilities.formatDate(from,ZONE,'h:mm a')+' – '+Utilities.formatDate(to,ZONE,'h:mm a z')+' ('+(end-start)+' minutes)',email,zoom,phone,teams,format:input.format,address:physical?address:'',meet:booked.hangoutLink||''};
  } finally { lock.releaseLock(); }
}
