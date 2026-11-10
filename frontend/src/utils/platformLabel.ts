const LABELS: Record<string, string> = {
  instagram: 'IG', tiktok: 'TT', youtube: 'YT', facebook: 'FB',
  twitter: 'X', threads: 'TH', snapchat: 'SC', pinterest: 'PIN',
  linkedin: 'LI', reddit: 'RD', vimeo: 'VM', twitch: 'TW',
  spotify: 'SP', soundcloud: 'SND', shazam: 'SZ',
};

/** The short label of the platform a post came from («IG», «TT»…); anything else is «WEB». */
export function platformLabel(platform: string): string {
  return Object.prototype.hasOwnProperty.call(LABELS, platform) ? LABELS[platform] : 'WEB';
}
