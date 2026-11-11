# Draft: Data Processing Agreement (agencies)

**Status: DRAFT, not legal advice.** DEPLOYMENT.md Step 2 lists an agency DPA among the legal pages. A lawyer must
review it before use, especially the governing law, liability and international-transfer sections, which depend on
where the business is registered and where customers are. Facts below match the code and the privacy page on
11 Nov 2026; if those change, update this too. Placeholders: `<…>`.

---

**Data Processing Agreement**

Between `<Agency legal name>` ("**Agency**", controller) and `<PinInova operator legal name>`, `<address>`
("**PinInova**", processor). This agreement forms part of the PinInova Terms of Service the Agency accepted.

**1. Scope.** PinInova processes personal data on the Agency's behalf only to provide the PinInova service to the
Agency for Pinterest accounts of the Agency's clients ("**Clients**") who have consented through PinInova's consent
flow and authorized PinInova through Pinterest OAuth.

**2. Data and data subjects.**
- Data subjects: Clients (Pinterest account holders) and the Agency's users.
- Categories: Pinterest account identifier and username; the account's organic analytics (numbers only); minimal Pin
  metadata (Pin id, creation date, board id, link URL and domain, declared AI disclosure); consent records (scopes,
  consent text version, time); Agency users' names and e-mail addresses. PinInova does not store Pin titles,
  descriptions, images or board names, and receives no special-category data.
- Purpose: monitoring account health, diagnosing likely causes of reach changes, link and domain checks, reports.

**3. Instructions.** PinInova processes the data only on the Agency's documented instructions, which are this
agreement and the Agency's use of the service. PinInova does not combine one Client's Pinterest data with another's
or use it for any other customer.

**4. Confidentiality.** Everyone at PinInova authorized to process the data is bound by confidentiality.

**5. Security.** PinInova maintains at least: per-workspace isolation enforced by database row-level security;
encryption in transit; OAuth tokens encrypted at rest with per-record keys wrapped by a rotatable key-encryption key;
read-only Pinterest scopes; error reports scrubbed of tokens, cookies, links and e-mail addresses; access to
production limited to `<named people/roles>`.

**6. Sub-processors.** The Agency authorizes these sub-processors: Hetzner (servers, United States), Neon (database,
United States), Resend (e-mail delivery), Sentry (error reports, scrubbed), Cloudflare (DNS). Paddle acts as merchant
of record for payments (an independent controller, not a sub-processor of Client data). If a Client's alerts go to a
Slack webhook the Agency provides, Slack receives them under the Agency's own agreement. PinInova will give at least
`<30>` days' notice of new sub-processors by e-mail; the Agency may object and terminate if the objection cannot be
resolved.

**7. Data-subject requests.** PinInova helps the Agency answer requests: data export per workspace, deletion by
disconnecting an account, and deletion of the Agency's PinInova account. A Client can also revoke access themselves
through their private revoke link, which deletes that Client's data as in section 9.

**8. Personal-data breaches.** PinInova notifies the Agency without undue delay, and within `<48>` hours of becoming
aware of a breach affecting the Agency's data, with what is known and the steps taken.

**9. Retention and deletion.** Raw analytics are kept at most 90 days and derived results at most 13 months. When an
account is disconnected or a Client revokes access, PinInova destroys its tokens immediately and permanently deletes
all of that account's Pinterest data and results within 24 hours, keeping only a deletion record without Pinterest
data. On termination, the same applies to every account in the Agency's workspaces.

**10. Audits.** PinInova makes available the information necessary to demonstrate compliance with this agreement and
answers reasonable written questionnaires once a year, or after a breach.

**11. International transfers.** `<Lawyer to complete: transfer mechanism, e.g. Standard Contractual Clauses, for
EU/UK Clients, given US hosting.>`

**12. Liability, term, law.** Liability is as in the Terms of Service. This agreement lasts as long as PinInova
processes data for the Agency. Governing law: `<…>`.

Signed for the Agency: ____________________ Date: ________
Signed for PinInova: ____________________ Date: ________
