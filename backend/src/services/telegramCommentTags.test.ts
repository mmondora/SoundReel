import { describe, expect, it } from 'vitest';
import { extractTelegramCommentTags } from './telegramCommentTags';

const URL = 'https://www.instagram.com/reel/abc123/';

describe('extractTelegramCommentTags', () => {
  it('returns empty when message is only the URL', () => {
    expect(extractTelegramCommentTags(URL, URL)).toEqual([]);
    expect(extractTelegramCommentTags(`  ${URL}  `, URL)).toEqual([]);
  });

  it('extracts hashtags after the URL', () => {
    expect(extractTelegramCommentTags(`${URL} #vacanze #2024`, URL)).toEqual([
      '#vacanze',
      '#2024',
    ]);
  });

  it('extracts free words as tags', () => {
    expect(extractTelegramCommentTags(`${URL} da provare in tesla`, URL)).toEqual([
      'provare',
      'tesla',
    ]);
  });

  it('handles comment before the URL', () => {
    expect(extractTelegramCommentTags(`musica jazz ${URL}`, URL)).toEqual([
      'musica',
      'jazz',
    ]);
  });

  it('dedupes bare token and prefers # form', () => {
    expect(extractTelegramCommentTags(`${URL} Tesla TESLA #Tesla`, URL)).toEqual([
      '#tesla',
    ]);
  });

  it('skips stopwords and bare numbers', () => {
    expect(extractTelegramCommentTags(`${URL} the 42 and del post`, URL)).toEqual([]);
  });

  it('caps at 15 tags', () => {
    const words = Array.from({ length: 20 }, (_, i) => `tag${i}`).join(' ');
    expect(extractTelegramCommentTags(`${URL} ${words}`, URL)).toHaveLength(15);
  });

  it('strips www / trailing-slash URL variants and keeps comment tags', () => {
    const text = 'https://instagram.com/reel/abc123 #tesla vacanze';
    expect(extractTelegramCommentTags(text, URL)).toEqual(['#tesla', 'vacanze']);
  });

  it('extracts tags when comment is only words before a different URL form', () => {
    expect(extractTelegramCommentTags(`musica jazz ${URL}`, 'https://instagram.com/reel/abc123')).toEqual([
      'musica',
      'jazz',
    ]);
  });
});
