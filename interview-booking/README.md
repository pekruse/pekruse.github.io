# Combined Zoom sign-in and meeting creation

The user-managed General OAuth app handles both visitor Zoom sign-in and a
separate host authorization. Visitors never become the meeting host. Their Zoom
identity determines the invitation email; meetings are created using the
configured host's authorization with `/users/me/meetings`.

## Configure the General app

Use these non-admin granular scopes:

- `user:read:user`
- `meeting:write:meeting`
- `meeting:delete:meeting`

Set the exact OAuth redirect URL and allow-list entry to:

`https://script.google.com/macros/s/AKfycbwL6Ai7tqXTs6gc_29alKRTHFxbMTsb1Meg4zW9dizNchMgDtlQ-IYRosy-UNsMWBvoHw/exec`

Set Script Properties `ZOOM_OAUTH_CLIENT_ID` and
`ZOOM_OAUTH_CLIENT_SECRET` using the same General app environment's credentials.
Keep `ZOOM_HOST_USER_ID` set to the intended host Zoom email or user ID.
`ZOOM_OAUTH_REDIRECT_URI` is optional and defaults to the URL above.

## Deploy and authorize the host

1. Replace the Apps Script project's entire `Code.gs` with this repository's
   current `interview-booking/Code.gs`. OAuth helpers are already included.
2. Save. Deploy a new version of the existing public web app, keeping the same
   URL. Execute the web app as its owner.
3. In the editor function dropdown, select `authorizeZoomHost` and click Run.
4. Open the authorization URL printed in the execution log within ten minutes.
5. Sign in using the account configured in `ZOOM_HOST_USER_ID` and approve
   the General app. The callback should say “Host Zoom account connected.”
6. Return to the booking page and refresh. Select Zoom, sign in as an attendee,
   choose a time, review, and confirm. Verify the actual Zoom meeting and invite.
7. Test a second slot and compare meeting URLs, then remove test events and meetings.

The original `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, and `ZOOM_CLIENT_SECRET`
properties are no longer used by this version. Keep them until the new flow is
verified. Host refresh credentials are stored under automatically managed
`ZOOM_OAUTH_HOST_*` properties; do not edit or publish those values.

A General app's development credentials and Local Test availability are for
permitted test accounts. Public visitor use is subject to Zoom's distribution
and review requirements. A login restriction from Zoom must be resolved there;
the website does not bypass it.

## Identity and behavior

Zoom bookings require a server-verified Zoom session. Google identity tokens,
guest email fields, expired sessions, and sessions with the wrong browser proof
are rejected for Zoom. Other formats keep the existing Google verification
until their provider-specific identity integrations are implemented.

Visitor sessions expire after 30 minutes and can expire earlier if Apps Script
evicts cache entries. Zoom access/refresh tokens are not returned to visitors.
Only the host's refresh authorization is persisted. The callback validates a
short-lived, single-use state. The private `authorizeZoomHost` editor function
creates host states; the public OAuth endpoint only creates visitor states.

Calendar conflicts are checked server-side before meeting creation. A failed
calendar insertion triggers best-effort meeting cleanup. Network uncertainty
may require checking Calendar and Zoom manually before retrying. Deleting or declining a Calendar invitation outside the management page does not
trigger Zoom cleanup. Use the private website management link for coordinated cancellation.

The website cannot confirm deployment, authorization, or live meeting creation
merely from configuration flags. Complete the live test above before describing
the integration as working.

## Tests

- `node --test interview-booking/zoom.test.cjs`
- `node --test patrick-kruse-portfolio/booking-workflow.test.cjs`

These tests mock external services; they do not create meetings or send invitations.

## Website management links

New confirmations include a clearly labeled **Manage booking — edit or cancel**
link to `patrick-kruse-portfolio/manage-booking.html`. Deploy the latest single
`Code.gs` file to the existing Apps Script deployment to enable the endpoints.
There are no new manual Script Properties and no additional Zoom scopes beyond
the existing create/delete scopes.

The URL fragment contains the event ID and an HMAC signature. Treat the full link
as a private capability: anyone holding it can read, edit or cancel that booking.
The page does not require another provider login. Links are not added retroactively
to previously sent emails. `BOOKING_MANAGEMENT_SECRET` is created once in private
Script Properties. Preserve it; replacing it invalidates outstanding links.

- Guests may repick a future Tuesday/Thursday, time and meeting format, and edit
  the address, phone or Teams link. The invitation email stays unchanged.
- Availability excludes the guest's own event and is checked again while saving.
- A rescheduled Zoom booking gets a new meeting; the old Zoom meeting is removed.
  This uses create/delete permissions and does not require a Zoom update scope.
- Cancellation deletes the Zoom meeting first, then removes the calendar event
  with attendee notifications. Failure leaves a durable retry marker; the page
  never reports complete cancellation until both operations finish.
- Updated and cancelled confirmations go to the guest and organizer.
- Management actions use POST, validate the private signature and event ownership
  marker, serialize with other app changes, and reject outdated event versions.
  Opening an email link or fetching a page never mutates the booking.
- If Zoom cleanup fails after a saved edit, the page displays a warning and stores
  the old meeting ID for retry rather than silently losing it.
- A network timeout can leave the result uncertain. Reload to check status before
  retrying; do not automatically repeat meeting creation.

Also run `node --test patrick-kruse-portfolio/manage-booking.test.cjs`.
Tests use mocked Calendar, Zoom and email services. Live edit/cancel verification
must follow the Apps Script redeployment; no live meetings were changed in tests.
