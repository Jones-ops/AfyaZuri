import { useState } from 'react';

/**
 * Licensed hospital photographs (see docs/image-credits.md). Each has a small and a large WebP
 * and a ~200-byte blurred placeholder that shows at once on slow links.
 */
export const PHOTOS = {
  wardNurse: {
    src: '/images/ward-nurse.webp',
    srcSet: '/images/ward-nurse-sm.webp 480w, /images/ward-nurse.webp 960w',
    width: 960,
    height: 1039,
    alt: "A nurse reads a patient's notes on a hospital ward",
    lqip: 'data:image/webp;base64,UklGRsoAAABXRUJQVlA4IL4AAACwBQCdASoYABoAPu1ur1IppiQiqAgBMB2JagCdMySuun/AKT174bxnRRszt+Qy3lF588SHJrwA27jwwMWVJGvFb3WeFxBRzAR9eA2DFaeProWEFwj0YwrjNeiKRlpU0h9pEs9tckYIYFg5ZUDWPVVk1GOUwao/PKc7APYAoJYSBcygrPiE5HNr6fpOUhuhvdmCePxRLmHXq4LM348pz9H6rjOxhcg56oyvimVZewpqvrlod5NVXZlLPgf4eXAA',
    credit: 'Marisol Grandon / UK Department for International Development',
    license: 'CC BY 2.0',
    source:
      'https://commons.wikimedia.org/wiki/File:Getting_treatment_for_malnutrition_in_northern_Kenya_(6220164120).jpg',
  },
  maternityMidwife: {
    src: '/images/maternity-midwife.webp',
    srcSet: '/images/maternity-midwife-sm.webp 800w, /images/maternity-midwife.webp 1600w',
    width: 1600,
    height: 500,
    alt: 'A midwife in a surgical cap and mask on a hospital maternity ward',
    lqip: 'data:image/webp;base64,UklGRm4AAABXRUJQVlA4IGIAAAAwBACdASoYAAgAPu1kqU2ppaQiMAgBMB2JQBOgBH9bTiQz0x5FcoV48AAA/p8MjJL67PT35yAtuh5qItmy1QzCGPikjausY6/9v5U8t38ZoxkXN+Lsok/y70OLCRzwTNHcAA==',
    credit: '1st Lt. Katherine Sibilla, U.S. Army',
    license: 'Public domain',
    source:
      'https://commons.wikimedia.org/wiki/File:US,_Ghana_midwives_team_up_in_maternity_ward_at_African_Lion_2025_(9047756).jpg',
  },
};

/**
 * A photo that fills its (positioned) parent: blurred placeholder first, then the real image fades
 * in with a slow settle. Pass `priority` for the above-the-fold image on a page.
 */
export function Photo({ photo, sizes = '100vw', position = '50% 50%', priority = false, className = '' }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span
      className={`absolute inset-0 overflow-hidden bg-cover bg-center ${className}`}
      style={{ backgroundImage: `url(${photo.lqip})` }}
    >
      <img
        src={photo.src}
        srcSet={photo.srcSet}
        sizes={sizes}
        width={photo.width}
        height={photo.height}
        alt={photo.alt}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        ref={(el) => {
          if (el?.complete && el.naturalWidth > 0) setLoaded(true); // already cached
        }}
        onLoad={() => setLoaded(true)}
        style={{ objectPosition: position }}
        className={`photo-pan h-full w-full object-cover transition-opacity duration-700 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
    </span>
  );
}

/** Attribution line required by the photo's licence. */
export function PhotoCredit({ photo, className = '' }) {
  return (
    <span className={className}>
      Photo: {photo.credit},{' '}
      <a className="underline decoration-current/50" href={photo.source} target="_blank" rel="noopener noreferrer">
        {photo.license}
      </a>
      , cropped
    </span>
  );
}
