# Draft: questions for Pinterest developer support

**Status: DRAFT for the owner to review and send.** Optional (DEPLOYMENT.md Step 2): nothing is blocked on the
answers. Send it from the business account that owns the developer app, after the app exists so you can quote its
App ID. Paste any written answer under the matching entry in `docs/policy/ASSUMPTIONS.md` with the date; never mark
an entry resolved without one.

Where to send: developers.pinterest.com → Help / Contact developer support (choose "API policy" if offered).

---

**Subject:** Policy questions before applying for Standard access: account-health tool (App ID: `<APP_ID>`)

Hello Pinterest Developer team,

I'm building PinInova, a read-only tool that helps creators, virtual assistants and agencies understand changes in
their *own* Pinterest reach. It connects only through Pinterest OAuth with the scopes `user_accounts:read`,
`pins:read` and `boards:read`. It never creates, edits or deletes Pins or boards, never scrapes pinterest.com, and
never combines one account's data with another's. Disconnecting deletes the account's data within 24 hours.

Before I apply for Standard access, I'd like to make sure our design matches the Developer Terms and Guidelines.
Could you confirm, or tell me what to change, for each point below?

1. **Storing an account's own analytics.** With the account holder's OAuth consent, may we store daily snapshots of
   that account's organic analytics (numbers only) for up to 90 days, and our own derived results (e.g. a detected
   drop date) for up to 13 months, solely to provide the service to that account holder? (Terms §4.1(a), Developer
   Guidelines on storage.)
2. **Minimal Pin metadata.** May we store Pin id, creation date, board id, link URL/domain and the declared AI
   disclosure alongside those metrics? We never store titles, descriptions, images or board names.
3. **Duplicate-image detection.** May we compute a perceptual hash of the user's own Pin images in memory to find
   near-duplicates, storing only which Pins are in the same group (not the hashes or images)?
4. **Comparing to published guidance.** Is comparing an account against Pinterest's own published guidance (e.g.
   landing pages loading in under 4 seconds, robots.txt allowing Pinterestbot) and against its own history
   acceptable, i.e. not "platform insights, benchmarking, or competitor research"? We do no cross-account comparison.
5. **Agencies.** May an agency monitor a client's account when the client completes our consent page and then
   authorizes the app through Pinterest OAuth themselves? We keep a consent record and the client can revoke at any time.
6. **User-reported "weather".** We show a public index built only from dates and symptoms that users voluntarily
   report to us (no Pinterest API data). Is that acceptable?
7. **Checking landing pages.** To explain a missing "Visit site" button, may we fetch the user's own landing pages
   identifying as Pinterestbot, at most one request per second per domain, with a header that identifies PinInova?
   If not, we will use our own user agent and only read robots.txt.
8. **Analytics delay.** Is it right that organic analytics can change for about 48 hours, so the last two days
   should be treated as provisional?
9. **Trial access.** Can a Trial-access app read real organic analytics for the developer's own account, so we can
   test before Standard access?

Thank you. I'm happy to share screenshots or a short demo of the consent and disconnect flows.

`<Your name>`, `<Business legal name>`
`<support@your-domain>` · `<https://your-domain>`

---

Mapping (for us, not for the email): 1 → PA-01, 2 → PA-02, 3 → PA-03, 4 → PA-04, 5 → PA-05, 6 → PA-06, 7 → PA-07,
8 → PA-08, 9 → PA-09. PA-10 (MCP server) is left out because it is not built.
