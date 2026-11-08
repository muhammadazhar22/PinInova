import Link from "next/link";
import { env } from "@/env";
import { MockBanner } from "@/components/ui";
import { requireUser } from "@/modules/auth/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="min-h-screen">
      <MockBanner mode={env().PINTEREST_MODE} />
      <header className="border-b border-stone-200 bg-white/80 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center gap-5 px-4 py-3 text-sm" aria-label="Main">
          <Link href="/app" className="font-semibold text-brand-700">PinPulse</Link>
          <Link href="/app" className="hover:underline">Workspaces</Link>
          <Link href="/weather" className="hover:underline">Weather</Link>
          <Link href="/app/billing" className="hover:underline">Plan</Link>
          <Link href="/app/integrations" className="hover:underline">Integrations</Link>
          <span className="ml-auto muted">{user.email}</span>
          <Link href="/app/account" className="hover:underline">Account</Link>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
