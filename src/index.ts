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