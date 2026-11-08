import { describe, expect, it } from 'vitest';
import type { AggregatedSong } from '../types';
import { attachSongVersions, classifyGroup, parseSongTitle, sameArtist, titleKey } from './songVersions';

const song = (title: string, artist: string): AggregatedSong => ({
  songKey: `${artist.toLowerCase()}::${title.toLowerCase()}`,
  title,
  artist,
  album: null,
  youtubeUrl: null,
  spotifyUrl: null,
  mentions: [],
  meta: null,
  inLibrary: false,
});

// Every title below is a real one from the journal (8 November 2026).
const VERSIONS: Array<[string, string, string[]]> = [
  ['Goth (Slowed + Reverb)', 'Goth', ['Slowed + Reverb']],
  ['BURN FOR YOU (Slowed)', 'BURN FOR YOU', ['Slowed']],
  ['Scheming (Instrumental Slowed)', 'Scheming', ['Instrumental Slowed']],
  ['Papaoutai (Slowed Reverb Instrumental)', 'Papaoutai', ['Slowed Reverb Instrumental']],
  ['Skins (Ultra Slowed + Reverb)', 'Skins', ['Ultra Slowed + Reverb']],
  ['REVENGE (Super Slowed)', 'REVENGE', ['Super Slowed']],
  ['Memory Reboot (Over Slowed)', 'Memory Reboot', ['Over Slowed']],
  ['In Essence (slowed to perfection)', 'In Essence', ['slowed to perfection']],
  ['Dark Is The Night (slowed + reverb)', 'Dark Is The Night', ['slowed + reverb']],
  ['Idea 10 (Slowed & Reverb)', 'Idea 10', ['Slowed & Reverb']],
  ['Minor (Slowed version)', 'Minor', ['Slowed version']],
  ['Les (Instrumental Slowed)', 'Les', ['Instrumental Slowed']],
  ['Bling (Instrumental)', 'Bling', ['Instrumental']],
  ['Always the Same Eyes (Andres Luque Remix)', 'Always the Same Eyes', ['Andres Luque Remix']],
  ["Bonita Applebum (Sir Piers and Si Ashton's Curious House Mix)", 'Bonita Applebum', ["Sir Piers and Si Ashton's Curious House Mix"]],
  ['Le Freak (Edit)', 'Le Freak', ['Edit']],
  ['Smalltown Boy (1991 Remix)', 'Smalltown Boy', ['1991 Remix']],
  ['O CORE NUN TENE PADRONE (1926 MIX)', 'O CORE NUN TENE PADRONE', ['1926 MIX']],
  ['Solitude (Felsmann + Tiley Reinterpretation)', 'Solitude', ['Felsmann + Tiley Reinterpretation']],
  ['Beanie - Piano Version', 'Beanie', ['Piano Version']],
  ['ATTACK ON TITAN - Slowed', 'ATTACK ON TITAN', ['Slowed']],
  ['In The Flight - Live', 'In The Flight', ['Live']],
  ['Solitude - Ultra Slowed', 'Solitude', ['Ultra Slowed']],
  ['As Time Flies (Special Version) - Pitched + Slowed', 'As Time Flies', ['Special Version', 'Pitched + Slowed']],
  ['Felicidad - (Instrumental)', 'Felicidad', ['Instrumental']],
  ['Holiday (7" Version)', 'Holiday', ['7" Version']],
  ['Interstellar (EPIC VERSION)', 'Interstellar', ['EPIC VERSION']],
  ['Love Story (Orchestral Version)', 'Love Story', ['Orchestral Version']],
  ['Enjoy the Silence (Lunar Lo-Fi Version)', 'Enjoy the Silence', ['Lunar Lo-Fi Version']],
  ['Stranger Things Theme Song (Speed)', 'Stranger Things Theme Song', ['Speed']],
  ['FΛSHION (Slow)', 'FΛSHION', ['Slow']],
  ['Je te laisserai des mots (Slowed Piano Version)', 'Je te laisserai des mots', ['Slowed Piano Version']],
  ['Prime (2012 Unfinished)', 'Prime', ['2012 Unfinished']],
  ['Memory (Live at Wembley)', 'Memory', ['Live at Wembley']],
];

// The same audio under another spelling: a credit or a remaster note.
const DECORATED: Array<[string, string, string[], string[]]> = [
  ['Runaway (feat. Pusha T)', 'Runaway', [], ['feat. Pusha T']],
  ['Bad Connection (2008 Remaster)', 'Bad Connection', [], ['2008 Remaster']],
  ['Slow Love - 2020 Remaster', 'Slow Love', [], ['2020 Remaster']],
  ['Last Christmas (Remastered)', 'Last Christmas', [], ['Remastered']],
  ['Prospettiva Nevski (Remastered 2008)', 'Prospettiva Nevski', [], ['Remastered 2008']],
  ['I Love You More (feat. Lowen) (Instrumental)', 'I Love You More', ['Instrumental'], ['feat. Lowen']],
  ['Get Money (feat. Junior M.A.F.I.A.) [2007 Remaster]', 'Get Money', [], ['feat. Junior M.A.F.I.A.', '2007 Remaster']],
  ['Six Days (Remix) [feat. Mos Def]', 'Six Days', ['Remix'], ['feat. Mos Def']],
];

// Parentheses that are PART of the title: they must never be taken for a version.
const UNTOUCHED = [
  '(It Goes Like) Nanana',
  'Are they Conscious (Interlude)',
  'Art of Now (Nature Sounds)',
  'One Summer\'s Day (From "Spirited Away")',
  'Honor (Main Title Theme from "the Pacific")',
  'Life (From "Prometheus" Soundtrack)',
  'Pangaea (Magic Feeling)',
  'Mafia Style (Gangster Trap)',
  'Magnolia Electric Co. (Deluxe Edition)',
  'Love Energy (888 Hz)',
  'HOTEL LOBBY (Unc & Phew)',
  "Naomi Sharon - I'm Not Your Toy",
  'Man of Steel - Flight',
  'Interstellar (Main Theme Piano)',
  'Luv(sic) Hexalogy',
  'Death Is No More(女子虽美 终究是鬼)',
  'Chest Pain (I Love)',
  'Right Now (Na Na Na)',
  'Born Slippy (Nuxx)',
  'Mazinga (Sigla Mazinga Robot)',
  'Plage Coquillage (First Kiss Song)',
  'Powerful Transformation (The Glow Up)',
  'Grace (Ambient Background Music)',
  'AVENGERS (THEME)',
  'Stay (With You)',
  'Wonder (Live Forever)',
  'Red Sex (Re-Strung)',
];

describe('parseSongTitle', () => {
  it.each(VERSIONS)('%s is a version of "%s"', (title, base, versions) => {
    expect(parseSongTitle(title)).toEqual({ base, versions, decorations: [] });
  });

  it.each(DECORATED)('%s: credits and remaster notes are decorations, not versions', (title, base, versions, decorations) => {
    expect(parseSongTitle(title)).toEqual({ base, versions, decorations });
  });

  it.each(UNTOUCHED)('%s is just a title', (title) => {
    expect(parseSongTitle(title)).toEqual({ base: title, versions: [], decorations: [] });
  });

  it('keeps a bracket that is not a marker even when another one is cut', () => {
    expect(parseSongTitle('If I Ruled the World (Imagine That) (feat. Lauryn Hill)')).toEqual({
      base: 'If I Ruled the World (Imagine That)',
      versions: [],
      decorations: ['feat. Lauryn Hill'],
    });
    expect(parseSongTitle('Flower In A Hurricane (feat. Tame Impala, SZA) [From GTAVI: Original Score]')).toEqual({
      base: 'Flower In A Hurricane [From GTAVI: Original Score]',
      versions: [],
      decorations: ['feat. Tame Impala, SZA'],
    });
  });

  it('never returns an empty title', () => {
    expect(parseSongTitle('(Instrumental)').base).toBe('(Instrumental)');
  });
});

describe('classifyGroup', () => {
  it('reads the words, not the punctuation or the numbers', () => {
    expect(classifyGroup('Slowed + Reverb')).toBe('version');
    expect(classifyGroup('Slowed & Reverb')).toBe('version');
    expect(classifyGroup('1991 Remix')).toBe('version');
    expect(classifyGroup('7" Version')).toBe('version');
    expect(classifyGroup('feat. A, B & C')).toBe('credit');
    expect(classifyGroup('2008 Remaster')).toBe('remaster');
    expect(classifyGroup('888 Hz')).toBe('title');
    expect(classifyGroup('')).toBe('title');
  });

  it('a named remix is a version whoever made it, a modifier alone is not', () => {
    expect(classifyGroup('DJ Whoever Remix')).toBe('version');
    expect(classifyGroup('Ultra')).toBe('title');
    expect(classifyGroup('Radio')).toBe('title');
    expect(classifyGroup('Radio Edit')).toBe('version');
    expect(classifyGroup('Sped Up')).toBe('version');
  });

  it('"live" opens a version only with a performance word after it', () => {
    expect(classifyGroup('Live')).toBe('version');
    expect(classifyGroup('Live from the studio')).toBe('version');
    expect(classifyGroup('Acoustic Sessions')).toBe('version');
    expect(classifyGroup('Live Forever')).toBe('title');
  });
});

describe('sameArtist', () => {
  it('shares a name, ignoring case, accents, "&" and credits', () => {
    expect(sameArtist('Post Malone', 'post malone')).toBe(true);
    expect(sameArtist('Sidewalks and Skeletons', 'Sidewalks & Skeletons')).toBe(true);
    expect(sameArtist('Ryutqc, NORWXXD REAPER, mety', 'Ryutqc')).toBe(true);
    expect(sameArtist('Tony Dark Eyes', 'Someone Else')).toBe(false);
    expect(sameArtist('Kanye West', 'Pusha T')).toBe(false);
  });

  it('a missing artist does not rule an original out', () => {
    expect(sameArtist('undefined', 'Sidewalks and Skeletons')).toBe(true);
    expect(sameArtist('', 'Anyone')).toBe(true);
    expect(sameArtist(null, 'Anyone')).toBe(true);
  });
});

describe('titleKey', () => {
  it('ignores case, accents and punctuation', () => {
    expect(titleKey('Amélie — Passacaglia!')).toBe(titleKey('amelie passacaglia'));
  });
});

describe('attachSongVersions', () => {
  it('links a version to its original, and only the version gets the pointer', () => {
    const original = song('Circles', 'Post Malone');
    const version = song('Circles (Instrumental)', 'Post Malone');
    attachSongVersions([original, version]);
    expect(version.versionOf).toEqual({ title: 'Circles', artist: 'Post Malone', songKey: original.songKey, labels: ['Instrumental'] });
    expect(original.versionOf).toBeUndefined();
  });

  it('with no original in the journal the label stays, without a link', () => {
    const a = song('Goth (Slowed + Reverb)', 'Sidewalks and Skeletons');
    const b = song('Goth (Slowed)', 'undefined');
    attachSongVersions([a, b]);
    expect(a.versionOf).toEqual({ title: 'Goth', artist: null, songKey: null, labels: ['Slowed + Reverb'] });
    expect(b.versionOf).toEqual({ title: 'Goth', artist: null, songKey: null, labels: ['Slowed'] });
  });

  it('a version is never the original of another version', () => {
    const slowed = song('Skins (Slowed)', 'KREZUS');
    const ultra = song('Skins (Ultra Slowed + Reverb)', 'KREZUS');
    attachSongVersions([slowed, ultra]);
    expect(slowed.versionOf?.songKey).toBeNull();
    expect(ultra.versionOf?.songKey).toBeNull();
  });

  it('the same title by another artist is not the original', () => {
    const other = song('Speed', 'Some Band');
    const version = song('Speed (Instrumental)', 'Tony Dark Eyes');
    attachSongVersions([other, version]);
    expect(version.versionOf).toEqual({ title: 'Speed', artist: null, songKey: null, labels: ['Instrumental'] });
  });

  it('an original with a missing artist is still the original of a version with an artist', () => {
    const original = song('Goth', 'undefined');
    const version = song('Goth (Slowed)', 'Sidewalks and Skeletons');
    attachSongVersions([original, version]);
    expect(version.versionOf?.songKey).toBe(original.songKey);
  });

  it('two possible originals: no link, the label stays', () => {
    const one = song('Runaway', 'Kanye West');
    const two = song('Runaway', 'Kanye West & Friends');
    const version = song('Runaway (Instrumental)', 'Kanye West');
    attachSongVersions([one, two, version]);
    expect(version.versionOf).toEqual({ title: 'Runaway', artist: null, songKey: null, labels: ['Instrumental'] });
  });

  it('a credit or a remaster note links to the original when it exists and says nothing when it does not', () => {
    const original = song('Runaway', 'Kanye West');
    const credited = song('Runaway (feat. Pusha T)', 'Kanye West');
    attachSongVersions([original, credited]);
    expect(credited.versionOf).toEqual({ title: 'Runaway', artist: 'Kanye West', songKey: original.songKey, labels: ['feat. Pusha T'] });

    const alone = song('Last Christmas (Remastered)', 'Wham!');
    attachSongVersions([alone]);
    expect(alone.versionOf).toBeUndefined();
  });

  it('leaves plain songs alone and touches nothing but versionOf', () => {
    const plain = song('Nightcall', 'Kavinsky');
    const version = song('Nightcall (Live)', 'Kavinsky');
    const before = JSON.stringify(plain);
    attachSongVersions([plain, version]);
    expect(JSON.stringify(plain)).toBe(before);
    const { versionOf, ...rest } = version;
    expect(versionOf).toBeDefined();
    expect(rest).toEqual({ ...song('Nightcall (Live)', 'Kavinsky') });
  });

  it('gives the same answer when run twice', () => {
    const songs = [song('Circles', 'Post Malone'), song('Circles (Instrumental)', 'Post Malone'), song('Goth (Slowed)', 'x')];
    attachSongVersions(songs);
    const first = JSON.stringify(songs);
    attachSongVersions(songs);
    expect(JSON.stringify(songs)).toBe(first);
  });
});
