// General OAuth app: visitor identity and separately authorized host credentials.
const ZOOM_OAUTH_CALLBACK_URL = 'https://script.google.com/macros/s/AKfycbwL6Ai7tqXTs6gc_29alKRTHFxbMTsb1Meg4zW9dizNchMgDtlQ-IYRosy-UNsMWBvoHw/exec';

function zoomOAuthConfig() {
  const p=PropertiesService.getScriptProperties();
  const client=(p.getProperty('ZOOM_OAUTH_CLIENT_ID')||'').trim();
  const secret=(p.getProperty('ZOOM_OAUTH_CLIENT_SECRET')||'').trim();
  const redirect=(p.getProperty('ZOOM_OAUTH_REDIRECT_URI')||ZOOM_OAUTH_CALLBACK_URL).trim();
  return client&&secret?{client,secret,redirect}:null;
}
function zoomRandom() {return (Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'');}
function zoomHash(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8)
    .map(b=>((b+256)%256).toString(16).padStart(2,'0')).join('');
}
function zoomJson(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function zoomTokenRequest(payload) {
  const c=zoomOAuthConfig();
  if(!c)throw Error('Zoom sign-in is not configured.');
  const r=UrlFetchApp.fetch('https://zoom.us/oauth/token',{
    method:'post',headers:{Authorization:'Basic '+Utilities.base64Encode(c.client+':'+c.secret)},
    payload,muteHttpExceptions:true
  });
  if(r.getResponseCode()!==200)throw Error('Zoom authorization failed. Please sign in again.');
  const token=JSON.parse(r.getContentText());
  if(!token.access_token)throw Error('Zoom authorization returned no access token.');
  return token;
}
function zoomProfile(token) {
  const r=UrlFetchApp.fetch('https://api.zoom.us/v2/users/me',{
    headers:{Authorization:'Bearer '+token},muteHttpExceptions:true
  });
  if(r.getResponseCode()!==200)throw Error('Your Zoom account could not be verified.');
  const user=JSON.parse(r.getContentText());
  if(!user.id||typeof user.email!=='string'||!user.email||user.email.length>254||/[\r\n,;]/.test(user.email))
    throw Error('Zoom did not provide an email address for the invitation.');
  return {id:String(user.id),email:user.email,name:String(user.display_name||[user.first_name,user.last_name].filter(Boolean).join(' ')).slice(0,100)};
}
function zoomStartFlow(challenge,kind) {
  const c=zoomOAuthConfig();
  if(!c)throw Error('Zoom sign-in setup is pending.');
  if(kind!=='host'&&!/^[a-f0-9]{64}$/.test(challenge||''))throw Error('Invalid sign-in request.');
  const state=zoomRandom();
  CacheService.getScriptCache().put('zoom-flow:'+state,JSON.stringify({
    challenge:challenge||'',kind,phase:'pending',expiresAt:Date.now()+600000
  }),600);
  return {state,authorizeUrl:'https://zoom.us/oauth/authorize?response_type=code&client_id='+encodeURIComponent(c.client)
    +'&redirect_uri='+encodeURIComponent(c.redirect)+'&state='+state};
}
// Run this function from the Apps Script editor as the project owner.
// Host authorization is never exposed as a public website endpoint.
function authorizeZoomHost() {
  const expected=(PropertiesService.getScriptProperties().getProperty('ZOOM_HOST_USER_ID')||'').trim();
  if(!expected)throw Error('Set ZOOM_HOST_USER_ID to your host Zoom email or user ID first.');
  const flow=zoomStartFlow('','host');
  console.log('Open this URL and sign in as your host Zoom account: '+flow.authorizeUrl);
  return flow.authorizeUrl;
}
function zoomStoreHost(token,user) {
  const p=PropertiesService.getScriptProperties(),expected=(p.getProperty('ZOOM_HOST_USER_ID')||'').trim();
  if(!expected||!(user.id===expected||user.email.toLowerCase()===expected.toLowerCase()))
    throw Error('Sign in with the configured host account to authorize meeting creation.');
  if(!token.refresh_token)throw Error('Zoom did not provide host refresh authorization.');
  p.setProperties({
    ZOOM_OAUTH_HOST_ID:user.id,ZOOM_OAUTH_HOST_EMAIL:user.email,
    ZOOM_OAUTH_HOST_ACCESS_TOKEN:token.access_token,
    ZOOM_OAUTH_HOST_REFRESH_TOKEN:token.refresh_token,
    ZOOM_OAUTH_HOST_EXPIRES_AT:String(Date.now()+Math.max(0,Number(token.expires_in)||0)*1000)
  });
}
function zoomHostReady() {
  const p=PropertiesService.getScriptProperties();
  return Boolean(zoomOAuthConfig()&&p.getProperty('ZOOM_OAUTH_HOST_ID')&&p.getProperty('ZOOM_OAUTH_HOST_REFRESH_TOKEN'));
}
function zoomHostAccessToken() {
  const p=PropertiesService.getScriptProperties();
  if(!zoomHostReady())throw Error('The host must authorize the new Zoom app before booking.');
  const current=p.getProperty('ZOOM_OAUTH_HOST_ACCESS_TOKEN');
  if(current&&Number(p.getProperty('ZOOM_OAUTH_HOST_EXPIRES_AT'))>Date.now()+60000)return current;
  // reserve() already holds the script lock, so refresh tokens cannot race.
  const token=zoomTokenRequest({grant_type:'refresh_token',refresh_token:p.getProperty('ZOOM_OAUTH_HOST_REFRESH_TOKEN')});
  if(!token.refresh_token)throw Error('Host Zoom authorization needs to be renewed.');
  p.setProperties({
    ZOOM_OAUTH_HOST_ACCESS_TOKEN:token.access_token,ZOOM_OAUTH_HOST_REFRESH_TOKEN:token.refresh_token,
    ZOOM_OAUTH_HOST_EXPIRES_AT:String(Date.now()+Math.max(0,Number(token.expires_in)||0)*1000)
  });
  return token.access_token;
}
function zoomOAuthCallback(params) {
  const cache=CacheService.getScriptCache();
  let flow,state=String(params.state||''),ok=false,heading='Zoom sign-in could not be completed.',detail='Return to the booking tab and try again.';
  try {
    if(!/^[a-f0-9]{64}$/.test(state))throw Error('Invalid sign-in state.');
    const lock=LockService.getScriptLock();lock.waitLock(10000);
    try {
      const raw=cache.get('zoom-flow:'+state);flow=raw&&JSON.parse(raw);
      if(!flow||flow.expiresAt<Date.now()||flow.phase!=='pending')throw Error('This sign-in request expired or was already used.');
      flow.phase='exchanging';cache.put('zoom-flow:'+state,JSON.stringify(flow),600);
    } finally {lock.releaseLock();}
    if(params.error)throw Error('Zoom sign-in was canceled. Return to your booking to try again.');
    if(typeof params.code!=='string'||!params.code||params.code.length>4096)throw Error('Zoom returned no authorization code.');
    // Serialize code exchange and host token updates with booking/refresh.
    // Zoom can invalidate the previous pair when the same user authorizes again.
    let token,user;
    const tokenLock=LockService.getScriptLock();tokenLock.waitLock(10000);
    try {
      token=zoomTokenRequest({grant_type:'authorization_code',code:params.code,redirect_uri:zoomOAuthConfig().redirect});
      user=zoomProfile(token.access_token);
      if(flow.kind==='host'){
        zoomStoreHost(token,user);
      }else{
        const p=PropertiesService.getScriptProperties();
        // Only maintain an existing host connection for that exact Zoom user ID.
        // Public visitor login must never establish or replace the host identity.
        if(zoomHostReady()&&user.id===p.getProperty('ZOOM_OAUTH_HOST_ID'))
          zoomStoreHost(token,user);
      }
    } finally {tokenLock.releaseLock();}
    if(flow.kind==='host'){
      heading='Host Zoom account connected.';detail='You can close this tab and return to Apps Script. The new app can now create meetings under your host account.';
    }else{
      const ticket=zoomRandom(),expiresAt=Date.now()+1800000;
      cache.put('zoom-session:'+ticket,JSON.stringify({user,challenge:flow.challenge,expiresAt}),1800);
      flow.ticket=ticket;flow.user=user;flow.sessionExpiresAt=expiresAt;
      heading='You are signed in with Zoom.';detail='Return to the booking tab to review and confirm your meeting. You can close this tab.';
    }
    ok=true;flow.phase='complete';cache.put('zoom-flow:'+state,JSON.stringify(flow),600);
  }catch(err){
    if(flow&&flow.phase==='exchanging'){flow.phase='error';flow.error='Zoom sign-in failed or was canceled. Please try again.';cache.put('zoom-flow:'+state,JSON.stringify(flow),600);}
    detail=String(err.message||detail);
  }
  const esc=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><main style="font:17px/1.6 system-ui;max-width:34rem;margin:12vh auto;padding:24px"><h1>'+esc(heading)+'</h1><p>'+esc(detail)+'</p><p>'+ (ok?'No meeting has been booked by signing in.':'No meeting was booked.')+'</p><a target="_top" href="https://pekruse.github.io/patrick-kruse-portfolio/self-interview.html#schedule">Return to booking page</a></main>');
}
function zoomFlowStatus(params) {
  const state=String(params.state||''),verifier=String(params.verifier||'');
  if(!/^[a-f0-9]{64}$/.test(state)||!/^[a-f0-9]{64}$/.test(verifier))throw Error('Invalid sign-in status request.');
  const raw=CacheService.getScriptCache().get('zoom-flow:'+state),flow=raw&&JSON.parse(raw);
  if(!flow||flow.expiresAt<Date.now()||flow.kind!=='visitor'||zoomHash(verifier)!==flow.challenge)throw Error('Sign-in expired. Please try again.');
  if(flow.phase==='complete')return {status:'complete',session:flow.ticket,email:flow.user.email,name:flow.user.name,expiresAt:flow.sessionExpiresAt};
  if(flow.phase==='error')return {status:'error',error:flow.error};
  return {status:'pending'};
}
function zoomBookingIdentity(input) {
  const ticket=String(input.zoomSession||''),verifier=String(input.zoomVerifier||'');
  if(!/^[a-f0-9]{64}$/.test(ticket)||!/^[a-f0-9]{64}$/.test(verifier))throw Error('Sign in with Zoom to book a Zoom meeting.');
  const raw=CacheService.getScriptCache().get('zoom-session:'+ticket),session=raw&&JSON.parse(raw);
  if(!session||session.expiresAt<=Date.now()||zoomHash(verifier)!==session.challenge)throw Error('Your Zoom sign-in expired. Sign in again.');
  return session.user;
}


// General OAuth provides both host meeting creation and visitor Zoom sign-in.
function zoomConfiguration() { return zoomHostReady()?{host:'me'}:null; }
function zoomAccessToken() { return zoomHostAccessToken(); }


function zoomMeetingFailure(response) {
  const status=Number(response.getResponseCode());
  let body={};
  try { body=JSON.parse(response.getContentText()); } catch (_) {}
  const numericCode=Number(body.code);
  const code=body.code!==undefined&&Number.isFinite(numericCode)?numericCode:null;
  const message=typeof body.message==='string'?body.message:'';
  let hint='Please contact Patrick so the host account settings can be checked.';
  if(code===4711||/does not contain scopes|missing scope|insufficient scope/i.test(message))
    hint='The host authorization is missing meeting-creation permission. Patrick must add meeting:write:meeting to the Zoom app and run authorizeZoomHost again.';
  else if(status===401||code===124)
    hint='The host Zoom authorization is no longer valid. Patrick must run authorizeZoomHost again.';
  else if(status===429)
    hint='Zoom has temporarily limited meeting creation. Please try again later.';
  else if(status===403)
    hint='Zoom denied meeting creation for the host. Patrick must check the app permissions and host account restrictions.';
  const reference='HTTP '+status+(code!==null?', Zoom code '+code:'');
  // Log only diagnostic codes, never the response body, credentials or meeting links.
  console.error('Zoom meeting creation rejected: '+reference);
  return new Error('Zoom could not create the meeting ('+reference+'). '+hint+' No booking was made.');
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
      start_time:Utilities.formatDate(from,ZONE,"yyyy-MM-dd'T'HH:mm:ss"),duration,timezone:ZONE,
      settings:{use_pmi:false,waiting_room:true,join_before_host:false}}),
    muteHttpExceptions:true
  });
  if (response.getResponseCode() !== 201) throw zoomMeetingFailure(response);
  const meeting = JSON.parse(response.getContentText());
  const id = String(meeting.id || '');
  const join = meeting.join_url;
  if (!/^\d+$/.test(id) || typeof join !== 'string' || !/^https:\/\/(?:[a-z0-9-]+\.)*zoom\.(?:us|com)\/j\/\d+(?:\?[^\s<>"']*)?$/i.test(join)) {
    if (/^\d+$/.test(id)) removeBookingZoom({id,token});
    throw new Error('Zoom did not return valid joining details. No booking was made.');
  }
  // Verify Zoom's returned UTC time rather than trusting a successful HTTP response.
  if(meeting.start_time){
    const returned=Date.parse(meeting.start_time);
    if(!Number.isFinite(returned)||Math.abs(returned-from.getTime())>1000){
      removeBookingZoom({id,token});
      throw new Error('Zoom returned a different meeting time. The meeting was removed and no new booking was confirmed. Please contact Patrick.');
    }
  }
  // The host-only start_url must never be included in attendee messages.
  return {id,join,token};
}


function updateBookingZoom(id,from,duration) {
  if(!/^\d+$/.test(String(id)))throw Error('The existing Zoom meeting reference is invalid. Please contact Patrick.');
  const token=zoomHostAccessToken();
  let response;
  try{
    response=UrlFetchApp.fetch('https://api.zoom.us/v2/meetings/'+encodeURIComponent(id),{
      method:'patch',contentType:'application/json',
      headers:{Authorization:'Bearer '+token},
      payload:JSON.stringify({start_time:Utilities.formatDate(from,ZONE,"yyyy-MM-dd'T'HH:mm:ss"),duration,timezone:ZONE}),
      muteHttpExceptions:true
    });
  }catch(_){
    const error=new Error('The Zoom update could not be verified. No replacement meeting was created.');
    error.zoomUpdateUncertain=true;throw error;
  }
  const status=response.getResponseCode();
  if(status===204)return;
  let body={};try{body=JSON.parse(response.getContentText());}catch(_){}
  const missingScope=Number(body.code)===4711||/scopes/i.test(String(body.message||''));
  const hint=missingScope?'Patrick must add meeting:update:meeting to the General app and run authorizeZoomHost again.'
    :status===401?'Patrick must reconnect the host Zoom account.'
    :status===404?'The original meeting is no longer available. Please contact Patrick.'
    :'Please try again later or contact Patrick.';
  const error=new Error('Zoom could not update the existing meeting (HTTP '+status+'). '+hint+' No replacement meeting was created.');
  error.zoomUpdateUncertain=status>=500;throw error;
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
  const params=e&&e.parameter||{};
  if(params.code||params.error)return zoomOAuthCallback(params);
  if(params.auth){
    try{
      if(params.auth==='zoom-start')return zoomJson(zoomStartFlow(params.challenge,'visitor'));
      if(params.auth==='zoom-status')return zoomJson(zoomFlowStatus(params));
      return zoomJson({error:'Unknown sign-in action.'});
    }catch(err){return zoomJson({error:String(err.message||'Zoom sign-in failed.')});}
  }
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
      let cursor = Math.max(0, Math.ceil((Date.now()-day.start)/60000));
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
  if (e && e.parameter.view === 'windows') return ContentService.createTextOutput('window.showInterviewWindows('+JSON.stringify({openings,week,additionalFormats:true,zoomOAuthAvailable:Boolean(zoomOAuthConfig()),zoomAvailable:Boolean(zoomConfiguration())})+');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark}body{font:16px system-ui;margin:8px}section{margin:.7em 0}.track{position:relative;height:14px;border-radius:4px;overflow:hidden;background:repeating-linear-gradient(135deg,#8885 0 3px,transparent 3px 6px);border:1px solid #8887;margin:4px 0}.track i{position:absolute;inset-block:0;background:#16846e}small{font-size:.85em}</style>'+rows).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  if(e&&e.parameter&&e.parameter.management){
    try{return zoomJson(manageBooking(e.parameter));}
    catch(error){return zoomJson({error:String(error.message||'Your booking could not be changed.')});}
  }
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
    if(receipt.manageUrl)message += '<p><a target="_top" href="'+esc(receipt.manageUrl)+'">Manage booking — edit or cancel</a></p>';
    if (receipt.zoom) message += '<p><a target="_blank" rel="noopener" href="'+esc(receipt.zoom)+'">Join Zoom meeting</a></p>';
    else if (/^https:\/\/meet\.google\.com\//.test(receipt.meet)) message += '<p><a target="_blank" rel="noopener" href="'+esc(receipt.meet)+'">Join Google Meet</a></p>';
    else if (receipt.format==='Google Meet') message += '<p>Your calendar invitation will contain the Google Meet details.</p>';
  } catch (error) {
    message = String(error.message || 'Booking failed.').replace(/[&<>"']/g, '');
  }
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><main style="font:18px system-ui;max-width:36em;margin:10vh auto;padding:1em"><h1>Interview booking</h1>' + message + '<a target="_top" href="https://pekruse.github.io/patrick-kruse-portfolio/self-interview.html">Return</a></main>');
}

function reserve(input) {
  let email,zoomIdentity=null;
  if(input.format==='Zoom'){
    zoomIdentity=zoomBookingIdentity(input);email=zoomIdentity.email;
  }else{
    const clientId = '970227434245-4cfu822ti8gc29jcjplmshpekqae4gfa.apps.googleusercontent.com';
    if (!clientId || typeof input.token !== 'string' || input.token.length > 8192) throw new Error('Google sign-in is required.');
    const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(input.token), {muteHttpExceptions:true});
    if (response.getResponseCode() !== 200) throw new Error('Sign in again.');
    const claims = JSON.parse(response.getContentText());
    if (claims.aud !== clientId || !['accounts.google.com','https://accounts.google.com'].includes(claims.iss) || Number(claims.exp) <= Date.now()/1000 || String(claims.email_verified) !== 'true' || !claims.email) throw new Error('Google sign-in could not be verified.');
    email = claims.email;
  }
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
      from.getTime() <= Date.now())
    throw new Error('Choose a future time on Tuesday or Thursday.');
  const wantsZoom = input.format === 'Zoom';
  if (wantsZoom && !zoomConfiguration()) throw new Error('Zoom is not available yet. Choose another meeting format.');
  const physical = input.format === 'In person';
  const phoneCall = input.format === 'Phone call';
  const teamsCall = input.format === 'Microsoft Teams';
  const phone = phoneCall ? String(input.phone || '').trim() : '';
  const teams = teamsCall ? String(input.teams || '').trim() : '';
  if (phoneCall && (!/^[+\d\s().-]{7,40}$/.test(phone) || phone.replace(/\D/g,'').length < 7 || phone.replace(/\D/g,'').length > 15))
    throw new Error('Enter a valid phone number, including country code.');
  if (teams && (teams.length > 1000 || !/^https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\/(?:l\/meetup-join\/|meet\/)[^\s<>"']+$/i.test(teams)))
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
    const event = {summary:'Interview with Patrick Kruse', start:{dateTime:timeMin}, end:{dateTime:timeMax}, attendees:[{email,...(zoomIdentity?{displayName:zoomIdentity.name}:{})}], guestsCanInviteOthers:false};
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
    event.id=zoomRandom();
    event.extendedProperties={private:{...(event.extendedProperties?.private||{}),bookingManaged:'1',bookingFormat:input.format,bookingEmail:email,bookingAddress:physical?address:'',bookingPhone:phone,bookingTeams:teams,bookingJoin:zoom||teams}};
    const manageUrl=bookingManagementUrl(event.id);
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
      phoneCall ? 'Phone call: Patrick will call '+phone : teamsCall ? 'Microsoft Teams: '+teamsDetails : physical ? 'In person: '+address : zoom ? 'Join Zoom meeting: '+zoom : 'Join Google Meet: '+(booked.hangoutLink || 'See the Calendar invitation for joining details.'),
      'View calendar event: '+booked.htmlLink,
      'Manage booking — edit or cancel: '+manageUrl
    ].join('\n');
    const escapeEmail=value=>String(value||'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const meetingLink=zoom||(!physical&&!phoneCall&&!teamsCall?booked.hangoutLink:teams)||'';
    const meetingLabel=zoom?'Join Zoom meeting':teamsCall?'Join Microsoft Teams meeting':'Join Google Meet';
    const htmlBody='<div style="font:16px/1.6 Arial,sans-serif;max-width:560px">'
      +'<h2>Interview confirmed</h2>'
      +'<p><strong>Date:</strong> '+escapeEmail(Utilities.formatDate(from,ZONE,'EEEE, MMMM d, yyyy'))+'<br>'
      +'<strong>Time:</strong> '+escapeEmail(Utilities.formatDate(from,ZONE,'h:mm a')+' – '+Utilities.formatDate(to,ZONE,'h:mm a z'))+'<br>'
      +'<strong>Meeting format:</strong> '+escapeEmail(input.format)+'<br>'
      +'<strong>Booked by:</strong> '+escapeEmail(email)+'</p>'
      +(meetingLink?'<p><a href="'+escapeEmail(meetingLink)+'" style="font-weight:bold">'+meetingLabel+'</a></p>':'')
      +(phoneCall?'<p>Patrick will call '+escapeEmail(phone)+'.</p>':physical?'<p><strong>Meeting address:</strong> '+escapeEmail(address)+'</p>':teamsCall&&!teams?'<p>'+escapeEmail(teamsDetails)+'</p>':'')
      +'<p><a href="'+escapeEmail(booked.htmlLink)+'">View calendar event</a></p>'
      +'<p><a href="'+escapeEmail(manageUrl)+'">Manage booking — edit or cancel</a></p></div>';
    for (const recipient of new Set([CALENDAR_ID.toLowerCase(),email.toLowerCase()])) {
      try {
        MailApp.sendEmail(recipient,subject,details,{htmlBody});
      } catch (error) {
        console.error('Confirmation email failed for event '+booked.id+' ('+(recipient===CALENDAR_ID.toLowerCase()?'organizer':'guest')+'): '+error.message);
      }
    }
    return {manageUrl,date:Utilities.formatDate(from,ZONE,'EEEE, MMMM d, yyyy'),time:Utilities.formatDate(from,ZONE,'h:mm a')+' – '+Utilities.formatDate(to,ZONE,'h:mm a z')+' ('+(end-start)+' minutes)',email,zoom,phone,teams,format:input.format,address:physical?address:'',meet:booked.hangoutLink||''};
  } finally { lock.releaseLock(); }
}


const BOOKING_MANAGE_PAGE='https://pekruse.github.io/patrick-kruse-portfolio/manage-booking.html';
function bookingManagementKey(id) {
  const p=PropertiesService.getScriptProperties();
  let secret=p.getProperty('BOOKING_MANAGEMENT_SECRET');
  if(!secret){secret=zoomRandom()+zoomRandom();p.setProperties({BOOKING_MANAGEMENT_SECRET:secret});}
  return Utilities.computeHmacSha256Signature('booking-management-v1:'+id,secret)
    .map(b=>((b+256)%256).toString(16).padStart(2,'0')).join('');
}
function bookingManagementUrl(id) {
  return BOOKING_MANAGE_PAGE+'#id='+encodeURIComponent(id)+'&key='+encodeURIComponent(bookingManagementKey(id));
}
function bookingGetManaged(input) {
  const id=String(input.id||''),key=String(input.key||'');
  if(!/^[a-v0-9]{5,1024}$/.test(id)||!/^[a-f0-9]{64}$/.test(key)||key!==bookingManagementKey(id))
    throw Error('This private booking link is invalid. Use the full link from your confirmation email.');
  let event;
  try{event=Calendar.Events.get(CALENDAR_ID,id);}
  catch(err){if(/404|410|not found|gone/i.test(String(err.message)))return {id,status:'cancelled'};throw Error('Your booking could not be loaded. Please try again.');}
  if(event.status!=='cancelled'&&event.extendedProperties?.private?.bookingManaged!=='1')
    throw Error('This booking does not have a management link.');
  return event;
}
function bookingPublic(event) {
  if(event.status==='cancelled')return {status:'cancelled'};
  const p=event.extendedProperties.private,from=new Date(event.start.dateTime),to=new Date(event.end.dateTime);
  const today=Utilities.formatDate(new Date(),ZONE,'yyyy-MM-dd');
  const monday=new Date(today+'T12:00:00Z');monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
  return {status:'confirmed',version:event.etag,date:Utilities.formatDate(from,ZONE,'yyyy-MM-dd'),
    start:Utilities.formatDate(from,ZONE,'HH:mm'),end:Utilities.formatDate(to,ZONE,'HH:mm'),
    format:p.bookingFormat,email:p.bookingEmail,address:p.bookingAddress||'',phone:p.bookingPhone||'',teams:p.bookingTeams||'',
    join:p.bookingJoin||event.hangoutLink||'',calendar:event.htmlLink||'',today,
    maxDate:new Date(+monday+90*86400000).toISOString().slice(0,10),
    editable:+from>Date.now()&&p.bookingCancellationPending!=='1',cancellationPending:p.bookingCancellationPending==='1',
    cleanupPending:!!p.bookingCleanup};
}
function bookingBusy(from,to,exclude) {
  const busy=[];let pageToken;
  do {
    const result=Calendar.Events.list(CALENDAR_ID,{timeMin:from.toISOString(),timeMax:to.toISOString(),
      singleEvents:true,showDeleted:false,maxResults:2500,...(pageToken?{pageToken}:{})});
    for(const item of result.items||[]){
      if(item.id===exclude||item.status==='cancelled'||item.transparency==='transparent')continue;
      const parse=part=>part.dateTime?Date.parse(part.dateTime):Utilities.parseDate(part.date+' 00:00',ZONE,'yyyy-MM-dd HH:mm').getTime();
      busy.push([parse(item.start),parse(item.end)]);
    }
    pageToken=result.nextPageToken;
  }while(pageToken);
  return busy;
}
function bookingValidateTime(input) {
  const date=String(input.date||''),start=String(input.start||''),end=String(input.end||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(end))throw Error('Choose a valid date and time.');
  const from=Utilities.parseDate(date+' '+start,ZONE,'yyyy-MM-dd HH:mm'),to=Utilities.parseDate(date+' '+end,ZONE,'yyyy-MM-dd HH:mm');
  const today=Utilities.formatDate(new Date(),ZONE,'yyyy-MM-dd'),monday=new Date(today+'T12:00:00Z');
  monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
  if(Utilities.formatDate(from,ZONE,'yyyy-MM-dd')!==date||!['Tue','Thu'].includes(Utilities.formatDate(from,ZONE,'EEE'))||
    +from<=Date.now()||+to<=+from||+to-+from>180*60000||start<'14:00'||end>'17:00'||date>new Date(+monday+90*86400000).toISOString().slice(0,10))
    throw Error('Choose a future Tuesday or Thursday between 2 PM and 5 PM Eastern, within the booking window.');
  return {from,to};
}
function bookingDeleteZoom(id) {
  if(!/^\d+$/.test(String(id)))throw Error('The Zoom meeting reference is invalid. Please contact Patrick.');
  const response=UrlFetchApp.fetch('https://api.zoom.us/v2/meetings/'+encodeURIComponent(id),{
    method:'delete',headers:{Authorization:'Bearer '+zoomHostAccessToken()},muteHttpExceptions:true});
  if(![204,404].includes(response.getResponseCode()))
    throw Error('Zoom could not remove the old meeting (HTTP '+response.getResponseCode()+'). Please retry or contact Patrick.');
}
function bookingClearOldZoom(event) {
  const p=event.extendedProperties.private;
  if(!p.bookingCleanup)return event;
  bookingDeleteZoom(p.bookingCleanup);
  return Calendar.Events.patch({extendedProperties:{private:{...p,bookingCleanup:''}}},CALENDAR_ID,event.id,{sendUpdates:'none'});
}
function bookingNotify(event,action) {
  const p=event.extendedProperties.private,url=bookingManagementUrl(event.id);
  const esc=value=>String(value||'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const join=p.bookingJoin||(p.bookingFormat==='Google Meet'?event.hangoutLink:'');
  const cancelled=action==='cancelled',title=cancelled?'Interview cancelled':'Interview updated';
  const lines=[title,Utilities.formatDate(new Date(event.start.dateTime),ZONE,'EEEE, MMMM d, yyyy'),
    Utilities.formatDate(new Date(event.start.dateTime),ZONE,'h:mm a')+' – '+Utilities.formatDate(new Date(event.end.dateTime),ZONE,'h:mm a z'),
    'Meeting format: '+p.bookingFormat];
  if(!cancelled&&join)lines.push('Join '+p.bookingFormat+' meeting: '+join);
  if(!cancelled&&p.bookingFormat==='In person')lines.push('Meeting address: '+p.bookingAddress);
  if(!cancelled&&p.bookingFormat==='Phone call')lines.push('Patrick will call: '+p.bookingPhone);
  if(!cancelled&&p.bookingFormat==='Microsoft Teams'&&!p.bookingTeams)lines.push('The Teams link will be emailed separately.');
  if(!cancelled){lines.push('View calendar event: '+event.htmlLink,'Manage booking: '+url);}
  const htmlBody='<div style="font:16px/1.6 Arial,sans-serif"><h2>'+title+'</h2><p>'+lines.slice(1,4).map(esc).join('<br>')+'</p>'
    +(!cancelled&&join?'<p><a href="'+esc(join)+'">Join '+esc(p.bookingFormat)+' meeting</a></p>':'')
    +(!cancelled&&p.bookingFormat==='In person'?'<p>Meeting address: '+esc(p.bookingAddress)+'</p>':'')
    +(!cancelled&&p.bookingFormat==='Phone call'?'<p>Patrick will call: '+esc(p.bookingPhone)+'</p>':'')
    +(!cancelled?'<p><a href="'+esc(event.htmlLink)+'">View calendar event</a></p><p><a href="'+esc(url)+'">Manage booking — edit or cancel</a></p>':'')+'</div>';
  let warning='';
  for(const recipient of new Set([CALENDAR_ID.toLowerCase(),p.bookingEmail.toLowerCase()])){
    try{MailApp.sendEmail(recipient,title,lines.join('\n'),{htmlBody});}
    catch(_){warning='Your change was saved, but a confirmation email could not be sent. Check your calendar.';console.error('Booking management confirmation email failed.');}
  }
  return warning;
}
function bookingSameSelection(current,input) {
  const normalize=value=>{
    const format=String(value.format||'').trim();
    return [String(value.date||''),String(value.start||''),String(value.end||''),format,
      format==='In person'?String(value.address||'').trim():'',
      format==='Phone call'?String(value.phone||'').trim():'',
      format==='Microsoft Teams'?String(value.teams||'').trim():''];
  };
  return JSON.stringify(normalize(current))===JSON.stringify(normalize(input));
}

function manageBooking(input) {
  const action=String(input.management||'');
  if(!['read','windows','save','cancel'].includes(action))throw Error('Unknown booking action.');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    let event=bookingGetManaged(input);
    if(event.status==='cancelled')return {booking:{status:'cancelled'}};
    const snapshot=bookingPublic(event);
    if(action==='read')return {booking:snapshot};
    if(action==='windows'){
      const date=String(input.date||'');
      bookingValidateTime({date,start:'16:59',end:'17:00'});
      const from=Utilities.parseDate(date+' 14:00',ZONE,'yyyy-MM-dd HH:mm'),to=Utilities.parseDate(date+' 17:00',ZONE,'yyyy-MM-dd HH:mm');
      let cursor=Math.max(+from,Math.ceil(Date.now()/300000)*300000),gaps=[];
      for(const [a,b] of bookingBusy(from,to,event.id).sort((a,b)=>a[0]-b[0]).concat([[+to,+to]])){
        if(cursor<a)gaps.push([cursor,Math.min(a,+to)]);cursor=Math.max(cursor,b);
      }
      return {openings:gaps.filter(([a,b])=>a<b).map(([a,b])=>({start:Utilities.formatDate(new Date(a),ZONE,'HH:mm'),end:Utilities.formatDate(new Date(b),ZONE,'HH:mm')}))};
    }
    // Idempotent even if a browser retries the last successful save with an old version.
    // An unchanged booking must not recreate Zoom, update Calendar or send email.
    if(action==='save'&&bookingSameSelection(snapshot,input)){
      if(snapshot.cancellationPending)throw Error('Cancellation is in progress. Reload and finish cancelling this booking.');
      let warning='';
      if(snapshot.cleanupPending){
        try{event=bookingClearOldZoom(event);}
        catch(_){warning='The previous Zoom link could not be removed yet. Retry cleanup or contact Patrick.';}
      }
      return {booking:bookingPublic(event),unchanged:true,warning};
    }
    if(input.version!==event.etag)throw Error('This booking changed in another tab. Reload it before making another change.');
    if(+new Date(event.start.dateTime)<=Date.now()&&!(action==='cancel'&&event.extendedProperties.private.bookingCancellationPending==='1'))throw Error('This meeting has already started. Please contact Patrick.');
    if(action==='cancel'){
      // Keep a durable retry marker if Zoom or Calendar is temporarily unavailable.
      const p=event.extendedProperties.private;
      if(p.bookingCancellationPending!=='1')event=Calendar.Events.patch({extendedProperties:{private:{...p,bookingCancellationPending:'1'}}},CALENDAR_ID,event.id,{sendUpdates:'none'});
      for(const id of new Set([event.extendedProperties.private.zoomMeetingId,event.extendedProperties.private.bookingCleanup].filter(Boolean)))bookingDeleteZoom(id);
      try{Calendar.Events.remove(CALENDAR_ID,event.id,{sendUpdates:'all'});}
      catch(_){throw Error('Cancellation is not confirmed yet. Reload this page and retry cancellation.');}
      const warning=bookingNotify(event,'cancelled');
      return {booking:{status:'cancelled'},warning};
    }
    if(!snapshot.editable)throw Error('Cancellation is in progress. Reload and finish cancelling this booking.');
    event=bookingClearOldZoom(event);
    const {from,to}=bookingValidateTime(input),format=String(input.format||'');
    if(!['Zoom','Microsoft Teams','Google Meet','In person','Phone call'].includes(format))throw Error('Choose a meeting format.');
    const address=format==='In person'?String(input.address||'').trim():'';
    const phone=format==='Phone call'?String(input.phone||'').trim():'';
    const teams=format==='Microsoft Teams'?String(input.teams||'').trim():'';
    if(format==='In person'&&(!address||address.length>300))throw Error('Enter a meeting address.');
    if(format==='Phone call'&&(!/^[+\d\s().-]{7,40}$/.test(phone)||phone.replace(/\D/g,'').length<7||phone.replace(/\D/g,'').length>15))throw Error('Enter a valid phone number.');
    if(teams&&(teams.length>1000||!/^https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\/(?:l\/meetup-join\/|meet\/)[^\s<>"']+$/i.test(teams)))throw Error('Enter a valid Teams meeting link.');
    if(bookingBusy(from,to,event.id).some(([a,b])=>a<+to&&b>+from))throw Error('That time is no longer available. Choose another opening.');
    const p=event.extendedProperties.private,operation=zoomRandom();
    const keepZoom=format==='Zoom'&&p.bookingFormat==='Zoom';
    if(keepZoom&&(!/^\d+$/.test(p.zoomMeetingId||'')||!p.bookingJoin))
      throw Error('The original Zoom meeting details are missing. Please contact Patrick; no replacement meeting was created.');
    const previousFrom=new Date(event.start.dateTime),previousDuration=(Date.parse(event.end.dateTime)-previousFrom.getTime())/60000;
    const zoomTimingChanged=keepZoom&&(from.getTime()!==previousFrom.getTime()||(+to-+from)/60000!==previousDuration);
    if(zoomTimingChanged){
      try{updateBookingZoom(p.zoomMeetingId,from,(+to-+from)/60000);}
      catch(error){
        if(error.zoomUpdateUncertain){
          try{updateBookingZoom(p.zoomMeetingId,previousFrom,previousDuration);}
          catch(_){throw Error('The Zoom update and restoration could not be verified. Please contact Patrick before retrying. No replacement meeting was created.');}
        }
        throw error;
      }
    }
    const zoom=keepZoom?{id:p.zoomMeetingId,join:p.bookingJoin}
      :format==='Zoom'?createBookingZoom(from,(+to-+from)/60000):null;
    const meta={...p,bookingFormat:format,bookingAddress:address,bookingPhone:phone,bookingTeams:teams,
      bookingJoin:zoom?zoom.join:format==='Microsoft Teams'?teams:'',
      zoomMeetingId:zoom?zoom.id:'',bookingCleanup:keepZoom?'':p.zoomMeetingId||'',bookingOperation:operation};
    const patch={start:{dateTime:from.toISOString()},end:{dateTime:to.toISOString()},
      extendedProperties:{private:meta},location:zoom?zoom.join:format==='In person'?address:format==='Phone call'?'Phone call':teams,
      description:zoom?'Join Zoom meeting: '+zoom.join:format==='Phone call'?'Patrick will call: '+phone:format==='Microsoft Teams'?'Microsoft Teams: '+(teams||'Link will be emailed separately.'):'',
      conferenceData:format==='Google Meet'?(p.bookingFormat==='Google Meet'?event.conferenceData:{createRequest:{requestId:operation,conferenceSolutionKey:{type:'hangoutsMeet'}}}):null};
    let saved;
    try{saved=Calendar.Events.patch(patch,CALENDAR_ID,event.id,{sendUpdates:'all',conferenceDataVersion:1});}
    catch(_){
      // A timeout can occur after Calendar applied the patch. Check before rollback.
      let checked;
      try{checked=Calendar.Events.get(CALENDAR_ID,event.id);}
      catch(_){throw Error('The update could not be verified. Reload and check the booking before retrying.');}
      if(checked.extendedProperties?.private?.bookingOperation===operation)saved=checked;
      else{
        if(keepZoom&&zoomTimingChanged){
          try{updateBookingZoom(p.zoomMeetingId,previousFrom,previousDuration);}
          catch(_){throw Error('The calendar update failed and the Zoom time could not be restored. Please contact Patrick before retrying.');}
        }else if(zoom&&!keepZoom)removeBookingZoom(zoom);
        throw Error('The calendar update failed. Your previous booking is unchanged.');
      }
    }
    let warning='';
    try{saved=bookingClearOldZoom(saved);}
    catch(_){warning='Your new booking is saved, but the previous Zoom link could not be removed yet. Reload and save again to retry cleanup, or contact Patrick.';}
    const emailWarning=bookingNotify(saved,'updated');
    return {booking:bookingPublic(saved),warning:[warning,emailWarning].filter(Boolean).join(' ')};
  }finally{lock.releaseLock();}
}
