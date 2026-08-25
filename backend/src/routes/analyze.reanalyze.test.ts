import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Structural tests, in the same spirit as analyze.transcribe.test.ts: the
 * analyze route is too tangled to exercise end to end here, but the two
 * properties that matter most about the second pass are pinnable at the
 * source level, and both are the kind that a refactor would silently undo.
 *
 * The first is a hard prohibition — a second pass must never re-download —
 * because it will eventually run over hundreds of archived Instagram posts,
 * and re-fetching them is what gets the account banned.
 */
describe('analyze route second pass', () => {
  const source = readFileSync(path.join(__dirname, 'analyze.ts'), 'utf8');

  it('calls extractContent from exactly one place', () => {
    const calls = source.match(/await extractContent\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('reaches that call only through the non-reanalyse branch', () => {
    const callAt = source.indexOf('await extractContent(');
    const before = source.slice(0, callAt);
    const guardAt = before.lastIndexOf('if (reanalyze) {');
    const elseAt = before.lastIndexOf('} else {');
    expect(guardAt).toBeGreaterThan(-1);
    // The nearest `} else {` above the call must itself be below the nearest
    // `if (reanalyze) {`: that is what makes the call the else of that if.
    expect(elseAt).toBeGreaterThan(guardAt);
  });

  it('rebuilds the media from disk instead', () => {
    expect(source).toMatch(/await rebuildLocalPaths\(entryId\)/);
  });

  it('abandons the pass when the disk holds nothing, without downloading', () => {
    const callAt = source.indexOf('await rebuildLocalPaths(entryId)');
    const branch = source.slice(callAt, callAt + 900);
    expect(branch).toMatch(/if \(!local\)/);
    expect(branch).toMatch(/no local media/);
    expect(branch).not.toMatch(/extractContent/);
  });

  it('never queues a third pass', () => {
    // transcribe → reanalyse → transcribe → ... is an infinite loop, and
    // audio.wav is still on disk when the second pass runs.
    expect(source).toMatch(/if \(!reanalyze && featuresConfig\.transcriptionEnabled/);
  });

  it('merges the results instead of replacing them', () => {
    expect(source).toMatch(/mergeEntryResults\(before\.results, finalResults\)/);
  });

  it('does not send a song the entry already had to the playlist again', () => {
    // Every reel with audio gets a second pass, and the merge keeps the song
    // that is already there — re-adding it only duplicates the Spotify track.
    expect(source).toMatch(/const priorSongKeys = new Set\(/);
    expect(source).toMatch(/if \(!alreadyOnEntry\) addedToPlaylist = await addToPlaylist\(/);
    expect(source).toMatch(/if \(!slideAlreadyOnEntry\) addedToPlaylist = await addToPlaylist\(/);
  });

  it('keeps the entry caption, thumbnail and mediaUrl out of the second pass', () => {
    // content.videoUrl and content.audioUrl are null on the rebuilt path, so
    // writing them back would blank an archived entry's mediaUrl.
    expect(source).toMatch(/if \(!reanalyze\) \{\s*\n\s*\/\/ -+\s*\n\s*\/\/ Thumbnail persistence/);
  });
});
