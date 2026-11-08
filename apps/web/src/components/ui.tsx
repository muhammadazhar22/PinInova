import Link from "next/link";
import type { ReactNode } from "react";

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title ? <h2>{title}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

const tones = {
  good: "bg-green-50 text-green-800 border-green-200",
  warn: "bg-amber-50 text-amber-800 border-amber-200",
  bad: "bg-red-50 text-red-800 border-red-200",
  info: "bg-sky-50 text-sky-800 border-sky-200",
  neutral: "bg-stone-100 text-stone-700 border-stone-200",
} as const;
export type Tone = keyof typeof tones;

export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Never colour alone: every status has text and an icon glyph (WCAG 1.4.1). */
export function StatusChip({ status }: { status: string }) {
  const map: Record<string, [Tone, string, string]> = {
    active: ["good", "●", "Connected"],
    needs_reauth: ["warn", "▲", "Reconnect needed"],
    disconnected: ["neutral", "○", "Disconnected"],
    purged: ["neutral", "○", "Deleted"],
    open: ["bad", "●", "Open"],
    validating: ["info", "◐", "Validating fix"],
    passed: ["good", "✓", "Passed"],
    failed: ["bad", "✕", "Failed"],
    resolved: ["good", "✓", "Resolved"],
    suppressed: ["neutral", "–", "Suppressed"],
    regressed: ["bad", "↺", "Regressed"],
    acknowledged: ["info", "◐", "Acknowledged"],
  };
  const [tone, glyph, label] = map[status] ?? ["neutral", "•", status];
  return <Chip tone={tone}><span aria-hidden>{glyph}</span>{label}</Chip>;
}

export function SourceChip({ source }: { source: string }) {
  if (source === "you") return <Chip tone="info" title="You can fix this">Source: You</Chip>;
  if (source === "pinterest") return <Chip tone="warn" title="Likely on Pinterest's side">Source: Pinterest</Chip>;
  return <Chip title="Not determined">Source: Unknown</Chip>;
}

export function ScoreRing({ score, size = 112 }: { score: number | null; size?: number }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const v = score ?? 0;
  const band = score === null ? "No score yet" : v <= 30 ? "Weak" : v <= 70 ? "Fair" : v <= 90 ? "Good" : "Excellent";
  const color = score === null ? "#a8a29e" : v <= 30 ? "#b91c1c" : v <= 70 ? "#b45309" : "#0f766e";
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`Health score ${score ?? "not available"}, ${band}`}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="#e7e5e4" strokeWidth="8" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 50 50)" />
        <text x="50" y="56" textAnchor="middle" fontSize="24" fontWeight="600" fill="currentColor">{score ?? "–"}</text>
      </svg>
      <div>
        <div className="text-sm font-semibold">{band}</div>
        <div className="muted text-xs">Health score</div>
      </div>
    </div>
  );
}

export function MockBanner({ mode }: { mode: string }) {
  if (mode !== "mock") return null;
  return (
    <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
      Simulated data: connected to the <b>mock Pinterest API</b>. Nothing here comes from real Pinterest accounts.{" "}
      <Link href="/app/integrations" className="underline">Integration status</Link>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="muted rounded-lg border border-dashed border-stone-300 p-6 text-center text-sm">{children}</div>;
}

export function fmtInt(n: number | bigint | null | undefined) {
  if (n === null || n === undefined) return "–";
  return Number(n).toLocaleString("en-US");
}
export function fmtPct(v: number | null | undefined, digits = 0) {
  return v === null || v === undefined ? "–" : `${(v * 100).toFixed(digits)}%`;
}
export function fmtDate(d: Date | string | null | undefined) {
  if (!d) return "–";
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toISOString().slice(0, 10);
}
