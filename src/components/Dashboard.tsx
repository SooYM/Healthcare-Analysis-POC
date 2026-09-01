/**
 * @file Dashboard.tsx
 * @module components/Dashboard
 * @description Main interactive healthcare analytics dashboard component.
 *
 * Provides:
 * - Patient search & auto-complete filtering across 1,154 patients.
 * - Date range controls and multi-panel biomarker selection.
 * - Longitudinal trend charts with multi-level drill-down (Year -> Month -> Day).
 * - Interactive scatter plots for same-visit biomarker correlations.
 * - Dynamic Pearson correlation heatmaps with summary statistics cards.
 * - 3D Multidimensional OLAP Cube integration (`OlapCube.tsx`).
 * - AI Clinical Assistant panel with Markdown rendering and reference range context.
 */

"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BiomarkerRow, DataResponse } from "@/types";
import { OlapCube } from "@/components/OlapCube";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

const DEFAULT_FROM = "2018-08-24";
const DEFAULT_TO = "2019-07-24";
const DEBOUNCE_MS = 350;

/** Shared chart theme — hoisted to avoid re-creating identical objects in every useMemo */
const CHART_THEME = {
  text: "rgba(236, 238, 242, 0.92)",
  muted: "rgba(179, 189, 204, 0.85)",
  grid: "rgba(255, 255, 255, 0.10)",
  axis: "rgba(255, 255, 255, 0.18)",
  tooltipBg: "rgba(10, 12, 16, 0.88)",
  tooltipBorder: "rgba(255, 255, 255, 0.14)",
} as const;
const CHART_COLORS = ["#2dd4bf", "#fb7185", "#a78bfa", "#60a5fa", "#fbbf24", "#22d3ee"];
const CHART_STYLE_FULL = { height: "100%" as const, width: "100%" as const };

/** Lightweight markdown → HTML for AI responses (no external deps) */
function formatMarkdown(md: string): string {
  let html = md;

  // Fenced code blocks: ```lang\n...\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;').trimEnd();
    return `<pre style="background:#1e293b;border-radius:8px;padding:12px 16px;overflow-x:auto;margin:10px 0;font-size:0.82em;line-height:1.6;"><code${lang ? ` class="language-${lang}"` : ''}>${escaped}</code></pre>`;
  });

  // Tables: | h1 | h2 |\n|---|---|\n| c1 | c2 |
  html = html.replace(
    /(^\|.+\|\n)(^\|[\s:|-]+\|\n)((?:^\|.+\|\n?)+)/gm,
    (_m, hdr, _sep, body) => {
      const ths = (hdr as string).split('|').filter(Boolean).map((c: string) => `<th style="padding:6px 10px;border-bottom:2px solid rgba(255,255,255,0.15);text-align:left;font-weight:600;">${c.trim()}</th>`).join('');
      const rows = (body as string).trim().split('\n').map((row: string) => {
        const tds = row.split('|').filter(Boolean).map((c: string) => `<td style="padding:5px 10px;border-bottom:1px solid rgba(255,255,255,0.07);">${c.trim()}</td>`).join('');
        return `<tr>${tds}</tr>`;
      }).join('');
      return `<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:0.88em;"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
    }
  );

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.12);margin:14px 0;"/>');

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h5 style="font-weight:600;margin:10px 0 4px;font-size:0.9em;">$1</h5>');
  html = html.replace(/^### (.+)$/gm, '<h4 style="font-weight:600;margin:12px 0 4px;font-size:1em;">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 style="font-weight:600;margin:14px 0 4px;font-size:1.1em;">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 style="font-weight:700;margin:16px 0 4px;font-size:1.2em;">$1</h2>');

  // Bold & italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;font-size:0.85em;">$1</code>');

  // Unordered list items
  html = html.replace(/^[-*] (.+)$/gm, '<li style="margin-left:18px;list-style:disc;margin-bottom:2px;">$1</li>');
  // Ordered list items
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li style="margin-left:18px;list-style:decimal;margin-bottom:2px;">$1</li>');

  // Line breaks (but not inside <pre> tags)
  html = html.replace(/\n/g, '<br/>');
  // Clean up extra <br/> inside <pre>
  html = html.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/g, (m) => m.replace(/<br\/>/g, '\n'));

  return html;
}

type DrillLevel = "year" | "month" | "day";

function timeTrend(
  rows: BiomarkerRow[],
  biomarkers: string[],
  level: DrillLevel,
  drillYear?: string | null,
  drillMonth?: string | null,
) {
  const keys = new Set(biomarkers);

  // Filter rows to the drill scope
  let filtered = rows;
  if (drillYear) {
    filtered = filtered.filter((r) => r.visit_date.slice(0, 4) === drillYear);
    if (drillMonth) {
      filtered = filtered.filter((r) => r.visit_date.slice(0, 7) === drillMonth);
    }
  }

  // Choose the time key based on level
  const timeKey = (r: BiomarkerRow): string => {
    if (level === "year") return r.visit_date.slice(0, 4);
    if (level === "month") return r.visit_date.slice(0, 7);
    return r.visit_date;
  };

  const byTime = new Map<string, Map<string, { sum: number; n: number }>>();
  for (const r of filtered) {
    if (!keys.has(r.biomarker)) continue;
    const t = timeKey(r);
    let inner = byTime.get(t);
    if (!inner) {
      inner = new Map();
      byTime.set(t, inner);
    }
    const cur = inner.get(r.biomarker) ?? { sum: 0, n: 0 };
    cur.sum += r.value;
    cur.n += 1;
    inner.set(r.biomarker, cur);
  }

  const labels = Array.from(byTime.keys()).sort();
  const series = biomarkers.map((name) => ({
    name,
    type: "line" as const,
    smooth: level !== "day",
    showSymbol: labels.length < 60,
    data: labels.map((t) => {
      const cell = byTime.get(t)?.get(name);
      if (!cell || cell.n === 0) return null;
      return Math.round((cell.sum / cell.n) * 1000) / 1000;
    }),
  }));
  return { labels, series };
}

function scatterPairs(
  rows: BiomarkerRow[],
  xKey: string,
  yKey: string,
): [number, number][] {
  const map = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = `${r.patient_id}|${r.visit_date}`;
    let o = map.get(k);
    if (!o) {
      o = {};
      map.set(k, o);
    }
    o[r.biomarker] = r.value;
  }
  const pts: [number, number][] = [];
  for (const o of map.values()) {
    const x = o[xKey];
    const y = o[yKey];
    if (x !== undefined && y !== undefined) pts.push([x, y]);
  }
  return pts;
}

/** Client-side Pearson correlation from rows — used so heatmap responds to drill scope */
function computeCorrelation(rows: BiomarkerRow[], biomarkers: string[]) {
  // Build per-visit vectors
  const visits = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = `${r.patient_id}|${r.visit_date}`;
    let o = visits.get(k);
    if (!o) { o = {}; visits.set(k, o); }
    o[r.biomarker] = r.value;
  }
  const pearson = (a: string, b: string): number => {
    const pairs: [number, number][] = [];
    for (const o of visits.values()) {
      if (o[a] !== undefined && o[b] !== undefined) pairs.push([o[a], o[b]]);
    }
    if (pairs.length < 3) return 0;
    const n = pairs.length;
    const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
    const my = pairs.reduce((s, p) => s + p[1], 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (const [x, y] of pairs) {
      num += (x - mx) * (y - my);
      dx += (x - mx) ** 2;
      dy += (y - my) ** 2;
    }
    const denom = Math.sqrt(dx * dy);
    return denom === 0 ? 0 : num / denom;
  };
  const result: Record<string, Record<string, number>> = {};
  for (const a of biomarkers) {
    result[a] = {};
    for (const b of biomarkers) {
      result[a][b] = a === b ? 1 : pearson(a, b);
    }
  }
  return result;
}

export function Dashboard() {
  const [dateFrom, setDateFrom] = useState(DEFAULT_FROM);
  const [dateTo, setDateTo] = useState(DEFAULT_TO);
  const [patientId, setPatientId] = useState("");
  const [patientSearch, setPatientSearch] = useState("");
  const [patientDropdownOpen, setPatientDropdownOpen] = useState(false);
  const patientComboRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<DataResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedBiomarkers, setSelectedBiomarkers] = useState<string[]>([]);
  const [scatterX, setScatterX] = useState<string>("");
  const [scatterY, setScatterY] = useState<string>("");

  // Drill state — shared across all charts
  const [drillLevel, setDrillLevel] = useState<DrillLevel>("year");
  const [drillYear, setDrillYear] = useState<string | null>(null);
  const [drillMonth, setDrillMonth] = useState<string | null>(null);

  const drillDown = useCallback((label: string) => {
    if (drillLevel === "year") {
      setDrillYear(label);
      setDrillLevel("month");
    } else if (drillLevel === "month") {
      setDrillMonth(label);
      setDrillLevel("day");
    }
  }, [drillLevel]);

  const drillUp = useCallback(() => {
    if (drillLevel === "day") {
      setDrillMonth(null);
      setDrillLevel("month");
    } else if (drillLevel === "month") {
      setDrillYear(null);
      setDrillLevel("year");
    }
  }, [drillLevel]);

  const drillReset = useCallback(() => {
    setDrillLevel("year");
    setDrillYear(null);
    setDrillMonth(null);
  }, []);

  const drillBreadcrumb = useMemo(() => {
    const parts: string[] = ["All Years"];
    if (drillYear) parts.push(drillYear);
    if (drillMonth) parts.push(drillMonth);
    return parts;
  }, [drillYear, drillMonth]);

  // Rows filtered to the current drill scope (for scatter + heatmap)
  const drillFilteredRows = useMemo(() => {
    if (!data) return [];
    let rows = data.rows;
    if (drillYear) {
      rows = rows.filter((r) => r.visit_date.slice(0, 4) === drillYear);
      if (drillMonth) {
        rows = rows.filter((r) => r.visit_date.slice(0, 7) === drillMonth);
      }
    }
    return rows;
  }, [data, drillYear, drillMonth]);

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainMode, setExplainMode] = useState<string | null>(null);
  
  const [allPatients, setAllPatients] = useState<string[]>([]);
  const [totalReports, setTotalReports] = useState<number | null>(null);

  useEffect(() => {
    async function fetchPatients() {
      try {
        const res = await fetch("/api/patients");
        if (res.ok) {
          const json = await res.json();
          setAllPatients(json.patientIds || []);
          setTotalReports(json.totalReports ?? null);
        }
      } catch (e) {
        console.error("Failed to fetch patients:", e);
      }
    }
    void fetchPatients();
  }, []);

  // Close patient dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (patientComboRef.current && !patientComboRef.current.contains(e.target as Node)) {
        setPatientDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredPatients = useMemo(() => {
    if (!patientSearch.trim()) return allPatients;
    const q = patientSearch.trim().toLowerCase();
    return allPatients.filter(pid => pid.toLowerCase().includes(q));
  }, [allPatients, patientSearch]);

  const prevPatientRef = useRef(patientId);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const patientChanged = prevPatientRef.current !== patientId;
    prevPatientRef.current = patientId;
    try {
      const res = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dateFrom,
          dateTo,
          patientId: patientId.trim() || undefined,
          // Don't filter by biomarker on the server — fetch all, filter on client
          rowLimit: 80000,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? res.statusText);
      }
      const json = (await res.json()) as DataResponse;
      setData(json);
      // If this is the first load, or the patient changed, auto-select only the first view table
      if (json.biomarkers.length) {
        setSelectedBiomarkers((prev) => {
          if (prev.length === 0 || patientChanged) {
            const groups = json.biomarkerGroups;
            if (groups && Object.keys(groups).length > 0) {
              const firstGroupKey = Object.keys(groups)[0];
              return groups[firstGroupKey];
            } else {
              return json.biomarkers.slice(0, 4);
            }
          }
          return prev;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, patientId]);

  // Debounced auto-load: waits for user to stop changing filters
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void load(); }, DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [load]);

  // Chart 1: Longitudinal trend (uses drill level directly)
  const trendData = useMemo(() => {
    if (!data || selectedBiomarkers.length === 0) return null;
    return timeTrend(data.rows, selectedBiomarkers, drillLevel, drillYear, drillMonth);
  }, [data, selectedBiomarkers, drillLevel, drillYear, drillMonth]);

  // Chart 2: Monthly mean — always shows general overview (no drill)
  const trendMonthly = useMemo(() => {
    if (!data || selectedBiomarkers.length === 0) return null;
    return timeTrend(data.rows, selectedBiomarkers, "month");
  }, [data, selectedBiomarkers]);

  const scatterPts = useMemo(() => {
    if (!data || !scatterX || !scatterY) return [];
    return scatterPairs(drillFilteredRows, scatterX, scatterY);
  }, [data, drillFilteredRows, scatterX, scatterY]);

  useEffect(() => {
    if (!data?.biomarkers.length) return;
    if (!scatterX) setScatterX(data.biomarkers[0] ?? "");
    if (!scatterY)
      setScatterY(data.biomarkers[Math.min(1, data.biomarkers.length - 1)] ?? "");
  }, [data, scatterX, scatterY]);

  const chart1Option = useMemo(() => {
    if (!trendData) return {};
    const theme = CHART_THEME;
    const xName = drillLevel === "year" ? "Year" : drillLevel === "month" ? "Month" : "Date";
    return {
      backgroundColor: "transparent",
      color: CHART_COLORS,
      textStyle: { color: theme.text, fontFamily: "var(--font-sans)" },
      tooltip: {
        trigger: "axis",
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: theme.text },
        extraCssText: "backdrop-filter: blur(10px); border-radius: 12px;",
      },
      legend: {
        bottom: 0,
        type: "scroll",
        textStyle: { color: theme.muted },
        pageTextStyle: { color: theme.muted },
      },
      grid: { left: 56, right: 24, top: 36, bottom: 98, containLabel: false },
      xAxis: {
        name: xName,
        nameLocation: "middle",
        nameGap: 35,
        type: "category",
        data: trendData.labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: theme.axis } },
        axisTick: { lineStyle: { color: theme.axis } },
        splitLine: { show: true, lineStyle: { color: theme.grid } },
        nameTextStyle: { color: theme.muted },
        axisLabel: {
          interval: 0,
          rotate: trendData.labels.length > 12 ? 45 : 0,
          fontSize: 10,
          color: theme.muted,
        },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: theme.muted },
        splitLine: { show: true, lineStyle: { color: theme.grid } },
      },
      series: trendData.series,
    };
  }, [trendData, drillLevel]);

  const chart2Option = useMemo(() => {
    if (!trendMonthly) return {};
    const theme = CHART_THEME;
    return {
      backgroundColor: "transparent",
      color: CHART_COLORS,
      textStyle: { color: theme.text, fontFamily: "var(--font-sans)" },
      tooltip: {
        trigger: "axis",
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: theme.text },
        extraCssText: "backdrop-filter: blur(10px); border-radius: 12px;",
      },
      legend: {
        bottom: 0,
        type: "scroll",
        textStyle: { color: theme.muted },
        pageTextStyle: { color: theme.muted },
      },
      grid: { left: 56, right: 24, top: 36, bottom: 84 },
      xAxis: {
        type: "category",
        data: trendMonthly.labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: theme.axis } },
        axisTick: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.muted, rotate: trendMonthly.labels.length > 12 ? 35 : 0 },
        splitLine: { show: true, lineStyle: { color: theme.grid } },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: theme.muted },
        splitLine: { show: true, lineStyle: { color: theme.grid } },
      },
      series: trendMonthly.series,
    };
  }, [trendMonthly]);

  const scatterOption = useMemo(() => {
    const theme = CHART_THEME;
    return {
      backgroundColor: "transparent",
      color: ["#2dd4bf"],
      textStyle: { color: theme.text, fontFamily: "var(--font-sans)" },
      tooltip: {
        trigger: "item",
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: theme.text },
        extraCssText: "backdrop-filter: blur(10px); border-radius: 12px;",
        formatter: (p: { value: [number, number] }) =>
          `${scatterX}: ${p.value[0]}<br/>${scatterY}: ${p.value[1]}`,
      },
      grid: { left: 56, right: 24, top: 36, bottom: 56 },
      xAxis: {
        type: "value",
        name: scatterX,
        scale: true,
        nameGap: 28,
        nameTextStyle: { color: theme.muted },
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.muted },
        splitLine: { show: true, lineStyle: { color: theme.grid } },
      },
      yAxis: {
        type: "value",
        name: scatterY,
        scale: true,
        nameGap: 28,
        nameTextStyle: { color: theme.muted },
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.muted },
        splitLine: { show: true, lineStyle: { color: theme.grid } },
      },
      series: [
        {
          type: "scatter",
          symbolSize: 7,
          itemStyle: { opacity: 0.88 },
          data: scatterPts,
        },
      ],
    };
  }, [scatterPts, scatterX, scatterY]);

  const heatmapOption = useMemo(() => {
    if (!data?.biomarkers.length || drillFilteredRows.length === 0) return null;
    const theme = CHART_THEME;
    const names = data.biomarkers;
    // Use client-side correlation from drill-filtered rows
    const corr = (drillYear || drillMonth)
      ? computeCorrelation(drillFilteredRows, names)
      : data.correlation;
    if (!corr) return null;
    const cells: [number, number, number][] = [];
    names.forEach((a, i) => {
      names.forEach((b, j) => {
        const v = corr[a]?.[b];
        const z = typeof v === "number" ? v : NaN;
        cells.push([i, j, Number.isFinite(z) ? z : 0]);
      });
    });
    return {
      tooltip: {
        position: "top",
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: theme.text },
        extraCssText: "backdrop-filter: blur(10px); border-radius: 12px;",
        formatter: (p: { data: [number, number, number] }) => {
          const [i, j, val] = p.data;
          return `${names[i]} vs ${names[j]}: ${typeof val === "number" ? val.toFixed(3) : val}`;
        },
      },
      backgroundColor: "transparent",
      textStyle: { color: theme.text, fontFamily: "var(--font-sans)" },
      grid: { left: 140, top: 56, bottom: 64, right: 56 },
      xAxis: {
        type: "category",
        data: names,
        splitArea: { show: true },
        axisLine: { lineStyle: { color: theme.axis } },
        axisTick: { lineStyle: { color: theme.axis } },
        axisLabel: { rotate: 35, color: theme.muted },
      },
      yAxis: {
        type: "category",
        data: names,
        splitArea: { show: true },
        axisLine: { lineStyle: { color: theme.axis } },
        axisTick: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.muted },
      },
      visualMap: {
        min: -1,
        max: 1,
        calculable: true,
        orient: "horizontal",
        left: "center",
        bottom: 8,
        textStyle: { color: theme.muted },
        inRange: { color: ["#2563eb", "#e5e7eb", "#fb7185"] },
      },
      series: [
        {
          type: "heatmap",
          data: cells,
          label: {
            show: names.length <= 10,
            formatter: (x: unknown) => {
              const d = x as { data?: [number, number, number] };
              const v = d.data?.[2];
              return typeof v === "number" && Number.isFinite(v)
                ? v.toFixed(2)
                : "";
            },
            color: "rgba(255,255,255,0.80)",
          },
          emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,0.35)" } },
        },
      ],
    };
  }, [data, drillFilteredRows, drillYear, drillMonth]);

  async function askLlm() {
    if (!data) return;
    setExplainLoading(true);
    setAnswer(null);
    setExplainMode(null);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          context: {
            filters: { dateFrom, dateTo, patientId: patientId.trim() || undefined, biomarkers: selectedBiomarkers },
            dataSource: data.source,
            rows: data.rows,
            correlation: data.correlation ?? {},
            rowCount: data.rowCount,
            chartHint:
              `Trend chart: monthly means for ${selectedBiomarkers.join(", ")}; scatter: ${scatterX} vs ${scatterY}`,
          },
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setAnswer(j.answer as string);
      setExplainMode(
        [j.mode, j.warning].filter(Boolean).join(" · ") || null,
      );
    } catch (e) {
      setAnswer(e instanceof Error ? e.message : "Explain failed");
    } finally {
      setExplainLoading(false);
    }
  }

  const toggleBiomarker = useCallback((id: string) => {
    setSelectedBiomarkers((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const toggleGroup = useCallback((marks: string[]) => {
    setSelectedBiomarkers(prev => {
      const allSelected = marks.every(m => prev.includes(m));
      if (allSelected) return prev.filter(m => !marks.includes(m));
      const next = new Set(prev);
      marks.forEach(m => next.add(m));
      return Array.from(next);
    });
  }, []);

  // Memoized drill click handler for charts — stable reference prevents chart re-renders
  const drillClickHandler = useCallback(
    (p: { name?: string }) => { if (p.name && drillLevel !== "day") drillDown(p.name); },
    [drillLevel, drillDown],
  );
  const drillEvents = useMemo(() => ({ click: drillClickHandler }), [drillClickHandler]);

  return (
    <div className="space-y-6">
      <header className="relative overflow-hidden rounded-3xl border border-glass-100 bg-glass-50 p-6 shadow-[0_18px_60px_-40px_rgba(0,0,0,0.9)] backdrop-blur md:p-8">
        <div className="pointer-events-none absolute inset-0 opacity-80">
          <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(circle_at_center,rgba(45,212,191,0.32),transparent_62%)] blur-2xl" />
          <div className="absolute -right-28 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(circle_at_center,rgba(251,113,133,0.22),transparent_62%)] blur-2xl" />
        </div>
        <div className="relative flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-300/90">
              BigQuery-backed prototype · LLM-assisted interpretation
            </p>
            <h1 className="mt-2 font-display text-3xl leading-[1.05] tracking-tight text-white md:text-4xl">
              Biomarker Observatory
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-200/90">
              Explore longitudinal trends, same-visit relationships, and correlation structure across your cohort. Use filters to narrow the slice, then ask targeted questions with context.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full border border-glass-200 bg-glass-50 px-3 py-1.5 text-ink-200">
              Source: <span className="font-medium text-clinic-teal">{data?.source === "local_csv" ? "Local CSV" : (data?.source ?? "—")}</span>
            </span>
            <span className="rounded-full border border-glass-200 bg-glass-50 px-3 py-1.5 text-ink-200">
              Rows: <span className="font-medium text-white">{data ? data.rowCount.toLocaleString() : "—"}</span>
            </span>
            <span className="rounded-full border border-glass-200 bg-glass-50 px-3 py-1.5 text-ink-200">
              Reports: <span className="font-medium text-white">{totalReports !== null ? totalReports.toLocaleString() : "—"}</span>
            </span>
          </div>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[320px_1fr]">
      <aside className="space-y-6 rounded-3xl border border-glass-100 bg-glass-50 p-6 shadow-[0_18px_60px_-40px_rgba(0,0,0,0.9)] backdrop-blur lg:sticky lg:top-6 lg:self-start">
        <div>
          <h2 className="text-sm font-semibold text-white">Filters</h2>
          <p className="mt-1 text-xs text-ink-200/90">
            Narrow the cohort; empty biomarker selection loads all markers in
            range.
          </p>
        </div>
        <div className="block text-xs font-medium text-ink-600">
          Patient ID (Optional)
          {totalReports !== null && (
            <span className="ml-1 font-normal text-ink-300/80">
              — {totalReports.toLocaleString()} total reports
            </span>
          )}
          <div ref={patientComboRef} className="relative mt-1">
            <div className="flex items-center rounded-xl border border-glass-200 bg-black/20 shadow-inner ring-1 ring-transparent transition focus-within:border-clinic-teal/60 focus-within:ring-clinic-teal/30">
              <input
                type="text"
                value={patientSearch}
                onChange={(e) => {
                  setPatientSearch(e.target.value);
                  setPatientDropdownOpen(true);
                }}
                onFocus={() => setPatientDropdownOpen(true)}
                placeholder={patientId || "Search or select patient…"}
                className="w-full rounded-xl bg-transparent px-3 py-2.5 text-sm text-ink-100 outline-none placeholder:text-ink-300/60"
              />
              {patientId && (
                <button
                  type="button"
                  onClick={() => {
                    setPatientId("");
                    setPatientSearch("");
                    setPatientDropdownOpen(false);
                  }}
                  className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-300/70 transition hover:bg-white/10 hover:text-white"
                  title="Clear selection"
                >
                  ×
                </button>
              )}
              <button
                type="button"
                onClick={() => setPatientDropdownOpen(prev => !prev)}
                className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-300/70 transition hover:bg-white/10 hover:text-white"
                title="Toggle dropdown"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`transition-transform ${patientDropdownOpen ? 'rotate-180' : ''}`}>
                  <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            {patientDropdownOpen && (
              <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-xl border border-glass-200 bg-[#0d1117]/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.9)] backdrop-blur-xl">
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setPatientId("");
                      setPatientSearch("");
                      setPatientDropdownOpen(false);
                    }}
                    className={`w-full px-3 py-2 text-left text-sm transition hover:bg-clinic-teal/15 ${
                      patientId === "" ? "text-clinic-teal font-medium" : "text-ink-200/90"
                    }`}
                  >
                    All Patients
                  </button>
                </li>
                {filteredPatients.map(pid => (
                  <li key={pid}>
                    <button
                      type="button"
                      onClick={() => {
                        setPatientId(pid);
                        setPatientSearch("");
                        setPatientDropdownOpen(false);
                      }}
                      className={`w-full px-3 py-2 text-left font-mono text-xs transition hover:bg-clinic-teal/15 ${
                        patientId === pid ? "text-clinic-teal font-medium" : "text-ink-100/90"
                      }`}
                    >
                      {pid}
                    </button>
                  </li>
                ))}
                {filteredPatients.length === 0 && (
                  <li className="px-3 py-2 text-xs text-ink-300/60">No matching patients</li>
                )}
              </ul>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-ink-200/90">
            From
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="mt-1 w-full rounded-xl border border-glass-200 bg-black/20 px-3 py-2.5 text-sm text-ink-100 shadow-inner outline-none ring-1 ring-transparent transition focus:border-clinic-teal/60 focus:ring-clinic-teal/30"
            />
          </label>
          <label className="block text-xs font-medium text-ink-200/90">
            To
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="mt-1 w-full rounded-xl border border-glass-200 bg-black/20 px-3 py-2.5 text-sm text-ink-100 shadow-inner outline-none ring-1 ring-transparent transition focus:border-clinic-teal/60 focus:ring-clinic-teal/30"
            />
          </label>
        </div>
        <div>
          <p className="text-xs font-medium text-ink-200/90">Biomarkers</p>
          <div className="mt-2 max-h-96 space-y-3 overflow-y-auto rounded-2xl border border-glass-100 bg-black/20 p-3 shadow-inner">
            {data?.biomarkerGroups && Object.keys(data.biomarkerGroups).length > 0 ? (
              Object.entries(data.biomarkerGroups).map(([group, marks]) => {
                const isAllSelected = marks.every(m => selectedBiomarkers.includes(m));
                return (
                  <div key={group} className="space-y-1.5">
                    <div className="mb-1 flex items-center justify-between border-b border-glass-100 pb-1">
                      <p className="text-xs font-semibold text-white/90">
                        {group.replace('View_Fact_', '')}
                      </p>
                      <button
                        type="button"
                        onClick={() => toggleGroup(marks)}
                        className="text-[10px] font-medium text-clinic-teal/90 hover:text-clinic-teal hover:underline"
                      >
                        {isAllSelected ? "Deselect All" : "Select All"}
                      </button>
                    </div>
                    {marks.sort().map((b) => (
                      <label
                        key={b}
                        className="ml-1 flex cursor-pointer items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={selectedBiomarkers.includes(b)}
                          onChange={() => toggleBiomarker(b)}
                          className="h-4 w-4 rounded border-glass-200 bg-black/30 text-clinic-teal focus:ring-clinic-teal/40"
                        />
                        <span className="font-mono text-xs text-ink-100/90">{b}</span>
                      </label>
                    ))}
                  </div>
                );
              })
            ) : (
              (data?.biomarkers ?? []).map((b) => (
                <label
                  key={b}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedBiomarkers.includes(b)}
                    onChange={() => toggleBiomarker(b)}
                    className="h-4 w-4 rounded border-glass-200 bg-black/30 text-clinic-teal focus:ring-clinic-teal/40"
                  />
                  <span className="font-mono text-xs text-ink-100/90">{b}</span>
                </label>
              ))
            )}
            {!data?.biomarkers.length && (
              <p className="text-xs text-ink-300/70">Load data to list markers.</p>
            )}
          </div>
        </div>
        {loading && (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-clinic-teal/20 bg-clinic-teal/5 px-4 py-3 text-sm text-clinic-teal">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round"/></svg>
            Loading…
          </div>
        )}
        {data?.source === "demo" && data.demoReason && (
          <p className="rounded-2xl border border-amber-200/30 bg-amber-400/10 px-3 py-3 text-xs leading-snug text-amber-100">
            {data.demoReason}
          </p>
        )}
        {error && (
          <p className="rounded-2xl border border-red-300/20 bg-red-500/10 px-3 py-3 text-xs text-red-100">
            {error}
          </p>
        )}
      </aside>

      <div className="space-y-8">
        {/* Drill breadcrumb bar */}
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-glass-100 bg-glass-50 px-5 py-3 shadow-inner backdrop-blur">
          <span className="text-[11px] font-medium text-ink-300/80">Drill level:</span>
          {drillBreadcrumb.map((part, i) => (
            <span key={part} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-ink-300/40">›</span>}
              <button
                type="button"
                onClick={() => {
                  if (i === 0) drillReset();
                  else if (i === 1) { setDrillMonth(null); setDrillLevel("month"); }
                }}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                  i === drillBreadcrumb.length - 1
                    ? "bg-clinic-teal/15 text-clinic-teal ring-1 ring-clinic-teal/25"
                    : "text-ink-200/80 hover:bg-white/10 hover:text-white"
                }`}
              >
                {part}
              </button>
            </span>
          ))}
          {drillLevel !== "year" && (
            <button
              type="button"
              onClick={drillUp}
              className="ml-auto flex items-center gap-1 rounded-lg bg-white/5 px-3 py-1.5 text-[11px] font-medium text-ink-200/80 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9.5 7.5L6 4L2.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Drill up
            </button>
          )}
          <span className="ml-2 text-[11px] text-ink-300/60">
            {drillLevel === "year" ? "Click a data point to drill into that year" : drillLevel === "month" ? "Click to drill into a month" : "Day-level (most granular)"}
          </span>
        </div>

        <section className="rounded-3xl border border-glass-100 bg-glass-50 p-6 shadow-[0_18px_60px_-40px_rgba(0,0,0,0.9)] backdrop-blur">
          <h2 className="text-lg font-semibold text-white">
            Longitudinal trend
            <span className="ml-2 text-sm font-normal text-ink-300/70">
              ({drillLevel === "year" ? "by year" : drillLevel === "month" ? `${drillYear} by month` : `${drillMonth} by day`})
            </span>
          </h2>
          <p className="mt-1 text-sm text-ink-200/90">
            Mean biomarker level aggregated by {drillLevel}. Click a data point to drill down.
          </p>
          <div className="mt-4 h-[380px] w-full">
            {trendData && trendData.labels.length > 0 ? (
              <ReactECharts
                option={chart1Option}
                style={CHART_STYLE_FULL}
                notMerge
                onEvents={drillEvents}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-glass-200 text-sm text-ink-300/80">
                Select biomarkers and apply filters to plot trends.
              </div>
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-glass-100 bg-glass-50 p-6 shadow-[0_18px_60px_-40px_rgba(0,0,0,0.9)] backdrop-blur">
          <h2 className="text-lg font-semibold text-white">
            Longitudinal trend (monthly mean)
          </h2>
          <p className="mt-1 text-sm text-ink-200/90">
            Mean biomarker level by calendar month across all patients in the current filters.
          </p>
          <div className="mt-4 h-[380px] w-full">
            {trendMonthly && trendMonthly.labels.length > 0 ? (
              <ReactECharts
                option={chart2Option}
                style={CHART_STYLE_FULL}
                notMerge
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-glass-200 text-sm text-ink-300/80">
                Select biomarkers and apply filters to plot trends.
              </div>
            )}
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-3xl border border-glass-100 bg-glass-50 p-6 shadow-[0_18px_60px_-40px_rgba(0,0,0,0.9)] backdrop-blur">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Same-visit scatter
                  {drillLevel !== "year" && (
                    <span className="ml-2 text-sm font-normal text-ink-300/70">
                      ({drillMonth ?? drillYear})
                    </span>
                  )}
                </h2>
                <p className="mt-1 text-sm text-ink-200/90">
                  Each point is one patient visit with both biomarkers present.
                  {drillLevel !== "year" && <span className="text-ink-300/60"> Filtered to {drillMonth ?? drillYear}.</span>}
                </p>
              </div>
              {drillLevel !== "year" && (
                <button type="button" onClick={drillUp} className="mt-1 flex shrink-0 items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-ink-200/80 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9.5 7.5L6 4L2.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Drill up
                </button>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <label className="text-xs font-medium text-ink-200/90">
                X axis
                <select
                  value={scatterX}
                  onChange={(e) => setScatterX(e.target.value)}
                  className="mt-1 block w-full min-w-[140px] rounded-xl border border-glass-200 bg-black/20 px-2 py-2 font-mono text-xs text-ink-100 shadow-inner outline-none focus:border-clinic-teal/60"
                >
                  {(data?.biomarkers ?? []).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-ink-200/90">
                Y axis
                <select
                  value={scatterY}
                  onChange={(e) => setScatterY(e.target.value)}
                  className="mt-1 block w-full min-w-[140px] rounded-xl border border-glass-200 bg-black/20 px-2 py-2 font-mono text-xs text-ink-100 shadow-inner outline-none focus:border-clinic-teal/60"
                >
                  {(data?.biomarkers ?? []).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-4 h-[320px]">
              {scatterPts.length ? (
                <ReactECharts
                  option={scatterOption}
                  style={CHART_STYLE_FULL}
                  notMerge
                />
              ) : (
                <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-glass-200 text-sm text-ink-300/80">
                  Need overlapping visits for both axes.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-glass-100 bg-glass-50 p-6 shadow-[0_18px_60px_-40px_rgba(0,0,0,0.9)] backdrop-blur">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Correlation heatmap
                  {drillLevel !== "year" && (
                    <span className="ml-2 text-sm font-normal text-ink-300/70">
                      ({drillMonth ?? drillYear})
                    </span>
                  )}
                </h2>
                <p className="mt-1 text-sm text-ink-200/90">
                  Pearson correlation on paired values at the same patient + visit.
                  {drillLevel !== "year" && <span className="text-ink-300/60"> Computed from {drillMonth ?? drillYear} data.</span>}
                </p>
              </div>
              {drillLevel !== "year" && (
                <button type="button" onClick={drillUp} className="mt-1 flex shrink-0 items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-ink-200/80 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9.5 7.5L6 4L2.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Drill up
                </button>
              )}
            </div>
            <div className="mt-4 h-[380px]">
              {heatmapOption && data && data.biomarkers.length ? (
                <ReactECharts
                  option={heatmapOption}
                  style={CHART_STYLE_FULL}
                  notMerge
                />
              ) : (
                <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-glass-200 text-sm text-ink-300/80">
                  Waiting for biomarker list…
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-glass-100 bg-glass-50 p-6 shadow-[0_18px_60px_-40px_rgba(0,0,0,0.9)] backdrop-blur">
          <h2 className="text-lg font-semibold text-white">
            Ask about relationships (LLM)
          </h2>
          <p className="mt-1 text-sm text-ink-200/90">
            Ask any question about the biomarkers, trends, or indicators shown on this dashboard.
            Only health-dashboard-related questions are accepted.
          </p>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={4}
            placeholder="e.g. What do these biomarker trends indicate? Explain the correlation between Hemoglobin and RBC."
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!explainLoading && data && question.trim()) void askLlm();
              }
            }}
            className="mt-4 w-full rounded-2xl border border-glass-200 bg-black/20 px-4 py-3 text-sm leading-relaxed text-ink-100 shadow-inner outline-none placeholder:text-ink-300/50 focus:border-clinic-teal/60"
          />
          <button
            type="button"
            onClick={() => void askLlm()}
            disabled={explainLoading || !data || !question.trim()}
            className="mt-3 rounded-2xl bg-white/10 px-5 py-3 text-sm font-medium text-white shadow-[0_18px_40px_-28px_rgba(0,0,0,0.9)] ring-1 ring-white/15 transition hover:bg-white/14 hover:ring-white/20 disabled:opacity-50"
          >
            {explainLoading ? "Thinking…" : "Explain with context"}
          </button>
          {explainMode && (
            <p className="mt-2 text-xs text-amber-200/90">{explainMode}</p>
          )}
          {answer && (
            <div className="relative mt-4">
              <div
                className="max-h-[600px] overflow-y-auto rounded-2xl border border-glass-100 bg-black/20 p-5 text-sm leading-relaxed text-ink-100/90 scroll-smooth"
                style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}
                dangerouslySetInnerHTML={{ __html: formatMarkdown(answer) }}
              />
              <button
                type="button"
                onClick={() => { void navigator.clipboard.writeText(answer); }}
                className="absolute right-3 top-3 rounded-lg bg-white/5 p-1.5 text-ink-300/60 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
                title="Copy response"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              </button>
            </div>
          )}
        </section>

        <OlapCube
          data={data}
          loading={loading}
          selectedBiomarkers={selectedBiomarkers}
          onFilter={(filters) => {
            if (filters.patientId !== undefined && filters.patientId !== patientId) {
              setPatientId(filters.patientId);
              setPatientSearch("");
            }
            if (filters.biomarkers !== undefined) {
              setSelectedBiomarkers(filters.biomarkers);
            }
            if (filters.dateFrom !== undefined && filters.dateFrom !== dateFrom) {
              setDateFrom(filters.dateFrom);
            }
            if (filters.dateTo !== undefined && filters.dateTo !== dateTo) {
              setDateTo(filters.dateTo);
            }
          }}
        />
      </div>
      </div>
    </div>
  );
}
