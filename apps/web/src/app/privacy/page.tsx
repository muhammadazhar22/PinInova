import type { Metadata } from "next";
import { LegalDoc, Section } from "@/components/Legal";
import { legalFacts } from "@/lib/legal";

export const metadata: Metadata = { title: "Privacy policy" };
export const dynamic = "force-dynamic";

export default function Privacy() {
  const f = legalFacts();
  return (
    <LegalDoc title="Privacy policy">
      <Section title="Who we are">
        <p>PinPulse is a Pinterest account-health service operated by {f.operator} (&ldquo;we&rdquo;). We are the controller of your account data and process your connected Pinterest data only to provide the service to you. Contact: {f.supportEmail}.</p>
        <p>PinPulse is not affiliated with, endorsed by, or approved by Pinterest.</p>
      </Section>

      <Section title="What we access on Pinterest">
        <p>We connect to Pinterest only through Pinterest&rsquo;s official API, using the access you grant on Pinterest&rsquo;s own consent screen. We request read-only permissions: <code>{f.scopes.join(", ")}</code>. We never create, edit or delete your Pins or boards, and we do not scrape or browse pinterest.com.</p>
      </Section>

      <Section title="What we store">
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Your PinPulse account:</strong> name, e-mail address, a password hash, workspace names and settings, and billing status.</li>
          <li><strong>Pinterest analytics:</strong> daily numbers for your own account and Pins (impressions, saves, clicks and similar). Raw daily numbers are kept for at most {f.rawDays} days.</li>
          <li><strong>Minimal Pin details:</strong> Pin ID, creation date, board ID, the Pin&rsquo;s link and its domain, and whether it is labelled as AI-generated. We do not store Pin titles, descriptions, images or board names.</li>
          <li><strong>Results we compute:</strong> diagnoses, health scores, alerts and reports for your account, kept for at most {f.derivedDays} days.</li>
          <li><strong>Access tokens:</strong> encrypted at rest (AES-256-GCM, per-record keys). They are never shown to anyone, including us, and never written to logs.</li>
          <li><strong>E-mails we send you:</strong> kept for {f.emailDays} days so we can retry delivery.</li>
        </ul>
        <p>We also check the landing pages your Pins link to (for example, whether a page loads or a site blocks Pinterest&rsquo;s crawler). These checks fetch only domains linked from your own Pins or claimed on your account, at most one request per second per domain, and identify themselves with a PinPulse header.</p>
      </Section>

      <Section title="How we use it">
        <p>Only to provide PinPulse to you and the people you invite: syncing, diagnosis, alerts, reports and support. We never combine your Pinterest data with another customer&rsquo;s, never sell it, never use it for advertising, and never use it to train models for others.</p>
        <p>The public &ldquo;weather&rdquo; page uses only voluntary reports that users submit about their own accounts; it does not use Pinterest API data.</p>
      </Section>

      <Section title="Agencies and their clients">
        <p>An agency can monitor a client&rsquo;s Pinterest account only after the client opens a single-use consent link (valid {f.consentLinkDays} days), reads what is accessed, and authorizes on Pinterest. We keep a record of that consent. The client receives a private link to revoke access at any time; revoking deletes the data as described below.</p>
      </Section>

      <Section title="Disconnecting deletes your data">
        <p>When you disconnect a Pinterest account (or a client revokes access), its access tokens are destroyed immediately and every row of Pinterest data and results for that account is permanently deleted within {f.purgeHours} hours. We keep only a deletion record (which connection, when, how many rows were removed) with no Pinterest data in it. A nightly check confirms nothing was left behind.</p>
        <p>If Pinterest access expires and is not renewed within {f.reauthGraceDays} days, we disconnect and delete the account&rsquo;s data the same way.</p>
      </Section>

      <Section title="Your rights">
        <p>You can download all of a workspace&rsquo;s data from that workspace&rsquo;s <strong>Settings</strong> page, and delete your PinPulse account yourself on the <strong>Account</strong> page. Deleting your account disconnects every Pinterest account and deletes all associated data as described above. You can also contact us to access, correct or delete your data, or to object to processing; you may complain to your local data-protection authority.</p>
      </Section>

      <Section title="Service providers">
        <p>We use these processors, each only to run PinPulse: Hetzner (servers, United States), Neon (database, United States), Resend (e-mail delivery), Sentry (error reports, with tokens, cookies, links and e-mail addresses removed before sending), Paddle (checkout, payments and invoicing as merchant of record), and Cloudflare (DNS). If you connect Slack, alerts are sent to the Slack webhook you provide.</p>
      </Section>

      <Section title="Cookies">
        <p>We use only cookies needed to run the service: your sign-in session and short-lived security cookies during a Pinterest connection or consent flow. We do not use advertising or third-party analytics cookies.</p>
      </Section>

      <Section title="Security">
        <p>Each workspace&rsquo;s data is isolated in the database by row-level security, connections are encrypted in transit, and access tokens are encrypted at rest with rotatable keys.</p>
      </Section>

      <Section title="Changes">
        <p>We will post changes here and, for material changes, e-mail account owners before they take effect.</p>
      </Section>
    </LegalDoc>
  );
}
