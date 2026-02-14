import { Logger } from './debugLogger';
import type { ExtractedContent } from '../types';

// Logger instance - will be replaced per-request if passed
let log = new Logger('contentExtractor');

// Allow setting the logger from the caller to ensure proper entryId tracking
export function setLogger(logger: Logger): void {
  log = logger;
}

const COBALT_API_URL = 'https://api.cobalt.tools/';

/**
 * Decode HTML entities in text (e.g., &quot; -> ", &#x1f3a7; -> 🎧)
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return _;
      }
    });
}

/**
 * Truncate string for logging
 */
function truncate(str: string, maxLen: number = 2000): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + `... [truncated, total ${str.length} chars]`;
}

/**
 * Extract relevant headers from response for logging
 */
function extractHeaders(headers: Headers): Record<string, string> {
  const relevant = ['content-type', 'location', 'set-cookie', 'x-ig-set-www-claim', 'x-robots-tag'];
  const result: Record<string, string> = {};
  relevant.forEach(key => {
    const value = headers.get(key);
    if (value) result[key] = value;
  });
  return result;
}

interface CobaltResponse {
  status: string;
  url?: string;
  audio?: string;
  error?: string;
  text?: string;
}

interface OEmbedResponse {
  version?: string;
  title?: string;
  description?: string;
  author_name?: string;
  author_url?: string;
  provider_name?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  html?: string;
  width?: number;
  height?: number;
}

/**
 * Try oEmbed API for metadata (works with multiple platforms)
 */
async function extractWithOEmbed(url: string, oEmbedEndpoint: string, platformName: string, cookies?: InstagramCookies): Promise<{
  caption: string | null;
  thumbnailUrl: string | null;
  authorName: string | null;
  success: boolean;
}> {
  const startTime = Date.now();
  const requestUrl = `${oEmbedEndpoint}?url=${encodeURIComponent(url)}&format=json&omitscript=true`;
  const requestHeaders: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  };

  if (cookies) {
    requestHeaders['Cookie'] = `sessionid=${cookies.sessionId}; csrftoken=${cookies.csrfToken}; ds_user_id=${cookies.dsUserId}`;
    log.info('oEmbed con cookie Instagram', { hasCookies: true });
  }

  log.debug(`Tentativo oEmbed ${platformName}`, {
    requestUrl,
    headers: requestHeaders
  });

  try {
    log.debug('Eseguendo fetch oEmbed...');
    let response;
    try {
      response = await fetch(requestUrl, {
        headers: requestHeaders
      });
    } catch (fetchError) {
      log.error('oEmbed fetch error (network/DNS)', fetchError instanceof Error ? fetchError : new Error(String(fetchError)), {
        errorType: typeof fetchError,
        errorMessage: String(fetchError)
      });
      throw fetchError;
    }

    log.debug('oEmbed fetch completato, leggendo body...');
    const durationMs = Date.now() - startTime;
    const responseHeaders = extractHeaders(response.headers);

    let bodyText;
    try {
      bodyText = await response.text();
    } catch (bodyError) {
      log.error('oEmbed errore lettura body', bodyError instanceof Error ? bodyError : new Error(String(bodyError)));
      throw bodyError;
    }

    log.debug(`oEmbed ${platformName} risposta`, {
      status: response.status,
      statusText: response.statusText,
      durationMs,
      responseHeaders,
      bodyPreview: truncate(bodyText)
    });

    if (!response.ok) {
      log.warn(`oEmbed ${platformName} fallito - status non ok`, {
        status: response.status,
        reason: response.status === 400 ? 'URL non valido o contenuto privato' :
                response.status === 404 ? 'Contenuto non trovato' :
                response.status === 429 ? 'Rate limit raggiunto' :
                response.status === 401 ? 'Autenticazione richiesta' :
                'Errore sconosciuto'
      });
      return { caption: null, thumbnailUrl: null, authorName: null, success: false };
    }

    let data: OEmbedResponse;
    try {
      data = JSON.parse(bodyText);
    } catch (parseError) {
      log.warn(`oEmbed ${platformName} risposta non è JSON valido`, {
        bodyPreview: truncate(bodyText, 500)
      });
      return { caption: null, thumbnailUrl: null, authorName: null, success: false };
    }

    // Try multiple fields for caption (different platforms use different fields)
    const caption = decodeHtmlEntities(
      data.title || data.description || ''
    ) || null;
    const thumbnailUrl = data.thumbnail_url || null;
    const authorName = data.author_name || null;

    log.info(`oEmbed ${platformName} estrazione riuscita`, {
      hasCaption: !!caption,
      captionPreview: caption ? truncate(caption, 100) : null,
      hasThumbnail: !!thumbnailUrl,
      authorName,
      providerName: data.provider_name
    });

    return { caption, thumbnailUrl, authorName, success: true };

  } catch (error) {
    const durationMs = Date.now() - startTime;
    log.error(`oEmbed ${platformName} errore di rete`, error instanceof Error ? error : new Error(String(error)), {
      requestUrl,
      durationMs
    });
    return { caption: null, thumbnailUrl: null, authorName: null, success: false };
  }
}

/**
 * Try Cobalt.tools API for audio extraction
 */
async function extractWithCobalt(url: string): Promise<{
  audioUrl: string | null;
  success: boolean;
}> {
  const startTime = Date.now();
  const requestHeaders = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  const payload = {
    url,
    aFormat: 'mp3',
    isAudioOnly: true
  };

  log.debug('Tentativo cobalt.tools per audio', {
    requestUrl: COBALT_API_URL,
    headers: requestHeaders,
    payload
  });

  try {
    const response = await fetch(COBALT_API_URL, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(payload)
    });

    const durationMs = Date.now() - startTime;
    const responseHeaders = extractHeaders(response.headers);
    const bodyText = await response.text();

    log.debug('cobalt.tools risposta HTTP', {
      status: response.status,
      statusText: response.statusText,
      durationMs,
      responseHeaders,
      bodyPreview: truncate(bodyText)
    });

    if (!response.ok) {
      log.warn('cobalt.tools HTTP error', {
        status: response.status,
        reason: response.status === 400 ? 'Richiesta non valida' :
                response.status === 429 ? 'Rate limit raggiunto' :
                response.status === 500 ? 'Errore interno Cobalt' :
                response.status === 503 ? 'Servizio non disponibile' :
                'Errore HTTP sconosciuto',
        bodyPreview: truncate(bodyText, 500)
      });
      return { audioUrl: null, success: false };
    }

    let data: CobaltResponse;
    try {
      data = JSON.parse(bodyText);
    } catch (parseError) {
      log.warn('cobalt.tools risposta non è JSON valido', {
        bodyPreview: truncate(bodyText, 500)
      });
      return { audioUrl: null, success: false };
    }

    log.debug('cobalt.tools risposta parsed', {
      status: data.status,
      hasUrl: !!data.url,
      hasAudio: !!data.audio,
      error: data.error,
      text: data.text
    });

    if (data.status === 'success' || data.status === 'stream' || data.status === 'redirect') {
      const audioUrl = data.url || data.audio || null;

      if (audioUrl) {
        log.info('cobalt.tools estrazione audio riuscita', {
          audioUrlPreview: truncate(audioUrl, 200),
          durationMs
        });
        return { audioUrl, success: true };
      } else {
        log.warn('cobalt.tools status success ma nessun URL audio', {
          responseData: data
        });
        return { audioUrl: null, success: false };
      }
    }

    // Handle specific Cobalt error statuses
    const errorReason =
      data.status === 'error' ? (data.text || data.error || 'Errore generico Cobalt') :
      data.status === 'rate-limit' ? 'Rate limit Cobalt raggiunto' :
      data.status === 'picker' ? 'Cobalt richiede selezione manuale (picker)' :
      `Status Cobalt non gestito: ${data.status}`;

    log.warn('cobalt.tools fallito', {
      status: data.status,
      reason: errorReason,
      errorText: data.text,
      errorField: data.error,
      instagramNote: url.includes('instagram') ?
        'Instagram spesso richiede autenticazione o blocca scraping automatico' : undefined
    });

    return { audioUrl: null, success: false };

  } catch (error) {
    const durationMs = Date.now() - startTime;
    log.error('cobalt.tools errore di rete', error instanceof Error ? error : new Error(String(error)), {
      requestUrl: COBALT_API_URL,
      durationMs,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return { audioUrl: null, success: false };
  }
}

/**
 * Scrape OG meta tags as fallback
 */
async function scrapeOgMeta(url: string, cookies?: InstagramCookies): Promise<{
  caption: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
}> {
  const startTime = Date.now();
  const requestHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache'
  };

  if (cookies) {
    requestHeaders['Cookie'] = `sessionid=${cookies.sessionId}; csrftoken=${cookies.csrfToken}; ds_user_id=${cookies.dsUserId}`;
    log.info('OG scraping con cookie Instagram', { hasCookies: true });
  }

  log.debug('Tentativo OG scraping', {
    requestUrl: url,
    headers: requestHeaders
  });

  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      redirect: 'follow'
    });

    const durationMs = Date.now() - startTime;
    const responseHeaders = extractHeaders(response.headers);
    const finalUrl = response.url; // URL dopo eventuali redirect

    const wasRedirected = finalUrl !== url;
    log.debug('OG scraping risposta HTTP', {
      status: response.status,
      statusText: response.statusText,
      durationMs,
      originalUrl: url,
      ...(wasRedirected && { finalUrl }),
      wasRedirected,
      responseHeaders
    });

    if (!response.ok) {
      log.warn('OG scraping fallito - status non ok', {
        status: response.status,
        reason: response.status === 404 ? 'Pagina non trovata' :
                response.status === 403 ? 'Accesso negato (possibile blocco bot)' :
                response.status === 429 ? 'Rate limit' :
                'Errore HTTP'
      });
      return { caption: null, thumbnailUrl: null, videoUrl: null };
    }

    const html = await response.text();

    log.debug('OG scraping HTML ricevuto', {
      htmlLength: html.length,
      htmlPreview: truncate(html, 1000),
      containsLoginForm: html.includes('login') || html.includes('Login'),
      containsCookieBanner: html.includes('cookie') || html.includes('Cookie'),
      containsAgeGate: html.includes('age') && html.includes('confirm')
    });

    // Extract all OG meta tags
    const ogTags: Record<string, string> = {};
    const ogRegex = /<meta\s+(?:property|name)=["'](og:[^"']+)["']\s+content=["']([^"']*)["']/gi;
    const ogRegex2 = /<meta\s+content=["']([^"']*)["']\s+(?:property|name)=["'](og:[^"']+)["']/gi;

    let match;
    while ((match = ogRegex.exec(html)) !== null) {
      ogTags[match[1]] = match[2];
    }
    while ((match = ogRegex2.exec(html)) !== null) {
      ogTags[match[2]] = match[1];
    }

    log.debug('OG meta tags trovati', {
      tagsFound: Object.keys(ogTags),
      ogTitle: ogTags['og:title'] ? truncate(ogTags['og:title'], 100) : null,
      ogDescription: ogTags['og:description'] ? truncate(ogTags['og:description'], 100) : null,
      ogImage: ogTags['og:image'] ? truncate(ogTags['og:image'], 200) : null,
      ogType: ogTags['og:type'],
      ogSiteName: ogTags['og:site_name']
    });

    const rawCaption = ogTags['og:description'] || ogTags['og:title'] || null;
    const caption = rawCaption ? decodeHtmlEntities(rawCaption) : null;
    const thumbnailUrl = ogTags['og:image'] || null;

    // Extract video URL from og:video or Instagram embedded data
    let videoUrl: string | null = ogTags['og:video'] || ogTags['og:video:secure_url'] || null;

    if (!videoUrl && cookies && url.includes('instagram')) {
      videoUrl = extractInstagramVideoUrl(html);
    }

    // Check for Instagram-specific issues
    if (url.includes('instagram')) {
      const isLoginPage = html.includes('loginForm') || html.includes('Log in to Instagram');
      const isPrivate = html.includes('This Account is Private');
      const isUnavailable = html.includes('Sorry, this page isn\'t available');

      if (isLoginPage || isPrivate || isUnavailable) {
        log.warn('Instagram richiede interazione', {
          isLoginPage,
          isPrivate,
          isUnavailable,
          note: 'Instagram blocca accesso programmatico senza autenticazione'
        });
      }
    }

    log.info('OG scraping completato', {
      hasCaption: !!caption,
      captionPreview: caption ? truncate(caption, 100) : null,
      hasThumbnail: !!thumbnailUrl,
      hasVideo: !!videoUrl
    });

    return { caption, thumbnailUrl, videoUrl };

  } catch (error) {
    const durationMs = Date.now() - startTime;
    log.error('OG scraping errore di rete', error instanceof Error ? error : new Error(String(error)), {
      requestUrl: url,
      durationMs,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return { caption: null, thumbnailUrl: null, videoUrl: null };
  }
}

/**
 * Extract video URL from Instagram's authenticated HTML page.
 * Instagram embeds video URLs in multiple places when authenticated:
 * - JSON-LD structured data
 * - Inline script data (window.__additionalDataLoaded, etc.)
 * - Direct video_url fields in embedded JSON
 */
function extractInstagramVideoUrl(html: string): string | null {
  // Method 1: JSON-LD contentUrl
  try {
    const ldJsonRegex = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldJsonRegex.exec(html)) !== null) {
      try {
        const ldData = JSON.parse(ldMatch[1]);
        const contentUrl = ldData.contentUrl || ldData.video?.contentUrl;
        if (contentUrl && typeof contentUrl === 'string') {
          log.info('Instagram video URL trovato via JSON-LD', {
            urlPreview: truncate(contentUrl, 200)
          });
          return contentUrl;
        }
      } catch { /* not valid JSON, skip */ }
    }
  } catch { /* regex failed, continue */ }

  // Method 2: video_url in inline script data
  try {
    const videoUrlRegex = /"video_url"\s*:\s*"([^"]+)"/g;
    const videoMatch = videoUrlRegex.exec(html);
    if (videoMatch?.[1]) {
      const videoUrl = videoMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      log.info('Instagram video URL trovato via inline script', {
        urlPreview: truncate(videoUrl, 200)
      });
      return videoUrl;
    }
  } catch { /* regex failed, continue */ }

  // Method 3: video_versions array (highest quality first)
  try {
    const versionsRegex = /"video_versions"\s*:\s*\[([\s\S]*?)\]/g;
    const versionsMatch = versionsRegex.exec(html);
    if (versionsMatch?.[1]) {
      const urlInVersion = /"url"\s*:\s*"([^"]+)"/.exec(versionsMatch[1]);
      if (urlInVersion?.[1]) {
        const videoUrl = urlInVersion[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        log.info('Instagram video URL trovato via video_versions', {
          urlPreview: truncate(videoUrl, 200)
        });
        return videoUrl;
      }
    }
  } catch { /* regex failed, continue */ }

  log.debug('Nessun video URL trovato nell\'HTML Instagram');
  return null;
}

import type { SocialPlatform } from '../types';

interface PlatformConfig {
  name: SocialPlatform;
  patterns: string[];
  oEmbedUrl?: string;
  label: string;
}

const PLATFORMS: PlatformConfig[] = [
  {
    name: 'instagram',
    patterns: ['instagram.com', 'instagr.am'],
    oEmbedUrl: 'https://api.instagram.com/oembed',
    label: 'IG'
  },
  {
    name: 'tiktok',
    patterns: ['tiktok.com', 'vm.tiktok.com'],
    oEmbedUrl: 'https://www.tiktok.com/oembed',
    label: 'TT'
  },
  {
    name: 'youtube',
    patterns: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
    oEmbedUrl: 'https://www.youtube.com/oembed',
    label: 'YT'
  },
  {
    name: 'facebook',
    patterns: ['facebook.com', 'fb.watch', 'fb.com'],
    oEmbedUrl: 'https://www.facebook.com/plugins/video/oembed.json',
    label: 'FB'
  },
  {
    name: 'twitter',
    patterns: ['twitter.com', 'x.com'],
    oEmbedUrl: 'https://publish.twitter.com/oembed',
    label: 'X'
  },
  {
    name: 'threads',
    patterns: ['threads.net'],
    label: 'TH'
  },
  {
    name: 'snapchat',
    patterns: ['snapchat.com', 'snap.com'],
    label: 'SC'
  },
  {
    name: 'pinterest',
    patterns: ['pinterest.com', 'pin.it'],
    label: 'PIN'
  },
  {
    name: 'linkedin',
    patterns: ['linkedin.com'],
    label: 'LI'
  },
  {
    name: 'reddit',
    patterns: ['reddit.com', 'redd.it'],
    oEmbedUrl: 'https://www.reddit.com/oembed',
    label: 'RD'
  },
  {
    name: 'vimeo',
    patterns: ['vimeo.com'],
    oEmbedUrl: 'https://vimeo.com/api/oembed.json',
    label: 'VM'
  },
  {
    name: 'twitch',
    patterns: ['twitch.tv', 'clips.twitch.tv'],
    label: 'TW'
  },
  {
    name: 'spotify',
    patterns: ['open.spotify.com'],
    oEmbedUrl: 'https://open.spotify.com/oembed',
    label: 'SP'
  },
  {
    name: 'soundcloud',
    patterns: ['soundcloud.com'],
    oEmbedUrl: 'https://soundcloud.com/oembed',
    label: 'SND'
  }
];

export function detectPlatform(url: string): SocialPlatform {
  const lowerUrl = url.toLowerCase();

  for (const platform of PLATFORMS) {
    if (platform.patterns.some(pattern => lowerUrl.includes(pattern))) {
      return platform.name;
    }
  }

  return 'other';
}

export function getPlatformConfig(platform: SocialPlatform): PlatformConfig | undefined {
  return PLATFORMS.find(p => p.name === platform);
}

export function getPlatformLabel(platform: SocialPlatform): string {
  const config = PLATFORMS.find(p => p.name === platform);
  return config?.label || 'WEB';
}

export interface InstagramCookies {
  sessionId: string;
  csrfToken: string;
  dsUserId: string;
}

export interface ExtractContentOptions {
  cobaltEnabled?: boolean;
  instagramCookies?: InstagramCookies;
}

export async function extractContent(url: string, options: ExtractContentOptions = {}): Promise<ExtractedContent> {
  const { cobaltEnabled = false, instagramCookies } = options;
  const platform = detectPlatform(url);
  const platformConfig = getPlatformConfig(platform);

  log.info('Inizio estrazione contenuto', {
    url,
    platform,
    platformLabel: platformConfig?.label || 'WEB',
    hasOEmbed: !!platformConfig?.oEmbedUrl,
    cobaltEnabled
  });

  let caption: string | null = null;
  let thumbnailUrl: string | null = null;
  let audioUrl: string | null = null;
  let authorName: string | null = null;

  // Step 1: Try oEmbed if platform supports it (best source for metadata)
  // Skip oEmbed for Instagram — their endpoint requires a Facebook Graph API token,
  // session cookies don't work. Go straight to OG scraping with cookies instead.
  const skipOEmbed = platform === 'instagram';
  if (platformConfig?.oEmbedUrl && !skipOEmbed) {
    log.debug(`Step 1: Tentativo oEmbed (${platform})`);
    const oembedResult = await extractWithOEmbed(url, platformConfig.oEmbedUrl, platform);

    if (oembedResult.success) {
      caption = oembedResult.caption;
      thumbnailUrl = oembedResult.thumbnailUrl;
      authorName = oembedResult.authorName;

      log.info('oEmbed ha fornito metadata', {
        platform,
        hasCaption: !!caption,
        hasThumbnail: !!thumbnailUrl,
        authorName
      });
    } else {
      log.debug('oEmbed non ha fornito risultati, procedo con OG scraping');
    }
  } else {
    log.debug(`Step 1: Skip oEmbed (${skipOEmbed ? 'Instagram richiede Graph API token' : `${platform} non lo supporta`})`);
  }

  // Step 2: OG scraping as fallback or primary (if no oEmbed)
  if (!caption || !thumbnailUrl) {
    log.debug('Step 2: OG scraping', {
      reason: !platformConfig?.oEmbedUrl ? `${platform} non supporta oEmbed` :
              !caption && !thumbnailUrl ? 'oEmbed non ha fornito dati' :
              !caption ? 'Manca caption da oEmbed' : 'Manca thumbnail da oEmbed'
    });

    const ogResult = await scrapeOgMeta(
      url,
      platform === 'instagram' ? instagramCookies : undefined
    );

    // Use OG results only for missing data
    if (!caption && ogResult.caption) {
      caption = ogResult.caption;
      log.debug('Caption ottenuta da OG scraping');
    }
    if (!thumbnailUrl && ogResult.thumbnailUrl) {
      thumbnailUrl = ogResult.thumbnailUrl;
      log.debug('Thumbnail ottenuta da OG scraping');
    }
    if (!audioUrl && ogResult.videoUrl) {
      audioUrl = ogResult.videoUrl;
      log.info('Video/audio URL ottenuto da OG scraping (Instagram authenticated)', {
        urlPreview: truncate(ogResult.videoUrl, 200)
      });
    }
  }

  // Step 3: Try Cobalt for audio extraction (only if enabled)
  if (cobaltEnabled) {
    log.debug('Step 3: Tentativo estrazione audio con Cobalt');
    const cobaltResult = await extractWithCobalt(url);
    audioUrl = cobaltResult.audioUrl;
  } else {
    log.debug('Step 3: Cobalt disabilitato, skip estrazione audio');
  }

  // Final summary
  const result: ExtractedContent = {
    caption,
    thumbnailUrl,
    audioUrl,
    hasAudio: !!audioUrl,
    hasCaption: !!caption
  };

  log.info('Estrazione completata', {
    hasCaption: !!caption,
    captionLength: caption?.length || 0,
    hasThumbnail: !!thumbnailUrl,
    hasAudio: !!audioUrl,
    authorName,
    platform,
    summary: {
      caption: caption ? truncate(caption, 80) : '[MANCANTE]',
      thumbnailUrl: thumbnailUrl ? truncate(thumbnailUrl, 80) : '[MANCANTE]',
      audioUrl: audioUrl ? truncate(audioUrl, 80) : '[MANCANTE - Instagram potrebbe richiedere interazione]'
    }
  });

  if (!audioUrl && platform === 'instagram') {
    log.warn('Audio non disponibile per Instagram', {
      reason: 'Instagram richiede autenticazione o interazione per accesso ai media',
      suggestion: 'L\'analisi procederà solo con caption e thumbnail tramite AI'
    });
  }

  return result;
}
