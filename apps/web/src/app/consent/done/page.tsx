import { cookies } from "next/headers";

export const metadata = { title: "Connected" };

export default async function ConsentDone() {
  const token = (await cookies()).get("pp_revoke")?.value;
  return (
    <main className="mx-auto mt-20 max-w-lg px-4">
      <h1>Your account is connected</h1>
      <p className="muted mt-2">Thank you. Monitoring starts within a few minutes.</p>
      {token ? (
        <div className="card mt-6">
          <h2>Keep this link to revoke access</h2>
          <p className="muted mt-1 text-sm">Shown once. Opening it lets you disconnect PinPulse and delete your data at any time. You can also remove the app in your Pinterest settings.</p>
          <p className="mt-3 break-all rounded bg-stone-100 p-2 font-mono text-xs">{`${process.env.APP_URL ?? "http://localhost:3000"}/revoke/${token}`}</p>
        </div>
      ) : <p className="mt-6 text-sm">To revoke access later, remove PinPulse in your Pinterest account settings or ask your agency.</p>}
    </main>
  );
}
