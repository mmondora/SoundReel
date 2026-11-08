import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import { SongVersionOf, songSearchLink } from './SongVersionOf';
import type { SongVersionOf as VersionOf } from '../types';

const render = (versionOf: VersionOf | undefined) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LanguageProvider>
        <SongVersionOf versionOf={versionOf} />
      </LanguageProvider>
    </MemoryRouter>,
  );

describe('SongVersionOf', () => {
  beforeEach(() => setStoredLanguage('it'));

  it('says "Versione di" with a link to the original and the kind of version', () => {
    const html = render({ title: 'Circles', artist: 'Post Malone', songKey: 'post malone::circles', labels: ['Instrumental'] });
    expect(html).toContain('song-version-of');
    expect(html).toContain('Versione di');
    expect(html).toContain('href="/songs?q=Circles"');
    expect(html).toContain('«Circles»');
    expect(html).toContain('Instrumental');
  });

  it('without an original in the journal the title is only a label, not a link', () => {
    const html = render({ title: 'Goth', artist: null, songKey: null, labels: ['Slowed + Reverb'] });
    expect(html).toContain('«Goth»');
    expect(html).toContain('Slowed + Reverb');
    expect(html).not.toContain('<a ');
  });

  it('joins several markers and skips empty ones', () => {
    const html = render({ title: 'As Time Flies', artist: null, songKey: null, labels: ['Special Version', ' ', 'Pitched + Slowed'] });
    expect(html).toContain('Special Version · Pitched + Slowed');
  });

  it('speaks English when the page does', () => {
    setStoredLanguage('en');
    expect(render({ title: 'Circles', artist: null, songKey: null, labels: ['Live'] })).toContain('Version of');
  });

  it('renders nothing for a song that is not a version', () => {
    expect(render(undefined)).toBe('');
  });

  it('builds a safe search link', () => {
    expect(songSearchLink('Shook Ones, Pt. II')).toBe('/songs?q=Shook%20Ones%2C%20Pt.%20II');
    expect(songSearchLink('Rock & Roll?')).toBe('/songs?q=Rock%20%26%20Roll%3F');
  });
});
