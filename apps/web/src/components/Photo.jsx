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
    height: 1117,
    alt: "A nurse reads a patient's notes on the paediatric ward at Lodwar District Hospital, Turkana",
    lqip: 'data:image/webp;base64,UklGRtAAAABXRUJQVlA4IMQAAADQBQCdASoYABwAPu1sq1GppaOiqAqpMB2JbACdINHJ/gHmAuC4ygl9GZA5vRAfNP+Ktna9EYWgANu48HAf/o3gSXWM5XEQw9CG4wTkiujU/LJ/xDUgd1KP1hlrOlQgLzqbzVYKo5Sd+hWEjOYFfR197LWuvbwCDoLG6ggZiu/W5i/p8Wsq24XZizPQlhvGH28wfis/tMbEnFDg7TI+myXWUXVubuzwoLL6sOQc9bF7r0ie6FfMpHFU2Kdt2u0rnbURdAAA',
    credit: 'Marisol Grandon / UK Department for International Development',
    license: 'CC BY 2.0',
    source:
      'https://commons.wikimedia.org/wiki/File:Getting_treatment_for_malnutrition_in_northern_Kenya_(6220164120).jpg',
  },
  lodwarDoctor: {
    src: '/images/lodwar-doctor.webp',
    srcSet: '/images/lodwar-doctor-sm.webp 800w, /images/lodwar-doctor.webp 1600w',
    width: 1600,
    height: 550,
    alt: 'The acting medical superintendent of Lodwar District Hospital in the hospital courtyard',
    lqip: 'data:image/webp;base64,UklGRmoAAABXRUJQVlA4IF4AAAAQBACdASoYAAgAPu1iqU2ppaOiMAgBMB2JZgCdMoADTsPTHClXLlCwJAD+zuBZJ1NnSmp110EDzymFJE1LUL++1hsBNJsLOvsXc/NTFijpDr9mbnCjwf7x63vC8AAA',
    credit: 'Marisol Grandon / UK Department for International Development',
    license: 'CC BY 2.0',
    source: 'https://commons.wikimedia.org/wiki/File:On_the_road_to_recovery_in_Lodwar_hospital_(6220162256).jpg',
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
