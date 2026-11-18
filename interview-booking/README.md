# Unique Zoom meetings for website bookings

Every Zoom booking creates a new scheduled meeting (`type: 2`, `use_pmi: false`).
The attendee join URL is included in the calendar event, confirmation page and
confirmation emails. The host-only start URL and OAuth credentials are never
published. Google Meet and in-person bookings continue to work as before.

## Activate

1. In the [Zoom App Marketplace](https://marketplace.zoom.us/), create a
   Server-to-Server OAuth app under the account that will host the interviews.
2. Grant `meeting:write:meeting:admin` (create) and
   `meeting:delete:meeting:admin` (cleanup), and activate the app. Account admin
   permission may be required. The configured host must belong to this account.
3. In the existing Google Apps Script project, open Project Settings → Script
   Properties and set:

   | Property | Value |
   | --- | --- |
   | `ZOOM_ACCOUNT_ID` | Zoom app Account ID |
   | `ZOOM_CLIENT_ID` | Zoom app Client ID |
   | `ZOOM_CLIENT_SECRET` | Zoom app Client Secret |
   | `ZOOM_HOST_USER_ID` | Host's Zoom user ID or Zoom account email |

   Do not put these values in GitHub, browser JavaScript, or chat. The former
   `ZOOM_JOIN_URL` property is no longer used; a shared link cannot enable Zoom.
4. Replace `Code.gs` in the existing project with this version. The existing
   `appsscript.json` already includes external-request permission.
5. Deploy → Manage deployments → edit the existing web app → New version →
   Deploy. Keep the existing deployment URL so the website continues to use it.
6. Verify with two separate Zoom bookings: their join URLs must differ, and
   each must match its calendar invitation and confirmations. Delete test
   calendar events and Zoom meetings afterward. Real bookings send invitations.

Zoom stays disabled in the website's format selector until all four properties
are present. This checks configuration presence, not credential validity; verify
the live account before announcing availability. Zoom account meeting-duration
limits still apply even though the scheduler permits up to three hours.

## Failure behavior and verification

Availability and Google identity are checked before Zoom is contacted. Zoom
creation failure prevents calendar insertion. Calendar insertion failure triggers
best-effort Zoom cleanup. Creation is not automatically retried after a network
error because Zoom may already have accepted it. An ambiguous network failure
can require checking both calendars and Zoom for an orphaned meeting/event.
Calendar cancellations do not yet automatically delete their Zoom meeting.

Run `node --test interview-booking/zoom.test.cjs` for mocked booking integration
checks. These tests send no emails and create no real calendar or Zoom meetings.

References: [Zoom authentication](https://developers.zoom.us/docs/internal-apps/s2s-oauth/)
and [Meetings API](https://developers.zoom.us/docs/api/meetings/).
