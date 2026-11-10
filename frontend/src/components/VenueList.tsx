import { useId, useState } from 'react';
import { interpolate, useLanguage } from '../i18n';
import type { CollectionVenue } from '../types';
import { venueKindLabel } from '../utils/venueKind';
import { PostLinks } from './PostLinks';

/**
 * «Locali» (spec 2026-11-09-library-collections-auto-topics-design.md §4.6; Michele: «una sezione con i nomi dei ristoranti e un link a googlemap»):
 * one row for each venue the posts name, with what it is, the city, the posts that cite it (ONE row even when several posts name it, ADR-0017) and
 * «Apri in Maps». The address of Maps is built by the SERVER (`mapsUrl`); the site only opens it, in a new tab, without giving the page away.
 */
/** How many venues show before «Show all»: a long list would push the posts far down the page. */
const FIRST_VENUES = 5;

export function VenueList({ venues }: { venues: CollectionVenue[] }) {
  const { t } = useLanguage();
  const titleId = useId();   // a post open next to the collection shows a list too: one id each
  const [showAll, setShowAll] = useState(false);
  if (venues.length === 0) return null;
  const shown = showAll ? venues : venues.slice(0, FIRST_VENUES);
  return (
    <section className="venue-list" aria-labelledby={titleId}>
      <h3 id={titleId}>{t.collectionVenues}</h3>
      <ul>
        {shown.map((venue) => (
          <li key={venue.key} className="venue-row">
            <div className="venue-main">
              <span className="venue-name">{venue.name}</span>
              <span className="venue-sub">{[venueKindLabel(venue.kind, t), venue.place].filter(Boolean).join(' · ')}</span>
              <PostLinks mentions={venue.posts} />
            </div>
            <a
              className="venue-maps"
              href={venue.mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${t.collectionOpenInMaps}: ${venue.name}`}
            >
              {t.collectionOpenInMaps}
            </a>
          </li>
        ))}
      </ul>
      {shown.length < venues.length && (
        <button type="button" className="venue-show-all" onClick={() => setShowAll(true)}>
          {interpolate(t.collectionVenuesShowAll, { count: venues.length })}
        </button>
      )}
    </section>
  );
}
