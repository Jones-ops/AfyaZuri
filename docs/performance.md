# Performance

## Patient search at 500 000 patients

**Target:** a search by MRN, name, phone, national ID or SHA number returns in under 300 ms with 500 000 patients (build prompt §6.1).

**How it's measured:** `npm run bench:search`. It loads 500 000 synthetic patients into a throwaway embedded PostgreSQL 16 and times the real search service 25 times per query type.

**Result** (2026-11-17, Windows 11 laptop, Node 26, embedded PostgreSQL 16, default settings):

| Query                                                   |      p50 |      p95 |
| ------------------------------------------------------- | -------: | -------: |
| MRN (exact)                                             |   3.2 ms |   4.8 ms |
| Phone (blind index)                                     |   3.9 ms |   5.4 ms |
| National ID (blind index)                               |   2.9 ms |   3.6 ms |
| Name, two words (`akinyi odhiambo`)                     |  39.0 ms |  46.2 ms |
| Name, partial (`wanj kari`)                             |  32.6 ms |  37.2 ms |
| Name, one common surname (`kiprotich`, ~21 000 matches) | 115.8 ms | 220.1 ms |
| Name with a typo (`otieno onyngo`)                      | 112.5 ms | 138.0 ms |

All of them are under target. The times are for the search service and database only; network time to the browser comes on top.

### What made the difference

The first benchmark run failed the target. Exact lookups took 120 ms at the median and up to 397 ms at p95, and typo searches found nothing. The fixes are in migration `20261117000003_search_indexes.js` and the search service:

| Problem                                                                                                                                                   | Fix                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identifier search looked up a blind-index hash without its type, but the index led with `type`, so every search containing digits scanned all identifiers | Index on `patient_identifiers (value_hash)`                                                                                                                                                        |
| Common surnames ranked every match by similarity before taking the top 20                                                                                 | GiST trigram index; `ORDER BY search_name <-> query LIMIT n` returns the nearest matches directly                                                                                                  |
| Misspelled names returned nothing                                                                                                                         | Typo-tolerant fallback using the GiST nearest-neighbour scan, with the similarity threshold applied to the top results (filtering with `%` made the planner use GIN and recheck thousands of rows) |

## Web app size

The initial JavaScript bundle is **about 120 KB gzipped**, against a 250 KB budget. Every page is loaded on demand: the QR library loads only on the 2FA and patient-card screens. The `slow-network` Playwright project checks sign-in and the staff list at 256 kbps with 300 ms latency.
