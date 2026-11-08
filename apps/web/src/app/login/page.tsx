import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Sign in" };

export default function Page() {
  return (
    <main className="mx-auto mt-20 max-w-sm px-4">
      <Link href="/" className="text-sm font-semibold text-brand-700">PinPulse</Link>
      <h1 className="mt-4 mb-6">Sign in</h1>
      <div className="card"><AuthForm mode="login" /></div>
      <p className="muted mt-4 text-sm">No account? <Link className="underline" href="/signup">Create one</Link></p>
    </main>
  );
}
