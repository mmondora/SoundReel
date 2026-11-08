/**
 * Turn the free-text part of a Telegram message (same message as the URL)
 * into entry filter tags. Hashtags and leftover words both count; the URL
 * itself is stripped. Tags are lowercased and deduped.
 */

const STOPWORDS = new Set([
  // IT
  'a', 'ad', 'al', 'alla', 'allo', 'ai', 'agli', 'alle', 'con', 'da', 'dal', 'dalla',
  'dei', 'del', 'della', 'delle', 'di', 'e', 'ed', 'che', 'chi', 'come', 'cosa',
  'dei', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'una', 'uno', 'per',
  'su', 'sul', 'sulla', 'tra', 'fra', 'in', 'nel', 'nella', 'nei', 'nelle',
  'mi', 'ti', 'si', 'ci', 'vi', 'ne', 'non', 'piu', 'più', 'anche', 'solo',
  'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'quei', 'quelle',
  'sono', 'sei', 'sia', 'ho', 'hai', 'ha', 'abbiamo', 'hanno', 'essere', 'fare',
  'guarda', 'vedi', 'link', 'post', 'reel', 'video', 'pls', 'please',
  // EN
  'the', 'and', 'or', 'but', 'for', 'with', 'from', 'this', 'that', 'these',
  'those', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at',
  'an', 'as', 'it', 'its', 'my', 'your', 'our', 'me', 'you', 'we', 'they',
  'check', 'out', 'see', 'look', 'here', 'http', 'https', 'www',
]);

const MAX_TAGS = 15;
const MAX_TAG_LEN = 40;

function stripUrl(text: string, url: string): string {
  let out = text;
  if (url) {
    out = out.split(url).join(' ');
    // Also strip common variants (www / trailing slash / bare host path).
    try {
      const u = new URL(url);
      const hostPath = `${u.host}${u.pathname}`.replace(/\/$/, '');
      const noWww = hostPath.replace(/^www\./i, '');
      const withWww = noWww.startsWith('www.') ? noWww : `www.${noWww}`;
      for (const variant of [
        hostPath,
        `${hostPath}/`,
        noWww,
        `${noWww}/`,
        withWww,
        `${withWww}/`,
        `https://${hostPath}`,
        `https://${hostPath}/`,
        `http://${hostPath}`,
        `http://${hostPath}/`,
        `https://${noWww}`,
        `https://${noWww}/`,
        `https://${withWww}`,
        `https://${withWww}/`,
      ]) {
        if (variant.length >= 8) out = out.split(variant).join(' ');
      }
    } catch {
      /* ignore invalid URL */
    }
  }
  // leftover bare URLs and www. paths
  out = out.replace(/https?:\/\/\S+/gi, ' ');
  out = out.replace(/\bwww\.[^\s]+/gi, ' ');
  return out;
}

function normalizeToken(raw: string): string | null {
  let t = raw.trim();
  if (!t) return null;
  // keep leading # / @ then strip other punctuation
  const prefix = t.startsWith('#') || t.startsWith('@') ? t[0] : '';
  t = (prefix ? t.slice(1) : t).replace(/^[^0-9a-zA-ZàèéìòùÀÈÉÌÒÙäöüÄÖÜß]+|[^0-9a-zA-ZàèéìòùÀÈÉÌÒÙäöüÄÖÜß]+$/g, '');
  if (!t || t.length < 2) return null;
  t = t.toLowerCase();
  if (STOPWORDS.has(t)) return null;
  // Bare numbers are noise; keep `#2024` / `@42` as intentional tags.
  if (!prefix && /^\d+$/.test(t)) return null;
  const tagged = `${prefix === '@' ? '@' : prefix === '#' ? '#' : ''}${t}`;
  if (tagged.length > MAX_TAG_LEN) return tagged.slice(0, MAX_TAG_LEN);
  return tagged;
}

/**
 * Extract filter tags from Telegram message text accompanying a URL.
 */
export function extractTelegramCommentTags(messageText: string, url: string): string[] {
  const remainder = stripUrl(messageText, url).trim();
  if (!remainder) return [];

  const found: string[] = [];
  /** Dedupe by bare token so `#tesla` and `tesla` collapse; prefer `#` form. */
  const seen = new Map<string, number>();

  const push = (tag: string | null) => {
    if (!tag) return;
    const bare = tag.replace(/^[#@]/, '').toLowerCase();
    if (!bare) return;
    const existingIdx = seen.get(bare);
    if (existingIdx !== undefined) {
      const prev = found[existingIdx];
      if ((tag.startsWith('#') || tag.startsWith('@')) && !prev.startsWith('#') && !prev.startsWith('@')) {
        found[existingIdx] = tag;
      }
      return;
    }
    if (found.length >= MAX_TAGS) return;
    seen.set(bare, found.length);
    found.push(tag);
  };

  // Explicit hashtags / mentions first
  const hashRe = /[#@][\w\u00C0-\u024F]+/g;
  let m: RegExpExecArray | null;
  while ((m = hashRe.exec(remainder)) !== null) {
    push(normalizeToken(m[0]));
    if (found.length >= MAX_TAGS) return found;
  }

  // Remaining words (without the hashtag tokens already consumed)
  const withoutHash = remainder.replace(hashRe, ' ');
  for (const part of withoutHash.split(/[\s,;|/]+/)) {
    push(normalizeToken(part));
    if (found.length >= MAX_TAGS) break;
  }

  return found;
}
