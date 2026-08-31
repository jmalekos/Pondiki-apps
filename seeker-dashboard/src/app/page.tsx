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
  const [now, setNow] = useState(Date.now());
  const [hideUnlisted, setHideUnlisted] = useState(false);
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

  // tick for the "updated Xs ago" counter
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const secondsAgo = data ? Math.max(0, Math.round((now - data.fetchedAt) / 1000)) : null;

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
            {/* overview header + refresh */}
            <section className="flex items-center justify-between gap-3">
              <h2 className="text-[11px] font-semibold tracking-[0.2em] text-stone-500 uppercase">Overview</h2>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[11px] text-stone-500">
                  {secondsAgo != null ? `updated ${secondsAgo}s ago` : "—"}
                </span>
                <button
                  onClick={() => load(true)}
                  disabled={loading}
                  className="rounded-md border border-amber-300/30 px-3 py-1.5 text-xs text-amber-300/90 hover:bg-amber-300/10 disabled:opacity-40 transition-colors"
                >
                  {loading ? "refreshing…" : "⟳ refresh now"}
                </button>
              </div>
            </section>

            {/* summary cards */}
            <section className="rounded-xl border border-amber-300/25 bg-gradient-to-br from-amber-300/[0.08] to-transparent p-5">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">Total Portfolio (incl. staked)</div>
                  <div className="mt-1 font-mono text-4xl font-semibold tabular-nums text-amber-300">{fmtUsd(data.totalWithUnstakingUsd)}</div>
                  <div className="mt-1 font-mono text-[11px] text-stone-500">
                    liquid {fmtUsd(data.totalUsd)} · staked {fmtUsd(data.stakingTotalUsd)} · unstaking {fmtUsd(data.unstakingUsd)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">excl. unstaking</div>
                  <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-stone-100">{fmtUsd(data.totalWithStakingUsd)}</div>
                </div>
              </div>
              {/* stacked bar: liquid / staked / unstaking */}
              <div className="mt-4">
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/5">
                  <div
                    className="bg-sky-400/80"
                    style={{ width: `${(data.totalUsd / data.totalWithUnstakingUsd) * 100}%` }}
                    title={`Liquid ${fmtUsd(data.totalUsd)}`}
                  />
                  <div
                    className="bg-amber-300/90"
                    style={{ width: `${(data.stakingTotalUsd / data.totalWithUnstakingUsd) * 100}%` }}
                    title={`Staked ${fmtUsd(data.stakingTotalUsd)}`}
                  />
                  <div
                    className="bg-emerald-400/80"
                    style={{ width: `${(data.unstakingUsd / data.totalWithUnstakingUsd) * 100}%` }}
                    title={`Unstaking ${fmtUsd(data.unstakingUsd)}`}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono">
                  <span className="flex items-center gap-1.5 text-stone-400">
                    <span className="inline-block h-2 w-2 rounded-full bg-sky-400/80" />
                    Liquid {fmtUsd(data.totalUsd)} ({(data.totalUsd / data.totalWithUnstakingUsd * 100).toFixed(1)}%)
                  </span>
                  <span className="flex items-center gap-1.5 text-stone-400">
                    <span className="inline-block h-2 w-2 rounded-full bg-amber-300/90" />
                    Staked {fmtUsd(data.stakingTotalUsd)} ({(data.stakingTotalUsd / data.totalWithUnstakingUsd * 100).toFixed(1)}%)
                  </span>
                  <span className="flex items-center gap-1.5 text-stone-400">
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-400/80" />
                    Unstaking {fmtUsd(data.unstakingUsd)} ({(data.unstakingUsd / data.totalWithUnstakingUsd * 100).toFixed(1)}%)
                  </span>
                </div>
              </div>
            </section>

            <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Card label="Liquid Value" big={fmtUsd(data.totalUsd)} sub="wallet balances" />
              <Card label="24h Δ (weighted)" big={fmtPct(data.weightedChange24h)} sub={data.weightedChange24h == null ? "no price history" : undefined} tone={data.weightedChange24h != null ? (data.weightedChange24h >= 0 ? "up" : "down") : "flat"} />
              <Card label="SOL" big={`${fmtNum(data.solBalance)} ◎`} sub={fmtUsd(data.solValueUsd)} />
              <Card label="Stablecoins" big={fmtUsd(data.stableValueUsd)} sub="USDC + USDT" />
            </section>

            {/* staking section */}
            {data.staking && data.staking.totalStakedSol > 0 && (
              <>
                <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <Card label="Staked SOL" big={`${fmtNum(data.staking.totalStakedSol)} ◎`} sub={fmtUsd(data.staking.totalStakedUsd)} accent />
                  <Card
                    label="Validator APY"
                    big={data.staking.validator?.totalApy != null ? `${data.staking.validator.totalApy.toFixed(2)}%` : "—"}
                    sub={data.staking.validator?.name ?? "unknown validator"}
                    tone={data.staking.validator?.totalApy != null && data.staking.validator.totalApy >= 5 ? "up" : "flat"}
                  />
                  <Card label="Est. Annual Yield" big={fmtUsd(data.staking.annualYieldUsd)} sub={data.staking.validator?.totalApy != null ? `${((data.staking.totalStakedSol * data.staking.validator.totalApy) / 100).toFixed(3)} ◎/yr` : undefined} />
                  <Card label="Est. Daily Yield" big={fmtUsd(data.staking.dailyYieldUsd)} sub="at current price" />
                </section>

                <section>
                  <h2 className="mb-2 text-[11px] font-semibold tracking-[0.2em] text-stone-500 uppercase">
                    Staked Positions
                  </h2>
                  <div className="overflow-x-auto rounded-xl border border-white/5 bg-white/[0.02]">
                    <table className="w-full min-w-[480px] text-sm">
                      <thead>
                        <tr className="border-b border-white/5 text-left text-[11px] uppercase tracking-wider text-stone-500">
                          <th className="px-4 py-3">Token</th>
                          <th className="px-4 py-3 text-right">QTY</th>
                          <th className="px-4 py-3 text-right">USD Total</th>
                          <th className="px-4 py-3 text-right">APY</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {data.staking.positions.map((p) => (
                          <tr key={p.symbol} className="hover:bg-white/[0.03] transition-colors">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <span className={`inline-block h-2 w-2 rounded-full ${p.symbol === "SOL" ? "bg-amber-300" : "bg-emerald-400"}`} />
                                <div>
                                  <div className="font-medium text-stone-100">{p.symbol}</div>
                                  <div className="text-[11px] text-stone-500">{p.name}</div>
                                  {p.detail && <div className="text-[11px] text-amber-300/80">{p.detail}</div>}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-stone-200">{p.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                            <td className="px-4 py-3 text-right font-mono text-stone-100">{fmtUsd(p.usdTotal)}</td>
                            <td className="px-4 py-3 text-right font-mono text-stone-200">
                              {p.apy != null ? `${p.apy.toFixed(2)}%` : "—"}
                              {p.apyNote && <div className="text-[10px] font-normal text-stone-500">{p.apyNote}</div>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {data.staking.validator && (
                    <p className="mt-2 text-[11px] text-stone-600">
                      Validator: {data.staking.validator.name} · commission {data.staking.validator.commission ?? "?"}%{data.staking.validator.isJito ? " · Jito MEV" : ""} · staking {data.staking.validator.stakingApy?.toFixed(2)}% + MEV {data.staking.validator.jitoApy?.toFixed(2)}%
                    </p>
                  )}
                </section>
              </>
            )}

            {data.unpricedCount > 0 && (
              <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[13px] text-amber-200/90">
                ⚠ {data.unpricedCount} holding{data.unpricedCount > 1 ? "s" : ""} unpriced — not tradable on Jupiter,
                no DexScreener pairs. Likely scam airdrops / unlisted tokens. Not counted in total
                {hideUnlisted ? " · hidden from table" : ""}.
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
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="text-[11px] font-semibold tracking-[0.2em] text-stone-500 uppercase">Holdings</h2>
                <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-stone-400">
                  <input
                    type="checkbox"
                    checked={hideUnlisted}
                    onChange={(e) => setHideUnlisted(e.target.checked)}
                    className="h-3.5 w-3.5 accent-amber-300"
                  />
                  Hide unlisted
                  {hideUnlisted && data.unpricedCount > 0 && (
                    <span className="font-mono text-[11px] text-stone-500">({data.unpricedCount} hidden)</span>
                  )}
                </label>
              </div>
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
                    {data.holdings
                      .filter((h) => !hideUnlisted || h.tradable)
                      .map((h) => {
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
