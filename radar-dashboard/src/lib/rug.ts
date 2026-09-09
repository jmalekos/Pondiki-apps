// Pondiki Radar — token rug screen data layer (serverless, no keys).
// Sources: DexScreener (latest token profiles + pair data) and Solana public RPC
// (mint/freeze authority, top-10 holder concentration). Ported from tools/rug_screen.py.

export type Verdict = "LOW" | "MEDIUM" | "HIGH" | "AVOID";

export interface RugResult {
  mint: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  fdv: number | null;
  priceChange24h: number | null;
  ageHours: number | null;
  top10HolderPct: number | null;
  mintRenounced: boolean | null;
  freezeRenounced: boolean | null;
  hasWebsite: boolean;
  hasTwitter: boolean;
  rugScore: number;
  verdict: Verdict;
  redFlags: string[];
  dex: string | null;
  url: string;
}

const RPC = "https://api.mainnet-beta.solana.com";
const DEX = "https://api.dexscreener.com";
const UA = { "User-Agent": "PondikiRadar/0.1 (research; jmalekos@gmail.com)" };

async function rpc(method: string, params: unknown[]): Promise<any> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
    });
    const j: any = await res.json();
    return j?.result ?? null;
  } catch {
    return null;
  }
}

async function dexLatest(limit: number): Promise<any[]> {
  const res = await fetch(`${DEX}/token-profiles/latest/v1`, { headers: UA, cache: "no-store" });
  if (!res.ok) return [];
  const j: any = await res.json();
  const arr = Array.isArray(j) ? j : j?.profiles || [];
  return arr.slice(0, limit);
}

async function dexPair(mint: string): Promise<any | null> {
  try {
    const res = await fetch(`${DEX}/latest/dex/tokens/${mint}`, { headers: UA, cache: "no-store" });
    if (!res.ok) return null;
    const j: any = await res.json();
    return (j?.pairs || [])[0] || null;
  } catch {
    return null;
  }
}

async function mintAuthorities(mint: string): Promise<{ mintRenounced: boolean | null; freezeRenounced: boolean | null }> {
  const res = await rpc("getAccountInfo", [mint, { encoding: "base64" }]);
  const data = res?.value?.data?.[0];
  if (!data) return { mintRenounced: null, freezeRenounced: null };
  const buf = Buffer.from(data, "base64");
  // SPL mint layout: mint_authority COption @0 (4-byte tag, 0=None), freeze_authority @46.
  const mintRenounced = buf.length >= 4 ? buf.readUInt32LE(0) === 0 : null;
  const freezeRenounced = buf.length >= 50 ? buf.readUInt32LE(46) === 0 : null;
  return { mintRenounced, freezeRenounced };
}

async function top10Pct(mint: string): Promise<number | null> {
  const largest = await rpc("getTokenLargestAccounts", [mint]);
  const supply = await rpc("getTokenSupply", [mint]);
  const accounts = largest?.value;
  const total = supply?.value?.uiAmount;
  if (!Array.isArray(accounts) || !total) return null;
  const top10 = accounts.slice(0, 10).reduce((s: number, a: any) => s + (Number(a.uiAmount) || 0), 0);
  return Math.round((top10 / Number(total)) * 1000) / 10;
}

function computeScore(
  d: { liquidityUsd: number | null; ageHours: number | null; priceChange24h: number | null; hasWebsite: boolean; hasTwitter: boolean },
  mintRenounced: boolean | null,
  freezeRenounced: boolean | null,
  top10: number | null
): { score: number; verdict: Verdict; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (top10 != null) {
    if (top10 >= 50) { score += 25; flags.push(`top-10 holders ${top10}%`); }
    else if (top10 >= 35) { score += 15; flags.push(`top-10 ${top10}%`); }
    else if (top10 >= 25) { score += 8; flags.push(`top-10 ${top10}%`); }
  }

  const liq = d.liquidityUsd ?? 0;
  if (liq < 10000) { score += 20; flags.push("liq <$10k"); }
  else if (liq < 50000) { score += 10; flags.push("liq <$50k"); }

  if (mintRenounced === false) { score += 15; flags.push("mint authority NOT renounced"); }
  if (freezeRenounced === false) { score += 8; flags.push("freeze authority NOT renounced"); }

  if (d.ageHours != null) {
    if (d.ageHours < 1) { score += 12; flags.push(`age ${d.ageHours}h`); }
    else if (d.ageHours < 24) { score += 8; flags.push(`age ${d.ageHours}h`); }
    else if (d.ageHours < 72) { score += 4; }
  }

  if (!d.hasWebsite) { score += 6; flags.push("no website"); }
  if (!d.hasTwitter) { score += 4; flags.push("no twitter"); }

  if ((d.priceChange24h ?? 0) > 300) { score += 5; flags.push("pump >300%"); }

  score = Math.min(score, 100);
  const verdict: Verdict = score < 20 ? "LOW" : score < 45 ? "MEDIUM" : score < 70 ? "HIGH" : "AVOID";
  return { score, verdict, flags };
}

export async function screenToken(mint: string): Promise<RugResult | null> {
  const p = await dexPair(mint);
  if (!p) return null;

  const info: any = p.info || {};
  const websites: any[] = info.websites || [];
  const socials: any[] = info.socials || [];
  const hasWebsite = websites.length > 0;
  const hasTwitter = socials.some((s: any) => s.type === "twitter");
  const created = p.pairCreatedAt as number | undefined;
  const ageHours = created ? Math.round(((Date.now() - created) / 3.6e6) * 10) / 10 : null;

  const liq = Number(p.liquidity?.usd || 0);
  const vol = Number(p.volume?.h24 || 0);
  const price = Number(p.priceUsd || 0);
  const fdv = Number(p.fdv || 0);
  const pchg = Number(p.priceChange?.h24 || 0);

  const { mintRenounced, freezeRenounced } = await mintAuthorities(mint);
  const top10 = await top10Pct(mint);
  const { score, verdict, flags } = computeScore(
    { liquidityUsd: liq, ageHours, priceChange24h: pchg, hasWebsite, hasTwitter },
    mintRenounced,
    freezeRenounced,
    top10
  );

  return {
    mint,
    chain: p.chainId || "solana",
    symbol: p.baseToken?.symbol || null,
    name: p.baseToken?.name || null,
    priceUsd: price || null,
    liquidityUsd: liq || null,
    volume24h: vol || null,
    fdv: fdv || null,
    priceChange24h: pchg || null,
    ageHours,
    top10HolderPct: top10,
    mintRenounced,
    freezeRenounced,
    hasWebsite,
    hasTwitter,
    rugScore: score,
    verdict,
    redFlags: flags,
    dex: p.dexId || null,
    url: `https://dexscreener.com/solana/${mint}`,
  };
}

export async function screenLatest(limit = 12): Promise<RugResult[]> {
  const profiles = await dexLatest(limit * 2);
  const solana = profiles.filter((p: any) => p.chainId === "solana").slice(0, limit);
  const settled = await Promise.all(
    solana.map(async (p: any) => {
      try {
        return await screenToken(p.tokenAddress);
      } catch {
        return null;
      }
    })
  );
  const out = settled.filter((r): r is RugResult => r != null);
  out.sort((a, b) => b.rugScore - a.rugScore);
  return out;
}
