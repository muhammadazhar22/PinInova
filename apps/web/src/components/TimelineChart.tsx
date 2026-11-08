"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, DataZoomComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, DataZoomComponent, SVGRenderer]);

export interface TimelineProps {
  dates: string[];
  impressions: (number | null)[];
  clicks: (number | null)[];
  markers: { date: string; label: string; kind: "drop" | "warning" }[];
  provisional: string[];
}

/** Annotated timeline: changepoints as marked lines, provisional (still-processing) days shaded. */
export function TimelineChart(p: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    const prov = p.provisional.length ? [[{ xAxis: p.provisional[0], itemStyle: { color: "rgba(180,83,9,0.08)" }, label: { show: true, position: "insideTop", formatter: "provisional", color: "#92400e", fontSize: 10 } }, { xAxis: p.provisional.at(-1) }]] : [];
    chart.setOption({
      aria: { enabled: true },
      grid: { left: 56, right: 56, top: 36, bottom: 56 },
      tooltip: { trigger: "axis" },
      legend: { top: 0, data: ["Impressions", "Outbound clicks"] },
      xAxis: { type: "category", data: p.dates, axisLabel: { color: "#78716c" } },
      yAxis: [
        { type: "value", name: "Impressions", axisLabel: { color: "#78716c" }, splitLine: { lineStyle: { color: "#e7e5e4" } } },
        { type: "value", name: "Clicks", axisLabel: { color: "#78716c" }, splitLine: { show: false } },
      ],
      dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
      series: [
        {
          name: "Impressions", type: "line", data: p.impressions, showSymbol: false, lineStyle: { width: 2, color: "#0f766e" }, itemStyle: { color: "#0f766e" },
          markLine: { symbol: "none", data: p.markers.map((m) => ({ xAxis: m.date, label: { formatter: m.label, color: m.kind === "drop" ? "#b91c1c" : "#b45309" }, lineStyle: { color: m.kind === "drop" ? "#b91c1c" : "#b45309", type: "dashed" } })) },
          markArea: { data: prov },
        },
        { name: "Outbound clicks", type: "line", yAxisIndex: 1, data: p.clicks, showSymbol: false, lineStyle: { width: 1.5, color: "#a8a29e" }, itemStyle: { color: "#a8a29e" } },
      ],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [p]);
  return (
    <div>
      <div ref={ref} style={{ height: 320 }} role="img" aria-label="Daily impressions and outbound clicks with detected changes" />
      <details className="mt-2 text-xs">
        <summary className="muted cursor-pointer">Chart data as a table</summary>
        <table className="data mt-2"><thead><tr><th>Date</th><th>Impressions</th><th>Outbound clicks</th></tr></thead>
          <tbody>{p.dates.map((d, i) => <tr key={d}><td>{d}</td><td>{p.impressions[i] ?? "–"}</td><td>{p.clicks[i] ?? "–"}</td></tr>)}</tbody></table>
      </details>
    </div>
  );
}
