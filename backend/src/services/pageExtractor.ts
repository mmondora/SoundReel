// backend/src/services/pageExtractor.ts

import { request } from 'undici';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Logger } from './debugLogger';
import { assertPublicHttpUrl } from './ssrfGuard';

export class PageFetchError extends Error {
  constructor(public readonly httpStatus: number | null, public readonly cause: string) {
    super(`Page fetch failed: ${cause} (status=${httpStatus ?? 'n/a'})`);
    this.name = 'PageFetchError';
  }
}

export class UnsupportedContentTypeError extends Error {
  constructor(public readonly contentType: string) {
    super(`Unsupported content type: ${contentType}`);
    this.name = 'UnsupportedContentTypeError';
  }
}

export interface PageRawLink {
  url: string;
  anchorText: string | null;
}

export interface PageExtractResult {
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  title: string | null;
  description: string | null;
  mainText: string | null;
  representativeImageUrl: string | null;
  rawLinks: PageRawLink[];
  siteName: string | null;
  lang: string | null;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5_000_000;          // 5 MB
const MAX_RAW_LINKS = 100;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SoundReelBot/2';

let log = new Logger('pageExtractor');
export function setLogger(logger: Logger): void {
  log = logger;
}

export async function extractPage(rawUrl: string): Promise<PageExtractResult> {
  const parsed = await assertPublicHttpUrl(rawUrl);

  log.info('Fetch pagina', { url: parsed.toString() });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await request(parsed.toString(), {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'it,en;q=0.8',
      },
      maxRedirections: 5,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new PageFetchError(null, `network:${(e as Error).message}`);
  }
  clearTimeout(timer);

  const httpStatus = res.statusCode;
  if (httpStatus < 200 || httpStatus >= 400) {
    throw new PageFetchError(httpStatus, `http_${httpStatus}`);
  }

  const contentType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('text/html') && !contentType.startsWith('application/xhtml')) {
    throw new UnsupportedContentTypeError(contentType || 'unknown');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_HTML_BYTES) {
      throw new PageFetchError(httpStatus, 'html_too_large');
    }
    chunks.push(buf);
  }
  const html = Buffer.concat(chunks).toString('utf8');
  const finalUrl = parsed.toString();

  const dom = new JSDOM(html, { url: finalUrl });
  const doc = dom.window.document;

  const meta = (sel: string): string | null => {
    const el = doc.querySelector(sel) as HTMLMetaElement | null;
    const v = el?.getAttribute('content') ?? null;
    return v && v.trim() ? v.trim() : null;
  };

  const title =
    meta('meta[property="og:title"]') ||
    meta('meta[name="twitter:title"]') ||
    (doc.querySelector('title')?.textContent?.trim() || null);

  const description =
    meta('meta[property="og:description"]') ||
    meta('meta[name="twitter:description"]') ||
    meta('meta[name="description"]');

  const siteName = meta('meta[property="og:site_name"]') || dom.window.location.hostname || null;
  const lang = doc.documentElement.getAttribute('lang') || null;

  const representativeImageUrl = pickRepresentativeImage(doc, finalUrl);
  const rawLinks = scrapeLinks(doc, finalUrl);

  let mainText: string | null = null;
  try {
    const reader = new Readability(doc.cloneNode(true) as Document);
    const article = reader.parse();
    mainText = article?.textContent?.trim() || null;
    if (mainText && mainText.length < 50) mainText = null;
  } catch (e) {
    log.warn('Readability fail', { error: String(e) });
    mainText = null;
  }

  return {
    finalUrl,
    httpStatus,
    contentType,
    title,
    description,
    mainText,
    representativeImageUrl,
    rawLinks,
    siteName,
    lang,
  };
}

function abs(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function pickRepresentativeImage(doc: Document, baseUrl: string): string | null {
  const og =
    doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
    doc.querySelector('meta[name="twitter:image:src"]')?.getAttribute('content');
  if (og) {
    const a = abs(og, baseUrl);
    if (a) return a;
  }

  const iconCandidates: Array<{ size: number; url: string }> = [];
  doc
    .querySelectorAll<HTMLLinkElement>(
      'link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="icon"]',
    )
    .forEach((el) => {
      const href = el.getAttribute('href');
      if (!href) return;
      const a = abs(href, baseUrl);
      if (!a) return;
      const sizesAttr = el.getAttribute('sizes') || '';
      const m = sizesAttr.match(/(\d+)x(\d+)/);
      const size = m ? Number(m[1]) : 0;
      iconCandidates.push({ size, url: a });
    });
  if (iconCandidates.length > 0) {
    iconCandidates.sort((x, y) => y.size - x.size);
    if (iconCandidates[0].size >= 144) return iconCandidates[0].url;
  }

  const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>('img'));
  for (const img of imgs) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    if (!src) continue;
    const w = Number(img.getAttribute('width') || '0');
    const h = Number(img.getAttribute('height') || '0');
    if (w >= 200 && h >= 200) {
      const a = abs(src, baseUrl);
      if (a) return a;
    }
  }
  for (const img of imgs) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    if (!src) continue;
    const a = abs(src, baseUrl);
    if (a) return a;
  }
  if (iconCandidates.length > 0) return iconCandidates[0].url;
  return null;
}

function scrapeLinks(doc: Document, baseUrl: string): PageRawLink[] {
  const baseHost = new URL(baseUrl).hostname;
  const seen = new Set<string>();
  const out: PageRawLink[] = [];

  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));
  for (const a of anchors) {
    if (out.length >= MAX_RAW_LINKS) break;

    const rawHref = a.getAttribute('href') || '';
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) continue;
    if (rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) continue;

    const absUrl = abs(rawHref, baseUrl);
    if (!absUrl) continue;
    if (!absUrl.startsWith('http://') && !absUrl.startsWith('https://')) continue;

    const u = new URL(absUrl);
    const sameHost = u.hostname === baseHost;
    if (sameHost && isInChromeBlock(a)) continue;

    if (seen.has(absUrl)) continue;
    seen.add(absUrl);

    const anchorText = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200) || null;
    out.push({ url: absUrl, anchorText });
  }

  return out;
}

function isInChromeBlock(el: Element): boolean {
  let cur: Element | null = el;
  while (cur && cur !== cur.ownerDocument?.body) {
    const tag = cur.tagName.toLowerCase();
    if (tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'aside') return true;
    cur = cur.parentElement;
  }
  return false;
}
