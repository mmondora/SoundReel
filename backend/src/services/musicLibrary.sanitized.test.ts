import { describe, expect, it } from 'vitest';
import { findLibraryTrack, type LibraryTrack } from './musicLibrary';
import { storeFileName } from './musicStore';

const track = (artist: string, title: string): LibraryTrack => ({
  artist, title, album: 'SoundReel', relPath: `SoundReel/${artist} - ${title}.mp3`,
});

describe('findLibraryTrack finds the files SoundReel itself writes (exFAT-safe spelling)', () => {
  it.each([
    ['AC/DC', 'Back In Black'],
    ['Sunn O)))', 'Aghartha'],
    ['Artist', 'Why?'],
    ['Artist', 'Song: The Sequel'],
    ['Artist', 'A/B Test "Live"'],
    ['Artist', 'Wait...'],
  ])('%s – %s', (artist, title) => {
    // Build the file exactly as the downloader names it, parse it back like the scanner does.
    const file = storeFileName(artist, title).replace(/\.mp3$/, '');
    const sep = file.indexOf(' - ');
    const scanned = track(file.slice(0, sep), file.slice(sep + 3));
    expect(findLibraryTrack([scanned], artist, title)).toBe(scanned);
  });

  it('still refuses a different song with a similar spelling', () => {
    expect(findLibraryTrack([track('AC DC', 'Back In Black')], 'AC/DC', 'Highway to Hell')).toBeNull();
    expect(findLibraryTrack([track('Other', 'Back In Black')], 'AC/DC', 'Back In Black')).toBeNull();
  });
});
