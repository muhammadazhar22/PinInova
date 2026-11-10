import Link from "next/link";
import { WeatherForm } from "@/components/PublicForms";
import { todayUtc } from "@/lib/dates";
import { NICHES, weatherIndex } from "@/modules/weather/weather";

export const metadata = { title: "Pinterest weather: is it just me?" };
export const dynamic = "force-dynamic";

export default async function WeatherPage({ searchParams }: { searchParams: Promise<{ niche?: string }> }) {
  const { niche } = await searchParams;
  const n = (NICHES as readonly string[]).includes(niche ?? "") ? (niche as (typeof NICHES)[number]) : null;
  const days = await weatherIndex({ days: 45, niche: n }).catch(() => null);
  const color = (l: string, insufficient?: boolean) => (insufficient ? "bg-stone-200" : l === "platform_wide" ? "bg-red-600" : l === "elevated" ? "bg-amber-500" : "bg-teal-600");
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <Link href="/" className="text-sm font-semibold text-brand-700">PinInova</Link>
      <h1 className="mt-3">Is it just me? Pinterest weather</h1>
      <p className="muted mt-1">Built only from anonymous reports people submit about their own accounts. It does not use any Pinterest account data. A red day means many reporters saw a drop start within two days of it.</p>
      <form className="mt-4 flex items-end gap-2"><label className="label" htmlFor="n">Niche</label>
        <select className="input max-w-xs" id="n" name="niche" defaultValue={n ?? ""}><option value="">All niches</option>{NICHES.map((x) => <option key={x}>{x}</option>)}</select><button className="btn-secondary">Show</button></form>
      <div className="card mt-4">
        {days ? (
          <>
            <div className="flex gap-0.5" role="list" aria-label="Daily weather levels">
              {days.map((d) => <div key={d.date} role="listitem" title={`${d.date}: ${d.reports} drop reports of ${d.active_reporters} reporters (${d.insufficient ? "not enough reports" : d.level.replace("_", " ")})`} className={`h-10 flex-1 rounded-sm ${color(d.level, d.insufficient)}`} />)}
            </div>
            <div className="muted mt-2 flex justify-between text-xs"><span>{days[0]?.date}</span><span>{days.at(-1)?.date}</span></div>
            <p className="muted mt-3 text-xs"><span className="mr-3">■ <span className="text-teal-700">normal</span></span><span className="mr-3">■ <span className="text-amber-700">elevated</span></span><span className="mr-3">■ <span className="text-red-700">platform-wide</span></span><span>■ grey: fewer than 5 reporters</span></p>
          </>
        ) : <p className="muted text-sm">The weather service is unavailable right now.</p>}
      </div>
      <div className="card mt-6"><h2 className="mb-3">Add your report</h2><WeatherForm niches={NICHES} today={todayUtc()} /></div>
    </main>
  );
}
