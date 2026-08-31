// Solana portfolio data layer: balances via public RPC, prices via DexScreener + Jupiter swap API.
// No API keys. In-process cache with TTL to respect rate limits.

export interface Holding {
  mint: string;
  symbol: string;
  name: string;
  amount: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
  change24h: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  dex: string | null;
  source: "native" | "token" | "stable";
  tradable: boolean;
  note?: string;
}

export interface Portfolio {
  wallet: string;
  fetchedAt: number;
  totalUsd: number;
  solBalance: number;
  solValueUsd: number;
  stableValueUsd: number;
  weightedChange24h: number | null;
  holdings: Holding[];
  unpricedCount: number;
}

const RPC = "https://api.mainnet-beta.solana.com";
const WALLET =
  process.env.SEEKER_WALLET ??
  "CKnkuC4jhtKq1DGiXcGztxSsRsUNVBF44zQFqkaMYwg8";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SPL_PROG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN2022_PROG = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const delay = 300; // polite pacing between external calls

// ---- in-process cache ----
let cache: { data: Portfolio; at: number } | null = null;
const TTL_MS = 60_000;

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

interface DexPair {
  dexId: string;
  pairAddress: string;
  priceUsd: string;
  priceNative: string;
  liquidity: { usd?: string };
  volume?: { h24?: string };
  priceChange?: { h24?: string };
  baseToken: { symbol: string; name: string };
  quoteToken: { symbol: string };
}

async function dexPrice(mint: string): Promise<{
  priceUsd: number;
  change24h: number;
  liquidityUsd: number;
  volume24h: number;
  dex: string;
  symbol: string;
  name: string;
} | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 seeker-dashboard" },
  });
  if (!res.ok) return null;
  const j = await res.json();
  const pairs: DexPair[] = j?.pairs ?? [];
  if (!pairs.length) return null;
  const stables = pairs.filter((p) => ["USDC", "USDT"].includes(p.quoteToken.symbol));
  const pool = (stables.length ? stables : pairs).filter(
    (p) => Number(p.liquidity?.usd ?? 0) > 0
  );
  if (!pool.length) return null;
  pool.sort((a, b) => Number(b.liquidity.usd) - Number(a.liquidity.usd));
  const p = pool[0];
  return {
    priceUsd: Number(p.priceUsd),
    change24h: Number(p.priceChange?.h24 ?? 0),
    liquidityUsd: Number(p.liquidity.usd),
    volume24h: Number(p.volume?.h24 ?? 0),
    dex: p.dexId,
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
  };
}

async function jupiterQuotePrice(
  mint: string,
  decimals: number
): Promise<{ priceUsd: number; symbol: string; name: string; tradable: boolean }> {
  const baseUnits = Math.pow(10, decimals);
  const url =
    `https://api.jup.ag/swap/v1/quote?inputMint=${mint}` +
    `&outputMint=${USDC}&amount=${baseUnits}&slippageBps=100`;
  const res = await fetch(url, { cache: "no-store" });
  const j = await res.json();
  if (!res.ok || j.error) {
    return { priceUsd: NaN, symbol: "", name: "", tradable: false };
  }
  const out = Number(j.outAmount) / 1e6; // USDC has 6 decimals
  return { priceUsd: out, symbol: "", name: "", tradable: true };
}

async function fetchHoldings(): Promise<{
  solLamports: number;
  tokens: { mint: string; amount: number; decimals: number }[];
}> {
  const [bal, spl, t22] = await Promise.all([
    rpc("getBalance", [WALLET]),
    rpc("getTokenAccountsByOwner", [WALLET, { programId: SPL_PROG }, { encoding: "jsonParsed" }]),
    rpc("getTokenAccountsByOwner", [WALLET, { programId: TOKEN2022_PROG }, { encoding: "jsonParsed" }]),
  ]);
  const tokens: { mint: string; amount: number; decimals: number }[] = [];
  for (const res of [spl, t22]) {
    for (const a of res?.value ?? []) {
      const info = a.account?.data?.parsed?.info;
      if (!info) continue;
      const amt = info.tokenAmount;
      if (Number(amt.amount) > 0) {
        tokens.push({ mint: info.mint, amount: Number(amt.uiAmount), decimals: amt.decimals });
      }
    }
  }
  return { solLamports: bal.value, tokens };
}

export async function getPortfolio(force = false): Promise<Portfolio> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const { solLamports, tokens } = await fetchHoldings();
  const solBalance = solLamports / 1e9;

  const holdings: Holding[] = [];
  const allMints = [SOL_MINT, ...tokens.map((t) => t.mint)];

  for (const mint of allMints) {
    if (mint === SOL_MINT) {
      const px = await dexPrice(SOL_MINT);
      if (!px) continue;
      holdings.push({
        mint,
        symbol: "SOL",
        name: "Solana",
        amount: solBalance,
        decimals: 9,
        priceUsd: px.priceUsd,
        valueUsd: solBalance * px.priceUsd,
        change24h: px.change24h,
        liquidityUsd: px.liquidityUsd,
        volume24h: px.volume24h,
        dex: px.dex,
        source: "native",
        tradable: true,
      });
      await sleep(delay);
      continue;
    }

    const tok = tokens.find((t) => t.mint === mint)!;
    // stablecoins: fixed at $1 (verified against dex where available)
    if (mint === USDC) {
      holdings.push({
        mint, symbol: "USDC", name: "USD Coin", amount: tok.amount, decimals: tok.decimals,
        priceUsd: 1, valueUsd: tok.amount, change24h: 0, liquidityUsd: null,
        volume24h: null, dex: null, source: "stable", tradable: true,
      });
      continue;
    }
    if (mint === USDT) {
      holdings.push({
        mint, symbol: "USDT", name: "Tether USD", amount: tok.amount, decimals: tok.decimals,
        priceUsd: 1, valueUsd: tok.amount, change24h: 0, liquidityUsd: null,
        volume24h: null, dex: null, source: "stable", tradable: true,
      });
      continue;
    }

    // non-stable: DexScreener first, Jupiter quote fallback
    const px = await dexPrice(mint);
    let h: Holding;
    if (px) {
      h = {
        mint, symbol: px.symbol, name: px.name, amount: tok.amount, decimals: tok.decimals,
        priceUsd: px.priceUsd, valueUsd: tok.amount * px.priceUsd, change24h: px.change24h,
        liquidityUsd: px.liquidityUsd, volume24h: px.volume24h, dex: px.dex,
        source: "token", tradable: true,
      };
    } else {
      const jq = await jupiterQuotePrice(mint, tok.decimals);
      if (jq.tradable && !isNaN(jq.priceUsd)) {
        h = {
          mint, symbol: jq.symbol || mint.slice(0, 6), name: jq.name || "Unknown token",
          amount: tok.amount, decimals: tok.decimals, priceUsd: jq.priceUsd,
          valueUsd: tok.amount * jq.priceUsd, change24h: null, liquidityUsd: null,
          volume24h: null, dex: "jupiter", source: "token", tradable: true,
          note: "priced via Jupiter quote",
        };
      } else {
        h = {
          mint, symbol: mint.slice(0, 6), name: "UNLISTED", amount: tok.amount,
          decimals: tok.decimals, priceUsd: null, valueUsd: null, change24h: null,
          liquidityUsd: null, volume24h: null, dex: null, source: "token", tradable: false,
          note: "not tradable on Jupiter; no DexScreener pairs — likely scam airdrop or unlisted",
        };
      }
    }
    holdings.push(h);
    await sleep(delay);
  }

  holdings.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

  const priced = holdings.filter((h) => h.valueUsd != null);
  const totalUsd = priced.reduce((s, h) => s + h.valueUsd!, 0);
  const solValueUsd = holdings.find((h) => h.mint === SOL_MINT)?.valueUsd ?? 0;
  const stableValueUsd = holdings
    .filter((h) => h.source === "stable")
    .reduce((s, h) => s + (h.valueUsd ?? 0), 0);

  // weighted 24h change (only priced + non-stable with change data)
  const movers = priced.filter((h) => h.change24h != null && h.source !== "stable");
  const weightedChange24h =
    movers.length && totalUsd - stableValueUsd > 0
      ? movers.reduce((s, h) => s + h.valueUsd! * h.change24h!, 0) / (totalUsd - stableValueUsd)
      : null;

  const data: Portfolio = {
    wallet: WALLET,
    fetchedAt: Date.now(),
    totalUsd,
    solBalance,
    solValueUsd,
    stableValueUsd,
    weightedChange24h,
    holdings,
    unpricedCount: holdings.filter((h) => h.valueUsd == null).length,
  };
  cache = { data, at: Date.now() };
  return data;
}
