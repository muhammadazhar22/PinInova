import Link from "next/link";

// Fixed messages only: the query carries a reason code, never display text (no text spoofing via the URL).
const MESSAGES: Record<string, string> = {
  state_invalid: "This connection link has expired. Please start again.",
  wrong_browser: "This connection was started in a different browser or by a different user. Please start again from PinInova.",
  denied: "Pinterest access was not granted.",
  plan_limit: "Your plan's connected-account limit has been reached.",
  consent_used: "This consent link has already been used or has expired. Ask your agency for a new one.",
  exchange_failed: "Could not complete the Pinterest connection. Please try again.",
};

export default async function ConnectError({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams;
  return (
    <main className="mx-auto mt-20 max-w-lg px-4">
      <h1>Couldn't connect the account</h1>
      <p className="mt-2">{MESSAGES[r ?? ""] ?? "Something went wrong."}</p>
      <Link className="btn-secondary mt-6" href="/app">Back to PinInova</Link>
    </main>
  );
}
