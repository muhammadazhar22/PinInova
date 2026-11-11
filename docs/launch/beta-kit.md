# Beta kit: recruiting, onboarding call, weekly review

**Status: DRAFT for the owner.** For DEPLOYMENT.md Step 5 (private beta, 10–15 Pinterest VAs). Until Standard access
lands, beta users can use only the no-API features: Drop Check, CSV import, pre-flight checks and the weather index.
Never promise that PinInova restores reach (non-negotiable 5): say "likely cause", "evidence", "confidence".

## 1. Recruiting

**Community post** (Pinterest VA groups, Facebook/Reddit/Slack communities that allow it; read each group's rules first):

> I'm building PinInova, a tool for Pinterest VAs and agencies that watches client accounts daily, dates the day
> reach changed, and explains the likely cause with evidence (Pinterest-side change, a broken or slow landing page,
> reused images and so on). It also builds a monthly client report. It's read-only: it never touches Pins.
>
> I'm looking for 10–15 VAs for a free private beta: a 20-minute call to set up, then honest feedback for a few
> weeks. Beta users get a founder discount afterwards. Interested? Comment or message me with how many client accounts
> you manage.

**Direct message** (to someone who posted about a sudden drop):

> Hi `<name>`, I saw your post about your impressions dropping on `<date>`. I'm building a tool that dates exactly
> when reach changed and shows the likely cause with evidence. Would you try the free Drop Check on your Pinterest
> analytics export? It takes two minutes and needs no account: `https://<domain>/drop-check`. If it's useful, I'm
> running a small free beta and would love your feedback.

**Screening (keep it short):** how many accounts do you manage? Have you had an unexplained drop in the last 3
months? What do you do today when it happens? Would you join two 20-minute calls?

## 2. Onboarding call (20 minutes)

| Minutes | Do | Note down |
|---|---|---|
| 0–3 | Their setup: number of clients, tools, how they report to clients | Current tools, reporting pain |
| 3–6 | Last drop they couldn't explain: what happened, what they tried | Their words for the problem |
| 6–14 | They share screen: sign up, create a workspace, run Drop Check or CSV import on a real export (or connect once Standard access exists). **Don't help unless stuck for 30 s.** | Every hesitation, with the screen it happened on |
| 14–18 | Walk through the result together: "What do you think this means? What would you do next? Would you send this to a client?" | Whether the cause and evidence made sense |
| 18–20 | Next steps: how to give feedback (reply e-mail or the in-app incident feedback), next call in 2 weeks | Willingness to pay; price reaction |

After the call: within 1 hour, write 5 bullets (biggest hesitation, what they valued, what confused them, would they
pay, quote worth keeping) into a shared note, one per user.

## 3. Weekly review (30 minutes, same day each week)

| Measure (Step 5 target) | This week | Last week | Notes |
|---|---|---|---|
| Alert precision on labelled incidents (≥ 80%) | | | useful ÷ (useful + not useful) |
| Labelled incidents so far (target 50) | | | |
| Connect → first diagnosis (< 10 min) | | | median from sign-up to first result |
| Nightly sync success (≥ 98%) | | | from worker logs / Sentry |
| Users active this week | | | |
| Would pay (≥ 8 of 15 by the end) | | | |

Then: top three complaints → one GitHub issue each; any incident labelled "not useful" → read its evidence and decide
whether it is a detector problem (feed the `detector-loop` skill) or a wording problem (UI copy).
