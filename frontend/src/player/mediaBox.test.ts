import { describe, expect, it } from 'vitest';
import {
  INITIAL_MEDIA_STATE,
  chooseMediaBox,
  coverCandidates,
  mediaReducer,
  pickCover,
  playingFrom,
} from './mediaBox';
import type { MediaEvent, MediaState } from './mediaBox';

const run = (events: MediaEvent[], from: MediaState = INITIAL_MEDIA_STATE): MediaState => events.reduce(mediaReducer, from);
const box = (events: MediaEvent[], from?: MediaState) => chooseMediaBox(run(events, from));

describe('chooseMediaBox: video or cover', () => {
  it('nothing loaded, or still deciding: the cover', () => {
    expect(chooseMediaBox(INITIAL_MEDIA_STATE)).toBe('cover');
    expect(box([{ type: 'songChanged', songKey: 'a::one' }])).toBe('cover');
  });

  it('the song plays from the LOCAL FILE (FS or media server): the album cover', () => {
    expect(box([{ type: 'songChanged', songKey: 'a::one' }, { type: 'localStarted', songKey: 'a::one', from: 'disk' }])).toBe('cover');
  });

  it('the song plays from the YouTube fallback and the video works: the VIDEO', () => {
    expect(box([{ type: 'songChanged', songKey: 'a::one' }, { type: 'videoRequested', songKey: 'a::one' }])).toBe('video');
  });

  it('the video cannot start (no id, embed blocked, player error): back to the cover', () => {
    expect(
      box([
        { type: 'songChanged', songKey: 'a::one' },
        { type: 'videoRequested', songKey: 'a::one' },
        { type: 'videoFailed', songKey: 'a::one' },
      ]),
    ).toBe('cover');
    // a failure reported without an earlier request still ends on the cover
    expect(box([{ type: 'songChanged', songKey: 'a::one' }, { type: 'videoFailed', songKey: 'a::one' }])).toBe('cover');
  });

  it('a local file that could not play falls through to the video (same song)', () => {
    expect(
      box([
        { type: 'songChanged', songKey: 'a::one' },
        { type: 'localStarted', songKey: 'a::one', from: 'disk' },
        { type: 'videoRequested', songKey: 'a::one' },
      ]),
    ).toBe('video');
  });
});

describe('song changes', () => {
  it('the box adjusts to each song: video → local file → video', () => {
    let s = run([{ type: 'songChanged', songKey: 'a::one' }, { type: 'videoRequested', songKey: 'a::one' }]);
    expect(chooseMediaBox(s)).toBe('video');
    s = run([{ type: 'songChanged', songKey: 'b::two' }, { type: 'localStarted', songKey: 'b::two', from: 'disk' }], s);
    expect(chooseMediaBox(s)).toBe('cover');
    s = run([{ type: 'songChanged', songKey: 'c::three' }, { type: 'videoRequested', songKey: 'c::three' }], s);
    expect(chooseMediaBox(s)).toBe('video');
  });

  it('a failed video does not follow the player to the next song', () => {
    let s = run([{ type: 'songChanged', songKey: 'a::one' }, { type: 'videoRequested', songKey: 'a::one' }, { type: 'videoFailed', songKey: 'a::one' }]);
    expect(chooseMediaBox(s)).toBe('cover');
    s = run([{ type: 'songChanged', songKey: 'b::two' }], s);
    expect(s).toEqual({ songKey: 'b::two', source: null, from: null, videoFailed: false });
    s = run([{ type: 'videoRequested', songKey: 'b::two' }], s);
    expect(chooseMediaBox(s)).toBe('video');
  });

  it('starting the same song over resets what was known about it', () => {
    const failed = run([{ type: 'songChanged', songKey: 'a::one' }, { type: 'videoFailed', songKey: 'a::one' }]);
    const again = run([{ type: 'songChanged', songKey: 'a::one' }, { type: 'videoRequested', songKey: 'a::one' }], failed);
    expect(chooseMediaBox(again)).toBe('video');
  });

  it('a late report about the PREVIOUS song is ignored', () => {
    const current = run([{ type: 'songChanged', songKey: 'b::two' }, { type: 'localStarted', songKey: 'b::two', from: 'disk' }]);
    const lates: MediaEvent[] = [
      { type: 'videoRequested', songKey: 'a::one' },
      { type: 'videoFailed', songKey: 'a::one' },
      { type: 'localStarted', songKey: 'a::one', from: 'media-server' },
      { type: 'downloadReady', songKey: 'a::one' },
    ];
    for (const late of lates) expect(mediaReducer(current, late)).toBe(current);
    expect(chooseMediaBox(current)).toBe('cover');
  });
});

describe('the first-play download finishing mid-song (rule W1)', () => {
  it('does not switch a song that plays from the VIDEO to the cover', () => {
    const playing = run([{ type: 'songChanged', songKey: 'a::one' }, { type: 'videoRequested', songKey: 'a::one' }]);
    const after = mediaReducer(playing, { type: 'downloadReady', songKey: 'a::one' });
    expect(after).toBe(playing);
    expect(chooseMediaBox(after)).toBe('video');
  });

  it('does not touch a song that already plays from the file, nor one whose video failed', () => {
    const local = run([{ type: 'songChanged', songKey: 'a::one' }, { type: 'localStarted', songKey: 'a::one', from: 'disk' }]);
    expect(chooseMediaBox(mediaReducer(local, { type: 'downloadReady', songKey: 'a::one' }))).toBe('cover');
    const failed = run([{ type: 'songChanged', songKey: 'a::one' }, { type: 'videoFailed', songKey: 'a::one' }]);
    expect(mediaReducer(failed, { type: 'downloadReady', songKey: 'a::one' })).toBe(failed);
  });

  it('only the NEXT play of that song comes from the file (a new songChanged + localStarted)', () => {
    let s = run([{ type: 'songChanged', songKey: 'a::one' }, { type: 'videoRequested', songKey: 'a::one' }, { type: 'downloadReady', songKey: 'a::one' }]);
    expect(chooseMediaBox(s)).toBe('video');
    s = run([{ type: 'songChanged', songKey: 'a::one' }, { type: 'localStarted', songKey: 'a::one', from: 'disk' }], s);
    expect(chooseMediaBox(s)).toBe('cover');
  });
});

describe('cover: song cover → entry thumbnail → placeholder, never an empty box', () => {
  it('orders the candidates and drops blanks and duplicates', () => {
    expect(coverCandidates('https://c/1.jpg', 'https://t/2.jpg')).toEqual(['https://c/1.jpg', 'https://t/2.jpg']);
    expect(coverCandidates(null, 'https://t/2.jpg')).toEqual(['https://t/2.jpg']);
    expect(coverCandidates('  ', undefined)).toEqual([]);
    expect(coverCandidates('https://same', 'https://same')).toEqual(['https://same']);
  });

  it('pickCover takes the first that has not failed to load; null = the neutral placeholder', () => {
    const list = ['https://c/1.jpg', 'https://t/2.jpg'];
    expect(pickCover(list, new Set())).toBe('https://c/1.jpg');
    expect(pickCover(list, new Set(['https://c/1.jpg']))).toBe('https://t/2.jpg');
    expect(pickCover(list, new Set(list))).toBeNull();
    expect(pickCover([], new Set())).toBeNull();
  });
});

describe('the actual source: what the player badge says and what the picture box follows (W4/W5)', () => {
  const song = (events: MediaEvent[], from?: MediaState) => run([{ type: 'songChanged', songKey: 'a::one' }, ...events], from);

  it('plays from the media server: the badge says so and the box shows the COVER', () => {
    const s = song([{ type: 'localStarted', songKey: 'a::one', from: 'media-server' }]);
    expect(playingFrom(s)).toBe('media-server');
    expect(chooseMediaBox(s)).toBe('cover');
  });

  it('plays from geekom’s disk: the badge says so and the box shows the COVER', () => {
    const s = song([{ type: 'localStarted', songKey: 'a::one', from: 'disk' }]);
    expect(playingFrom(s)).toBe('disk');
    expect(chooseMediaBox(s)).toBe('cover');
  });

  it('plays from Internet (YouTube): the badge says so and the box shows the VIDEO', () => {
    const s = song([{ type: 'videoRequested', songKey: 'a::one' }]);
    expect(playingFrom(s)).toBe('youtube');
    expect(chooseMediaBox(s)).toBe('video');
  });

  it('says nothing while it is still being decided, and nothing when the video failed', () => {
    expect(playingFrom(INITIAL_MEDIA_STATE)).toBeNull();
    expect(playingFrom(song([]))).toBeNull();
    const failed = song([{ type: 'videoRequested', songKey: 'a::one' }, { type: 'videoFailed', songKey: 'a::one' }]);
    expect(playingFrom(failed)).toBeNull();
    expect(chooseMediaBox(failed)).toBe('cover');
  });

  it('a home file that cannot play and falls through to the video: Internet and VIDEO', () => {
    const s = song([{ type: 'localStarted', songKey: 'a::one', from: 'media-server' }, { type: 'videoRequested', songKey: 'a::one' }]);
    expect(playingFrom(s)).toBe('youtube');
    expect(chooseMediaBox(s)).toBe('video');
  });

  it('each song brings its own source: media server → Internet → disk', () => {
    let s = song([{ type: 'localStarted', songKey: 'a::one', from: 'media-server' }]);
    s = run([{ type: 'songChanged', songKey: 'b::two' }, { type: 'videoRequested', songKey: 'b::two' }], s);
    expect([playingFrom(s), chooseMediaBox(s)]).toEqual(['youtube', 'video']);
    s = run([{ type: 'songChanged', songKey: 'c::three' }, { type: 'localStarted', songKey: 'c::three', from: 'disk' }], s);
    expect([playingFrom(s), chooseMediaBox(s)]).toEqual(['disk', 'cover']);
  });

  it('the first-play download finishing mid-song changes neither the badge nor the box (W1)', () => {
    const s = song([{ type: 'videoRequested', songKey: 'a::one' }]);
    const after = mediaReducer(s, { type: 'downloadReady', songKey: 'a::one' });
    expect(playingFrom(after)).toBe('youtube');
    expect(chooseMediaBox(after)).toBe('video');
  });
});
