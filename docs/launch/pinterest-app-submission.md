# Draft: Pinterest app description and Standard-access demo video

**Status: DRAFT for the owner.** Used in DEPLOYMENT.md Step 4. Record only after staging runs with
`PINTEREST_MODE=live` and your own business account is connected through the **real** consent screen: rejections
most often cite a demo that doesn't show the authentication flow or a live integration. Mock data is not enough.

## App description (developers.pinterest.com → My apps → your app)

**Short description (one line):**
PinInova helps creators and agencies understand changes in their own Pinterest reach, with read-only access.

**Full description:**
PinInova is an account-health tool for Pinterest creators, virtual assistants and agencies. After the account holder
connects through Pinterest OAuth, PinInova reads that account's own organic analytics, Pins and boards (read-only
scopes `user_accounts:read`, `pins:read`, `boards:read`) to:

- notice when reach changes, and date the change;
- explain the likely cause with evidence and a stated confidence (for example a change on Pinterest's side, a broken
  or slow landing page, or a publishing pattern such as reused images);
- check the account's own landing pages against Pinterest's published guidance;
- produce a monthly PDF report and a dated evidence pack the account holder can share with Pinterest support.

PinInova never creates, edits or deletes Pins or boards, never scrapes pinterest.com and never combines one
account's data with another's. Analytics are kept for at most 90 days. Disconnecting deletes the account's data within
24 hours. Agencies can monitor a client only after the client consents and authorizes through Pinterest themselves.

Privacy policy: `https://<domain>/privacy` · Terms: `https://<domain>/terms` · Support: `support@<domain>`

## Demo video (3–5 minutes)

Record the screen at 1080p in a clean browser profile; narrate briefly in English. Show the browser address bar
throughout so reviewers see the real domains (`staging.<domain>` and `pinterest.com`). Don't speed it up or cut
inside the OAuth step.

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | Home page at `https://staging.<domain>` | "PinInova helps creators understand changes in their own Pinterest reach. It is read-only." |
| 0:20–0:45 | Sign up, create a workspace | "A creator signs up and creates a workspace." |
| 0:45–1:30 | Click **Connect Pinterest account** → **real Pinterest consent screen** → scopes visible → **Allow** → back on PinInova | "We connect only through Pinterest OAuth. The scopes are read-only: user_accounts:read, pins:read, boards:read." |
| 1:30–2:15 | Account page after the first sync: health score, daily impressions, Issues list | "PinInova reads this account's own analytics and Pins. Here it dates any change and lists issues with evidence." |
| 2:15–2:45 | **Run link checks**; the Link and domain checks table | "It checks the account's own landing pages against Pinterest's published guidance, like load time and robots.txt." |
| 2:45–3:20 | **Monthly report** → Download PDF; open it | "The account holder gets a report they can share. We describe likely causes, never guarantees." |
| 3:20–4:00 | Account page → type DELETE → **Disconnect and delete** → confirmation | "Disconnecting removes access immediately and deletes this account's data within 24 hours." |
| 4:00–4:20 | Privacy page, "What we access" section | "Our privacy policy lists exactly what we read and store." |

Before recording: run `apps/web/scripts/smoke-live.ts` (`docs/runbooks/live-smoke-test.md`) and fix any contract
differences, so the data on screen is real and correct. Upload the video unlisted (or as the form asks) and paste the
link in My apps → Upgrade.

## Submission checklist
- [ ] App description and privacy URL on the app page match the text above
- [ ] Staging is live with HTTPS and `PINTEREST_MODE=live`; your own account connects through the real consent screen
- [ ] Smoke test passes; the video shows the full OAuth step and disconnect
- [ ] Legal pages show your real operator name, support e-mail and refund window (no "[to be set: …]")
- [ ] No answer after 14 days: polite status post in the Pinterest Business Community with the App ID
