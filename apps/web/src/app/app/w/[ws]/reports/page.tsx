import { Card, Empty, fmtDate } from "@/components/ui";
import { ShareForm } from "@/components/Forms";
import { requireUser } from "@/modules/auth/session";
import { reportsList } from "@/modules/queries";
import { asUser } from "@/modules/workspaces/access";

export default async function ReportsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ created?: string }> }) {
  const { ws } = await params;
  const { created } = await searchParams;
  const user = await requireUser();
  const { rows, acc } = await asUser(user.id, ws, async (tx, acc) => ({ rows: await reportsList(tx), acc }));
  const latest = created && rows.find((r) => r.id === created);
  return (
    <div className="space-y-6">
      {latest && (
        <Card title="Preview">
          <iframe title="Report preview" src={`/api/reports/${latest.id}/html?ws=${ws}`} className="h-[640px] w-full rounded-lg border border-stone-200 bg-white" sandbox="" />
        </Card>
      )}
      <Card title="Reports">
        {rows.length === 0 ? <Empty>No reports yet. Build a monthly report from an account page, or an evidence pack from an incident.</Empty> : (
          <table className="data"><thead><tr><th>Created</th><th>Type</th><th>Account</th><th>Period</th><th /></tr></thead><tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.created_at)}</td><td>{r.kind === "monthly" ? "Monthly report" : "Evidence pack"}</td><td>@{r.username}</td><td>{r.period_start} – {r.period_end}</td>
                <td className="space-x-2 whitespace-nowrap">
                  <a className="btn-secondary !py-1 text-xs" href={`/app/w/${ws}/reports?created=${r.id}`}>View</a>
                  <a className="btn-secondary !py-1 text-xs" href={`/api/reports/${r.id}/pdf?ws=${ws}`}>PDF</a>
                  {acc.canManage && <ShareForm ws={ws} report={r.id} shared={r.shared} />}
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
        <p className="muted mt-3 text-xs">Share links show the static report only, expire after 30 days, and can be revoked at any time.</p>
      </Card>
    </div>
  );
}
