import { promises as fs } from 'fs';
import path from 'path';
import type { ExtractedContentLocalPaths } from '../types';

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';

/**
 * Rebuild the pipeline's local paths from what the first pass already left on
 * disk, so a re-analysis never touches the network.
 *
 * extractContent() downloads unconditionally — it has no "already have it"
 * branch — so routing a second pass through it would re-fetch hundreds of
 * posts from Instagram and risk the account. Everything needed is here.
 *
 * Returns null when the directory holds nothing usable. The caller must then
 * abandon the pass rather than fall back to downloading.
 */
export async function rebuildLocalPaths(entryId: string): Promise<ExtractedContentLocalPaths | null> {
  const dir = path.join(MEDIA_ROOT, entryId);

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }

  const pick = (name: string): string | null =>
    names.includes(name) ? path.join(dir, name) : null;

  const sortedMatching = (re: RegExp): string[] =>
    names.filter((n) => re.test(n)).sort().map((n) => path.join(dir, n));

  const paths: ExtractedContentLocalPaths = {
    videoPath: pick('video.mp4'),
    audioPath: pick('audio.wav'),
    thumbnailPath: pick('thumbnail.jpg') ?? pick('thumbnail-source.jpg'),
    slidePaths: sortedMatching(/^slide-\d+\.(jpg|jpeg|png|webp)$/i),
    framePaths: sortedMatching(/^frame-\d+\.(jpg|jpeg|png|webp)$/i),
  };

  const hasSomething =
    paths.videoPath || paths.audioPath || paths.thumbnailPath ||
    paths.slidePaths.length > 0 || paths.framePaths.length > 0;

  return hasSomething ? paths : null;
}

export interface EntryMediaUrls {
  entryId: string;
  videoUrl: string | null;
  audioUrl: string | null;
  thumbnailUrl: string | null;
  frames: string[];
  slides: string[];
}

function toPublicUrl(entryId: string, absPath: string | null): string | null {
  if (!absPath) return null;
  return `/media/${entryId}/${path.basename(absPath)}`;
}

/** Public `/media/...` URLs for files still on disk for this entry. */
export async function listEntryMediaUrls(entryId: string): Promise<EntryMediaUrls | null> {
  const paths = await rebuildLocalPaths(entryId);
  if (!paths) return null;
  return {
    entryId,
    videoUrl: toPublicUrl(entryId, paths.videoPath),
    audioUrl: toPublicUrl(entryId, paths.audioPath),
    thumbnailUrl: toPublicUrl(entryId, paths.thumbnailPath),
    frames: paths.framePaths.map((p) => toPublicUrl(entryId, p)!),
    slides: paths.slidePaths.map((p) => toPublicUrl(entryId, p)!),
  };
}

/**
 * Prefer durable local media URLs over expiring CDN links when the file exists.
 * Leaves remote URLs untouched when nothing is on disk.
 */
export async function preferLocalMediaUrls<T extends {
  id: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
}>(entry: T): Promise<T> {
  const local = await listEntryMediaUrls(entry.id);
  if (!local) return entry;
  return {
    ...entry,
    mediaUrl: local.videoUrl ?? entry.mediaUrl,
    thumbnailUrl: local.thumbnailUrl ?? entry.thumbnailUrl,
  };
}
