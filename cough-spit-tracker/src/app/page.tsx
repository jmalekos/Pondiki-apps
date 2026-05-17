"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------- types ----------
interface DayData {
  cough: number;
  spit: number;
}
type Store = Record<string, DayData>;

const STORAGE_KEY = "pondiki_cough_spit";

// ---------- helpers ----------
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Store;
  } catch { /* ignore */ }
  return {};
}

function fmtDate(key: string): string {
  const d = new Date(key + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ---------- chart component ----------
function Chart({ data }: { data: Store }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = 520;
    const H = 200;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = "520px";
    canvas.style.height = "200px";
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    // Build 14-day series
    const days: { key: string; cough: number; spit: number }[] = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const dd = new Date(today);
      dd.setDate(dd.getDate() - i);
      const key = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, "0")}-${String(dd.getDate()).padStart(2, "0")}`;
      const d = data[key] ?? { cough: 0, spit: 0 };
      days.push({ key, ...d });
    }

    const maxVal = Math.max(1, ...days.map((x) => Math.max(x.cough, x.spit)));
    const pad = { top: 14, bottom: 24, left: 32, right: 8 };
    const cw = W - pad.left - pad.right;
    const ch = H - pad.top - pad.bottom;
    const gap = cw / days.length;
    const barW = gap * 0.28;

    // Grid lines
    ctx.strokeStyle = "#21262d";
    ctx.lineWidth = 1;
    for (let y = 0; y <= 4; y++) {
      const yy = pad.top + ch * (1 - y / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(W - pad.right, yy);
      ctx.stroke();
      ctx.fillStyle = "#8b949e";
      ctx.font = "9px -apple-system, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(String(Math.round((maxVal * y) / 4)), pad.left - 5, yy + 3);
    }

    // Bars
    days.forEach((day, i) => {
      const cx = pad.left + gap * i + gap / 2;
      const cH = (day.cough / maxVal) * ch;
      const sH = (day.spit / maxVal) * ch;

      ctx.fillStyle = "rgba(248,81,73,0.8)";
      ctx.fillRect(cx - barW - 1, pad.top + ch - cH, barW, Math.max(cH, 0.5));

      ctx.fillStyle = "rgba(88,166,255,0.8)";
      ctx.fillRect(cx + 1, pad.top + ch - sH, barW, Math.max(sH, 0.5));

      ctx.fillStyle = "#8b949e";
      ctx.font = "9px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(day.key.slice(5), cx, H - 5);

      if (day.cough > 0 || day.spit > 0) {
        ctx.font = "8px -apple-system, sans-serif";
        if (day.cough > 0) {
          ctx.fillStyle = "#f85149";
          ctx.fillText(String(day.cough), cx - barW / 2 - 1, pad.top + ch - cH - 3);
        }
        if (day.spit > 0) {
          ctx.fillStyle = "#58a6ff";
          ctx.fillText(String(day.spit), cx + 1 + barW / 2, pad.top + ch - sH - 3);
        }
      }
    });

    // Legend
    ctx.font = "9px -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#f85149";
    ctx.fillRect(W - 66, 3, 7, 7);
    ctx.fillStyle = "#e6edf3";
    ctx.fillText("Cough", W - 55, 11);
    ctx.fillStyle = "#58a6ff";
    ctx.fillRect(W - 66, 16, 7, 7);
    ctx.fillStyle = "#e6edf3";
    ctx.fillText("Spit", W - 55, 24);
  }, [data]);

  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <canvas ref={canvasRef} className="block w-full h-auto max-w-[520px] rounded-xl border border-[#30363d] bg-[#161b22]" />
    </div>
  );
}

// ---------- history table ----------
function HistoryTable({ data, today }: { data: Store; today: string }) {
  const keys = Object.keys(data).sort().reverse().slice(0, 14);

  if (keys.length === 0) {
    return (
      <p className="text-[#8b949e] text-sm text-center py-6">No data yet — start tapping!</p>
    );
  }

  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[#8b949e] border-b border-[#30363d]">
            <th className="text-left py-2 pr-4 font-medium">Date</th>
            <th className="text-left py-2 pr-4 font-medium text-[#f85149]">Cough</th>
            <th className="text-left py-2 font-medium text-[#58a6ff]">Spit</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const d = data[k];
            const isToday = k === today;
            return (
              <tr key={k} className={`border-b border-[#21262d] ${isToday ? "font-semibold" : ""}`}>
                <td className="py-2 pr-4">
                  {fmtDate(k)}
                  {isToday && <span className="text-[#d29922] text-xs ml-1">← today</span>}
                </td>
                <td className="py-2 pr-4 text-[#f85149]">{d.cough}</td>
                <td className="py-2 text-[#58a6ff]">{d.spit}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- main page ----------
export default function TrackerPage() {
  const [store, setStore] = useState<Store>({});
  const [mode, setMode] = useState<"cough" | "spit">("cough");
  const [today, setToday] = useState(todayKey);
  const [resetMsg, setResetMsg] = useState("");

  // Load on mount
  useEffect(() => {
    setStore(loadStore());
  }, []);

  // Persist on change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }, [store]);

  // Check day rollover every 15s
  useEffect(() => {
    const interval = setInterval(() => {
      const tk = todayKey();
      if (tk !== today) {
        setToday(tk);
        const fresh = loadStore();
        setStore(fresh);
        setResetMsg("🔄 New day — counters reset");
        setTimeout(() => setResetMsg(""), 4000);
      }
    }, 15000);
    return () => clearInterval(interval);
  }, [today]);

  // Refresh on visibility change
  useEffect(() => {
    const handler = () => {
      if (!document.hidden) {
        const fresh = loadStore();
        setStore(fresh);
        setToday(todayKey());
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  const dayData = store[today] ?? { cough: 0, spit: 0 };

  const totals = (() => {
    let tc = 0,
      ts = 0;
    for (const k in store) {
      tc += store[k].cough ?? 0;
      ts += store[k].spit ?? 0;
    }
    return { cough: tc, spit: ts };
  })();

  const increment = useCallback(() => {
    setStore((prev) => {
      const tk = todayKey();
      const next = { ...prev };
      if (!next[tk]) next[tk] = { cough: 0, spit: 0 };
      next[tk] = { ...next[tk], [mode]: (next[tk][mode] ?? 0) + 1 };
      return next;
    });
  }, [mode]);

  const undo = useCallback(
    (type: "cough" | "spit") => {
      setStore((prev) => {
        const tk = todayKey();
        const next = { ...prev };
        if (!next[tk]) return prev;
        const val = next[tk][type] ?? 0;
        if (val <= 0) return prev;
        next[tk] = { ...next[tk], [type]: val - 1 };
        return next;
      });
    },
    []
  );

  const resetToday = () => {
    const tk = todayKey();
    if ((store[tk]?.cough ?? 0) === 0 && (store[tk]?.spit ?? 0) === 0) return;
    setStore((prev) => {
      const next = { ...prev };
      next[tk] = { cough: 0, spit: 0 };
      return next;
    });
  };

  const clearAll = () => {
    if (Object.keys(store).length === 0) return;
    setStore({});
    setResetMsg("All data cleared");
    setTimeout(() => setResetMsg(""), 3000);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        increment();
      }
      if (e.key === "1") setMode("cough");
      if (e.key === "2") setMode("spit");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [increment]);

  return (
    <main className="flex flex-col items-center px-4 py-6 pb-10 max-w-lg mx-auto w-full">
      {/* Header */}
      <h1 className="text-lg font-medium text-[#8b949e] tracking-wide">
        🐭 Pondiki · Tracker
      </h1>
      <p className="text-sm text-[#8b949e] mb-4">
        {new Date().toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        })}
      </p>

      {resetMsg && (
        <p className="text-xs text-[#d29922] mb-3 transition-opacity">{resetMsg}</p>
      )}

      {/* Mode selector — radio style */}
      <div className="flex bg-[#161b22] rounded-full border border-[#30363d] overflow-hidden mb-7">
        <input
          type="radio"
          id="modeCough"
          name="mode"
          className="hidden"
          checked={mode === "cough"}
          onChange={() => setMode("cough")}
        />
        <label
          htmlFor="modeCough"
          className={`px-7 py-2.5 text-sm font-semibold uppercase tracking-wide cursor-pointer select-none transition-all ${
            mode === "cough"
              ? "text-[#f85149] bg-[rgba(248,81,73,0.12)]"
              : "text-[#8b949e] hover:text-[#e6edf3]"
          }`}
        >
          😤 Cough
        </label>
        <input
          type="radio"
          id="modeSpit"
          name="mode"
          className="hidden"
          checked={mode === "spit"}
          onChange={() => setMode("spit")}
        />
        <label
          htmlFor="modeSpit"
          className={`px-7 py-2.5 text-sm font-semibold uppercase tracking-wide cursor-pointer select-none transition-all ${
            mode === "spit"
              ? "text-[#58a6ff] bg-[rgba(88,166,255,0.12)]"
              : "text-[#8b949e] hover:text-[#e6edf3]"
          }`}
        >
          💧 Spit
        </label>
      </div>

      {/* Big tap button */}
      <button
        onClick={increment}
        className={`w-36 h-36 rounded-full border-4 text-5xl transition-transform active:scale-90 select-none touch-manipulation ${
          mode === "cough"
            ? "border-[#f85149] active:bg-[rgba(248,81,73,0.12)]"
            : "border-[#58a6ff] active:bg-[rgba(88,166,255,0.12)]"
        } bg-[#161b22] text-[#e6edf3]`}
        aria-label={`Tap to count a ${mode}`}
      >
        +
      </button>
      <p className="text-xs text-[#8b949e] mt-2 mb-5">
        {mode === "cough" ? "Tap to log a cough" : "Tap to log a spit"}
      </p>

      {/* Today's counts */}
      <div className="flex gap-14 mb-4">
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-2xl">😤</span>
          <span
            key={dayData.cough}
            className="text-4xl font-bold tabular-nums text-[#f85149] transition-transform"
          >
            {dayData.cough}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">Cough</span>
          <button
            onClick={() => undo("cough")}
            className="text-[11px] text-[#8b949e] underline underline-offset-2 decoration-dotted cursor-pointer hover:text-[#e6edf3]"
          >
            ← undo
          </button>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-2xl">💧</span>
          <span
            key={dayData.spit}
            className="text-4xl font-bold tabular-nums text-[#58a6ff] transition-transform"
          >
            {dayData.spit}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">Spit</span>
          <button
            onClick={() => undo("spit")}
            className="text-[11px] text-[#8b949e] underline underline-offset-2 decoration-dotted cursor-pointer hover:text-[#e6edf3]"
          >
            ← undo
          </button>
        </div>
      </div>

      {/* All-time totals */}
      <div className="flex gap-5 mb-7 px-5 py-2.5 rounded-xl border border-[#30363d] bg-[#161b22] text-[13px] text-[#8b949e]">
        <span>
          All-time cough: <strong className="text-[#e6edf3]">{totals.cough}</strong>
        </span>
        <span>
          All-time spit: <strong className="text-[#e6edf3]">{totals.spit}</strong>
        </span>
      </div>

      {/* Chart */}
      <section className="w-full mb-5">
        <h2 className="text-xs font-medium text-[#8b949e] uppercase tracking-wider mb-2.5">
          Last 14 Days
        </h2>
        <Chart data={store} />
      </section>

      {/* History */}
      <section className="w-full mb-6">
        <h2 className="text-xs font-medium text-[#8b949e] uppercase tracking-wider mb-2.5">
          Daily Log
        </h2>
        <HistoryTable data={store} today={today} />
      </section>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={resetToday}
          className="px-4 py-2 text-xs rounded-lg border border-[#30363d] bg-[#161b22] text-[#8b949e] cursor-pointer hover:bg-[#1c2333] transition-colors"
        >
          Reset today
        </button>
        <button
          onClick={clearAll}
          className="px-4 py-2 text-xs rounded-lg border border-[#f85149] bg-[#161b22] text-[#f85149] cursor-pointer hover:bg-[rgba(248,81,73,0.08)] transition-colors"
        >
          Clear all
        </button>
      </div>

      {/* Keyboard hint */}
      <p className="text-[10px] text-[#30363d] mt-5">
        <kbd className="px-1 py-0.5 rounded border border-[#30363d] text-[10px]">1</kbd> cough ·{" "}
        <kbd className="px-1 py-0.5 rounded border border-[#30363d] text-[10px]">2</kbd> spit ·{" "}
        <kbd className="px-1 py-0.5 rounded border border-[#30363d] text-[10px]">Space</kbd> tap
      </p>
    </main>
  );
}
