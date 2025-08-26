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