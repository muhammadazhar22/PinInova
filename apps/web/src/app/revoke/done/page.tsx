export default async function RevokeDone({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const { ok } = await searchParams;
  return (
    <main className="mx-auto mt-20 max-w-lg px-4">
      <h1>{ok === "1" ? "Access revoked" : "Nothing to revoke"}</h1>
      <p className="muted mt-2">{ok === "1" ? "Your tokens were destroyed and your data is being deleted." : "This link was already used or is not valid."}</p>
    </main>
  );
}
