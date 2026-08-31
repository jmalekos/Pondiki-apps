"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Portfolio } from "@/lib/solana";

const fmtUsd = (n: number | null, digits = 2) =>
  n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const fmtNum = (n: number | null, digits = 4) =>
  n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits });
const fmtPct = (n: number | null) =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const shortAddr = (a: string) => `${a.slice(0, 5)}…${a.slice(-5)}`;

export default function Home() {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastTick, setLastTick] = useState(0);
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);

  const load = useCallback(async (force = false) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch(`/api/portfolio${force ? "?force=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setData(j);
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
    load(true);
    const id = setInterval(() => load(false), 60_000);
    return () => clearInterval(id);
  }, [load]);

  const copyWallet = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const changeColor = (n: number | null) =>
    n == null ? "text-stone-400" : n >= 0 ? "text-emerald-400" : "text-red-400";

  return (
    <main className="min-h-screen bg-[#0a0c10] text-stone-200 pb-16">
      {/* header */}
      <header className="sticky top-0 z-10 border-b border-white/5 bg-[#0a0c10]/90 backdrop-blur">
        <div className="mx-auto max-w-5xl px-5 py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-lg tracking-[0.25em] text-amber-300/90 uppercase">Seeker Wallet</h1>
            {data && (
              <button
                onClick={copyWallet}
                className="mt-0.5 font-mono text-[11px] text-stone-500 hover:text-amber-300 transition-colors"
                title="Copy address"
              >
                {copied ? "✓ copied" : shortAddr(data.wallet)}
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-stone-500">
            <span>
              {data
                ? `updated ${new Date(data.fetchedAt).toLocaleTimeString("en-US", { hour12: false })}`
                : "loading…"}
            </span>
            <button
              onClick={() => load(true)}
              disabled={loading}
              className="rounded-md border border-amber-300/30 px-3 py-1.5 text-amber-300/90 hover:bg-amber-300/10 disabled:opacity-40 transition-colors"
            >
              {loading ? "…" : "⟳ refresh"}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-5 space-y-6 mt-8">
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            ⚠ {error}
          </div>
        )}

        {!data && !error && (
          <div className="rounded-lg border border-white/5 bg-white/[0.02] px-4 py-10 text-center text-stone-500 text-sm">
            Loading portfolio…
          </div>
        )}

        {data && (
          <>
            {/* summary cards */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Card label="Total Value" big={fmtUsd(data.totalUsd)} accent />
              <Card label="24h Δ (weighted)" big={fmtPct(data.weightedChange24h)} sub={data.weightedChange24h == null ? "no price history" : undefined} tone={data.weightedChange24h != null ? (data.weightedChange24h >= 0 ? "up" : "down") : "flat"} />
              <Card label="SOL" big={`${fmtNum(data.solBalance)} ◎`} sub={fmtUsd(data.solValueUsd)} />
              <Card label="Stablecoins" big={fmtUsd(data.stableValueUsd)} sub="USDC + USDT" />
            </section>

            {data.unpricedCount > 0 && (
              <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[13px] text-amber-200/90">
                ⚠ {data.unpricedCount} holding{data.unpricedCount > 1 ? "s" : ""} unpriced — not tradable on Jupiter,
                no DexScreener pairs. Likely scam airdrops / unlisted tokens. Not counted in total.
              </div>
            )}

            {/* allocation bar */}
            <section>
              <h2 className="mb-2 text-[11px] font-semibold tracking-[0.2em] text-stone-500 uppercase">Allocation</h2>
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/5">
                {data.holdings
                  .filter((h) => h.valueUsd != null && h.valueUsd > 0.005)
                  .map((h) =>
                    <div
                      key={h.mint}
                      style={{ width: `${((h.valueUsd! / data.totalUsd) * 100).toFixed(3)}%` }}
                      title={`${h.symbol} ${((h.valueUsd! / data.totalUsd) * 100).toFixed(1)}%`}
                      className={h.source === "stable" ? "bg-sky-400/80" : h.mint === "So11111111111111111111111111111111111111112" ? "bg-amber-300/90" : "bg-emerald-400/80"}
                    />
                  )}
              </div>
            </section>

            {/* holdings table */}
            <section>
              <h2 className="mb-2 text-[11px] font-semibold tracking-[0.2em] text-stone-500 uppercase">Holdings</h2>
              <div className="overflow-x-auto rounded-xl border border-white/5 bg-white/[0.02]">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-white/5 text-left text-[11px] uppercase tracking-wider text-stone-500">
                      <th className="px-4 py-3">Asset</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                      <th className="px-4 py-3 text-right">Price</th>
                      <th className="px-4 py-3 text-right">Value</th>
                      <th className="px-4 py-3 text-right">24h</th>
                      <th className="px-4 py-3 w-40">Alloc</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {data.holdings.map((h) => {
                      const alloc = h.valueUsd != null && data.totalUsd > 0 ? (h.valueUsd / data.totalUsd) * 100 : null;
                      return (
                        <tr key={h.mint} className="group hover:bg-white/[0.03] transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className={`inline-block h-2 w-2 rounded-full ${h.source === "stable" ? "bg-sky-400" : h.source === "native" ? "bg-amber-300" : h.tradable ? "bg-emerald-400" : "bg-red-500"}`} />
                              <div>
                                <div className="font-medium text-stone-100">{h.symbol}</div>
                                {h.tradable ? (
                                  <div className="text-[11px] text-stone-500">{h.name}</div>
                                ) : (
                                  <div className="text-[11px] text-red-400/80">{h.note}</div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-stone-300">{fmtNum(h.amount)}</td>
                          <td className="px-4 py-3 text-right font-mono text-stone-300">{fmtUsd(h.priceUsd, 4)}</td>
                          <td className="px-4 py-3 text-right font-mono text-stone-100">{fmtUsd(h.valueUsd)}</td>
                          <td className={`px-4 py-3 text-right font-mono ${changeColor(h.change24h)}`}>{fmtPct(h.change24h)}</td>
                          <td className="px-4 py-3">
                            {alloc != null ? (
                              <div className="flex items-center gap-2">
                                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                                  <div
                                    className="h-full rounded-full bg-amber-300/70"
                                    style={{ width: `${Math.max(alloc, 0.5)}%` }}
                                  />
                                </div>
                                <span className="w-12 text-right font-mono text-[11px] text-stone-500">{alloc.toFixed(1)}%</span>
                              </div>
                            ) : (
                              <span className="text-[11px] text-stone-600">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="text-center text-[11px] text-stone-600">
              Data: public Solana RPC · DexScreener · Jupiter. Auto-refresh 60s. No keys stored.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Card({
  label,
  big,
  sub,
  accent,
  tone,
}: {
  label: string;
  big: string;
  sub?: string;
  accent?: boolean;
  tone?: "up" | "down" | "flat";
}) {
  const toneClass =
    tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : accent ? "text-amber-300" : "text-stone-100";
  return (
    <div className={`rounded-xl border p-4 ${accent ? "border-amber-300/20 bg-amber-300/[0.04]" : "border-white/5 bg-white/[0.02]"}`}>
      <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">{label}</div>
      <div className={`mt-1.5 font-mono text-2xl font-semibold tabular-nums ${toneClass}`}>{big}</div>
      {sub && <div className="mt-0.5 font-mono text-[11px] text-stone-500">{sub}</div>}
    </div>
  );
}
