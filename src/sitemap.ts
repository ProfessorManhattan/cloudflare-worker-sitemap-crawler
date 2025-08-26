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