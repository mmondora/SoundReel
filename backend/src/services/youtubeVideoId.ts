/**
 * Extract a YouTube video id from common watch / short / embed URL shapes.
 * Returns null for search-result URLs or anything without a clear id.
 */
export function extractYoutubeVideoId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const url = raw.trim();
  if (!url) return null;

  // youtu.be/<id>
  const short = /^https?:\/\/(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{6,})/i.exec(url);
  if (short) return short[1];

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
      const v = parsed.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) return v;
      const parts = parsed.pathname.split('/').filter(Boolean);
      // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
      if (parts.length >= 2 && ['embed', 'shorts', 'live', 'v'].includes(parts[0].toLowerCase())) {
        const id = parts[1];
        if (/^[A-Za-z0-9_-]{6,}$/.test(id)) return id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
