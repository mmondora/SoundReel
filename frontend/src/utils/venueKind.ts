import type { Translations } from '../i18n/translations';
import type { TextKey } from './homeSectionTitles';

/** The kinds of venue the server knows (`entryPlaces.ts`), each with the text that names it. `other` is not here: it says nothing about the venue. */
const KIND_TEXT: Record<string, TextKey> = {
  restaurant: 'venueKindRestaurant',
  pizzeria: 'venueKindPizzeria',
  bar: 'venueKindBar',
  cafe: 'venueKindCafe',
  hotel: 'venueKindHotel',
  refuge: 'venueKindRefuge',
  winery: 'venueKindWinery',
  shop: 'venueKindShop',
};

/** The kind of venue in the words of the page; `other` says nothing (null); a kind this site does not know (a newer server) is written as it came. */
export function venueKindLabel(kind: string, t: Translations): string | null {
  if (kind === 'other') return null;
  const key = KIND_TEXT[kind];
  return key ? t[key] : kind;
}
