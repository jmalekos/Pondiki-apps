// News aggregation: x.com via `bird` CLI (local Pi) with Google News RSS fallback (Vercel).
// Queries researched by sub-agent 2026-08-31 (see .openclaw/tmp/solana_alpha_keywords.md).
// No API keys. Cached in-process to respect rate limits.

import { execFile } from "child_process";
import { promisify } from "util";
const execFileP = promisify(execFile);

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  pubDate: string; // ISO
  handle?: string;
}

export interface NewsBundle {
  solana: NewsItem[];
  seeker: NewsItem[];
  alpha: NewsItem[];
  source: "x" | "rss";
  fetchedAt: number;
}

let cache: { at: number; data: NewsBundle } | null = null;
const TTL_MS = 10 * 60 * 1000;

// ---- x.com via bird CLI (local only) ----
const SCAM_FILTER = "-is:retweet -filter:replies -claim -giveaway -walletconnect -verify -connect_wallet";

const X_QUERIES = {
  solana: [
    `"Solana" alpha -is:retweet -filter:replies min_faves:20`,
    `"$SOL" price -is:retweet -filter:replies min_faves:30`,
    `"Solana" ecosystem news -is:retweet -filter:replies`,
    `"Solana" airdrop -is:retweet -is:quote -filter:replies`,
    `from:@solana OR from:@heliuslabs OR from:@JupiterExchange`,
    `"Solana" volume surge -is:retweet`,
  ],
  seeker: [
    `"Solana Seeker" staking -is:retweet -filter:replies`,
    `"SKR token" -is:retweet -filter:replies`,
    `"Solana Mobile" Seeker -is:retweet -filter:replies`,
    `"Solana Seeker" quest -is:retweet`,
    `"Solana Seeker" review -is:retweet`,
    `from:@solanamobile`,
  ],
  alpha: [
    `cbBTC -is:retweet ${SCAM_FILTER}`,
    `GEOD OR BIRB Solana -is:retweet ${SCAM_FILTER}`,
    `"Solana Seeker" OR "$SKR" ${SCAM_FILTER}`,
  ],
};

interface BirdTweet {
  id: string;
  author: { username: string; name: string };
  createdAt: string;
  text: string;
  likeCount: number;
  retweetCount: number;
}

async function xSearch(query: string, count: number): Promise<NewsItem[]> {
  try {
    // source ~/.bashrc for AUTH_TOKEN/CT0 (systemd service env is bare); query via env var avoids shell-quoting bugs
    const { stdout } = await execFileP(
      "bash",
      ["-lc", `source ~/.bashrc 2>/dev/null; bird search "$XQUERY" -n "$XCOUNT" --json`],
      {
        env: { ...process.env, XQUERY: query, XCOUNT: String(count) },
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    const tweets: BirdTweet[] = JSON.parse(stdout);
    return tweets
      .filter((t) => t.text && t.author?.username)
      .map((t) => ({
        title: t.text.replace(/https:\/\/t\.co\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 200),
        link: `https://x.com/${t.author.username}/status/${t.id}`,
        source: `@${t.author.username}`,
        handle: t.author.username,
        pubDate: new Date(t.createdAt).toISOString(),
      }));
  } catch {
    return [];
  }
}

// run async tasks with limited concurrency (X search API rate limits)
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchX(): Promise<{ solana: NewsItem[]; seeker: NewsItem[]; alpha: NewsItem[] } | null> {
  try {
    const [solRaw, skrRaw, alphaRaw] = await Promise.all([
      mapLimit(X_QUERIES.solana, 2, (q) => xSearch(q, 4)).then((r) => r.flat()),
      mapLimit(X_QUERIES.seeker, 2, (q) => xSearch(q, 4)).then((r) => r.flat()),
      mapLimit(X_QUERIES.alpha, 2, (q) => xSearch(q, 5)).then((r) => r.flat()),
    ]);
    const dedupe = (items: NewsItem[]) => {
      const seen = new Set<string>();
      return items.filter((i) => {
        const k = i.link;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };
    const sortNew = (items: NewsItem[]) =>
      items.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
    const solana = sortNew(dedupe(solRaw)).slice(0, 6);
    const seeker = sortNew(dedupe(skrRaw)).slice(0, 6);
    const alpha = sortNew(dedupe(alphaRaw)).slice(0, 6);
    // if everything came back empty (e.g. bird not installed), signal RSS fallback
    if (!solana.length && !seeker.length && !alpha.length) return null;
    return { solana, seeker, alpha };
  } catch {
    return null;
  }
}

// ---- Google News RSS fallback (Vercel / no bird) ----
function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseRss(xml: string, max: number): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) && items.length < max) {
    const block = m[1];
    const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "").trim();
    if (!title || !link) continue;
    const pubDateRaw = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "";
    const pubDate = pubDateRaw ? new Date(pubDateRaw).toISOString() : "";
    let source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "").trim();
    if (!source) {
      try {
        source = new URL(link).hostname.replace(/^www\./, "");
      } catch {
        source = "news";
      }
    }
    items.push({ title, link, source, pubDate });
  }
  return items;
}

async function fetchGoogleNews(query: string, max = 8): Promise<NewsItem[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; seeker-dashboard/1.0)" },
    });
    if (!res.ok) return [];
    return parseRss(await res.text(), max);
  } catch {
    return [];
  }
}

async function fetchRss() {
  const [solana, seeker, alphaRaw] = await Promise.all([
    fetchGoogleNews('Solana blockchain OR "SOL price"', 7),
    fetchGoogleNews('"Solana Seeker" OR "SKR token" OR "Solana Mobile"', 7),
    fetchGoogleNews('(cbBTC OR "Coinbase Wrapped BTC") OR (GEOD OR BIRB) OR ("Solana Seeker" OR SKR)', 10),
  ]);
  const alphaRe = /cbbtc|coinbase wrapped|geod|birb|seeker|skr|solana mobile/i;
  const alpha = alphaRaw.filter((i) => alphaRe.test(i.title));
  return {
    solana: solana.slice(0, 6),
    seeker: seeker.slice(0, 6),
    alpha: alpha.slice(0, 6),
  };
}

export async function getNews(force = false): Promise<NewsBundle> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  let source: "x" | "rss" = "x";
  let data = await fetchX();
  if (!data) {
    source = "rss";
    data = await fetchRss();
  }

  const bundle: NewsBundle = { ...data, source, fetchedAt: Date.now() };
  cache = { at: Date.now(), data: bundle };
  return bundle;
}
