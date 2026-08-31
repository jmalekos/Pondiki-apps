// Solana portfolio data layer: balances via public RPC, prices via DexScreener + Jupiter swap API.
// Staking: native stake accounts via RPC getProgramAccounts, validator APY via Stakewiz (free).
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

export interface StakeAccount {
  pubkey: string;
  stakedSol: number;
  state: "stake" | "deactivating" | "other";
  activationEpoch: number;
  deactivationEpoch: number | null;
}

export interface ValidatorInfo {
  voteIdentity: string;
  name: string;
  totalApy: number | null;
  stakingApy: number | null;
  jitoApy: number | null;
  commission: number | null;
  isJito: boolean;
}

export interface StakedPosition {
  symbol: string;
  name: string;
  qty: number;
  usdTotal: number;
  apy: number | null;
  apyNote?: string;
  detail?: string;
}

export interface StakingInfo {
  totalStakedSol: number;
  totalStakedUsd: number;
  annualYieldUsd: number | null;
  dailyYieldUsd: number | null;
  positions: StakedPosition[];
  accounts: StakeAccount[];
  validator: ValidatorInfo | null;
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
  staking: StakingInfo | null;
  stakingTotalUsd: number;
  unstakingUsd: number;
  totalWithStakingUsd: number;
  totalWithUnstakingUsd: number;
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
const STAKE_PROG = "Stake11111111111111111111111111111111111111";
const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
const SKR_STAKING_PROG = "SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ";
const SKR_APY_BASE = 15; // SKR staking APY per Seeker (Cretan, 2026-08-31)
// SKR in unstaking cooldown: two on-chain unstake requests 26,516.37 + 13,270.25 = 39,786.61 (Cretan confirmed 2026-08-31)
const SKR_UNSTAKING = 39_786.61;
const DEACT_MAX = BigInt("0xFFFFFFFFFFFFFFFF");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const delay = 300; // polite pacing between external calls

// ---- in-process caches ----
let cache: { data: Portfolio; at: number } | null = null;
const TTL_MS = 60_000;
let stakewizCache: { data: any[]; at: number } | null = null;
const STAKEWIZ_TTL_MS = 6 * 3600 * 1000; // validator APY changes slowly

// ---- base58 (encode only, no deps) ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes: Uint8Array): string {
  let n = BigInt(0);
  for (const b of bytes) n = (n << BigInt(8)) | BigInt(b);
  let s = "";
  while (n > BigInt(0)) {
    s = B58[Number(n % BigInt(58))] + s;
    n /= BigInt(58);
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}

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

// ---- staking ----
async function fetchStakeAccounts(): Promise<{
  totalStakedSol: number;
  voteIdentity: string | null;
  accounts: StakeAccount[];
}> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getProgramAccounts",
      params: [
        STAKE_PROG,
        {
          encoding: "base64",
          filters: [{ memcmp: { offset: 12, bytes: WALLET } }],
        },
      ],
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RPC getProgramAccounts failed: ${res.status}`);
  const j = await res.json();
  const raw: { pubkey: string; account: { data: [string, string] } }[] = j?.result ?? [];

  const accounts: StakeAccount[] = [];
  let total = 0;
  let voteIdentity: string | null = null;
  for (const a of raw) {
    const data = Buffer.from(a.account.data[0], "base64");
    if (data.length < 196) continue;
    const variant = data.readUInt32LE(0);
    if (variant !== 2) continue; // StakeStateV2::Stake(Meta, Stake)
    const voter = bs58Encode(new Uint8Array(data.subarray(124, 156)));
    const stakeLamports = Number(data.readBigUInt64LE(156));
    const activationEpoch = Number(data.readBigUInt64LE(164));
    const deactivationRaw = data.readBigUInt64LE(172);
    const staked = stakeLamports / 1e9;
    voteIdentity = voter;
    total += staked;
    accounts.push({
      pubkey: a.pubkey,
      stakedSol: staked,
      state: deactivationRaw === DEACT_MAX ? "stake" : "deactivating",
      activationEpoch,
      deactivationEpoch: deactivationRaw === DEACT_MAX ? null : Number(deactivationRaw),
    });
  }
  accounts.sort((a, b) => b.stakedSol - a.stakedSol);
  return { totalStakedSol: total, voteIdentity, accounts };
}

async function fetchValidator(voteIdentity: string): Promise<ValidatorInfo | null> {
  if (!stakewizCache || Date.now() - stakewizCache.at > STAKEWIZ_TTL_MS) {
    try {
      const res = await fetch("https://api.stakewiz.com/validators", { cache: "no-store" });
      if (res.ok) stakewizCache = { data: await res.json(), at: Date.now() };
    } catch {
      // keep stale cache on failure
    }
  }
  const v = stakewizCache?.data?.find((x) => x.vote_identity === voteIdentity);
  if (!v) return null;
  return {
    voteIdentity,
    name: v.name ?? "Unknown validator",
    totalApy: v.total_apy ?? null,
    stakingApy: v.staking_apy ?? null,
    jitoApy: v.jito_apy ?? null,
    commission: v.commission ?? null,
    isJito: !!v.is_jito,
  };
}

// ---- SKR staking (Solana Mobile program) ----
async function fetchSkrStake(): Promise<{ staked: number } | null> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccounts",
        params: [
          SKR_STAKING_PROG,
          {
            encoding: "base64",
            filters: [{ memcmp: { offset: 41, bytes: WALLET } }],
          },
        ],
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw: { pubkey: string; account: { data: [string, string] } }[] = j?.result ?? [];
    if (!raw.length) return null;
    const data = Buffer.from(raw[0].account.data[0], "base64");
    // UserStake layout (bincode): disc(8) + guardian(32) + bump(1) + staker(32) + vote(32)
    // then fields: ... staked_amount u64 @153, unstake_timestamp i64 @161
    if (data.length < 169) return null;
    const stakedBase = Number(data.readBigUInt64LE(153));
    return { staked: stakedBase / 1e6 };
  } catch {
    return null;
  }
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

  const movers = priced.filter((h) => h.change24h != null && h.source !== "stable");
  const weightedChange24h =
    movers.length && totalUsd - stableValueUsd > 0
      ? movers.reduce((s, h) => s + h.valueUsd! * h.change24h!, 0) / (totalUsd - stableValueUsd)
      : null;

  // ---- staking ----
  let staking: StakingInfo | null = null;
  let stakingTotalUsd = 0;
  let unstakingUsd = 0;
  let totalWithStakingUsd = totalUsd;
  let totalWithUnstakingUsd = totalUsd;
  try {
    const { totalStakedSol, voteIdentity, accounts } = await fetchStakeAccounts();
    const solPrice = holdings.find((h) => h.mint === SOL_MINT)?.priceUsd ?? null;
    const totalStakedUsd = totalStakedSol * (solPrice ?? 0);
    let validator: ValidatorInfo | null = null;
    if (voteIdentity) {
      validator = await fetchValidator(voteIdentity);
      await sleep(delay);
    }
    const annualYieldUsd =
      validator?.totalApy != null && solPrice != null
        ? (totalStakedSol * validator.totalApy * solPrice) / 100
        : null;
    const skrHolding = holdings.find((h) => h.mint === SKR_MINT);
    const skrStake = await fetchSkrStake();
    const skrStaked = skrStake?.staked ?? 0;
    const positions: StakedPosition[] = [
      {
        symbol: "SOL",
        name: "Solana (native)",
        qty: totalStakedSol,
        usdTotal: totalStakedUsd,
        apy: validator?.totalApy ?? null,
      },
      {
        symbol: "SKR",
        name: "Seeker",
        qty: skrStaked,
        usdTotal: skrStaked * (skrHolding?.priceUsd ?? 0),
        apy: skrStaked > 0 ? SKR_APY_BASE : null,
        apyNote: "per Seeker staking",
        detail: `${SKR_UNSTAKING.toLocaleString()} unstaking (cooldown)`,
      },
    ];
    staking = {
      totalStakedSol,
      totalStakedUsd,
      annualYieldUsd,
      dailyYieldUsd: annualYieldUsd != null ? annualYieldUsd / 365 : null,
      positions,
      accounts,
      validator,
    };
    const skrPrice = skrHolding?.priceUsd ?? 0;
    stakingTotalUsd = positions.reduce((s, p) => s + p.usdTotal, 0);
    unstakingUsd = SKR_UNSTAKING * skrPrice;
    totalWithStakingUsd = totalUsd + stakingTotalUsd;
    totalWithUnstakingUsd = totalWithStakingUsd + unstakingUsd;
  } catch (e) {
    console.error("staking fetch failed:", e);
  }

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
    staking,
    stakingTotalUsd,
    unstakingUsd,
    totalWithStakingUsd,
    totalWithUnstakingUsd,
  };
  cache = { data, at: Date.now() };
  return data;
}
