import type { Metadata } from "next";
import Link from "next/link";
import { LegalDoc, Section } from "@/components/Legal";
import { legalFacts } from "@/lib/legal";

export const metadata: Metadata = { title: "Terms of service" };
export const dynamic = "force-dynamic";

export default function Terms() {
  const f = legalFacts();
  return (
    <LegalDoc title="Terms of service">
      <Section title="Agreement">
        <p>These terms are an agreement between you and {f.operator} for the use of PinPulse. By creating an account you accept them. If you use PinPulse for a business or for clients, you accept them on behalf of that business.</p>
      </Section>

      <Section title="What PinPulse does">
        <p>PinPulse reads analytics for Pinterest accounts you connect, checks the pages your Pins link to, and gives you diagnoses, alerts and reports. A diagnosis is a likely explanation based on your own account&rsquo;s data, shown with its evidence and a confidence level. It is not a statement from Pinterest, and PinPulse cannot change how Pinterest distributes your content. We make no promise about reach, traffic, revenue or the outcome of any appeal.</p>
        <p>PinPulse is not affiliated with, endorsed by, or approved by Pinterest. Your use of Pinterest remains subject to Pinterest&rsquo;s own terms.</p>
      </Section>

      <Section title="Your account and connected accounts">
        <p>Keep your sign-in details secure; you are responsible for activity in your account. Connect only Pinterest accounts you own or are authorized to manage. To monitor a client&rsquo;s account, use PinPulse&rsquo;s client consent link, so that the client authorizes access themselves.</p>
      </Section>

      <Section title="Acceptable use">
        <p>Do not misuse PinPulse: no attempts to access other customers&rsquo; data, to probe or overload the service, to resell access without our agreement, or to use it to break the law or Pinterest&rsquo;s terms.</p>
      </Section>

      <Section title="Plans, payment and cancellation">
        <p>Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle provides all customer service inquiries and handles returns. Prices, taxes and billing periods are shown at checkout; subscriptions renew automatically until cancelled.</p>
        <p>You can cancel at any time through the link in your Paddle receipt or by e-mailing {f.supportEmail}; your plan stays active until the end of the period already paid. Refunds follow our <Link className="underline" href="/refunds">refund policy</Link>.</p>
      </Section>

      <Section title="Your data">
        <p>You own your data. Our <Link className="underline" href="/privacy">privacy policy</Link> explains what we store, for how long, and how disconnecting a Pinterest account deletes its data.</p>
      </Section>

      <Section title="Availability and changes">
        <p>PinPulse depends on Pinterest&rsquo;s API, which Pinterest can change or restrict. We may change or discontinue features; if we discontinue the paid service we will refund any prepaid period not yet used.</p>
      </Section>

      <Section title="Disclaimers and liability">
        <p>PinPulse is provided &ldquo;as is&rdquo;. To the extent the law allows, we are not liable for indirect or consequential losses, lost profits or lost revenue, and our total liability is limited to the amount you paid us in the 12 months before the claim. Nothing in these terms limits liability that cannot be limited by law.</p>
      </Section>

      <Section title="Ending the agreement">
        <p>You can stop using PinPulse and delete your account at any time. We may suspend or close accounts that break these terms, with notice where reasonable.</p>
      </Section>

      <Section title="Law and contact">
        <p>These terms are governed by {f.governingLaw}. We will notify account owners by e-mail before material changes take effect. Contact: {f.supportEmail}.</p>
      </Section>
    </LegalDoc>
  );
}
