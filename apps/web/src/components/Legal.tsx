import Link from "next/link";
import type { ReactNode } from "react";
import { legalFacts } from "@/lib/legal";

export function LegalDoc({ title, children }: { title: string; children: ReactNode }) {
  const f = legalFacts();
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 text-[15px] leading-relaxed">
      <p className="text-sm font-semibold text-brand-700"><Link href="/">PinInova</Link></p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="muted mt-2 text-sm">Effective {f.effectiveDate}. Operated by {f.operator}. Questions: {f.supportEmail}.</p>
      <div className="legal mt-8 space-y-6">{children}</div>
    </main>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

export function LegalFooter() {
  return (
    <footer className="muted mx-auto max-w-4xl px-4 py-8 text-xs">
      <nav aria-label="Legal" className="flex flex-wrap gap-4">
        <Link href="/pricing">Pricing</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/refunds">Refunds</Link>
      </nav>
      <p className="mt-2">PinInova is not affiliated with, endorsed by, or approved by Pinterest.</p>
    </footer>
  );
}
