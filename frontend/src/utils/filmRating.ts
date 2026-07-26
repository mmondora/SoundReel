/**
 * Derives a fresh/rotten rating from the score slider position.
 * Explicit 🍅/🤢 clicks always win; this only applies when the user moves
 * the slider: <20 → rotten, >80 → fresh, anything between leaves the
 * current rating untouched (returns null).
 */
export function ratingFromScore(score: number): 'fresh' | 'rotten' | null {
  if (score < 20) return 'rotten';
  if (score > 80) return 'fresh';
  return null;
}
