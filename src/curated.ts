// Curated catalog orchestration, deduplication, KindItem conversion,
// incremental /changes state, /search, and /expand facet hydration.

import {
  cacheGet,
  cachePut,
  clearMetadataCache,
  loadItemSnapshot,
  loadSyncStats,
  nowSec,
  saveSyncStats,
  storeItemSnapshot,
  storePartUrls,
  type SyncStats,
} from "./cache.ts";
import {
  canonicalizeSeriesName,
  canonicalWorkTitle,
  dedupeSeriesEditions,
  editionQualityScore,
  isBoxSetOrOmnibus,
  isRejectedEntry,
  isSplitPartEdition,
  repairStoredKindItem,
  shouldDeleteStoredKindItem,
} from "./hygiene.ts";
import { fetchAudibleByAsin, fetchAudibleCatalog, searchAudible } from "./providers/audible.ts";
import { fetchHardcoverCatalog, searchHardcover } from "./providers/hardcover.ts";
import {
  fetchLibriVoxById,
  fetchLibriVoxCatalog,
  searchLibriVox,
} from "./providers/librivox.ts";
import {
  fetchOpenLibraryCatalog,
  hydrateOpenLibraryWork,
  searchOpenLibrary,
} from "./providers/openlibrary.ts";
import {
  fetchGutendexBooks,
  fetchStandardEbooks,
  searchStandardEbooks,
} from "./providers/standardebooks.ts";
import {
  canonicalizeGenres,
  dedupeStrings,
  deriveSortTitle,
  durationLengthBucket,
  extractSurname,
  fnv1aHex,
  normalizeText,
  rethrowIfHostFault,
} from "./text.ts";
import type {
  ItemHints,
  KindArtRef,
  KindItem,
  NormalizedEntry,
  PersonCredit,
  PluginSettings,
} from "./types.ts";

function dedupeKey(entry: NormalizedEntry): string {
  const titleNorm = canonicalWorkTitle(entry.title);
  const authorSurname = entry.authors[0]?.name ? extractSurname(entry.authors[0].name) : "";
  return `${entry.kind}:${titleNorm}:${authorSurname}`;
}

function mergePeople(primary: PersonCredit[], secondary: PersonCredit[]): PersonCredit[] {
  const byKey = new Map<string, PersonCredit>();
  for (const p of [...primary, ...secondary]) {
    const key = normalizeText(p.name);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...p });
    } else if (!prev.thumb && p.thumb) {
      prev.thumb = p.thumb;
    }
  }
  return Array.from(byKey.values()).slice(0, 8);
}

export function mergeEntries(entries: NormalizedEntry[], language = "en"): NormalizedEntry[] {
  const byKey = new Map<string, NormalizedEntry>();
  const order: string[] = [];

  for (const rawInput of entries) {
    if (!rawInput.title.trim()) continue;
    const raw: NormalizedEntry = {
      ...rawInput,
      series: canonicalizeSeriesName(rawInput.series),
    };
    if (isRejectedEntry(raw, language)) continue;

    const key = dedupeKey(raw);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, raw);
      order.push(key);
      continue;
    }

    const incomingWins = editionQualityScore(raw) > editionQualityScore(existing);
    const base = incomingWins ? { ...raw } : { ...existing };
    const other = incomingWins ? existing : raw;

    base.authors = mergePeople(base.authors, other.authors);
    if (base.kind === "audiobooks") {
      base.narrators = mergePeople(base.narrators || [], other.narrators || []);
      if (base.narrators.length === 0) base.narrators = undefined;
    }
    base.genres = dedupeStrings([...base.genres, ...other.genres], 6);
    base.curated = dedupeStrings([...base.curated, ...other.curated], 8);
    if (base.awards || other.awards) {
      base.awards = dedupeStrings([...(base.awards || []), ...(other.awards || [])], 6);
    }
    if (!base.summary && other.summary) base.summary = other.summary;
    if (!base.coverUrl && other.coverUrl) base.coverUrl = other.coverUrl;
    if ((!base.series && other.series) || (!base.seriesIndex && other.seriesIndex)) {
      base.series = canonicalizeSeriesName(other.series || base.series);
      base.seriesIndex = other.seriesIndex ?? base.seriesIndex;
      base.seriesNumber = other.seriesNumber || base.seriesNumber;
    }
    if (!base.isbn && other.isbn) base.isbn = other.isbn;
    if (!base.isbn13 && other.isbn13) base.isbn13 = other.isbn13;
    if (!base.asin && other.asin) base.asin = other.asin;
    if (!base.publisher && other.publisher) base.publisher = other.publisher;
    if (!base.pages && other.pages) base.pages = other.pages;
    if (!base.durationSec && other.durationSec) base.durationSec = other.durationSec;
    if (!base.year && other.year) base.year = other.year;
    if (!base.released && other.released) base.released = other.released;
    if (!base.rating && other.rating) base.rating = other.rating;
    if (other.directSources && other.directSources.length > 0) {
      base.directSources = [...(base.directSources || []), ...other.directSources];
    }
    if (!base.parts && other.parts) {
      base.parts = other.parts;
      base.partUrls = other.partUrls;
    }
    byKey.set(key, base);
  }

  return dedupeSeriesEditions(order.map((k) => byKey.get(k)!));
}

function displaySourceName(src: NormalizedEntry["source"]): string {
  switch (src) {
    case "hardcover":
      return "Hardcover";
    case "openlibrary":
      return "Open Library";
    case "standard-ebooks":
      return "Standard Ebooks";
    case "gutenberg":
      return "Project Gutenberg";
    case "audible":
      return "Audible";
    case "librivox":
      return "LibriVox";
    default:
      return "Open Library";
  }
}

function displayFormatName(fmt: NormalizedEntry["format"], isAudio: boolean): string {
  const f = (fmt || (isAudio ? "m4b" : "epub")).toUpperCase();
  if (isAudio) return f === "MP3" ? "MP3" : "M4B";
  if (f === "PDF" || f === "CBZ") return f;
  return "EPUB";
}

export function entryToKindItem(entry: NormalizedEntry): KindItem {
  const isAudio = entry.kind === "audiobooks";
  const art: KindArtRef[] = [];
  if (entry.coverUrl) {
    art.push({ role: "poster", url: entry.coverUrl });
    art.push({ role: "thumb", url: entry.coverUrl });
  }
  if (entry.backdropUrl) {
    art.push({ role: "backdrop", url: entry.backdropUrl });
  }

  const fields: Record<string, unknown> = {
    authors: entry.authors,
    source: displaySourceName(entry.source),
    format: displayFormatName(entry.format, isAudio),
    language: entry.language || "English",
  };
  if (entry.genres.length > 0) {
    fields.genres = entry.genres;
  }

  const canonSeries = canonicalizeSeriesName(entry.series);
  if (entry.curated.length > 0) fields.curated = entry.curated;
  if (canonSeries) fields.series = canonSeries;
  if (entry.seriesNumber) fields.series_number = entry.seriesNumber;
  if (entry.awards && entry.awards.length > 0) fields.awards = entry.awards;
  if (entry.publisher) fields.publisher = entry.publisher;
  if (entry.isbn) fields.isbn = entry.isbn;
  if (entry.releaseDate) fields.release_date = entry.releaseDate;

  if (isAudio) {
    if (entry.narrators && entry.narrators.length > 0) {
      fields.narrators = entry.narrators;
    }
    if (entry.durationSec && entry.durationSec > 0) {
      fields.duration = Math.round(entry.durationSec);
      const bucket = durationLengthBucket(entry.durationSec);
      if (bucket) fields.length = bucket;
    }
    fields.unabridged = entry.unabridged !== false;
    if (entry.asin) fields.asin = entry.asin;
  } else {
    if (entry.pages && entry.pages > 0) {
      fields.pages = Math.round(entry.pages);
    }
  }

  if (entry.partUrls && entry.partUrls.length > 0) {
    storePartUrls(entry.sourceId, entry.partUrls);
  }

  const hints: ItemHints = {
    kind: entry.kind,
    source: entry.source,
    sourceId: entry.sourceId,
    title: entry.title,
    authors: entry.authors.map((a) => a.name),
    narrators: entry.narrators?.map((n) => n.name),
    series: canonSeries,
    seriesNumber: entry.seriesNumber,
    year: entry.year,
    isbn: entry.isbn,
    isbn13: entry.isbn13,
    asin: entry.asin,
    durationSec: entry.durationSec,
    unabridged: entry.unabridged,
    language: entry.language,
    preferredFormat: entry.format,
    directSources: entry.directSources,
    parts: entry.parts,
  };

  // Enforce Ether's 16 KiB MaxKindHintsBytes limit safely for books with 100+ chapters
  // while preserving size and durationSec on every part for W196 multi-part playback.
  const MAX_HINTS_SAFE = 14_500;
  if (hints.parts && hints.parts.length > 0 && JSON.stringify(hints).length > MAX_HINTS_SAFE) {
    // Pass 1: keep full {name, mime, durationSec, size} with shorter chapter titles.
    hints.parts = hints.parts.map((p, idx) => ({
      name: p.name.length > 24 ? p.name.slice(0, 21).trim() + "..." : p.name || `Part ${idx + 1}`,
      mime: p.mime,
      durationSec: p.durationSec,
      size: p.size,
    }));
  }
  if (hints.parts && hints.parts.length > 0 && JSON.stringify(hints).length > MAX_HINTS_SAFE) {
    // Pass 2: omit redundant per-part mime (resolver still returns audio/mpeg) while keeping size & durationSec.
    hints.parts = hints.parts.map((p, idx) => ({
      name: p.name.length > 24 ? p.name.slice(0, 21).trim() + "..." : p.name || `Part ${idx + 1}`,
      durationSec: p.durationSec,
      size: p.size,
    }));
  }
  if (hints.parts && hints.parts.length > 0 && JSON.stringify(hints).length > MAX_HINTS_SAFE) {
    // Pass 3: ultra-long audiobooks (200+ sections) — compact numbered labels with size & durationSec intact.
    hints.parts = hints.parts.map((p, idx) => ({
      name: `Part ${idx + 1}`,
      durationSec: p.durationSec,
      size: p.size,
    }));
  }
  if (hints.parts && hints.parts.length > 0 && JSON.stringify(hints).length > MAX_HINTS_SAFE) {
    hints.parts = hints.parts.slice(0, 250).map((p, idx) => ({
      name: `P${idx + 1}`,
      durationSec: p.durationSec,
      size: p.size,
    }));
  }

  const subNorm = entry.subtitle ? normalizeText(entry.subtitle) : "";
  const titleAlreadyHasSub = Boolean(subNorm && normalizeText(entry.title).includes(subNorm));
  const titleDisplay =
    entry.subtitle && entry.title.length < 40 && !titleAlreadyHasSub
      ? `${entry.title}: ${entry.subtitle}`
      : entry.title;

  const item: KindItem = {
    id: entry.sourceId,
    level: isAudio ? "audiobook" : "book",
    index: entry.seriesIndex && entry.seriesIndex > 0 ? entry.seriesIndex : undefined,
    title: titleDisplay,
    sortTitle: deriveSortTitle(titleDisplay),
    summary: entry.summary,
    year: entry.year,
    released: entry.released,
    rating: entry.rating,
    playable: true,
    art: art.length > 0 ? art : undefined,
    fields,
    hints,
  };
  item.etag = fnv1aHex(
    `${item.id}|${item.title}|${item.year || 0}|${item.rating || 0}|${canonSeries || ""}|${item.index || 0}|${entry.publisher || ""}|${entry.curated.join(",")}|${entry.genres.join(",")}|${entry.coverUrl || ""}|${hints.parts?.length || 0}|${hints.parts?.[0]?.size || 0}`,
  );
  return item;
}

export function buildCatalogItems(
  kind: "books" | "audiobooks",
  settings: PluginSettings,
): KindItem[] {
  const cacheKey = `cat3:${kind}:${settings.language}:${settings.catalogSize}:${settings.hardcoverToken ? "hc1" : "hc0"}:${settings.enableOpenLibrary ? 1 : 0}${settings.enableAudibleMetadata ? 1 : 0}${settings.enableStandardEbooks ? 1 : 0}${settings.enableLibriVox ? 1 : 0}${settings.enableGutenberg ? 1 : 0}`;
  const cached = cacheGet<KindItem[]>(cacheKey);
  if (cached && cached.length > 0) {
    return cached;
  }

  const raw: NormalizedEntry[] = [];
  const sourceStats: Record<string, { ok: boolean; count: number; note?: string }> = {};

  if (kind === "books") {
    if (settings.hardcoverToken) {
      const hc = fetchHardcoverCatalog("books", settings);
      sourceStats["hardcover_books"] = { ok: hc.length > 0, count: hc.length };
      raw.push(...hc);
    }
    if (settings.enableOpenLibrary) {
      const ol = fetchOpenLibraryCatalog(settings);
      sourceStats["openlibrary"] = { ok: ol.length > 0, count: ol.length };
      raw.push(...ol);
    }
    if (settings.enableStandardEbooks) {
      const se = fetchStandardEbooks(settings, settings.catalogSize === "compact" ? 20 : 40);
      sourceStats["standard_ebooks"] = { ok: se.length > 0, count: se.length };
      raw.push(...se);
    }
    if (settings.enableGutenberg) {
      const gdx = fetchGutendexBooks(settings, "", 20);
      sourceStats["gutenberg"] = { ok: gdx.length > 0, count: gdx.length };
      raw.push(...gdx);
    }
  } else {
    if (settings.enableAudibleMetadata) {
      const aud = fetchAudibleCatalog(settings);
      sourceStats["audible"] = { ok: aud.length > 0, count: aud.length };
      raw.push(...aud);
    }
    if (settings.hardcoverToken) {
      const hc = fetchHardcoverCatalog("audiobooks", settings);
      sourceStats["hardcover_audiobooks"] = { ok: hc.length > 0, count: hc.length };
      raw.push(...hc);
    }
    if (settings.enableLibriVox) {
      const lv = fetchLibriVoxCatalog(settings);
      sourceStats["librivox"] = { ok: lv.length > 0, count: lv.length };
      raw.push(...lv);
    }
  }

  const merged = mergeEntries(raw, settings.language);
  const items = merged.map(entryToKindItem);

  if (items.length > 0) {
    cachePut(cacheKey, items, 3 * 3600);
    // Keep snapshots for quick /items/{id} lookups and preserving curated metadata during /search
    for (let i = 0; i < Math.min(items.length, 300); i++) {
      storeItemSnapshot(kind, items[i]);
    }
  }

  // Update sync stats
  const prevStats: SyncStats = loadSyncStats() || {
    booksCount: 0,
    audiobooksCount: 0,
    lastSyncAt: 0,
    sources: {},
  };
  if (kind === "books") prevStats.booksCount = items.length;
  else prevStats.audiobooksCount = items.length;
  prevStats.lastSyncAt = nowSec();
  prevStats.sources = { ...prevStats.sources, ...sourceStats };
  saveSyncStats(prevStats);

  return items;
}

// Preserve curated catalog metadata (series, index, curated shelves, awards, richer genres)
// when live /search or /expand returns an item that already exists in our snapshot cache.
function mergeWithExistingSnapshot(kind: "books" | "audiobooks", item: KindItem): KindItem {
  const prev = loadItemSnapshot(kind, item.id);
  if (!prev) return item;
  const next: KindItem = {
    ...item,
    fields: { ...item.fields },
    hints: { ...item.hints },
  };
  if ((!next.index || !next.fields.series) && prev.fields?.series) {
    next.fields.series = canonicalizeSeriesName(String(prev.fields.series));
    next.hints.series = typeof next.fields.series === "string" ? next.fields.series : next.hints.series;
    if (prev.index && !next.index) next.index = prev.index;
    if (prev.fields.series_number && !next.fields.series_number) {
      next.fields.series_number = prev.fields.series_number;
      next.hints.seriesNumber = String(prev.fields.series_number);
    }
  }
  if (Array.isArray(prev.fields?.curated) && prev.fields.curated.length > 0) {
    const cur = Array.isArray(next.fields.curated) ? (next.fields.curated as string[]) : [];
    next.fields.curated = dedupeStrings([...(prev.fields.curated as string[]), ...cur], 8);
  }
  if (Array.isArray(prev.fields?.awards) && prev.fields.awards.length > 0) {
    const cur = Array.isArray(next.fields.awards) ? (next.fields.awards as string[]) : [];
    next.fields.awards = dedupeStrings([...(prev.fields.awards as string[]), ...cur], 6);
  }
  if (Array.isArray(prev.fields?.genres) && prev.fields.genres.length > 0) {
    const cur = Array.isArray(next.fields.genres) ? (next.fields.genres as string[]) : [];
    if (cur.length === 0) next.fields.genres = prev.fields.genres;
  }
  if (!next.art && prev.art) next.art = prev.art;
  return next;
}

export function liveSearchCatalog(
  kind: "books" | "audiobooks",
  query: string,
  settings: PluginSettings,
  limit = 24,
): KindItem[] {
  const q = query.trim();
  if (!q) return [];
  const raw: NormalizedEntry[] = [];

  if (kind === "books") {
    if (settings.enableStandardEbooks) {
      raw.push(...searchStandardEbooks(q, settings, 8));
    }
    if (settings.hardcoverToken) {
      raw.push(...searchHardcover("books", q, settings, 12));
    }
    if (settings.enableOpenLibrary) {
      raw.push(...searchOpenLibrary(q, settings, { limit: Math.min(limit, 24) }));
    }
    if (settings.enableGutenberg && raw.length < limit) {
      raw.push(...fetchGutendexBooks(settings, q, 10));
    }
  } else {
    if (settings.enableAudibleMetadata) {
      raw.push(...searchAudible(q, settings, { limit: Math.min(limit, 24) }));
    }
    if (settings.enableLibriVox) {
      raw.push(...searchLibriVox(q, settings, 10));
    }
    if (settings.hardcoverToken) {
      raw.push(...searchHardcover("audiobooks", q, settings, 10));
    }
  }

  const items = mergeEntries(raw, settings.language)
    .map((e) => mergeWithExistingSnapshot(kind, entryToKindItem(e)))
    .slice(0, limit);
  for (const item of items) {
    storeItemSnapshot(kind, item);
  }
  return items;
}

export function expandCatalogFacet(
  kind: "books" | "audiobooks",
  facet: string,
  value: string,
  cursor: string | undefined,
  settings: PluginSettings,
): { items: KindItem[]; cursor?: string } {
  const pageNum = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1;
  if (pageNum > 3) return { items: [] };

  const raw: NormalizedEntry[] = [];
  const rawVal = value.trim();
  if (!rawVal) return { items: [] };
  const val = facet === "series" ? canonicalizeSeriesName(rawVal) || rawVal : rawVal;

  if (kind === "books") {
    if (facet === "authors") {
      if (settings.enableOpenLibrary) {
        raw.push(...searchOpenLibrary("", settings, { author: val, limit: 25, page: pageNum }));
      }
      if (pageNum === 1 && settings.enableStandardEbooks) {
        raw.push(...searchStandardEbooks(val, settings, 12));
      }
      if (pageNum === 1 && settings.hardcoverToken) {
        raw.push(...searchHardcover("books", val, settings, 15));
      }
    } else if (facet === "series") {
      if (settings.enableOpenLibrary) {
        raw.push(...searchOpenLibrary(val, settings, { limit: 25, page: pageNum }));
      }
      if (pageNum === 1 && settings.hardcoverToken) {
        raw.push(...searchHardcover("books", val, settings, 15));
      }
    } else if (facet === "genres") {
      if (settings.enableOpenLibrary) {
        raw.push(...searchOpenLibrary("", settings, { subject: val, limit: 25, page: pageNum }));
      }
    }
  } else {
    if (facet === "authors") {
      if (settings.enableAudibleMetadata) {
        raw.push(...searchAudible("", settings, { author: val, limit: 25, page: pageNum }));
      }
      if (pageNum === 1 && settings.enableLibriVox) {
        raw.push(...searchLibriVox(val, settings, 12));
      }
    } else if (facet === "narrators") {
      if (settings.enableAudibleMetadata) {
        raw.push(...searchAudible("", settings, { narrator: val, limit: 25, page: pageNum }));
      }
    } else if (facet === "series") {
      if (settings.enableAudibleMetadata) {
        raw.push(...searchAudible(val, settings, { limit: 25, page: pageNum }));
      }
    } else if (facet === "genres") {
      if (settings.enableAudibleMetadata) {
        raw.push(...searchAudible("", settings, { genre: val, limit: 25, page: pageNum }));
      }
    }
  }

  const stripSeriesNoise = (s: string) =>
    normalizeText(canonicalizeSeriesName(s) || s)
      .replace(/^the\s+/, "")
      .replace(/\s+(?:series|saga|cycle|trilogy|chronicles|quartet|sequence)$/, "")
      .trim();
  const valNorm = stripSeriesNoise(val);

  // Pre-filter series candidates before canonical merge so only genuine series editions compete
  const prefiltered =
    facet === "series"
      ? raw.filter((e) => {
          if (isBoxSetOrOmnibus(e.title, e.subtitle, e.series || val)) return false;
          if (isSplitPartEdition(e.title, e.subtitle, kind, true)) return false;
          const sNorm = stripSeriesNoise(e.series || "");
          if (!sNorm || !valNorm) return false;
          return sNorm === valNorm || sNorm.includes(valNorm) || valNorm.includes(sNorm);
        })
      : raw;

  if (facet === "series") {
    for (const e of prefiltered) {
      e.series = val;
    }
  }

  const merged = mergeEntries(prefiltered, settings.language);
  const items = merged.map((e) => {
    const item = mergeWithExistingSnapshot(kind, entryToKindItem(e));
    if (facet === "series") {
      item.fields.series = val;
      item.hints.series = val;
    } else if (facet === "genres") {
      const existing = Array.isArray(item.fields.genres) ? (item.fields.genres as string[]) : [];
      if (!existing.includes(val)) item.fields.genres = [val, ...existing];
    }
    storeItemSnapshot(kind, item);
    return item;
  });

  return {
    items,
    cursor: items.length >= 20 && pageNum < 3 ? String(pageNum + 1) : undefined,
  };
}

// Reconcile already-stored library items on revision upgrades via ether.kinds.items():
// - Emit deletes for previously-imported junk (posters, merch, sheet music, GraphicAudio
//   dramatised editions in books, split-part editions, box sets, and duplicate series editions).
// - Emit repaired upserts for retained legitimate items (e.g. misclassified biographies,
//   duplicated subtitles, un-canonicalized series names).
export function reconcileStoredCatalog(
  kind: "books" | "audiobooks",
  freshCatalog: KindItem[],
  settings: PluginSettings,
): { extraUpserts: KindItem[]; deletes: string[]; suppressedFreshIds: string[] } {
  const freshById = new Map<string, KindItem>();
  const seriesClaimedWorks = new Map<string, Set<string>>();
  const seriesClaimedSlots = new Map<string, Set<string>>();
  const seriesAuthorCounts = new Map<string, Map<string, number>>();
  const seriesProseCounts = new Map<string, number>();

  const registerSeriesClaim = (item: KindItem) => {
    const rawSeries = typeof item.fields?.series === "string" ? item.fields.series : "";
    const canon = canonicalizeSeriesName(rawSeries);
    if (!canon) return;
    const sKey = normalizeText(canon);
    const works = seriesClaimedWorks.get(sKey) || new Set<string>();
    works.add(canonicalWorkTitle(item.title));
    seriesClaimedWorks.set(sKey, works);

    if (item.index && item.index > 0) {
      const sn = typeof item.fields?.series_number === "string" ? item.fields.series_number : "";
      const slotKey = sn.includes(".") ? `f:${sn}` : `i:${item.index}`;
      const slots = seriesClaimedSlots.get(sKey) || new Set<string>();
      slots.add(slotKey);
      seriesClaimedSlots.set(sKey, slots);
    }

    const auths = Array.isArray(item.fields?.authors)
      ? (item.fields.authors as Array<{ name?: string } | string>).map((a) =>
          typeof a === "string" ? a : a?.name || "",
        )
      : item.hints?.authors || [];
    const ac = seriesAuthorCounts.get(sKey) || new Map<string, number>();
    for (const a of auths) {
      const sn = extractSurname(a);
      if (sn) ac.set(sn, (ac.get(sn) || 0) + 1);
    }
    seriesAuthorCounts.set(sKey, ac);

    const genres = Array.isArray(item.fields?.genres) ? (item.fields.genres as string[]) : [];
    if (!genres.includes("Comics and graphic novels")) {
      seriesProseCounts.set(sKey, (seriesProseCounts.get(sKey) || 0) + 1);
    }
  };

  for (const item of freshCatalog) {
    freshById.set(item.id, item);
  }

  // Read existing items stored in Ether's library (bounded to 10 pages = 2,000 items)
  const stored: KindItem[] = [];
  let cursor = "";
  for (let pageIdx = 0; pageIdx < 10; pageIdx++) {
    let page: { items?: KindItem[]; nextCursor?: string } | null = null;
    try {
      page = ether.kinds?.items ? ether.kinds.items(kind, cursor, 200) : null;
    } catch (err) {
      rethrowIfHostFault(err);
      break;
    }
    if (!page || !Array.isArray(page.items) || page.items.length === 0) break;
    stored.push(...page.items);
    if (!page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }

  if (stored.length === 0) {
    return { extraUpserts: [], deletes: [], suppressedFreshIds: [] };
  }

  const storedIds = new Set<string>();
  for (const item of stored) {
    if (item?.id) storedIds.add(item.id);
  }

  const deletes: string[] = [];
  const extraUpserts: KindItem[] = [];
  const seenDelete = new Set<string>();
  const suppressedFreshIds = new Set<string>();
  let hydratedLibriVoxCount = 0;

  const markDelete = (id: string, allowFresh = false) => {
    if (!id || seenDelete.has(id) || (!allowFresh && freshById.has(id))) return;
    seenDelete.add(id);
    deletes.push(id);
    try {
      ether.kv.delete(`item:${kind}:${id}`);
    } catch {
      // ignore KV cleanup error
    }
  };

  // Collapse duplicate audiobook recordings across fresh + stored items by canonical
  // work:surname, skipping multi-part split titles and merging narrators (up to 8).
  // Playable copies with parts outrank fresh metadata-only copies, and merged narrators
  // are applied to the keeper whether it is fresh or stored.
  const recordingKeepers: KindItem[] = [];
  if (kind === "audiobooks") {
    const SPLIT_RE =
      /\b(?:part|pt|vol|volume|chapter|book|disc|cd)\.?\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|[ivx]+)\b/i;
    const VARIANT_RE =
      /[\(\[][^()\[\]]*(?:version\s*\d+|dramatic\s+reading|dramati[sz]|abridged|full\s+cast|multi-?cast|solo\s+reading)[^()\[\]]*[\)\]]/i;
    const hasPlayableParts = (item: KindItem): boolean =>
      (Array.isArray(item.hints?.parts) && item.hints.parts.length > 0) ||
      (Array.isArray(item.hints?.directSources) && item.hints.directSources.length > 0);
    const authorsOf = (item: KindItem): string[] =>
      Array.isArray(item.fields?.authors)
        ? (item.fields.authors as Array<{ name?: string } | string>).map((a) =>
            typeof a === "string" ? a : a?.name || "",
          )
        : item.hints?.authors || [];
    const workKeyOf = (item: KindItem): string => {
      const title = String(item.title || "");
      if (!title || SPLIT_RE.test(title)) return "";
      const surname = extractSurname(authorsOf(item)[0] || "");
      const work = canonicalWorkTitle(title);
      if (!surname || !work) return "";
      return `${work}:${surname}`;
    };

    type GroupMember = { item: KindItem; fresh: boolean };
    const groups = new Map<string, GroupMember[]>();
    const addMember = (item: KindItem, fresh: boolean) => {
      const key = workKeyOf(item);
      if (!key) return;
      const g = groups.get(key) || [];
      g.push({ item, fresh });
      groups.set(key, g);
    };

    for (const item of freshCatalog) {
      addMember(item, true);
    }
    for (const item of stored) {
      if (!item?.id || freshById.has(item.id)) continue;
      if (shouldDeleteStoredKindItem(kind, item, settings.language)) continue;
      addMember(item, false);
    }

    // Playable copies with parts (+20) always outrank metadata-only fresh copies (+10).
    const score = (m: GroupMember): number =>
      (hasPlayableParts(m.item) ? 20 : 0) +
      (m.fresh ? 10 : 0) +
      (VARIANT_RE.test(String(m.item.title || "")) ? 0 : 2) +
      Math.min(1, (Number(m.item.rating) || 0) / 10);

    for (const members of groups.values()) {
      if (members.length < 2) continue;
      let keeper = members[0];
      for (const m of members) {
        if (score(m) > score(keeper)) keeper = m;
      }

      const names = new Map<string, PersonCredit>();
      const collectNarrators = (item: KindItem) => {
        const fieldList = Array.isArray(item.fields?.narrators) ? item.fields.narrators : [];
        const rawList: unknown[] =
          fieldList.length > 0
            ? fieldList
            : Array.isArray(item.hints?.narrators)
              ? item.hints.narrators
              : [];
        for (const n of rawList) {
          const obj: PersonCredit =
            typeof n === "string"
              ? { name: n.trim(), role: "Narrator" }
              : {
                  ...(n as PersonCredit),
                  name: String((n as PersonCredit)?.name || "").trim(),
                  role: (n as PersonCredit)?.role || "Narrator",
                };
          const k = normalizeText(obj.name);
          if (!k) continue;
          const prev = names.get(k);
          if (!prev) names.set(k, obj);
          else if (!prev.thumb && obj.thumb) prev.thumb = obj.thumb;
        }
      };

      collectNarrators(keeper.item);
      const before = names.size;
      for (const m of members) {
        if (m === keeper) continue;
        if (hasPlayableParts(m.item) && !hasPlayableParts(keeper.item)) continue;
        collectNarrators(m.item);
        if (m.fresh) {
          suppressedFreshIds.add(m.item.id);
          freshById.delete(m.item.id);
          if (storedIds.has(m.item.id)) {
            markDelete(m.item.id, true);
          }
        } else {
          markDelete(m.item.id);
        }
      }

      if (names.size > before && before < 8) {
        const mergedNarrators = Array.from(names.values()).slice(0, 8);
        keeper.item.fields = {
          ...(keeper.item.fields || {}),
          narrators: mergedNarrators,
        };
        keeper.item.hints = {
          ...(keeper.item.hints || {}),
          narrators: mergedNarrators.map((n) => n.name),
        };
        keeper.item.etag = fnv1aHex(
          `${keeper.item.etag || keeper.item.id}|rec${mergedNarrators.length}`,
        );
        recordingKeepers.push(keeper.item);
      }
    }
  }

  // Register series claims only for non-suppressed fresh items so a suppressed fresh
  // metadata-only duplicate cannot evict a stored keeper with playable parts.
  for (const item of freshCatalog) {
    if (!suppressedFreshIds.has(item.id)) {
      registerSeriesClaim(item);
    }
  }

  // Determine dominant author per series across fresh + numbered stored items
  const dominantAuthorBySeries = new Map<string, string>();
  for (const [sKey, counts] of seriesAuthorCounts) {
    let best = "";
    let bestCnt = 0;
    for (const [sn, cnt] of counts) {
      if (cnt > bestCnt) {
        best = sn;
        bestCnt = cnt;
      }
    }
    if (bestCnt >= 2) dominantAuthorBySeries.set(sKey, best);
  }

  for (const item of stored) {
    if (!item.id || freshById.has(item.id)) continue;
    if (seenDelete.has(item.id)) continue;

    if (shouldDeleteStoredKindItem(kind, item, settings.language)) {
      markDelete(item.id);
      continue;
    }

    // Check series-level deduplication against fresh canonical catalog + earlier kept stored items
    const rawSeries = typeof item.fields?.series === "string" ? item.fields.series : "";
    const canonSeries = canonicalizeSeriesName(rawSeries);
    if (canonSeries) {
      const sKey = normalizeText(canonSeries);
      const workKey = canonicalWorkTitle(item.title);
      const works = seriesClaimedWorks.get(sKey);
      if (works && works.has(workKey)) {
        markDelete(item.id);
        continue;
      }

      if (item.index && item.index > 0) {
        const sn = typeof item.fields?.series_number === "string" ? item.fields.series_number : "";
        const slotKey = sn.includes(".") ? `f:${sn}` : `i:${item.index}`;
        const slots = seriesClaimedSlots.get(sKey);
        if (slots && slots.has(slotKey)) {
          markDelete(item.id);
          continue;
        }
      }

      // Drop comics spinoffs (or comic "Vol. N" spinoffs) mixed into prose novel series
      const genres = Array.isArray(item.fields?.genres) ? (item.fields.genres as string[]) : [];
      if (
        kind === "books" &&
        (seriesProseCounts.get(sKey) || 0) >= 2 &&
        !item.index &&
        (genres.includes("Comics and graphic novels") || /\bvol\.?\s*\d+\b/i.test(item.title))
      ) {
        markDelete(item.id);
        continue;
      }

      // Drop unrelated author coincidences inside established series
      const domAuthor = dominantAuthorBySeries.get(sKey);
      if (domAuthor && !item.index) {
        const auths = Array.isArray(item.fields?.authors)
          ? (item.fields.authors as Array<{ name?: string } | string>).map((a) =>
              typeof a === "string" ? a : a?.name || "",
            )
          : item.hints?.authors || [];
        const surnames = auths.map((a) => extractSurname(a)).filter(Boolean);
        if (!surnames.includes(domAuthor)) {
          markDelete(item.id);
          continue;
        }
      }

      // Claim this stored series item's work & slot so duplicate stored copies collapse
      registerSeriesClaim(item);
    }

    // Backfill W196 hints.parts ({name, mime, durationSec, size}) on already-stored LibriVox
    // audiobooks that weren't in the current fresh catalog slice.
    if (
      kind === "audiobooks" &&
      settings.enableLibriVox &&
      item.id.startsWith("lv-") &&
      hydratedLibriVoxCount < 45
    ) {
      const existingParts = Array.isArray(item.hints?.parts) ? item.hints.parts : [];
      const missingPartSize =
        existingParts.length === 0 ||
        existingParts.some((p) => !p.size || p.size <= 0 || !p.mime);
      if (missingPartSize) {
        hydratedLibriVoxCount++;
        const hydrated = fetchLibriVoxById(item.id, settings);
        if (hydrated?.parts && hydrated.parts.length > 0) {
          const rebuilt = entryToKindItem(hydrated);
          if (item.fields?.series && !rebuilt.fields.series) {
            rebuilt.fields.series = canonicalizeSeriesName(String(item.fields.series));
            rebuilt.hints.series = String(rebuilt.fields.series || "");
            if (item.index) rebuilt.index = item.index;
            if (item.fields.series_number) {
              rebuilt.fields.series_number = item.fields.series_number;
              rebuilt.hints.seriesNumber = String(item.fields.series_number);
            }
          }
          if (Array.isArray(item.fields?.curated) && item.fields.curated.length > 0) {
            const cur = Array.isArray(rebuilt.fields.curated)
              ? (rebuilt.fields.curated as string[])
              : [];
            rebuilt.fields.curated = dedupeStrings(
              [...(item.fields.curated as string[]), ...cur],
              8,
            );
          }
          if (Array.isArray(item.fields?.narrators) && item.fields.narrators.length > 0) {
            const existingNarrs = item.fields.narrators as PersonCredit[];
            const rebuiltNarrs = Array.isArray(rebuilt.fields.narrators)
              ? (rebuilt.fields.narrators as PersonCredit[])
              : [];
            const combinedNarrs = mergePeople(rebuiltNarrs, existingNarrs);
            if (combinedNarrs.length > rebuiltNarrs.length) {
              rebuilt.fields.narrators = combinedNarrs;
              rebuilt.hints.narrators = combinedNarrs.map((n) => n.name);
            }
          }
          extraUpserts.push(rebuilt);
          storeItemSnapshot(kind, rebuilt);
          continue;
        }
      }
    }

    const repaired = repairStoredKindItem(kind, item);
    if (repaired) {
      extraUpserts.push(repaired);
      storeItemSnapshot(kind, repaired);
    }
  }

  for (const k of recordingKeepers) {
    if (!seenDelete.has(k.id) && !extraUpserts.some((u) => u.id === k.id)) {
      extraUpserts.push(k);
      storeItemSnapshot(kind, k);
    }
  }

  // Respect Ether's 50% delete guard safely (cap at 45% of stored count)
  const maxSafeDeletes = Math.max(0, Math.floor(stored.length * 0.45));
  const safeDeletes = deletes.length > maxSafeDeletes ? deletes.slice(0, maxSafeDeletes) : deletes;

  return {
    extraUpserts,
    deletes: safeDeletes,
    suppressedFreshIds: Array.from(suppressedFreshIds),
  };
}

export function resetCatalogCachesForUpgrade(): void {
  clearMetadataCache();
}

export function getItemDetail(
  kind: "books" | "audiobooks",
  id: string,
  settings: PluginSettings,
): KindItem | null {
  const snap = loadItemSnapshot(kind, id);
  if (snap) {
    // Hydrate Open Library synopsis on detail open if missing
    if (kind === "books" && id.startsWith("ol-") && !snap.summary) {
      const extra = hydrateOpenLibraryWork(id, settings);
      if (extra?.summary) {
        snap.summary = extra.summary;
        if (extra.genres && extra.genres.length > 0) {
          const cur = Array.isArray(snap.fields.genres) ? (snap.fields.genres as string[]) : [];
          snap.fields.genres = dedupeStrings([...cur, ...extra.genres], 6);
        }
        storeItemSnapshot(kind, snap);
      }
    }
    return snap;
  }

  // Fallback live fetch by known ID prefix
  if (kind === "audiobooks" && id.startsWith("aud-")) {
    const entry = fetchAudibleByAsin(id, settings);
    if (entry) {
      const item = entryToKindItem(entry);
      storeItemSnapshot(kind, item);
      return item;
    }
  }
  if (kind === "audiobooks" && id.startsWith("lv-")) {
    const entry = fetchLibriVoxById(id, settings);
    if (entry) {
      const item = entryToKindItem(entry);
      storeItemSnapshot(kind, item);
      return item;
    }
  }
  if (kind === "books" && id.startsWith("se-")) {
    const list = fetchStandardEbooks(settings, 60);
    const hit = list.find((e) => e.sourceId === id);
    if (hit) {
      const item = entryToKindItem(hit);
      storeItemSnapshot(kind, item);
      return item;
    }
  }
  return null;
}
