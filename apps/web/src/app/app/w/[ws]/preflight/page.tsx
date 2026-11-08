import { Card } from "@/components/ui";
import { PreflightForm } from "@/components/Forms";
import { requireUser } from "@/modules/auth/session";
import { asUser } from "@/modules/workspaces/access";

export default async function PreflightPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const user = await requireUser();
  const conns = await asUser(user.id, ws, (tx) => tx<{ id: string; username: string }[]>`SELECT id, username FROM pinterest_connection WHERE status = 'active'`);
  return (
    <Card title="Pre-flight check for scheduled Pins">
      <p className="muted mb-4 text-sm">Upload the drafts you are about to schedule. Each finding says whether it comes from Pinterest's published policy, vendor guidance, or is a hypothesis from creator reports. Rules were last reviewed against the Community Guidelines effective 12 Nov 2026. Nothing you upload is stored.</p>
      <PreflightForm ws={ws} conns={[...conns]} />
    </Card>
  );
}
