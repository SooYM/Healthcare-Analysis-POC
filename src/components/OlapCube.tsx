/**
 * @file OlapCube.tsx
 * @module components/OlapCube
 * @description 3D Multidimensional On-Line Analytical Processing (OLAP) Cube visualizer.
 *
 * Implements:
 * - 4-dimensional hypercube mapping: Time (Grain: Day/Month), Biomarker, Patient, Group.
 * - OLAP Operations:
 *   - Slice: Pin one dimension to a single coordinate and project a 2D matrix.
 *   - Dice: Sub-select a sub-cube defined by multiple dimensional filters.
 *   - Roll-up / Drill-down: Granularity toggle across time hierarchy.
 * - Interactive 3D Bar Visualizations via ECharts GL and 2D Heatmap projections.
 */

"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { BiomarkerRow, DataResponse } from "@/types";

export type CubeFilterPayload = {
  patientId?: string;
  biomarkers?: string[];
  dateFrom?: string;
  dateTo?: string;
};

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

type TimeGrain = "day" | "month";
type Dim = "time" | "biomarker" | "patient" | "group";

function monthOf(isoDate: string) {
  return isoDate.slice(0, 7);
}

function clampList<T>(xs: T[], max: number) {
  return xs.length <= max ? xs : xs.slice(0, max);
}

function uniqSorted(xs: string[]) {
  return Array.from(new Set(xs)).sort();
}

function buildCube(rows: BiomarkerRow[], opts: { grain: TimeGrain; biomarkers: string[] }) {
  const timeKey = (r: BiomarkerRow) => (opts.grain === "month" ? monthOf(r.visit_date) : r.visit_date);
  const allow = new Set(opts.biomarkers);

  const times = uniqSorted(rows.map(timeKey));
  const patients = uniqSorted(rows.map((r) => r.patient_id));
  const biomarkers = uniqSorted(rows.map((r) => r.biomarker)).filter((b) => allow.has(b));
  const groups = uniqSorted(rows.map((r) => r.group ?? "ungrouped"));

  // Aggregate: avg(value) by (time, biomarker, patient, group)
  const agg = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (!allow.has(r.biomarker)) continue;
    const t = timeKey(r);
    const g = r.group ?? "ungrouped";
    const k = `${t}||${r.biomarker}||${r.patient_id}||${g}`;
    const cur = agg.get(k) ?? { sum: 0, n: 0 };
    cur.sum += r.value;
    cur.n += 1;
    agg.set(k, cur);
  }

  return { times, biomarkers, patients, groups, agg };
}

function keyOf(dim: Dim, t: string, b: string, p: string, g: string) {
  if (dim === "time") return t;
  if (dim === "biomarker") return b;
  if (dim === "group") return g;
  return p;
}

function defaultDims() {
  return { x: "time" as Dim, y: "biomarker" as Dim, slice: "patient" as Dim };
}

export const OlapCube = memo(function OlapCube({
  data,
  loading,
  selectedBiomarkers,
  onFilter,
}: {
  data: DataResponse | null;
  loading: boolean;
  selectedBiomarkers: string[];
  onFilter?: (filters: CubeFilterPayload) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [grain, setGrain] = useState<TimeGrain>("month");
  const [dims, setDims] = useState(defaultDims());
  const [op, setOp] = useState<"slice" | "dice">("slice");

  const [biomarkerMode, setBiomarkerMode] = useState<"dashboard" | "all">("dashboard");
  const [biomarkerCap, setBiomarkerCap] = useState<number>(14);

  const [sliceValue, setSliceValue] = useState<string>("");

  const [timeFrom, setTimeFrom] = useState<string>("");
  const [timeTo, setTimeTo] = useState<string>("");
  const [diceQuery, setDiceQuery] = useState<string>("");
  const [diceSelected, setDiceSelected] = useState<string[]>([]);
  const [diceCap, setDiceCap] = useState<number>(18);

  // Interactive filtering state — tracks active "clicked" filters
  const [activeFilters, setActiveFilters] = useState<Record<Dim, string | null>>({
    time: null,
    biomarker: null,
    patient: null,
    group: null,
  });

  useEffect(() => {
    void import("echarts-gl");
  }, []);

  const cube = useMemo(() => {
    if (!data) return null;
    const biomarkerUniverse =
      biomarkerMode === "dashboard" && selectedBiomarkers.length
        ? selectedBiomarkers
        : data.biomarkers;
    const used = clampList(biomarkerUniverse, Math.max(1, biomarkerCap));
    return buildCube(data.rows, { grain, biomarkers: used });
  }, [data, grain, selectedBiomarkers, biomarkerCap, biomarkerMode]);

  const dimOptions = useMemo(() => {
    if (!cube) return { time: [], biomarker: [], patient: [], group: [] };
    const time = cube.times;
    const biomarker = cube.biomarkers;
    const patient = cube.patients;
    const group = cube.groups;
    return { time, biomarker, patient, group };
  }, [cube]);

  // Keep sliceValue valid when dims/cube change.
  useEffect(() => {
    if (!cube) return;
    const vals = dimOptions[dims.slice];
    if (!vals.length) return;
    if (!sliceValue || !vals.includes(sliceValue)) {
      setSliceValue(vals[0] ?? "");
    }
  }, [cube, dimOptions, dims.slice, sliceValue]);

  // Initialize dice selection for the current slice dimension.
  useEffect(() => {
    if (!cube) return;
    const vals = dimOptions[dims.slice];
    if (!vals.length) return;
    setDiceSelected((prev) => {
      const keep = prev.filter((x) => vals.includes(x));
      if (keep.length) return keep;
      return vals.slice(0, Math.max(1, diceCap));
    });
    // Reset query when changing slice dimension
    setDiceQuery("");
  }, [cube, dimOptions, dims.slice, diceCap]);

  useEffect(() => {
    if (!cube) return;
    if (!timeFrom) setTimeFrom(cube.times[0] ?? "");
    if (!timeTo) setTimeTo(cube.times[cube.times.length - 1] ?? "");
  }, [cube, timeFrom, timeTo]);

  const filteredData = useMemo(() => {
    if (!cube) return null;

    const xCats = dimOptions[dims.x];
    const yCats = dimOptions[dims.y];
    const zDim = dims.slice;
    const zCats = dimOptions[zDim];

    const xIndex = new Map<string, number>(xCats.map((v, i) => [v, i]));
    const yIndex = new Map<string, number>(yCats.map((v, i) => [v, i]));

    // Decide which z members are included (slice vs dice)
    let allowedZ = new Set<string>();
    if (op === "slice") {
      if (sliceValue) allowedZ.add(sliceValue);
    } else {
      // dice: constrain along slice dimension with sensible defaults
      if (zDim === "time") {
        const tFrom = timeFrom || cube.times[0] || "";
        const tTo = timeTo || cube.times[cube.times.length - 1] || "";
        const inRange = (t: string) => t >= tFrom && t <= tTo;
        allowedZ = new Set(cube.times.filter(inRange));
      } else {
        // explicit member selection (search + checkbox list)
        if (diceSelected.length) {
          allowedZ = new Set(diceSelected);
        } else {
          allowedZ = new Set(zCats.slice(0, Math.max(1, diceCap)));
        }
      }
    }

    // Aggregate measure across z for each (x,y): avg(value)
    const cell = new Map<string, { sum: number; n: number }>();
    const iterZ = allowedZ.size ? Array.from(allowedZ) : zCats;

    for (const [k, a] of cube.agg.entries()) {
      const [t, b, p, g] = k.split("||");
      const z = keyOf(zDim, t, b, p, g);
      if (allowedZ.size && !allowedZ.has(z)) continue;

      const xv = keyOf(dims.x, t, b, p, g);
      const yv = keyOf(dims.y, t, b, p, g);
      const xi = xIndex.get(xv);
      const yi = yIndex.get(yv);
      if (xi === undefined || yi === undefined) continue;

      const ck = `${xi}|${yi}`;
      const cur = cell.get(ck) ?? { sum: 0, n: 0 };
      cur.sum += a.sum / a.n;
      cur.n += 1;
      cell.set(ck, cur);
    }

    const seriesData: [number, number, number][] = [];
    for (const [k, v] of cell.entries()) {
      const [xiStr, yiStr] = k.split("|");
      const xi = Number(xiStr);
      const yi = Number(yiStr);
      seriesData.push([xi, yi, Math.round((v.sum / v.n) * 1000) / 1000]);
    }

    return {
      xCats,
      yCats,
      zDim,
      allowedZ: iterZ,
      seriesData,
    };
  }, [cube, dimOptions, dims, diceCap, diceSelected, op, sliceValue, timeFrom, timeTo]);

  const option = useMemo(() => {
    if (!filteredData) return null;
    const theme = {
      text: "rgba(236, 238, 242, 0.92)",
      muted: "rgba(179, 189, 204, 0.85)",
      grid: "rgba(255, 255, 255, 0.12)",
      axis: "rgba(255, 255, 255, 0.22)",
      tooltipBg: "rgba(10, 12, 16, 0.88)",
      tooltipBorder: "rgba(255, 255, 255, 0.14)",
    };

    const titleOp =
      op === "slice"
        ? `Slice on ${filteredData.zDim}: ${filteredData.allowedZ[0] ?? "—"}`
        : `Dice: ${grain} + ${filteredData.zDim}`;

    return {
      backgroundColor: "transparent",
      animation: true,
      animationDurationUpdate: 650,
      animationEasingUpdate: "cubicOut",
      tooltip: {
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: theme.text },
        extraCssText: "backdrop-filter: blur(10px); border-radius: 12px;",
        formatter: (p: { value: [number, number, number] }) => {
          const [xi, yi, z] = p.value;
          const x = filteredData.xCats[xi] ?? "";
          const y = filteredData.yCats[yi] ?? "";
          return `<strong>${y}</strong><br/>${x}<br/>Measure: ${typeof z === "number" ? z : ""}`;
        },
      },
      grid3D: {
        boxWidth: 140,
        boxDepth: 90,
        viewControl: {
          autoRotate: !reduceMotion,
          autoRotateAfterStill: 2,
          distance: 210,
          alpha: 20,
          beta: 34,
          minDistance: 140,
          maxDistance: 420,
        },
        light: {
          main: { intensity: 1.2, shadow: true, shadowQuality: "high" },
          ambient: { intensity: 0.35 },
        },
      },
      xAxis3D: {
        type: "category",
        name: dims.x,
        data: filteredData.xCats,
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.muted, fontSize: 10, rotate: dims.x === "time" ? 35 : 0 },
        nameTextStyle: { color: theme.muted },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      yAxis3D: {
        type: "category",
        name: dims.y,
        data: filteredData.yCats,
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.muted, fontSize: 10, fontFamily: dims.y === "biomarker" ? "var(--font-mono)" : "var(--font-sans)" },
        nameTextStyle: { color: theme.muted },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      zAxis3D: {
        type: "value",
        name: "avg(value)",
        axisLine: { lineStyle: { color: theme.axis } },
        axisLabel: { color: theme.muted },
        nameTextStyle: { color: theme.muted },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      visualMap: {
        type: "continuous",
        dimension: 2,
        calculable: true,
        textStyle: { color: theme.muted },
        inRange: { color: ["#60a5fa", "#2dd4bf", "#fbbf24", "#fb7185"] },
      },
      title: {
        text: "OLAP Cube (slice · dice · drill · across)",
        subtext: titleOp,
        left: 10,
        top: 6,
        textStyle: { color: theme.text, fontSize: 12, fontWeight: 600 },
        subtextStyle: { color: theme.muted, fontSize: 11 },
      },
      series: [
        {
          type: "bar3D",
          shading: "realistic",
          bevelSize: 0.2,
          bevelSmoothness: 3,
          barSize: 5.2,
          data: filteredData.seriesData,
          itemStyle: { opacity: 0.92 },
          emphasis: { itemStyle: { opacity: 1 } },
        },
      ],
    };
  }, [dims.x, dims.y, filteredData, grain, op, reduceMotion]);

  const dimChoices = [
    { id: "time", label: "Time" },
    { id: "biomarker", label: "Biomarker" },
    { id: "patient", label: "Patient" },
    { id: "group", label: "Group" },
  ] as const;

  const sliceCandidates = useMemo(() => dimOptions[dims.slice] ?? [], [dimOptions, dims.slice]);
  const diceCandidates = useMemo(() => {
    const q = diceQuery.trim().toLowerCase();
    const base = sliceCandidates;
    if (!q) return base;
    return base.filter((v) => v.toLowerCase().includes(q));
  }, [diceQuery, sliceCandidates]);

  const canRender = !!option && !!filteredData?.seriesData.length;

  const hasActiveFilter = Object.values(activeFilters).some(Boolean);

  const clearFilter = useCallback((dim: Dim) => {
    setActiveFilters(prev => ({ ...prev, [dim]: null }));
  }, []);

  const clearAllFilters = useCallback(() => {
    setActiveFilters({ time: null, biomarker: null, patient: null, group: null });
  }, []);

  const handleChartClick = useCallback(
    (params: { value?: [number, number, number] }) => {
      if (!filteredData || !params.value) return;
      const [xi, yi] = params.value;
      const xVal = filteredData.xCats[xi];
      const yVal = filteredData.yCats[yi];

      const newFilters = {
        ...activeFilters,
        [dims.x]: xVal ?? null,
        [dims.y]: yVal ?? null,
      };
      setActiveFilters(newFilters);

      // Immediately push to dashboard
      if (onFilter) {
        const payload: CubeFilterPayload = {};
        if (newFilters.patient) payload.patientId = newFilters.patient;
        if (newFilters.biomarker) payload.biomarkers = [newFilters.biomarker];
        if (newFilters.time) {
          if (grain === "month") {
            payload.dateFrom = newFilters.time + "-01";
            const [y, m] = newFilters.time.split("-").map(Number);
            const lastDay = new Date(y, m, 0).getDate();
            payload.dateTo = `${newFilters.time}-${String(lastDay).padStart(2, "0")}`;
          } else {
            payload.dateFrom = newFilters.time;
            payload.dateTo = newFilters.time;
          }
        }
        onFilter(payload);
      }
    },
    [filteredData, dims.x, dims.y, activeFilters, grain, onFilter],
  );

  const chartEvents = useMemo(() => ({ click: handleChartClick }), [handleChartClick]);

  return (
    <div className="liquid-glass p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">OLAP cube navigator</h2>
          <p className="mt-1 text-sm text-ink-200/90">
            Click any bar to filter. Active filters propagate to the dashboard like Looker Studio cross-filtering.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setBiomarkerMode((m) => (m === "dashboard" ? "all" : "dashboard"))}
            className="rounded-2xl bg-white/10 px-3 py-2 text-white ring-1 ring-white/15 transition hover:bg-white/14"
          >
            Biomarkers: {biomarkerMode === "dashboard" ? "Dashboard selection" : "All"}
          </button>
          <button
            type="button"
            onClick={() => setGrain((g) => (g === "day" ? "month" : "day"))}
            className="rounded-2xl bg-white/10 px-3 py-2 text-white ring-1 ring-white/15 transition hover:bg-white/14"
          >
            Drill {grain === "day" ? "up (to month)" : "down (to day)"}
          </button>
          <button
            type="button"
            onClick={() => setDims((d) => ({ ...d, x: d.y, y: d.x }))}
            className="rounded-2xl bg-white/10 px-3 py-2 text-white ring-1 ring-white/15 transition hover:bg-white/14"
          >
            Drill across (swap axes)
          </button>
        </div>
      </div>

      {/* Active filter chips */}
      {hasActiveFilter && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-ink-300/80">Active filters:</span>
          {(Object.entries(activeFilters) as [Dim, string | null][]).filter(([, v]) => v).map(([dim, val]) => (
            <span
              key={dim}
              className="inline-flex items-center gap-1.5 rounded-full border border-clinic-teal/30 bg-clinic-teal/10 px-3 py-1 text-xs font-medium text-clinic-teal"
            >
              <span className="text-ink-300/70">{dim}:</span> {val}
              <button
                type="button"
                onClick={() => clearFilter(dim)}
                className="ml-0.5 rounded-full p-0.5 transition hover:bg-clinic-teal/20"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => {
              clearAllFilters();
              // Also reset dashboard filters
              if (onFilter) onFilter({});
            }}
            className="rounded-full bg-white/5 px-3 py-1 text-[11px] text-ink-200/80 ring-1 ring-white/10 transition hover:bg-white/10"
          >
            Clear all
          </button>
        </div>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="rounded-3xl border border-glass-100 bg-black/20 p-4 shadow-inner">
          <div className="grid gap-3">
            <label className="text-[11px] font-medium text-ink-200/90">
              Biomarker cap (performance)
              <input
                type="range"
                min={4}
                max={40}
                value={biomarkerCap}
                onChange={(e) => setBiomarkerCap(Number(e.target.value))}
                className="mt-2 w-full"
              />
              <div className="mt-1 text-[11px] text-ink-300/80">{biomarkerCap} biomarkers</div>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setOp("slice")}
                className={`rounded-xl px-3 py-2 ring-1 transition ${
                  op === "slice" ? "bg-clinic-teal/20 text-white ring-clinic-teal/30" : "bg-white/5 text-ink-200 ring-white/10 hover:bg-white/10"
                }`}
              >
                Slice
              </button>
              <button
                type="button"
                onClick={() => setOp("dice")}
                className={`rounded-xl px-3 py-2 ring-1 transition ${
                  op === "dice" ? "bg-clinic-teal/20 text-white ring-clinic-teal/30" : "bg-white/5 text-ink-200 ring-white/10 hover:bg-white/10"
                }`}
              >
                Dice
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="text-[11px] font-medium text-ink-200/90">
                X dim
                <select
                  value={dims.x}
                  onChange={(e) => setDims((d) => ({ ...d, x: e.target.value as Dim }))}
                  className="mt-1 w-full rounded-xl border border-glass-200 bg-black/20 px-2 py-2 text-xs text-ink-100 shadow-inner outline-none"
                >
                  {dimChoices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] font-medium text-ink-200/90">
                Y dim
                <select
                  value={dims.y}
                  onChange={(e) => setDims((d) => ({ ...d, y: e.target.value as Dim }))}
                  className="mt-1 w-full rounded-xl border border-glass-200 bg-black/20 px-2 py-2 text-xs text-ink-100 shadow-inner outline-none"
                >
                  {dimChoices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] font-medium text-ink-200/90">
                Slice dim
                <select
                  value={dims.slice}
                  onChange={(e) => setDims((d) => ({ ...d, slice: e.target.value as Dim }))}
                  className="mt-1 w-full rounded-xl border border-glass-200 bg-black/20 px-2 py-2 text-xs text-ink-100 shadow-inner outline-none"
                >
                  {dimChoices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {op === "slice" ? (
              <label className="text-[11px] font-medium text-ink-200/90">
                Slice member
                <select
                  value={sliceValue}
                  onChange={(e) => setSliceValue(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-glass-200 bg-black/20 px-2 py-2 text-xs text-ink-100 shadow-inner outline-none"
                >
                  {sliceCandidates.slice(0, 250).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="grid gap-2">
                {dims.slice === "time" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[11px] font-medium text-ink-200/90">
                      Time from
                      <select
                        value={timeFrom}
                        onChange={(e) => setTimeFrom(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-glass-200 bg-black/20 px-2 py-2 text-xs text-ink-100 shadow-inner outline-none"
                      >
                        {(dimOptions.time ?? []).slice(0, 300).map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-[11px] font-medium text-ink-200/90">
                      Time to
                      <select
                        value={timeTo}
                        onChange={(e) => setTimeTo(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-glass-200 bg-black/20 px-2 py-2 text-xs text-ink-100 shadow-inner outline-none"
                      >
                        {(dimOptions.time ?? []).slice(0, 300).map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] font-medium text-ink-200/90">
                        Search members
                        <input
                          value={diceQuery}
                          onChange={(e) => setDiceQuery(e.target.value)}
                          placeholder={`Filter ${dims.slice}...`}
                          className="mt-1 w-full rounded-xl border border-glass-200 bg-black/20 px-2 py-2 text-xs text-ink-100 shadow-inner outline-none placeholder:text-ink-300/50"
                        />
                      </label>
                      <div className="mt-5 flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setDiceSelected([])}
                          className="rounded-xl bg-white/5 px-2.5 py-2 text-[11px] text-ink-200 ring-1 ring-white/10 transition hover:bg-white/10"
                        >
                          None
                        </button>
                        <button
                          type="button"
                          onClick={() => setDiceSelected(diceCandidates.slice(0, diceCap))}
                          className="rounded-xl bg-white/5 px-2.5 py-2 text-[11px] text-ink-200 ring-1 ring-white/10 transition hover:bg-white/10"
                        >
                          Select visible
                        </button>
                      </div>
                    </div>

                    <label className="text-[11px] font-medium text-ink-200/90">
                      Dice cap (performance)
                      <input
                        type="range"
                        min={6}
                        max={60}
                        value={diceCap}
                        onChange={(e) => setDiceCap(Number(e.target.value))}
                        className="mt-2 w-full"
                      />
                      <div className="mt-1 text-[11px] text-ink-300/80">
                        Up to {diceCap} {dims.slice} members
                      </div>
                    </label>

                    <div className="max-h-40 overflow-auto rounded-2xl border border-glass-100 bg-black/20 p-2 shadow-inner">
                      {diceCandidates.slice(0, 240).map((v) => {
                        const checked = diceSelected.includes(v);
                        return (
                          <label key={v} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs text-ink-100/90">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setDiceSelected((prev) =>
                                  checked ? prev.filter((x) => x !== v) : [...prev, v],
                                )
                              }
                              className="h-4 w-4 rounded border-glass-200 bg-black/30 text-clinic-teal focus:ring-clinic-teal/40"
                            />
                            <span className={dims.slice === "biomarker" ? "font-mono" : ""}>{v}</span>
                          </label>
                        );
                      })}
                      {!diceCandidates.length && (
                        <div className="px-2 py-6 text-center text-xs text-ink-300/70">No matches.</div>
                      )}
                    </div>

                    <div className="text-[11px] text-ink-300/80">
                      Selected: <span className="font-medium text-white">{diceSelected.length}</span>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="rounded-2xl border border-glass-100 bg-black/20 px-3 py-2 text-[11px] text-ink-200/80">
              <div className="flex items-center justify-between">
                <span>
                  Mode: <span className="font-medium text-white">{op}</span>
                </span>
                <span>
                  Grain: <span className="font-medium text-white">{grain}</span>
                </span>
              </div>
              <div className="mt-1">
                Dims: <span className="font-medium text-white">{dims.x}</span> ×{" "}
                <span className="font-medium text-white">{dims.y}</span> (slice:{" "}
                <span className="font-medium text-white">{dims.slice}</span>)
              </div>
            </div>
          </div>
        </div>

        <div className="h-[520px] w-full">
          {loading ? (
            <div className="chart-frame relative h-full w-full p-3">
              <div className="chart-skeleton" />
              <div className="relative flex h-full items-center justify-center text-xs text-ink-200/80">
                Loading cube…
              </div>
            </div>
          ) : option ? (
            <div className="chart-frame h-full w-full p-3">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={`${op}-${grain}-${dims.x}-${dims.y}-${dims.slice}-${sliceValue}-${timeFrom}-${timeTo}-${diceCap}-${diceSelected.join(",")}`}
                  initial={{ opacity: 0, rotateX: -6, rotateY: 10, y: 8, scale: 0.992 }}
                  animate={{ opacity: 1, rotateX: 0, rotateY: 0, y: 0, scale: 1 }}
                  exit={{ opacity: 0, rotateX: 5, rotateY: -8, y: -6, scale: 0.995 }}
                  transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                  style={{ height: "100%" }}
                >
                  <ReactECharts
                    option={option}
                    style={{ height: "100%", width: "100%" }}
                    notMerge
                    onEvents={chartEvents}
                  />
                </motion.div>
              </AnimatePresence>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-glass-200 text-sm text-ink-300/80">
              Load data and select biomarkers to render the cube.
            </div>
          )}

          {!loading && option && !canRender && (
            <div className="mt-3 rounded-2xl border border-amber-200/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              No cells matched the current slice/dice filters. Try a different slice member or widen the dice window.
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

