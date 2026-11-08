/** Minimal server-side SVG line chart for reports and PDFs (no client JS). */
export function lineChartSvg(p: { dates: string[]; series: { name: string; values: number[]; color: string }[]; markers?: { date: string; label: string }[]; width?: number; height?: number; title?: string }) {
  const W = p.width ?? 720;
  const H = p.height ?? 220;
  const L = 56, R = 16, T = 28, B = 28;
  const n = p.dates.length;
  const max = Math.max(1, ...p.series.flatMap((s) => s.values));
  const x = (i: number) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const fmt = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : `${Math.round(v)}`);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const grid = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#e5e7eb"/><text x="${L - 6}" y="${y(t) + 4}" font-size="10" text-anchor="end" fill="#6b7280">${fmt(t)}</text>`).join("");
  const step = Math.max(1, Math.round(n / 6));
  const xl = p.dates.map((d, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#6b7280">${d.slice(5)}</text>` : "")).join("");
  const lines = p.series
    .map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="1.75" points="${s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`)
    .join("");
  const marks = (p.markers ?? [])
    .map((m) => {
      const i = p.dates.indexOf(m.date);
      if (i < 0) return "";
      return `<line x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}" stroke="#b45309" stroke-dasharray="4 3"/><text x="${x(i) + 4}" y="${T + 10}" font-size="10" fill="#b45309">${esc(m.label)}</text>`;
    })
    .join("");
  const legend = p.series.map((s, k) => `<rect x="${L + k * 150}" y="6" width="10" height="10" fill="${s.color}"/><text x="${L + 14 + k * 150}" y="15" font-size="11" fill="#374151">${esc(s.name)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(p.title ?? p.series.map((s) => s.name).join(", "))}">${p.title ? "" : ""}${legend}${grid}${xl}${lines}${marks}</svg>`;
}
