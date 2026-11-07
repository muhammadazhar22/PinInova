# PinPulse — Product & Design Research Report (7 Nov 2026)

All claims from pages actually fetched; URLs in the source list.

## 0. Summary

1. Nobody owns post-publish account health on Pinterest. Incumbents sell creation/scheduling. Only monitoring-adjacent features: PinClicks Pin Plus ($49/mo) emails on "AI Modified" flags and Visit-site removal; PinGenerator free one-off profile audit (/100) and trend alerts; Circleboom's thin "shadowban checker" page. No changepoint detection, cause classification, cohort comparison or evidence packs anywhere.
2. The pain is acute and unserved: 80–98% drop threads through 2025–26 (May 8 and Oct 29 2026 waves, AI-Modified false positives, missing Visit-site button); moderators "can't determine why impressions changed"; support sends "form letters"; appeals are one-shot ("each decision can only be appealed once").
3. Platform risk: Pinterest MCP server (alpha, holding-company agencies) and Business Assistant with "proactive alerts" in Ads Manager (Jun 2026) — ads-centric and gated.
4. Money is there: a Pinterest manager's stack is about $92/mo (PinClicks $29, Tailwind $30, Canva $13, ChatGPT $20, two $27/yr tools); retainers $300–$1,500/client/mo; "performance reporting" separates the $600 tier from $1,000+.
5. Ladder: Free Traffic Leak Check → Solo $19 → Pro $39 (5 accounts) → Agency $99 (20 accounts), overage $5–6. Activation: first annotated drop explained within 24 h.

## 1. Competitor teardown

| Tool | Price | Post-publish monitoring | Alerting | Agency | Weaknesses |
|---|---|---|---|---|---|
| Tailwind | Scheduling $17.99 annual / $29.99 monthly; SEO $11.99–14.99; Engagement $11.99–14.99; bundle $29.98; per Pinterest account | Keyword rank tracking; no drop diagnosis; reach-drop blog pushes input metrics | None | None | G2 4.3/5: wants longer history, less lag, faster support; Trustpilot 3.0/5: renewal and cancellation complaints |
| PinClicks | Pro $29 ($249/yr); Plus $49 ($399/yr) | Keyword rankings, Account Explorer, Pin Stats | Plus only: AI-Modified flags, Visit-site removal | Export/follow; no workspaces | Opaque methods |
| Pin Inspector | $67 one-time | Desktop scraper, on demand | None | License covers outsourcers | Desktop-only; no history |
| PinGenerator | Credit tiers (Free 15, Starter 200, Pro 1,000, Agency 10,000) | Free profile audit /100, Pin history, cleanup | Trend alerts only | More credits | One-off audit |
| BlogToPin | $25 / $50 / $125, unlimited accounts | Basic analytics; deletes underperformers | None | Team "coming soon" | Volume-first (35–1,000 pins/day) |
| Outfy | $15 / $27 / $33 | None | None | None | — |
| Pinterest Trends | Free | Search demand only | None | None | — |
| Circleboom | Pricing page 4xx | "Shadowban checker" with unexplained method | None | Unknown | Lead-gen page |
| Planoly | $14 / $24 / $47 | None stated | None | Seats + sets | — |
| Later | $18.75 / $37.50 / $82.50 | Pinterest analytics capped at 3 months | None | Access groups | — |
| Buffer | Free; $5–10/channel | Basic only for Pinterest | None | Team reports | Advanced analytics excludes Pinterest |
| Metricool | Free; $20–$159; ~$3/brand | Cross-network PDF/PPT reports | None | Advanced: roles, API; white-label Custom only | Generalist |
| Socialinsider | $82–$199 | Pinterest not supported | — | — | N/A |
| PinFreshly | Free + Pro | None (creation) | None | None | New |
| PINREVOS | Could not verify existence | — | — | — | Treat as non-existent |
| Pinterest Business Assistant / MCP | Closed beta; MCP alpha with PMG, Pacvue, Dentsu, Havas, Omnicom | Ads Q&A, trends, "proactive alerts" | Yes (ads) | Gated | Ads-only |

## 2. Customer evidence (≤15-word quotes, one per source)

- PBC 2 Nov 2026: moderator "can't determine why impressions changed"; topic closed in 6 minutes.
- PBC guide Aug 2026: moderators "cannot confirm whether an account was flagged, filtered, or limited."
- PBC Jul 2026 (140→1 daily visitors): "Multiple requests got only form letters."
- PBC Sep–Oct 2026 (5,000→100): staff "couldn't determine whether something account-specific was happening."
- PBC May 2026 "Read This Before You Spiral": "the 7 day guide is not accurate this time"; ~1,000 affected accounts claimed.
- PBC Jul 2026 Visit-site warning: staff "do not have the ability to manually review an account."
- PBC Jun 2025: support called the missing button a "UI experiment" with "no opt-out."
- PBC Aug 2026 VMP merchant: "impressions and traffic dropped by around 50%"; contacted "at least ten times."
- r/Blogging Nov 2025: "the people with only one account will feel it the most."; food blog: support blamed "a bug in its spam filter that flagged legitimate accounts."
- Food Blogger Pro ep. 555 (Jan 2026), Kate Ahl: "every third or fourth pin that is probably ai".
- GIGAZINE/404 Media Feb 2026: illustrator "repeatedly tagged 'AI-modified'"; 15% layoffs Jan 2026.
- Pinterest Reports & Violations lists "Limited distribution": "excluded from search results and the home feed"; "each decision can only be appealed once." Pioneer post: "Shadow banning is a myth on Pinterest" — vocabulary gap is the brand.
- VA economics: DDIY (Feb 2026) $600–$900 / $1,000–$1,500 with reporting / $2,000+; Boutique COO $400–$1,500; Larsen course page $300–$1,000+/mo, course $997; Hustle & Slow "$300-$400 per month per account"; Fiverr basic $60.
- Simple Pin Media SPM Insiders ($9/mo) sells cross-account "Quick Strategy Drops" — agencies monetise pattern knowledge the weather map productises.

### Personas

- Retainer Rachel (VA/micro-agency, 3–12 clients at $300–$1,500): tell me within a day whether it's them, me or Pinterest; produce a credible monthly report; prove platform-wide drops. Objections: PinClicks already alerts (only $49 tier, two signals); per-client cost; "will connecting a client's account get it flagged?"; "shadowbans are a myth."
- Evergreen Erin (food/home/DIY blogger, ad-monetised): which of pin/board/domain/copycat/platform, what to do first, a ticket that gets read. WTP $15–$19; strong free-tool funnel.
- Catalog Chris (Shopify/Etsy): product visibility, merchant status, Visit-site demotion, site fixes. Phase 2 via Shopify App Store at $19–$29.

## 3. UX patterns to copy

Ahrefs health score (error-only %, four bands, per-project ignore) → HealthScoreRing with published formula; Semrush site audit (weighted score, thematic reports, delta) → thematic issue tabs; GSC page indexing (source: Google vs website; Validate fix states; issue lifetime) → Source chip and Validate button; GSC manual actions → appeal evidence pack and one-appeal tracking; UptimeRobot/Better Stack status pages → public weather page and private client pages; Sentry issues (grouping, Regressed, Escalating, suspect commits) → issue grouping and "suspect change"; Mediavine/Raptive (median comparisons, ranked actions, Compass MCP) → Action Center and later MCP; Stripe Radar (score + top factors + related entities) → CauseCard with factors; Grammarly (relative score, sub-grades) → five sub-grades.

## 4. Design system

Calm, forensic, independent. Inter/IBM Plex Sans with tabular figures; 16 px body, 14 px minimum in tables. Radix 12-step scales; primary Teal/Indigo; status Green/Amber/Red/Grey with icons and text; WCAG 2.2 4.5:1 text, 3:1 UI and chart series; one focus hue plus greys; ≤5 categorical hues; CVD-tested; token-based dark mode. Stack: Next.js + shadcn/ui + Recharts (shadcn wrapper) + Tremor Tracker/ProgressCircle + Radix Colors. Components: HealthScoreRing, AnnotatedTimeline, CauseCard, WeatherMap, MatchedPairWizard, DomainIntegrityChecklist, ReportBuilder, IssueList, ActionCenter, AlertRuleEditor, ClientWorkspaceSwitcher, Appeal composer.

## 5. Pricing & packaging

Benchmarks: Tailwind $12–$30/account; PinClicks $29/$49; BlogToPin $25/$50/$125; Metricool ~$3–4/brand; Later $11.25/set; Planoly $8–10/set; Buffer $5–10/channel. Ladder: Free Traffic Leak Check; Solo $19 ($15 annual); Pro $39 ($32) for 5 (+$6); Agency $99 ($82) for 20 (+$5) with white-label, seats, API/MCP, cohort benchmarks once authorized. Billing hygiene as a trust feature. Free tools: Traffic Leak Check, "Not-a-Shadowban Checker", public Niche Weather Map. Onboarding: connect → niche → backfill → first annotated drop → one alert rule → first report. Activation metric: cause card viewed and alert kept within 24 h; first report shared within 7 days.

## 6. Go-to-market

Communities: Pinterest Business Community (Pioneers as design partners), Kristin Larsen's course ($997, private Facebook community), Simple Pin Media (SPM Insiders, 15,000-subscriber newsletter, podcast), Dish It Out Social, Jen Vazquez, Cara Chace, Tailwind Communities, Reddit (r/Blogging, r/socialmedia, r/PinterestMarketing), Fiverr/Upwork. Affiliates: Tailwind pays up to $120 per customer plus milestone bonuses on dub.co; recommend 30% recurring for 12 months. SEO: "pinterest impressions dropped" (forum threads + two Tailwind posts; no tool page ranks), "pinterest shadowban" (opinion pages only), "pinterest visit site button missing" (~10 PBC threads, Simple Pin article), plus "AI modified label pinterest", "limited distribution pinterest", "pinterest VMP review". No third-party volume data retrievable.

## 7. Risks

Data access scopes for client accounts; platform encroachment (Business Assistant, MCP); the "myth" narrative; unverified items (PINREVOS, Circleboom pricing, PinClicks affiliate terms, Facebook group sizes, keyword volumes).

## Sources

Competitors: https://www.tailwindapp.com/pricing · https://www.tailwindapp.com/blog/pinterest-reach-drop-impressions · https://www.tailwindapp.com/blog/why-are-my-pinterest-impressions-going-down · https://www.tailwindapp.com/affiliate · https://www.g2.com/products/tailwind/reviews?qs=cons · https://www.trustpilot.com/review/tailwindapp.com · https://pinclicks.com/pricing · https://pininspector.com/ · https://pingenerator.com/pricing · https://pingenerator.com/blog/how-to-audit-your-pinterest-account · https://blogtopin.com/pricing · https://outfy.com/pricing · https://circleboom.com/blog/pinterest-shadowban-checker/ · https://www.planoly.com/pricing · https://later.com/pricing/ · https://buffer.com/pricing · https://metricool.com/pricing/ · https://www.socialinsider.io/pricing · https://huntscreens.com/products/pinfreshly · https://trends.pinterest.com/ · https://ppc.land/pinterests-mcp-server-and-ask-pinterest-app-rewrite-the-discovery-playbook/ · https://community.pinterest.biz/t/introducing-pinterest-ai-tools-for-smarter-faster-decision-making/47883.md
Customers: https://community.pinterest.biz/t/impressions-down-90-since-oct-29-top-pins-missing-from-search/52914.md · https://community.pinterest.biz/t/how-to-get-support-for-impression-drops/49965.md · https://community.pinterest.biz/t/massive-drop-in-impressions-with-no-explanation/48188.md · https://community.pinterest.biz/t/pin-dropped-from-5-000-daily-impressions-to-100-how-is-this-not-a-distribution-issue/51484.md · https://community.pinterest.biz/t/pinterest-numbers-dropped-read-this-before-you-spiral/45856.md · https://community.pinterest.biz/t/the-pinterest-urban-legend-of-shadowbanning-why-you-should-stop-believing-it/46478.md · https://community.pinterest.biz/t/visit-site-button-showing-spam-warning-on-all-pins-requesting-review/48297.md · https://community.pinterest.biz/t/visit-website-button-missing-on-pins-traffic-down-despite-full-optimization/34576.md · https://community.pinterest.biz/t/pinterest-impressions-dropped-after-vmp-review-new-pins-not-getting-reach/49360.md · https://help.pinterest.com/en/article/review-your-reports-and-violations · https://www.simplepinmedia.com/visit-site-button-on-pinterest/ · https://gigazine.net/gsc_news/en/20260224-pinterest-ai-slop · https://www.foodbloggerpro.com/podcast/pinterest-strategy-for-food-creators-in-2026/ · https://pinningartfully.substack.com/p/all-the-cool-software-i-use-for-my · https://benable.com/secretpinner/pinterest-growth-tools-i-actually-use-and-recommend-to-clients · https://carachace.squarespace.com/blog/pinterest-manager-success · https://ddiy.co/virtual-assistant-pinterest-cost/ · https://theboutiquecoo.squarespace.com/blog/how-much-does-it-cost-to-hire-a-pinterest-va · https://digitaltriggers.io/pinterest-va-review · https://www.hustleandslow.com/pinterest-virtual-assistant/ · https://www.fiverr.com/shamir_786/be-your-pinterest-manager · https://www.simplepinmedia.com/spm-insiders/
UX/design: https://help.ahrefs.com/en/articles/1424673-what-is-health-score-and-how-is-it-calculated-in-ahrefs-site-audit · https://www.semrush.com/kb/540-site-audit-overview · https://support.google.com/webmasters/answer/7440203 · https://support.google.com/webmasters/answer/9044175 · https://uptimerobot.com/status-page/ · https://betterstack.com/docs/uptime/status-pages/ · https://docs.sentry.io/product/issues/ · https://help.mediavine.com/navigating-the-new-mediavine-dashboard · https://help.raptive.com/hc/en-us/articles/27423332296219-Performance-by-Page · https://docs.stripe.com/radar/reviews/risk-insights · https://support.grammarly.com/hc/en-us/articles/360007144751-What-is-Performance-and-how-is-it-calculated · https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html · https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html · https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale · https://ui.shadcn.com/docs/components/chart · https://tremor.so/docs/getting-started/installation · https://www.datawrapper.de/blog/colorguide
