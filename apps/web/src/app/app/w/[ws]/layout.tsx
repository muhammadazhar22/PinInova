import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth/session";
import { asUser } from "@/modules/workspaces/access";

export default async function WsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const user = await requireUser();
  const info = await asUser(user.id, ws, async (tx, acc) => ({ acc, ws: (await tx<{ name: string }[]>`SELECT name FROM workspace WHERE id = ${ws}`)[0] })).catch(() => null);
  if (!info?.ws) notFound();
  const base = `/app/w/${ws}`;
  const tabs = [["Overview", base], ["Pre-flight", `${base}/preflight`], ["Reports", `${base}/reports`], ["Alerts", `${base}/alerts`], ["Attribution", `${base}/attribution`], ["Settings", `${base}/settings`]] as const;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1>{info.ws.name}</h1>
        {!info.acc.canManage && <span className="muted text-sm">Read-only access</span>}
      </div>
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-stone-200 text-sm" aria-label="Workspace">
        {tabs.filter(([l]) => info.acc.canManage || ["Overview", "Reports"].includes(l)).map(([label, href]) => (
          <Link key={href} href={href} className="rounded-t-lg px-3 py-2 hover:bg-stone-100">{label}</Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
