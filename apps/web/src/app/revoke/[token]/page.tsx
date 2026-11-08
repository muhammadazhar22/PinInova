export const metadata = { title: "Revoke access" };

export default async function RevokePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto mt-20 max-w-lg px-4">
      <h1>Revoke PinPulse's access</h1>
      <p className="muted mt-2">This disconnects your Pinterest account from PinPulse immediately and deletes the data PinPulse holds about it within 24 hours.</p>
      <form method="post" action="/api/revoke" className="mt-6"><input type="hidden" name="token" value={token} /><button className="btn-danger">Revoke and delete my data</button></form>
    </main>
  );
}
