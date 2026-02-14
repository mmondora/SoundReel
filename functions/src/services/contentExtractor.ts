import { Logger } from './debugLogger';
import type { ExtractedContent } from '../types';

// Logger instance - will be replaced per-request if passed
let log = new Logger('contentExtractor');

// Allow setting the logger from the caller to ensure proper entryId tracking
export function setLogger(logger: Logger): void {
  log = logger;
}

const COBALT_API_URL = 'https://cobalt-972218119922.europe-west1.run.app/';

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
  filename?: string;
  error?: string | { code: string };
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
 * Try Cobalt.tools API for media extraction
 */
async function extractWithCobalt(url: string, audioOnly: boolean = true): Promise<{
  audioUrl: string | null;
  success: boolean;
}> {
  const startTime = Date.now();
  const requestHeaders = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  const payload: Record<string, unknown> = {
    url,
    downloadMode: audioOnly ? 'audio' : 'auto',
    audioFormat: 'mp3'
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

    if (data.status === 'success' || data.status === 'stream' || data.status === 'redirect' || data.status === 'tunnel') {
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
    const errorCode = typeof data.error === 'object' ? data.error?.code : data.error;
    const errorReason =
      data.status === 'error' ? (errorCode || data.text || 'Errore generico Cobalt') :
      data.status === 'rate-limit' ? 'Rate limit Cobalt raggiunto' :
      data.status === 'picker' ? 'Cobalt richiede selezione manuale (picker)' :
      `Status Cobalt non gestito: ${data.status}`;

    log.warn('cobalt.tools fallito', {
      status: data.status,
      reason: errorReason,
      errorText: data.text,
      errorField: errorCode,
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
async function scrapeOgMeta(url: string): Promise<{
  caption: string | null;
  thumbnailUrl: string | null;
}> {
  const startTime = Date.now();
  const requestHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache'
  };

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
      return { caption: null, thumbnailUrl: null };
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
      hasThumbnail: !!thumbnailUrl
    });

    return { caption, thumbnailUrl };

  } catch (error) {
    const durationMs = Date.now() - startTime;
    log.error('OG scraping errore di rete', error instanceof Error ? error : new Error(String(error)), {
      requestUrl: url,
      durationMs,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return { caption: null, thumbnailUrl: null };
  }
}

/**
 * Convert Instagram shortcode to numeric media ID.
 * Instagram uses a custom base64 encoding for shortcodes.
 */
function shortcodeToMediaId(shortcode: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let mediaId = BigInt(0);
  for (const char of shortcode) {
    mediaId = mediaId * BigInt(64) + BigInt(alphabet.indexOf(char));
  }
  return mediaId.toString();
}

/**
 * Extract shortcode from an Instagram URL.
 * Supports /reel/XXX/, /p/XXX/, /tv/XXX/
 */
function extractShortcode(url: string): string | null {
  const match = url.match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/);
  return match?.[1] || null;
}

/**
 * Fetch Instagram media data via the private API.
 * Uses i.instagram.com/api/v1/media/{id}/info/ with session cookies.
 * This works from datacenter IPs unlike HTML scraping.
 */
interface InstagramApiResult {
  caption: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  musicInfo: { title: string; artist: string } | null;
  success: boolean;
}

async function fetchInstagramApi(url: string, cookies: InstagramCookies): Promise<InstagramApiResult> {
  const shortcode = extractShortcode(url);
  if (!shortcode) {
    log.warn('Instagram: impossibile estrarre shortcode dall\'URL', { url });
    return { caption: null, thumbnailUrl: null, videoUrl: null, musicInfo: null, success: false };
  }

  const mediaId = shortcodeToMediaId(shortcode);
  const apiUrl = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;

  log.debug('Instagram API request', { shortcode, mediaId, apiUrl });

  const startTime = Date.now();
  try {
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 440dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100)',
        'Cookie': `sessionid=${cookies.sessionId}; csrftoken=${cookies.csrfToken}; ds_user_id=${cookies.dsUserId}`,
        'X-CSRFToken': cookies.csrfToken,
        'X-IG-App-ID': '936619743392459',
        'Accept': '*/*',
      }
    });

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      log.warn('Instagram API errore', {
        status: response.status,
        durationMs,
        shortcode
      });
      return { caption: null, thumbnailUrl: null, videoUrl: null, musicInfo: null, success: false };
    }

    const data = await response.json();
    const item = data?.items?.[0];

    if (!item) {
      log.warn('Instagram API: nessun item trovato', { shortcode, mediaId });
      return { caption: null, thumbnailUrl: null, videoUrl: null, musicInfo: null, success: false };
    }

    // Extract caption
    const caption = item.caption?.text || null;

    // Extract video URL (first video version = highest quality)
    let videoUrl: string | null = null;
    if (item.video_versions?.length > 0) {
      videoUrl = item.video_versions[0].url || null;
    }

    // Extract thumbnail
    const thumbnailUrl = item.image_versions2?.candidates?.[0]?.url || null;

    // Extract music metadata from reel clips_metadata
    let musicInfo: { title: string; artist: string } | null = null;
    const musicAsset = item.clips_metadata?.music_info?.music_asset_info;
    if (musicAsset?.title && musicAsset?.display_artist) {
      musicInfo = {
        title: musicAsset.title,
        artist: musicAsset.display_artist
      };
      log.info('Instagram musica del reel trovata', {
        title: musicInfo.title,
        artist: musicInfo.artist
      });
    } else {
      // Try alternative path: item.music_metadata
      const altMusic = item.music_metadata?.music_info?.music_asset_info;
      if (altMusic?.title && altMusic?.display_artist) {
        musicInfo = {
          title: altMusic.title,
          artist: altMusic.display_artist
        };
        log.info('Instagram musica del reel trovata (alt path)', {
          title: musicInfo.title,
          artist: musicInfo.artist
        });
      }
    }

    log.info('Instagram API estrazione riuscita', {
      durationMs,
      hasCaption: !!caption,
      captionPreview: caption ? truncate(caption, 100) : null,
      hasVideo: !!videoUrl,
      hasThumbnail: !!thumbnailUrl,
      hasMusic: !!musicInfo,
      musicTitle: musicInfo?.title,
      musicArtist: musicInfo?.artist,
      mediaType: item.media_type,
      hasAudio: item.has_audio
    });

    return { caption, thumbnailUrl, videoUrl, musicInfo, success: true };

  } catch (error) {
    const durationMs = Date.now() - startTime;
    log.error('Instagram API errore di rete', error instanceof Error ? error : new Error(String(error)), {
      apiUrl,
      durationMs
    });
    return { caption: null, thumbnailUrl: null, videoUrl: null, musicInfo: null, success: false };
  }
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
  let videoUrl: string | null = null;
  let authorName: string | null = null;
  let musicInfo: { title: string; artist: string } | null = null;

  // Step 1: For Instagram with cookies, use the private API (works from datacenter IPs)
  if (platform === 'instagram' && instagramCookies) {
    log.debug('Step 1: Instagram API (private endpoint)');
    const igResult = await fetchInstagramApi(url, instagramCookies);

    if (igResult.success) {
      caption = igResult.caption;
      thumbnailUrl = igResult.thumbnailUrl;
      audioUrl = igResult.videoUrl;
      videoUrl = igResult.videoUrl;
      musicInfo = igResult.musicInfo;
      log.info('Instagram API ha fornito dati', {
        hasCaption: !!caption,
        hasThumbnail: !!thumbnailUrl,
        hasVideo: !!audioUrl,
        hasMusic: !!musicInfo
      });
    } else {
      log.warn('Instagram API fallita, fallback su OG scraping');
    }
  }

  // Step 2: Try oEmbed if platform supports it (skip for Instagram)
  if (!caption && !thumbnailUrl && platformConfig?.oEmbedUrl && platform !== 'instagram') {
    log.debug(`Step 2: Tentativo oEmbed (${platform})`);
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
  }

  // Step 3: OG scraping as fallback
  if (!caption || !thumbnailUrl) {
    log.debug('Step 3: OG scraping', {
      reason: !caption && !thumbnailUrl ? 'Dati mancanti' :
              !caption ? 'Manca caption' : 'Manca thumbnail'
    });

    const ogResult = await scrapeOgMeta(url);

    if (!caption && ogResult.caption) {
      caption = ogResult.caption;
      log.debug('Caption ottenuta da OG scraping');
    }
    if (!thumbnailUrl && ogResult.thumbnailUrl) {
      thumbnailUrl = ogResult.thumbnailUrl;
      log.debug('Thumbnail ottenuta da OG scraping');
    }
  }

  // Step 4: Try Cobalt for audio + video extraction (only if enabled)
  if (cobaltEnabled) {
    const promises: Promise<{ audioUrl: string | null; success: boolean }>[] = [];

    if (!audioUrl) {
      log.debug('Step 4a: Tentativo estrazione audio con Cobalt');
      promises.push(extractWithCobalt(url, true));
    } else {
      promises.push(Promise.resolve({ audioUrl, success: true }));
    }

    if (!videoUrl) {
      log.debug('Step 4b: Tentativo estrazione video con Cobalt');
      promises.push(extractWithCobalt(url, false));
    } else {
      promises.push(Promise.resolve({ audioUrl: videoUrl, success: true }));
    }

    const [audioResult, videoResult] = await Promise.all(promises);
    if (!audioUrl && audioResult.audioUrl) audioUrl = audioResult.audioUrl;
    if (!videoUrl && videoResult.audioUrl) videoUrl = videoResult.audioUrl;
  } else if (!audioUrl) {
    log.debug('Step 4: Nessuna estrazione audio (Cobalt disabilitato o audio già presente)');
  }

  // Final summary
  const result: ExtractedContent = {
    caption,
    thumbnailUrl,
    audioUrl,
    videoUrl,
    hasAudio: !!audioUrl,
    hasCaption: !!caption,
    musicInfo
  };

  log.info('Estrazione completata', {
    hasCaption: !!caption,
    captionLength: caption?.length || 0,
    hasThumbnail: !!thumbnailUrl,
    hasAudio: !!audioUrl,
    hasVideo: !!videoUrl,
    authorName,
    platform,
    summary: {
      caption: caption ? truncate(caption, 80) : '[MANCANTE]',
      thumbnailUrl: thumbnailUrl ? truncate(thumbnailUrl, 80) : '[MANCANTE]',
      audioUrl: audioUrl ? truncate(audioUrl, 80) : '[MANCANTE]',
      videoUrl: videoUrl ? truncate(videoUrl, 80) : '[MANCANTE]'
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
