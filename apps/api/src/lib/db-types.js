// Postgres type parsing shared by everything that reads the database (API, scripts,
// benchmarks). Imported for its side effect by app.js and by services that use dates.
import pg from 'pg';

// Calendar dates (e.g. date of birth) stay 'YYYY-MM-DD' strings; never time-zone-shifted Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
