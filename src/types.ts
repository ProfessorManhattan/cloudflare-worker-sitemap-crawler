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