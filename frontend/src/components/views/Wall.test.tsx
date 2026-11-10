import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Wall } from './Wall';
import type { PostCardModel } from './postCard';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';

// The Bacheca (look and feel P3, board B): a wall of cards, each post with its media in view (the first songs and films); a card opens the
// detail of the post (the page decides where: a panel that closes). Each card is a real button: keyboard, one tab stop, pressed state.

const t = translations.en;

const post = (id: string, over: Partial<PostCardModel> = {}): PostCardModel => ({
  id, platform: 'instagram', createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), thumbnailUrl: `https://img/${id}.jpg`,
  summary: `Summary of ${id}`, status: 'completed', songs: [], films: [], songCount: 0, filmCount: 0, noteCount: 0, tags: [], ...over,
});

function wall(posts: PostCardModel[], selectedId: string | null = null, onSelect: (id: string) => void = () => undefined) {
  return render(<LanguageProvider><Wall posts={posts} selectedId={selectedId} onSelect={onSelect} /></LanguageProvider>);
}

describe('the wall of posts', () => {
  it('is a list, one card per post, each a button that says what the post is about', () => {
    wall([post('a'), post('b')]);
    const list = screen.getByRole('list', { name: t.wallLabel });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Summary of a/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Summary of b/ })).toBeInTheDocument();
  });

  it('puts the first songs in view, «title — artist», and says how many more there are', () => {
    wall([post('a', {
      songs: [{ title: 'Nightcall', artist: 'Kavinsky' }, { title: 'Lux Aeterna', artist: 'Clint Mansell' }, { title: 'Honor', artist: 'Hans Zimmer' }],
      songCount: 5,
    })]);
    const card = screen.getByRole('button', { name: /Summary of a/ });
    expect(card).toHaveTextContent('Nightcall — Kavinsky');
    expect(card).toHaveTextContent('Honor — Hans Zimmer');
    expect(card).toHaveTextContent(t.wallMoreSongs.replace('{count}', '2'));
  });

  it('no «more» line when every song is in view', () => {
    wall([post('a', { songs: [{ title: 'One', artist: 'Solo' }], songCount: 1 })]);
    expect(screen.getByRole('button', { name: /Summary of a/ }).textContent).not.toContain(t.wallMoreSongs.replace('{count}', '0'));
    expect(screen.getByRole('button', { name: /Summary of a/ }).textContent).not.toMatch(/\+\d/);
  });

  it('puts the films in view with their year (none when unknown), and the films not in view are counted', () => {
    wall([post('a', { films: [{ title: 'Drive', year: '2011' }, { title: 'Heat', year: null }], filmCount: 4 })]);
    const card = screen.getByRole('button', { name: /Summary of a/ });
    expect(card).toHaveTextContent('Drive (2011)');
    expect(card).toHaveTextContent('Heat');
    expect(card.textContent).not.toContain('Heat (');
    expect(card).toHaveTextContent(t.wallMoreFilms.replace('{count}', '2'));
    expect(card.textContent).not.toContain('🎬 4');                                    // the films in view are not counted again as a chip
  });

  it('every film in view: no «+0 films»; no notes: no note chip', () => {
    wall([post('a', { films: [{ title: 'Drive', year: '2011' }], filmCount: 1 })]);
    const card = screen.getByRole('button', { name: /Summary of a/ });
    expect(card.textContent).not.toMatch(/\+\d/);
    expect(card.textContent).not.toContain('📝');
  });

  it('a list that carries only counts (the summaries) shows the counts, so the card is not bare', () => {
    wall([post('a', { songCount: 12, filmCount: 2, noteCount: 1 })]);
    const card = screen.getByRole('button', { name: /Summary of a/ });
    expect(card).toHaveTextContent('🎵 12');
    expect(card).toHaveTextContent('🎬 2');
    expect(card).toHaveTextContent('📝 1');
  });

  it('with songs in view the song count is not repeated as a chip; notes are always counted', () => {
    wall([post('a', { songs: [{ title: 'S', artist: 'A' }], songCount: 1, noteCount: 3 })]);
    const card = screen.getByRole('button', { name: /Summary of a/ });
    expect(card.textContent).not.toContain('🎵');
    expect(card).toHaveTextContent('📝 3');
  });

  it('shows the tags', () => {
    wall([post('a', { tags: ['jazz', 'vinyl'] })]);
    const card = screen.getByRole('button', { name: /Summary of a/ });
    expect(card).toHaveTextContent('jazz');
    expect(card).toHaveTextContent('vinyl');
  });

  it('shows how long ago the post was added', () => {
    wall([post('a')]);
    expect(screen.getByRole('button', { name: /Summary of a/ })).toHaveTextContent(t.hoursAgo.replace('{count}', '2'));
  });

  it('a click selects the post; the selected card is the pressed one', async () => {
    const onSelect = vi.fn();
    wall([post('a'), post('b')], 'b', onSelect);
    expect(screen.getByRole('button', { name: /Summary of b/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Summary of a/ })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: /Summary of a/ }));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('the keyboard opens a card too (Tab to it, Enter)', async () => {
    const onSelect = vi.fn();
    wall([post('a')], null, onSelect);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: /Summary of a/ })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('a picture that cannot be loaded gives way to the platform label; no picture at all is the label too', () => {
    wall([post('a', { thumbnailUrl: null, platform: 'tiktok' })]);
    const card = screen.getByRole('button', { name: /Summary of a/ });
    expect(card.querySelector('img')).toBeNull();
    expect(within(card).getAllByText('TT').length).toBeGreaterThan(0);
  });

  it('a broken picture falls back to the label', async () => {
    wall([post('a')]);
    const card = screen.getByRole('button', { name: /Summary of a/ });
    const img = card.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('alt', '');
    img.dispatchEvent(new Event('error'));
    await screen.findByText('IG', { selector: '.wall-thumb-placeholder' });
    expect(card.querySelector('img')).toBeNull();
  });

  it('a post being analysed and a failed one say so', () => {
    wall([post('a', { status: 'processing' }), post('b', { status: 'error' })]);
    expect(screen.getByRole('button', { name: /Summary of a/ }).querySelector('.wall-spinner')).not.toBeNull();
    expect(within(screen.getByRole('button', { name: /Summary of b/ })).getByTitle(t.error)).toBeInTheDocument();
  });

  it('another look (a class) and another name for the same list can be asked for, and the stand-in of a missing picture is not read aloud', () => {
    render(<LanguageProvider><Wall posts={[post('a', { thumbnailUrl: null })]} selectedId={null} onSelect={() => undefined} className="home-rail" label="Pick up" /></LanguageProvider>);
    const list = screen.getByRole('list', { name: 'Pick up' });
    expect(list).toHaveClass('wall', 'home-rail');
    expect(list.querySelector('.wall-thumb-placeholder')).toHaveAttribute('aria-hidden', 'true');
  });

  it('no posts: no list at all (the page says «nothing here»)', () => {
    wall([]);
    expect(screen.queryByRole('list')).toBeNull();
  });
});
