import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Create account" };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="mx-auto mt-20 max-w-sm px-4">
      <Link href="/" className="text-sm font-semibold text-brand-700">PinInova</Link>
      <h1 className="mt-4 mb-6">Create your account</h1>
      <div className="card"><AuthForm mode="signup" next={next} /></div>
      <p className="muted mt-4 text-sm">Already have an account? <Link className="underline" href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}>Sign in</Link></p>
    </main>
  );
}
