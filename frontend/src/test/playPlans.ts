import { vi } from 'vitest';
import { fetchPlayPlan } from '../services/api';
import type { NetworkKind, PlayPlan } from '../types';

// A stand-in for what the SERVER answers to `GET /api/songs/:key/play` (rule P, ADR-0018), for the tests of the player that
// mock `../services/api`. The rule itself is the server's and is tested there (backend/src/services/playPlan.test.ts); here
// it only produces answers for the browser to follow, and the tests check that the browser follows them and nothing else.

export type FileAt = 'media-server' | 'disk';

/** The address a plan gives for a song's file (the contract: a path on SoundReel). */
export const fileUrlOf = (songKey: string): string => `/api/songs/${encodeURIComponent(songKey)}/file`;

/** The same address as an `<audio>` element reports it (`src` is made absolute). */
export const absoluteUrl = (path: string): string => new URL(path, document.baseURI).href;

/** A plan, written out: the answer for a song that has its file at the media server, at home (override what differs). */
export function makePlan(songKey: string, over: Partial<PlayPlan> = {}): PlayPlan {
  return {
    songKey,
    prefer: 'auto',
    network: 'internal',
    choice: 'media',
    from: 'media-server',
    download: false,
    fileUrl: fileUrlOf(songKey),
    ...over,
  };
}

/** The song plays from the video: from the internet, or at home with no file (then `download`). */
export function videoPlan(songKey: string, over: Partial<PlayPlan> = {}): PlayPlan {
  return makePlan(songKey, { from: 'youtube', fileUrl: null, ...over });
}

/** Where each song's file is: a table, or a rule; a song that is not there (or `null`) has no file anywhere. */
export type FilesAt = Record<string, FileAt | null> | ((songKey: string) => FileAt | null);

/**
 * Makes the mocked `fetchPlayPlan` answer like SoundReel would: the network it sees, the preference it is sent and where
 * the file is. Call it again to change the world (another network, a download that finished).
 */
export function servePlans(network: NetworkKind, files: FilesAt = {}): void {
  const fileOf = (key: string): FileAt | null => (typeof files === 'function' ? files(key) : files[key] ?? null);
  vi.mocked(fetchPlayPlan).mockImplementation(async (songKey, prefer = 'auto') => {
    const choice = prefer === 'auto' ? (network === 'internal' ? 'media' : 'internet') : prefer;
    const file = fileOf(songKey);
    const from = choice === 'media' && file ? file : 'youtube';
    return makePlan(songKey, {
      prefer,
      network,
      choice,
      from,
      download: file === null,
      fileUrl: from === 'youtube' ? null : fileUrlOf(songKey),
    });
  });
}
