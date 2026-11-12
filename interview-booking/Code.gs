const CALENDAR_ID = 'pekruse504@gmail.com';
const ZONE = 'America/New_York';

function doGet() {
  const page = HtmlService.createTemplateFromFile('Booking');
  page.clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  return page.evaluate().setTitle('Schedule an interview');
}

function reserve(input) {
  const clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
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