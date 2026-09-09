"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RugResult } from "@/lib/rug";

const fmtUsd = (n: number | null) =>
  n == null
    ? "—"
    : n >= 1e6
    ? `$${(n / 1e6).toFixed(2)}M`
    : n >= 1e3
    ? `$${(n / 1e3).toFixed(1)}k`
    : `$${n.toFixed(0)}`;

const shortAddr = (a: string) => `${a.slice(0, 5)}…${a.slice(-5)}`;

const verdictColor: Record<string, string> = {
  LOW: "bg-emerald-500/15 text-emerald-300",
  MEDIUM: "bg-yellow-500/15 text-yellow-300",
  HIGH: "bg-orange-500/15 text-orange-300",
  AVOID: "bg-red-500/15 text-red-400",
};

export default function Home() {
  const [rugs, setRugs] = useState<RugResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastTick, setLastTick] = useState(0);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch("/api/rugs", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setRugs(j.rugs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      busy.current = false;
      setLoading(false);
      setLastTick(Date.now());
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const list = rugs || [];
  const risky = list.filter((r) => r.verdict === "HIGH" || r.verdict === "AVOID").length;
  const avgScore = list.length ? Math.round(list.reduce((s, r) => s + r.rugScore, 0) / list.length) : 0;

  return (
    <main className="min-h-screen bg-[#0a0c10] text-stone-200 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <header className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">🐭 Pondiki Radar</h1>
            <p className="text-stone-400 text-sm mt-1">
              Token rug screen — the newest Solana launches, scored before you trade.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-stone-500 text-xs">
              {lastTick ? `updated ${new Date(lastTick).toLocaleTimeString()}` : ""}
            </span>
            <button
              onClick={load}
              className="px-3 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-sm transition-colors"
            >
              ⟳ Refresh
            </button>
          </div>
        </header>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-[#14161f] border border-[#262b3a] rounded-xl p-4">
            <div className="text-stone-500 text-xs uppercase tracking-wide">Screened</div>
            <div className="text-2xl font-bold mt-1">{loading ? "…" : list.length}</div>
          </div>
          <div className="bg-[#14161f] border border-[#262b3a] rounded-xl p-4">
            <div className="text-stone-500 text-xs uppercase tracking-wide">Risky (HIGH+AVOID)</div>
            <div className="text-2xl font-bold mt-1 text-red-400">{loading ? "…" : risky}</div>
          </div>
          <div className="bg-[#14161f] border border-[#262b3a] rounded-xl p-4">
            <div className="text-stone-500 text-xs uppercase tracking-wide">Avg score</div>
            <div className="text-2xl font-bold mt-1">{loading ? "…" : avgScore}</div>
          </div>
          <div className="bg-[#14161f] border border-[#262b3a] rounded-xl p-4">
            <div className="text-stone-500 text-xs uppercase tracking-wide">Verdicts</div>
            <div className="text-sm font-medium mt-1.5">
              {list.length === 0
                ? "—"
                : Object.entries(
                    list.reduce((acc: Record<string, number>, r) => {
                      acc[r.verdict] = (acc[r.verdict] || 0) + 1;
                      return acc;
                    }, {})
                  )
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ")}
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-xl p-4 mb-4 text-sm">
            {error}
          </div>
        )}

        <div className="bg-[#14161f] border border-[#262b3a] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#262b3a] text-sm text-stone-400">
            Newest Solana tokens by rug score (higher = riskier)
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-stone-500 text-xs uppercase tracking-wide border-b border-[#262b3a]">
                  <th className="text-left px-4 py-3 font-medium">Token</th>
                  <th className="text-left px-4 py-3 font-medium">Score</th>
                  <th className="text-left px-4 py-3 font-medium">Verdict</th>
                  <th className="text-right px-4 py-3 font-medium">Liq</th>
                  <th className="text-right px-4 py-3 font-medium">Age</th>
                  <th className="text-right px-4 py-3 font-medium">Top10</th>
                  <th className="text-left px-4 py-3 font-medium">Red flags</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-stone-500">
                      No tokens screened yet.
                    </td>
                  </tr>
                ) : (
                  list.map((r) => (
                    <tr key={r.mint} className="border-b border-[#1e2333] hover:bg-[#181c28]">
                      <td className="px-4 py-3">
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-stone-100 hover:text-stone-300"
                        >
                          {r.symbol || "—"}
                        </a>
                        <div className="text-stone-500 text-xs font-mono">{shortAddr(r.mint)}</div>
                      </td>
                      <td className="px-4 py-3 font-bold">{r.rugScore}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${verdictColor[r.verdict]}`}>
                          {r.verdict}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-stone-400">{fmtUsd(r.liquidityUsd)}</td>
                      <td className="px-4 py-3 text-right text-stone-400">
                        {r.ageHours != null ? `${r.ageHours}h` : "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-stone-400">
                        {r.top10HolderPct != null ? `${r.top10HolderPct}%` : "—"}
                      </td>
                      <td className="px-4 py-3 text-orange-300/80 text-xs max-w-xs">
                        {r.redFlags.length ? r.redFlags.join(", ") : <span className="text-stone-500">—</span>}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <footer className="mt-6 text-stone-600 text-xs">
          Rug score = holder concentration + liquidity + mint/freeze authority + age + socials. Not financial
          advice — a score is a flag, not a verdict. Built by the mouse in the labyrinth 🐭
        </footer>
      </div>
    </main>
  );
}
