import type { Metadata } from "next";
import { LegalDoc, Section } from "@/components/Legal";
import { legalFacts } from "@/lib/legal";

export const metadata: Metadata = { title: "Refund policy" };
export const dynamic = "force-dynamic";

export default function Refunds() {
  const f = legalFacts();
  return (
    <LegalDoc title="Refund policy">
      <Section title="Refund window">
        <p>If PinPulse is not right for you, you can request a full refund within {f.refundWindow} of a payment. Refunds go back to the original payment method.</p>
      </Section>
      <Section title="How to request a refund">
        <p>Paddle.com is our Merchant of Record and processes all payments and refunds. Request a refund through the link in your Paddle receipt, or e-mail {f.supportEmail} with the e-mail address you paid with, and we will arrange it with Paddle.</p>
      </Section>
      <Section title="Cancelling">
        <p>You can cancel at any time through the link in your Paddle receipt or by e-mailing {f.supportEmail}. Cancelling stops future renewals; your plan stays active until the end of the period already paid.</p>
      </Section>
      <Section title="Your data after cancelling">
        <p>Cancelling a plan does not delete your data. To delete it, disconnect your Pinterest accounts or delete your PinPulse account; see the privacy policy.</p>
      </Section>
    </LegalDoc>
  );
}
