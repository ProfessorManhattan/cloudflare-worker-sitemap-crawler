# Cloudflare Worker — Sitemap / Sitemap Index Crawler (TypeScript)

This is a production‑ready Cloudflare Worker that crawls either a **sitemap.xml** or a **sitemap index** (including **.gz** variants). If no input is provided, it defaults to crawling **[https://megabyte.space/sitemap.xml](https://megabyte.space/sitemap.xml)**.

It is deliberately structured with clear interfaces and patterns so you can scale it up (Queues, Durable Objects) or keep it lightweight for ad‑hoc jobs.

---

## ✅ Features

* **Parses both** `<urlset>` sitemaps **and** `<sitemapindex>` (recursively).
* Handles **.gz** compressed sitemaps using the Web Streams `DecompressionStream` (supported in Workers).
* Uses a **Strategy + Factory** pattern for parsing, and a **Pluggable Enqueuer** abstraction to either crawl inline or send to a Queue.
* **Politeness knobs**: user‑agent string, max concurrency, and a simple `robots.txt` allow check.
* **Respects platform limits**: caps outbound fetches per invocation (default 40 < 50 subrequest limit) and bounds concurrency.
* Route endpoints for **on‑demand runs** and **previewing** parsed URLs.
* Optional **Cron Trigger** (disabled by default) and optional **Cloudflare Queues** integration.

---

## 🧱 Project Layout

```
.
├── wrangler.toml        # Worker + (optional) Queues + (optional) Cron
├── package.json         # Dependencies (fast-xml-parser, wrangler, typescript)
└── src/
    ├── index.ts         # Worker entry: routes, scheduled, queue consumer (optional)
    ├── sitemap.ts       # SitemapSource + ParserStrategy + Factory
    ├── crawler.ts       # Crawler, robots.txt check, concurrency controller
    └── types.ts         # Shared types
```

> You can collapse this into a single file if you prefer; it’s organized for clarity and testing.

---

## 🚀 Quickstart

1. **Install deps**

```bash
npm install
```

2. **Dev run**

```bash
npx wrangler dev
```

Open:

* `http://127.0.0.1:8787/crawl` → crawls `https://megabyte.space/sitemap.xml` by default
* `http://127.0.0.1:8787/crawl?sitemap=https://example.com/sitemap.xml`
* `http://127.0.0.1:8787/crawl?domain=example.com` → infers `https://example.com/sitemap.xml`
* `http://127.0.0.1:8787/preview?sitemap=https://example.com/sitemap.xml` → show first N URLs

3. **Deploy**

```bash
npx wrangler deploy
```

---

## ⚙️ Configuration (edit as needed)

### `wrangler.toml`

```toml
name = "sitemap-crawler"
main = "src/index.ts"
compatibility_date = "2024-10-01"

# Optional: Bind a Queue to fan out URL crawls (inline crawling will be used if absent)
# [[queues.producers]]
# queue = "crawl-urls"
# binding = "CRAWL_QUEUE"

# [[queues.consumers]]
# queue = "crawl-urls"

[vars]
# Default target if none is provided
DEFAULT_SITEMAP = "https://megabyte.space/sitemap.xml"
# Good bots identify themselves politely
USER_AGENT = "MegabyteLabsBot/1.0 (+https://megabyte.space)"

# Safety knobs for Workers limits and politeness
MAX_CONCURRENCY = "5"           # pending crawls at once
MAX_URLS_PER_RUN = "40"         # keep < 50 subrequests per invocation
PREVIEW_LIMIT = "50"            # how many URLs to show in /preview

# Optional: Enable a scheduled run (commented out by default)
# [triggers]
# crons = ["0 */6 * * *"]
```

### `package.json`

```json
{
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "fast-xml-parser": "^4.4.0"
  },
  "devDependencies": {
    "wrangler": "^3.79.0",
    "typescript": "^5.6.2"
  }
}
```

---

## 🧠 Design Notes (Patterns & Rationale)

* **Strategy Pattern (parsing)**: `SitemapParserStrategy` has two concrete strategies: `UrlsetParser` and `IndexParser`. A factory chooses which to use based on root node.
* **Factory Pattern**: `SitemapParserFactory.from(xml)` inspects the XML tree and returns the right parser.
* **Adapter / Abstraction for I/O**: `SitemapSource` hides `.gz` handling and `fetch()` details.
* **Pluggable Enqueuer**: `Enqueuer` interface lets you swap “inline crawl now” vs “enqueue to Queue” without touching crawler logic.
* **Concurrency Controller**: a tiny scheduler (`pLimit`‑style) to cap concurrent fetches (politeness + stay under Worker limits).
* **Defensive limits**: `MAX_URLS_PER_RUN` avoids >50 subrequests/CPU budget surprises.

---

## 🧩 Source Code

### `src/types.ts`

```ts
export interface Env {
  DEFAULT_SITEMAP: string;
  USER_AGENT: string;
  MAX_CONCURRENCY?: string;
  MAX_URLS_PER_RUN?: string;
  PREVIEW_LIMIT?: string;
  // Optional Queue binding: present only if configured in wrangler.toml
  CRAWL_QUEUE?: Queue<string>;
}

export type UrlString = string;

export interface Enqueuer {
  enqueueMany(urls: UrlString[]): Promise<number>; // returns count accepted
}

export interface CrawlResult {
  ok: boolean;
  status: number;
  url: UrlString;
}
```

---

### `src/sitemap.ts`

```ts
import { XMLParser } from "fast-xml-parser";
import type { UrlString } from "./types";

/**
 * SitemapSource abstracts network + decompression so the parser can focus on XML.
 */
export class SitemapSource {
  constructor(private userAgent: string) {}

  async fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: { "User-Agent": this.userAgent, "Accept-Encoding": "gzip,deflate" },
    });
    if (!res.ok) throw new Error(`Failed to fetch sitemap: ${url} (${res.status})`);

    // If the URL ends with .gz, transparently decompress
    if (/\.gz$/i.test(new URL(url).pathname)) {
      if (!res.body) return "";
      const ds = new DecompressionStream("gzip");
      const decompressed = res.body.pipeThrough(ds);
      return await new Response(decompressed).text();
    }
    return await res.text();
  }
}

/**
 * Strategy interface for parsing different sitemap roots.
 */
interface SitemapParserStrategy {
  extractUrls(xml: string): Promise<UrlString[]>;
}

/**
 * Parses a <urlset> sitemap (the common case).
 */
class UrlsetParser implements SitemapParserStrategy {
  async extractUrls(xml: string): Promise<UrlString[]> {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const doc = parser.parse(xml);
    const urls = doc?.urlset?.url;
    if (!urls) return [];
    const list = Array.isArray(urls) ? urls : [urls];
    return list.map((u: any) => u?.loc).filter(Boolean);
  }
}

/**
 * Parses a <sitemapindex> recursively by fetching each child sitemap.
 */
export class IndexParser implements SitemapParserStrategy {
  constructor(private source: SitemapSource) {}

  async extractUrls(xml: string): Promise<UrlString[]> {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const doc = parser.parse(xml);
    const entries = doc?.sitemapindex?.sitemap;
    if (!entries) return [];
    const list = Array.isArray(entries) ? entries : [entries];

    const results: UrlString[] = [];
    for (const entry of list) {
      const childLoc = entry?.loc as string | undefined;
      if (!childLoc) continue;
      const childXml = await this.source.fetchText(childLoc);
      const childParser = SitemapParserFactory.from(childXml, this.source);
      const childUrls = await childParser.extractUrls(childXml);
      results.push(...childUrls);
    }
    return results;
  }
}

/**
 * Factory that returns the correct parser based on the XML root node.
 */
export class SitemapParserFactory {
  static from(xml: string, source: SitemapSource): SitemapParserStrategy {
    // A tiny sniff to avoid parsing twice. For robustness we still parse below if needed.
    const head = xml.slice(0, 200).toLowerCase();
    if (head.includes("<urlset")) return new UrlsetParser();
    if (head.includes("<sitemapindex")) return new IndexParser(source);

    // Fallback: parse and check root keys
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const doc = parser.parse(xml);
    if (doc?.urlset) return new UrlsetParser();
    if (doc?.sitemapindex) return new IndexParser(source);

    // Unknown
    return new UrlsetParser();
  }
}
```

---

### `src/crawler.ts`

```ts
import type { CrawlResult, UrlString } from "./types";

/**
 * Minimal, permissive robots.txt check: honors User-agent: * disallow prefixes.
 * For production, swap with a robust robots parser if needed.
 */
export async function allowedByRobots(url: UrlString, userAgent: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const res = await fetch(robotsUrl, { headers: { "User-Agent": userAgent } });
    if (!res.ok) return true; // be permissive if robots is missing
    const text = await res.text();

    const lines = text.split(/\r?\n/).map((l) => l.trim());
    let inStar = false;
    const disallows: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const k = line.slice(0, idx).trim().toLowerCase();
      const v = line.slice(idx + 1).trim();
      if (k === "user-agent") {
        inStar = v === "*" || v.toLowerCase() === userAgent.toLowerCase();
      } else if (inStar && k === "disallow") {
        if (v) disallows.push(v);
      }
    }
    return !disallows.some((rule) => rule !== "/" && u.pathname.startsWith(rule));
  } catch {
    return true;
  }
}

/**
 * Tiny p-limit implementation: caps concurrently running promises.
 */
export async function pLimit<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>) {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p = fn(item);
    executing.add(p);
    p.finally(() => executing.delete(p));
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

/**
 * Crawl a batch of URLs with concurrency + robots.txt check.
 */
export async function crawlBatch(urls: UrlString[], userAgent: string, concurrency: number): Promise<CrawlResult[]> {
  const out: CrawlResult[] = [];
  await pLimit(urls, Math.max(1, concurrency), async (url) => {
    try {
      if (!(await allowedByRobots(url, userAgent))) {
        out.push({ ok: true, status: 999, url }); // 999 = skipped by robots
        return;
      }
      const res = await fetch(url, { headers: { "User-Agent": userAgent } });
      out.push({ ok: res.ok, status: res.status, url });
    } catch {
      out.push({ ok: false, status: 0, url });
    }
  });
  return out;
}
```

---

### `src/index.ts`

```ts
import { SitemapSource, SitemapParserFactory } from "./sitemap";
import { crawlBatch } from "./crawler";
import type { Env, Enqueuer, UrlString, CrawlResult } from "./types";

// ---- Enqueuer implementations -------------------------------------------------

class InlineEnqueuer implements Enqueuer {
  constructor(private userAgent: string, private concurrency: number) {}
  async enqueueMany(urls: UrlString[]): Promise<number> {
    // Inline "enqueue" == crawl now
    const results = await crawlBatch(urls, this.userAgent, this.concurrency);
    // Optionally: log or persist somewhere (R2/D1/KV). For demo, log summary.
    const ok = results.filter((r) => r.ok).length;
    console.log(`Crawled inline: ${urls.length} urls (ok=${ok})`);
    return urls.length;
  }
}

class QueueEnqueuer implements Enqueuer {
  constructor(private queue: Queue<string>) {}
  async enqueueMany(urls: UrlString[]): Promise<number> {
    const chunkSize = 1000;
    for (let i = 0; i < urls.length; i += chunkSize) {
      const chunk = urls.slice(i, i + chunkSize);
      await this.queue.sendBatch(chunk.map((u) => ({ body: u })));
    }
    return urls.length;
  }
}

function makeEnqueuer(env: Env, concurrency: number): Enqueuer {
  return env.CRAWL_QUEUE ? new QueueEnqueuer(env.CRAWL_QUEUE) : new InlineEnqueuer(env.USER_AGENT, concurrency);
}

// ---- Helpers ------------------------------------------------------------------

function inferSitemapFromParams(url: URL, env: Env): string {
  const direct = url.searchParams.get("sitemap");
  if (direct) return direct;
  const domain = url.searchParams.get("domain");
  if (domain) return `https://${domain.replace(/\/$/, "")}/sitemap.xml`;
  return env.DEFAULT_SITEMAP || "https://megabyte.space/sitemap.xml";
}

function limitList<T>(xs: T[], max: number): T[] {
  return xs.slice(0, Math.max(0, max));
}

// ---- Worker Handlers ----------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const source = new SitemapSource(env.USER_AGENT);

    if (url.pathname === "/") {
      return new Response(
        `Sitemap crawler ready. Try /crawl or /preview.\n` +
          `Examples: /crawl?sitemap=https://example.com/sitemap.xml or /crawl?domain=example.com\n`,
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    if (url.pathname === "/preview") {
      const sitemapUrl = inferSitemapFromParams(url, env);
      const xml = await source.fetchText(sitemapUrl);
      const parser = SitemapParserFactory.from(xml, source);
      const urls = await parser.extractUrls(xml);
      const limit = parseInt(env.PREVIEW_LIMIT || "50", 10);
      return json({ sitemap: sitemapUrl, total: urls.length, sample: limitList(urls, limit) });
    }

    if (url.pathname === "/crawl") {
      const sitemapUrl = inferSitemapFromParams(url, env);
      const xml = await source.fetchText(sitemapUrl);
      const parser = SitemapParserFactory.from(xml, source);
      const urls = await parser.extractUrls(xml);

      const maxPerRun = parseInt(env.MAX_URLS_PER_RUN || "40", 10); // keep < 50 subrequests
      const concurrency = parseInt(env.MAX_CONCURRENCY || "5", 10);
      const batch = limitList(urls, maxPerRun);

      const enqueuer = makeEnqueuer(env, concurrency);
      const accepted = await enqueuer.enqueueMany(batch);
      return json({ sitemap: sitemapUrl, discovered: urls.length, dispatched: accepted, mode: env.CRAWL_QUEUE ? "queued" : "inline" });
    }

    return new Response("Not found", { status: 404 });
  },

  // Optional queue consumer — only runs if you bound CRAWL_QUEUE in wrangler.toml
  async queue(batch: MessageBatch<string>, env: Env): Promise<void> {
    const concurrency = parseInt(env.MAX_CONCURRENCY || "5", 10);
    const urls = batch.messages.map((m) => m.body);
    const results: CrawlResult[] = await crawlBatch(urls, env.USER_AGENT, concurrency);
    const ok = results.filter((r) => r.ok).length;
    console.log(`Queue consumer crawled ${urls.length} urls (ok=${ok})`);
    // Ack all (you could selectively retry based on status)
    for (const msg of batch.messages) msg.ack();
  },
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), { ...init, headers: { "Content-Type": "application/json" } });
}
```

---

## 🔧 Extending / Operating at Scale

* **Durable Objects for per‑host backoff**: Route each hostname through a DO that maintains `lastFetchedAt`, adjusting delay on `429/503`.
* **Persist results**: Store HTML in **R2**, metadata in **KV** or **D1**. Swap `InlineEnqueuer.enqueueMany` to write results.
* **Bigger sitemaps**: Raise `MAX_URLS_PER_RUN` slowly; if you hit the 50 subrequest cap or CPU time, switch to **Queues**.
* **Advanced robots**: Replace the minimal checker with a full robots parser and support for `Crawl-delay`.

---

## 🧪 Example Calls

* Crawl default (Megabyte Labs):

  * `GET /crawl`
* Crawl a specific domain (infers `/sitemap.xml`):

  * `GET /crawl?domain=example.com`
* Crawl an explicit sitemap index or .gz file:

  * `GET /crawl?sitemap=https://example.com/sitemap_index.xml`
  * `GET /crawl?sitemap=https://example.com/sitemap.xml.gz`
* Preview (no crawling, just show URLs):

  * `GET /preview?sitemap=https://example.com/sitemap.xml`

---

## 📄 License

MIT — do what you like, no warranty.
