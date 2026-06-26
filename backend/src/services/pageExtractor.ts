// backend/src/services/pageExtractor.ts

import { request } from 'undici';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Logger } from './debugLogger';
import { assertPublicHttpUrl } from './ssrfGuard';
import type { Browser } from 'playwright-core';

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
// Playwright fallback triggers when Readability returns fewer chars than this
const PW_TEXT_THRESHOLD = 300;

let log = new Logger('pageExtractor');
export function setLogger(logger: Logger): void {
  log = logger;
}

// ── Playwright singleton ────────────────────────────────────────────────────

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser | null> {
  if (process.env.PLAYWRIGHT_ENABLED === 'false') return null;
  if (_browser?.isConnected()) return _browser;
  try {
    const { chromium } = await import('playwright-core');
    _browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--mute-audio',
      ],
    });
    _browser.on('disconnected', () => { _browser = null; });
    log.info('Playwright browser avviato');
    return _browser;
  } catch (e) {
    log.warn('Playwright launch fallito (Chromium non disponibile?)', { error: String(e) });
    return null;
  }
}

async function fetchHtmlWithPlaywright(url: string): Promise<string | null> {
  const browser = await getBrowser();
  if (!browser) return null;
  let page;
  try {
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'it,en;q=0.8', 'User-Agent': USER_AGENT });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    // Give JS a moment to render content
    await page.waitForTimeout(1_500);
    return await page.content();
  } catch (e) {
    log.warn('Playwright page fetch fallito', { url, error: String(e) });
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}

function isRedditUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h === 'reddit.com' || h === 'old.reddit.com' || h === 'redd.it';
  } catch { return false; }
}

async function resolveRedirectUrl(rawUrl: string): Promise<string> {
  // Use global fetch (Node 18+) — exposes response.url (final URL after redirects)
  const res = await fetch(rawUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  await res.body?.cancel(); // drain without reading
  return res.url || rawUrl;
}

async function extractRedditRss(rawUrl: string): Promise<PageExtractResult | null> {
  try {
    await assertPublicHttpUrl(rawUrl);

    // Short Reddit share links (/s/xxx) redirect to the canonical post URL.
    // Follow the redirect first so we can build the correct .rss URL.
    const canonical = await resolveRedirectUrl(rawUrl).catch(() => rawUrl);
    const base = canonical.split('?')[0].replace(/\/$/, '');
    const rssUrl = `${base}.rss`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(rssUrl, {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'application/atom+xml,text/xml,*/*' },
        maxRedirections: 3,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.statusCode < 200 || res.statusCode >= 400) {
      for await (const _ of res.body) { void _; }
      return null;
    }

    const xml = await res.body.text();
    const xmlDom = new JSDOM(xml, { contentType: 'application/xml' });
    const doc = xmlDom.window.document;

    const entries = Array.from(doc.querySelectorAll('entry'));
    if (!entries.length) return null;

    const postEntry = entries[0];
    const title = postEntry.querySelector('title')?.textContent?.trim() ?? null;
    const postAuthor = postEntry.querySelector('author name')?.textContent?.trim() ?? '';
    const thumbnailEl = postEntry.querySelector('thumbnail');
    const thumbnail = thumbnailEl?.getAttribute('url') ?? null;
    const postContentHtml = postEntry.querySelector('content')?.textContent ?? '';
    const postText = new JSDOM(postContentHtml).window.document.body.textContent?.trim() ?? '';

    const comments: string[] = [];
    for (const entry of entries.slice(1, 16)) {
      const html = entry.querySelector('content')?.textContent ?? '';
      const text = new JSDOM(html).window.document.body.textContent?.trim() ?? '';
      if (text && !text.includes('[deleted]') && !text.includes('[removed]')) comments.push(text);
    }

    const subreddit = doc.querySelector('category')?.getAttribute('label') ?? '';
    const postLink = postEntry.querySelector('link')?.getAttribute('href') ?? base;

    const parts = [
      title ? `# ${title}` : '',
      [subreddit ? `r/${subreddit}` : '', postAuthor].filter(Boolean).join(' | '),
      postText,
      comments.length ? `## Comments\n${comments.join('\n\n')}` : '',
    ].filter(Boolean);

    log.info('Reddit RSS estratto', { title, postTextChars: postText.length, comments: comments.length });

    return {
      finalUrl: postLink,
      httpStatus: res.statusCode,
      contentType: 'application/atom+xml',
      title,
      description: postText.slice(0, 300) || null,
      mainText: parts.join('\n\n') || null,
      representativeImageUrl: thumbnail,
      rawLinks: [],
      siteName: 'Reddit',
      lang: null,
    };
  } catch (e) {
    log.warn('Reddit RSS fallito', { error: String(e) });
    return null;
  }
}

export async function extractPage(rawUrl: string): Promise<PageExtractResult> {
  // Reddit: use RSS feed for structured content (JSON API is blocked)
  if (isRedditUrl(rawUrl)) {
    const redditResult = await extractRedditRss(rawUrl);
    if (redditResult) return redditResult;
    log.warn('Reddit RSS fallback a HTML', { url: rawUrl });
  }

  const parsed = await assertPublicHttpUrl(rawUrl);

  log.info('Fetch pagina', { url: parsed.toString() });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  let httpStatusCode: number;
  let contentTypeHeader: string;
  try {
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
      throw new PageFetchError(null, `network:${e instanceof Error ? e.message : String(e)}`);
    }

    httpStatusCode = res.statusCode;
    if (httpStatusCode < 200 || httpStatusCode >= 400) {
      // Drain so the connection is released.
      try { for await (const _ of res.body) { void _; } } catch { /* ignore */ }
      throw new PageFetchError(httpStatusCode, `http_${httpStatusCode}`);
    }

    contentTypeHeader = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!contentTypeHeader.startsWith('text/html') && !contentTypeHeader.startsWith('application/xhtml')) {
      try { for await (const _ of res.body) { void _; } } catch { /* ignore */ }
      throw new UnsupportedContentTypeError(contentTypeHeader || 'unknown');
    }

    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        const buf = chunk as Buffer;
        total += buf.length;
        if (total > MAX_HTML_BYTES) {
          ctrl.abort();
          throw new PageFetchError(httpStatusCode, 'html_too_large');
        }
        chunks.push(buf);
      }
    } catch (e) {
      if (e instanceof PageFetchError) throw e;
      if (ctrl.signal.aborted) {
        throw new PageFetchError(httpStatusCode, 'timeout');
      }
      throw new PageFetchError(httpStatusCode, `body_read:${e instanceof Error ? e.message : String(e)}`);
    }
    html = Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
  const finalUrl = parsed.toString();

  const dom = new JSDOM(html, { url: finalUrl });
  const doc = dom.window.document;

  const meta = (sel: string): string | null => {
    const el = doc.querySelector(sel) as HTMLMetaElement | null;
    const v = el?.getAttribute('content') ?? null;
    return v && v.trim() ? v.trim() : null;
  };

  let title: string | null =
    meta('meta[property="og:title"]') ||
    meta('meta[name="twitter:title"]') ||
    (doc.querySelector('title')?.textContent?.trim() || null);

  let description: string | null =
    meta('meta[property="og:description"]') ||
    meta('meta[name="twitter:description"]') ||
    meta('meta[name="description"]') || null;

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

  // ── Playwright fallback: JS-rendered pages (Twitter, LinkedIn, etc.) ──────
  if (!mainText || mainText.length < PW_TEXT_THRESHOLD) {
    log.info('Contenuto scarso, provo Playwright', { chars: mainText?.length ?? 0 });
    const pwHtml = await fetchHtmlWithPlaywright(finalUrl);
    if (pwHtml) {
      try {
        const pwDom = new JSDOM(pwHtml, { url: finalUrl });
        const pwDoc = pwDom.window.document;

        // Re-run Readability on rendered HTML
        const pwReader = new Readability(pwDoc.cloneNode(true) as Document);
        const pwArticle = pwReader.parse();
        const pwText = pwArticle?.textContent?.trim() || null;

        if (pwText && pwText.length > (mainText?.length ?? 0)) {
          mainText = pwText;
          log.info('Playwright migliorato contenuto', { chars: pwText.length });
        }

        // Fill missing metadata from rendered DOM
        const pwMeta = (sel: string): string | null => {
          const el = pwDoc.querySelector(sel) as HTMLMetaElement | null;
          const v = el?.getAttribute('content') ?? null;
          return v?.trim() || null;
        };
        if (!title) {
          title = pwMeta('meta[property="og:title"]') ||
                  pwMeta('meta[name="twitter:title"]') ||
                  pwDoc.querySelector('title')?.textContent?.trim() || null;
        }
        if (!description) {
          description = pwMeta('meta[property="og:description"]') ||
                        pwMeta('meta[name="twitter:description"]') ||
                        pwMeta('meta[name="description"]') || null;
        }
      } catch (e) {
        log.warn('Playwright HTML parse fallito', { error: String(e) });
      }
    }
  }

  return {
    finalUrl,
    httpStatus: httpStatusCode,
    contentType: contentTypeHeader,
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
