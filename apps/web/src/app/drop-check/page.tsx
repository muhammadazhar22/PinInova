import Link from "next/link";
import { DropCheckForm } from "@/components/PublicForms";

export const metadata = { title: "Free Pinterest Drop Check" };

export default function DropCheckPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <Link href="/" className="text-sm font-semibold text-brand-700">PinPulse</Link>
      <h1 className="mt-3">Free Pinterest Drop Check</h1>
      <p className="muted mt-1 mb-6">Upload your Pinterest Analytics export. We find the day reach changed, how big the change was, and whether engagement per view held (a sign that distribution was cut rather than content getting worse). No account needed; nothing is stored.</p>
      <DropCheckForm />
      <p className="muted mt-8 text-xs">PinPulse is not affiliated with Pinterest. This is not a "shadowban checker": it reports what your own numbers show.</p>
    </main>
  );
}
