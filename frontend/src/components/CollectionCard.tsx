import { Link } from 'react-router-dom';
import { interpolate, useLanguage } from '../i18n';
import { initial } from '../utils/initial';
import type { CollectionListItem } from '../types';

/** The tiles of the mosaic of a card: the pictures the server sent (up to four) and neutral tiles for the rest. */
const MOSAIC_TILES = 4;

/**
 * A card of a collection (page «Raccolte», shelves of the Home): a 2×2 mosaic of pictures, the name, how many posts, and «New». It is a link to the
 * collection. The server sends the pictures; the card never chooses them.
 */
export function CollectionCard({ collection }: { collection: Pick<CollectionListItem, 'id' | 'name' | 'count' | 'isNew' | 'thumbs'> }) {
  const { t } = useLanguage();
  const tiles = Array.from({ length: MOSAIC_TILES }, (_, i) => collection.thumbs[i] ?? null);
  return (
    <Link to={`/collections/${encodeURIComponent(collection.id)}`} className="collection-card">
      {collection.thumbs.length > 0 ? (
        <span className="collection-mosaic" aria-hidden="true">
          {tiles.map((src, i) => (
            <span key={i} className="collection-tile">{src ? <img src={src} alt="" loading="lazy" /> : null}</span>
          ))}
        </span>
      ) : (
        // no picture at all: the first letter of the name, not four empty squares
        <span className="collection-mosaic is-empty" aria-hidden="true">{initial(collection.name)}</span>
      )}
      <span className="collection-card-name">{collection.name}</span>
      <span className="collection-card-sub">
        {interpolate(t.collectionPosts, { count: collection.count })}
        {collection.isNew && <span className="collection-new">{t.collectionNew}</span>}
      </span>
    </Link>
  );
}
