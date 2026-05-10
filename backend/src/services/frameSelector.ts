/**
 * Pick N evenly-spaced key frames from a sorted list of frame paths.
 * Heuristic v1: first + last + (n-2) equidistant in between.
 * Upgrade path: scene-change detection via pixel diff (not implemented here).
 */
export function pickKeyFrames(framePaths: string[], n: number = 5): string[] {
  if (framePaths.length <= n) return [...framePaths];
  if (n <= 0) return [];
  if (n === 1) return [framePaths[0]];

  const indices = new Set<number>();
  indices.add(0);
  indices.add(framePaths.length - 1);

  const step = (framePaths.length - 1) / (n - 1);
  for (let i = 1; i < n - 1; i++) {
    indices.add(Math.round(i * step));
  }

  return Array.from(indices)
    .sort((a, b) => a - b)
    .slice(0, n)
    .map((i) => framePaths[i]);
}
