import type { Translations } from '../i18n/translations';
import type { HomeSectionId } from '../types';

/** The keys of the translations that are one text (some are lists). */
export type TextKey = { [K in keyof Translations]: Translations[K] extends string ? K : never }[keyof Translations];

/** The name of each section of the Home: written on the Home and in the panel where the user orders them. */
export const HOME_SECTION_TITLE: Record<HomeSectionId, TextKey> = {
  resume: 'homeSectionResume',
  songs: 'homeSectionSongs',
  playlists: 'homeSectionPlaylists',
  collections: 'homeSectionCollections',
  films: 'homeSectionFilms',
};
