import Link from "next/link";
export default async function ConnectError({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const { m } = await searchParams;
  return (
    <main className="mx-auto mt-20 max-w-lg px-4">
      <h1>Couldn't connect the account</h1>
      <p className="mt-2">{m ?? "Something went wrong."}</p>
      <Link className="btn-secondary mt-6" href="/app">Back to PinPulse</Link>
    </main>
  );
}
