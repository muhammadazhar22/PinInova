import { Card } from "@/components/ui";
import { requireUser } from "@/modules/auth/session";
import { deleteAccountAction } from "../actions";

export const metadata = { title: "Account" };

export default async function AccountSettings() {
  const user = await requireUser();
  return (
    <div className="max-w-xl space-y-6">
      <h1>Account</h1>
      <Card title="Delete account">
        <p className="muted mb-3 text-sm">Deletes your PinPulse account. For organisations where you are the only owner, every connected Pinterest account is disconnected, its data deleted, and the organisation removed. This cannot be undone.</p>
        <form action={deleteAccountAction} className="space-y-2">
          <label className="label" htmlFor="confirm">Type your email ({user.email}) to confirm</label>
          <input className="input" id="confirm" name="confirm" required />
          <button className="btn-danger">Delete my account and data</button>
        </form>
      </Card>
    </div>
  );
}
