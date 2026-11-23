// LibriVox public-domain audiobook provider (https://librivox.org/api/feed/audiobooks/).
// Exposes ordered chapter MP3 tracks via hints.parts + direct Archive.org artwork.

import { cacheGet, cachePut, fetchJson, fetchText, storePartUrls } from "../cache.ts";
import {
  canonicalizeGenres,
  clampSummary,
  dedupeStrings,
  encodeQuery,
  extractYear,
  normalizeLanguage,
  safeHttpsUrl,
  stableExternalId,
} from "../text.ts";
import type {
  BookDirectSource,
  KindItemPart,
  NormalizedEntry,
  PersonCredit,
  PluginSettings,
} from "../types.ts";

const LIBRIVOX_API = "https://librivox.org/api/feed/audiobooks/";

interface LibriVoxAuthor {
  id?: string;
  first_name?: string;
  last_name?: string;
}

interface LibriVoxReader {
  reader_id?: string;
  display_name?: string;
}

interface LibriVoxSection {
  id?: string;
  section_number?: string;
  title?: string;
  listen_url?: string;
  playtime?: string | number;
  readers?: LibriVoxReader[];
}

interface LibriVoxGenre {
  id?: string;
  name?: string;
}

interface LibriVoxBook {
  id: string | number;
  title?: string;
  description?: string;
  url_iarchive?: string;
  url_librivox?: string;
  url_zip_file?: string;
  language?: string;
  copyright_year?: string;
  num_sections?: string | number;
  totaltimesecs?: number;
  authors?: LibriVoxAuthor[];
  sections?: LibriVoxSection[];
  genres?: LibriVoxGenre[];
}

interface LibriVoxResponse {
  books?: LibriVoxBook[];
}

function extractArchiveId(iarchiveUrl?: string, fallbackListenUrl?: string): string | undefined {
  if (iarchiveUrl) {
    const m = /archive\.org\/details\/([^/?#]+)/i.exec(iarchiveUrl);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  if (fallbackListenUrl) {
    const m = /archive\.org\/download\/([^/?#]+)\//i.exec(fallbackListenUrl);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return undefined;
}

function archiveCoverFromUrl(iarchiveUrl?: string, fallbackListenUrl?: string): string | undefined {
  const iaId = extractArchiveId(iarchiveUrl, fallbackListenUrl);
  if (!iaId) return undefined;
  return `https://archive.org/services/img/${encodeURIComponent(iaId)}`;
}

function filenameFromUrl(url: string): string {
  const withoutQuery = url.split("?")[0].split("#")[0];
  const raw = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

interface ArchiveFilesResponse {
  result?: Array<{
    name?: string;
    size?: string | number;
  }>;
}

export function fetchArchivePartSizes(
  iaId: string,
  settings: PluginSettings,
): Record<string, number> {
  if (!iaId) return {};
  const cacheKey = `iasz:${iaId}`;
  const cached = cacheGet<Record<string, number>>(cacheKey);
  if (cached) return cached;

  const resp = fetchText(`https://archive.org/metadata/${encodeURIComponent(iaId)}/files`, {
    provider: "archive",
    settings,
  });
  if (!resp || resp.status < 200 || resp.status >= 300 || !resp.body) {
    return {};
  }
  try {
    const parsed = JSON.parse(resp.body) as ArchiveFilesResponse;
    const files = Array.isArray(parsed?.result) ? parsed.result : [];
    const sizes: Record<string, number> = {};
    for (const f of files) {
      const name = typeof f?.name === "string" ? f.name.trim() : "";
      if (!name || !/\.mp3$/i.test(name)) continue;
      const sz =
        typeof f.size === "number"
          ? Math.round(f.size)
          : parseInt(String(f.size || ""), 10) || 0;
      if (sz > 0) {
        sizes[name] = sz;
      }
    }
    if (Object.keys(sizes).length > 0) {
      cachePut(cacheKey, sizes, 30 * 24 * 3600);
    }
    return sizes;
  } catch {
    return {};
  }
}

function lookupPartSize(sizes: Record<string, number>, url: string): number | undefined {
  const fn = filenameFromUrl(url);
  if (!fn) return undefined;
  const exact = sizes[fn];
  if (exact && exact > 0) return exact;
  const lower = fn.toLowerCase();
  for (const [k, v] of Object.entries(sizes)) {
    if (k.toLowerCase() === lower && v > 0) return v;
  }
  return undefined;
}

function mapLibriVoxBook(
  b: LibriVoxBook,
  curatedTags: string[] = [],
  settings?: PluginSettings,
  fetchSizes = false,
): NormalizedEntry | null {
  const title = (b.title || "").trim();
  if (!title) return null;

  const authors: PersonCredit[] = [];
  for (const a of b.authors || []) {
    const full = `${a.first_name || ""} ${a.last_name || ""}`.trim();
    if (full && full.toLowerCase() !== "various") {
      authors.push({ name: full, role: "Author" });
    }
  }
  if (authors.length === 0) {
    authors.push({ name: "Various authors", role: "Author" });
  }

  const sections = Array.isArray(b.sections) ? b.sections : [];
  const firstListenUrl = sections.map((s) => safeHttpsUrl(s.listen_url)).find(Boolean);
  const iaId = extractArchiveId(b.url_iarchive, firstListenUrl);
  const partSizes =
    fetchSizes && settings && iaId ? fetchArchivePartSizes(iaId, settings) : {};

  const narratorNames: string[] = [];
  const parts: KindItemPart[] = [];
  const partUrls: string[] = [];
  const directSources: BookDirectSource[] = [];
  let sumSec = 0;

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const url = safeHttpsUrl(sec.listen_url);
    const dur =
      typeof sec.playtime === "number"
        ? sec.playtime
        : parseInt(String(sec.playtime || "0"), 10) || 0;
    if (dur > 0) sumSec += dur;
    for (const r of sec.readers || []) {
      const rn = (r.display_name || "")
        .replace(/\s*\((?:[db]\.\s*|ca?\.\s*)?\d{3,4}[^)]*\)\s*$/gi, "")
        .trim();
      if (rn) narratorNames.push(rn);
    }
    if (url) {
      const rawSecTitle = (sec.title || `Chapter ${i + 1}`).trim();
      const secTitle = rawSecTitle.length > 64 ? rawSecTitle.slice(0, 61).trim() + "..." : rawSecTitle;
      const byteSize = lookupPartSize(partSizes, url);
      parts.push({
        name: secTitle,
        mime: "audio/mpeg",
        durationSec: dur > 0 ? dur : undefined,
        size: byteSize,
      });
      partUrls.push(url);
      if (i === 0) {
        directSources.push({
          url,
          mime: "audio/mpeg",
          format: "mp3",
          label: `LibriVox MP3 (${sections.length} parts)`,
          size: byteSize,
          durationSec: dur > 0 ? dur : undefined,
        });
      }
    }
  }

  const sourceId = stableExternalId("lv", String(b.id));
  if (partUrls.length > 0) {
    storePartUrls(sourceId, partUrls);
  }

  const uniqueNarrators = dedupeStrings(narratorNames, 8);
  const narrators: PersonCredit[] =
    uniqueNarrators.length > 0
      ? uniqueNarrators.map((name) => ({ name, role: "Narrator" }))
      : [{ name: "LibriVox Volunteers", role: "Narrator" }];

  const durationSec =
    typeof b.totaltimesecs === "number" && b.totaltimesecs > 0
      ? b.totaltimesecs
      : sumSec > 0
        ? sumSec
        : undefined;

  const rawGenres = ["Classics", ...(b.genres || []).map((g) => g.name || "").filter(Boolean)];
  const genres = dedupeStrings(["Classics", ...canonicalizeGenres(rawGenres, 5)], 6);
  const year = extractYear(b.copyright_year);
  const coverUrl = archiveCoverFromUrl(b.url_iarchive, firstListenUrl);

  return {
    kind: "audiobooks",
    source: "librivox",
    sourceId,
    title,
    summary: clampSummary(b.description),
    year: year && year >= 1400 ? year : undefined,
    rating: 8.1,
    authors,
    narrators,
    genres,
    curated: dedupeStrings(["Free classics", ...curatedTags], 8),
    publisher: "LibriVox",
    durationSec,
    unabridged: true,
    format: "mp3",
    language: normalizeLanguage(b.language || "English") || "English",
    coverUrl,
    directSources: directSources.length > 0 ? directSources : undefined,
    parts: parts.length > 0 ? parts : undefined,
    partUrls: partUrls.length > 0 ? partUrls : undefined,
  };
}

function queryLibriVox(
  params: Record<string, string | number | boolean | undefined>,
  settings: PluginSettings,
  cacheKey: string,
  curatedTags: string[] = [],
  opts?: { fetchSizes?: boolean; sizeBudgetMs?: number; maxSized?: number },
): NormalizedEntry[] {
  const qs = encodeQuery({
    format: "json",
    extended: 1,
    ...params,
  });
  const data = fetchJson<LibriVoxResponse>(`${LIBRIVOX_API}?${qs}`, {
    provider: "librivox",
    settings,
    cacheKey,
    cacheTtlSec: 6 * 3600,
  });
  if (!data || !Array.isArray(data.books)) return [];

  const startedAt = Date.now();
  const fetchSizes = opts?.fetchSizes !== false;
  const maxSized = opts?.maxSized ?? Number.POSITIVE_INFINITY;
  const budgetMs = opts?.sizeBudgetMs ?? Number.POSITIVE_INFINITY;
  let sizedCount = 0;

  const out: NormalizedEntry[] = [];
  for (const book of data.books) {
    if (
      settings.language === "en" &&
      book.language &&
      book.language.toLowerCase() !== "english"
    ) {
      continue;
    }
    const wantSize =
      fetchSizes && sizedCount < maxSized && Date.now() - startedAt < budgetMs;
    const mapped = mapLibriVoxBook(book, curatedTags, settings, wantSize);
    if (mapped && mapped.parts && mapped.parts.length > 0) {
      if (wantSize) sizedCount++;
      out.push(mapped);
    }
  }
  return out;
}

const CURATED_LV_GENRES: Array<{ query: string; genreTag: string }> = [
  { query: "Science Fiction", genreTag: "Science fiction" },
  { query: "Fantasy Fiction", genreTag: "Fantasy" },
  { query: "Detective Fiction", genreTag: "Mystery and thriller" },
  { query: "Horror & Supernatural Fiction", genreTag: "Horror" },
  { query: "History", genreTag: "History" },
  { query: "Biography & Autobiography", genreTag: "Biography and memoir" },
];

export function fetchLibriVoxCatalog(settings: PluginSettings): NormalizedEntry[] {
  if (!settings.enableLibriVox) return [];
  const perSlice = settings.catalogSize === "compact" ? 6 : settings.catalogSize === "large" ? 16 : 10;
  const results: NormalizedEntry[] = [];

  // Recent LibriVox releases
  results.push(
    ...queryLibriVox(
      { limit: perSlice * 2 },
      settings,
      `lv:recent:${settings.language}:${perSlice}`,
      ["Free classics"],
    ),
  );

  // Curated genre slices so classic sci-fi/fantasy/mystery/history populate immediately
  for (const slice of CURATED_LV_GENRES) {
    const items = queryLibriVox(
      { genre: slice.query, limit: perSlice },
      settings,
      `lv:genre:${slice.query}:${settings.language}:${perSlice}`,
      ["Free classics"],
    );
    for (const item of items) {
      if (!item.genres.includes(slice.genreTag)) {
        item.genres = dedupeStrings([slice.genreTag, ...item.genres], 6);
      }
      results.push(item);
    }
  }

  return results;
}

export function searchLibriVox(
  query: string,
  settings: PluginSettings,
  limit = 15,
): NormalizedEntry[] {
  if (!settings.enableLibriVox || !query.trim()) return [];
  const q = query.trim();
  const searchOpts = { fetchSizes: true, sizeBudgetMs: 2200, maxSized: 5 };
  const byTitle = queryLibriVox(
    { title: `^${q}`, limit },
    settings,
    `lv:st:${q.toLowerCase()}:${limit}`,
    [],
    searchOpts,
  );
  if (byTitle.length >= Math.min(limit, 5)) return byTitle.slice(0, limit);
  const byAuthor = queryLibriVox(
    { author: q, limit },
    settings,
    `lv:sa:${q.toLowerCase()}:${limit}`,
    [],
    searchOpts,
  );
  const seen = new Set(byTitle.map((x) => x.sourceId));
  for (const item of byAuthor) {
    if (!seen.has(item.sourceId)) {
      byTitle.push(item);
      seen.add(item.sourceId);
    }
  }
  return byTitle.slice(0, limit);
}

export function fetchLibriVoxById(id: string, settings: PluginSettings): NormalizedEntry | null {
  if (!settings.enableLibriVox) return null;
  const numId = id.replace(/^lv-/, "");
  if (!/^\d+$/.test(numId)) return null;
  const rows = queryLibriVox({ id: numId }, settings, `lv:id:${numId}`);
  return rows[0] || null;
}
