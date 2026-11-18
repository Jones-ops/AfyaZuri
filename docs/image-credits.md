# Image credits

Every photograph in the Afyazuri UI is used under a licence that permits reuse in this software. Each one
is credited on screen next to where it appears (`PhotoCredit` in `apps/web/src/components/Photo.jsx`) and
listed here. Do not add an image without recording its source and licence in this file.

| File (`apps/web/public/images/`)              | Shows                                                                                  | Author / credit                                               | Licence                                                   | Source                                                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ward-nurse.webp`, `ward-nurse-sm.webp`       | A nurse reading notes on the paediatric ward, Lodwar District Hospital, Turkana        | Marisol Grandon / UK Department for International Development | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) | [Wikimedia Commons](<https://commons.wikimedia.org/wiki/File:Getting_treatment_for_malnutrition_in_northern_Kenya_(6220164120).jpg>) (originally DFID on Flickr, 6220164120) |
| `lodwar-doctor.webp`, `lodwar-doctor-sm.webp` | Dr Okemwa, acting medical superintendent, in the courtyard of Lodwar District Hospital | Marisol Grandon / UK Department for International Development | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) | [Wikimedia Commons](<https://commons.wikimedia.org/wiki/File:On_the_road_to_recovery_in_Lodwar_hospital_(6220162256).jpg>) (originally DFID on Flickr, 6220162256)           |

## Changes made

Both images were cropped and re-encoded as WebP, with a 1× and a 2× width, for low-bandwidth use (the
CC BY licence allows adaptation with attribution; the on-screen credit says "cropped"). The crops
deliberately leave out the patients who appear in the original photographs: the ward photo keeps only
the nurse and the ward, and the courtyard photo keeps the doctor and the buildings.

The DFID terms on the source page read: "You are free to embed, download or otherwise re-use it, as long
as you credit the source as 'Marisol Grandon/Department for International Development'."

## Considered and not used

- Public-domain photos of a US Army medical outreach in Kenya: they show military insignia, which is the
  wrong message for a civilian hospital system.
- A public-domain USAID photo from an HIV clinic waiting room: it shows an identifiable child in a
  setting that implies a diagnosis.
- Photos from Getty, iStock, Adobe Stock, Reuters and similar agencies: not licensed for this use.

## Adding an image

1. Use only CC0, public domain, CC BY, the Unsplash Licence or the Pexels Licence, and check the licence
   on the file's own page.
2. Avoid identifiable patients, especially children, and anything that implies a person's diagnosis.
3. Export as WebP at two widths (about 60 KB for the large one) and generate a tiny blurred placeholder.
4. Add it to `PHOTOS` in `Photo.jsx` with its credit, licence and source, and add a row above.
