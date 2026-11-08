import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_FILTER,
  actorLabel,
  categoryParamFor,
  matchesFunction,
  mergeFunctions,
  readActor,
} from './logActor';

describe('categoryParamFor', () => {
  it('sends the selected function as the category', () => {
    expect(categoryParamFor('jobQueueWorker')).toBe('jobQueueWorker');
    expect(categoryParamFor('sync')).toBe('sync');
  });

  it('the Attività option sends the four activity categories', () => {
    expect(ACTIVITY_CATEGORIES).toEqual(['playlist', 'sync', 'download', 'device']);
    expect(categoryParamFor(ACTIVITY_FILTER)).toBe('playlist,sync,download,device');
  });

  it('"all" and the placeholder "unknown" send nothing', () => {
    expect(categoryParamFor('all')).toBeUndefined();
    expect(categoryParamFor('unknown')).toBeUndefined();
  });
});

describe('matchesFunction', () => {
  it('all / one function / activity', () => {
    expect(matchesFunction('anything', 'all')).toBe(true);
    expect(matchesFunction('sync', 'sync')).toBe(true);
    expect(matchesFunction('sync', 'playlist')).toBe(false);
    expect(matchesFunction('download', ACTIVITY_FILTER)).toBe(true);
    expect(matchesFunction('jobQueueWorker', ACTIVITY_FILTER)).toBe(false);
  });
});

describe('mergeFunctions', () => {
  it('always offers the activity categories and keeps what was seen before', () => {
    expect(mergeFunctions(new Set(), [])).toEqual(['device', 'download', 'playlist', 'sync']);
    const seen = new Set(['jobQueueWorker', 'share']);
    expect(mergeFunctions(seen, ['sync'])).toEqual(['device', 'download', 'jobQueueWorker', 'playlist', 'share', 'sync']);
  });
});

describe('readActor / actorLabel', () => {
  it('reads user, device and channel', () => {
    const a = readActor({ action: 'prepare', actor: { user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' } });
    expect(a).toEqual({ user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' });
    expect(actorLabel(a!)).toBe('mike · iPhone di Michele');
  });

  it('no device on the web: just the user', () => {
    const a = readActor({ actor: { user: 'sara', device: null, channel: 'web' } });
    expect(actorLabel(a!)).toBe('sara');
  });

  it('is null when there is no usable actor', () => {
    for (const data of [null, undefined, {}, { actor: null }, { actor: 'mike' }, { actor: [] }, { actor: { device: 'x' } }, { actor: { user: '  ' } }]) {
      expect(readActor(data as never)).toBeNull();
    }
  });
});
