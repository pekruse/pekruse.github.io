const CALENDAR_ID = 'pekruse504@gmail.com';
const ZONE = 'America/New_York';

function doGet() {
  return ContentService.createTextOutput('Patrick Kruse interview scheduler. Book through the portfolio.');
}

function doPost(e) {
  let message;
  try {
    message = reserve(e.parameter);
  } catch (error) {
    message = String(error.message || 'Booking failed.').replace(/[&<>"']/g, '');
  }
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><main style="font:18px system-ui;max-width:36em;margin:10vh auto;padding:1em"><h1>Interview booking</h1><p>' + message + '</p><a target="_top" href="https://pekruse.github.io/patrick-kruse-portfolio/self-interview.html">Return to Ask Patrick</a></main>');
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
    Calendar.Events.insert(event,CALENDAR_ID,{sendUpdates:'all',conferenceDataVersion:1});
    return 'Booked. Check your calendar invitation.';
  } finally { lock.releaseLock(); }
}