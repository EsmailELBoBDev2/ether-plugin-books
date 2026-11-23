# Books and audiobooks (`ether.books`)

Ether content plugin providing dedicated **Books** (`media: "book"`) and **Audiobooks** (`media: "audiobook"`) libraries.

## Features

- **Curated Home shelves**: Popular this week, New and notable, Award winners, Series to start, genre shelves, Free classics, Quick listens (<6h), Epic listens (20h+), and Top rated.
- **Rich browse tabs**: Home, Browse, Authors, Narrators (Audiobooks), Series (ordered by book index), Genres, Awards (Books), By length (Audiobooks), Free classics, History, and To read / To listen.
- **Zero-config public catalogs + optional Hardcover enrichment**:
  - Open Library for trending books, curated subjects, author portraits, and live search.
  - Audible public catalog API (metadata only) for audiobook editions, narrators, runtimes, unabridged flags, series order, and square artwork.
  - Standard Ebooks for carefully typeset, direct-download public-domain EPUBs.
  - LibriVox for free public-domain audiobooks with multi-part chapter MP3 playback (`hints.parts`).
  - Optional Hardcover API token (`hardcover_token`) for community ratings, trending reads, awards, and series catalogs.
- **Strict release matching**:
  - Prefers direct public-domain files when available.
  - Searches configured Ether indexers (`7000,7020` for books, `3030` for audiobooks), checks debrid cache, inspects `release_files` to select exact `.epub` / `.cbz` / `.pdf` or `.m4b` / ordered `.mp3` files with explicit `file` / `fileIndex` / `fileHint`, and rejects abridged releases when unabridged editions are requested.
  - Supports `/ether/job/prepare` slow resolution when deep file inspection exceeds the 5-second `/resolve` deadline.
- **Incremental sync (`/changes`) & live facet expansion (`/expand`)**:
  - Keeps searched, expanded, and read/listened titles alive across syncs and hydrates full author, narrator, series, and genre catalogs on demand.
