// Optional Hardcover GraphQL provider (https://api.hardcover.app/v1/graphql).
// Activated only when the owner configures an optional hardcover_token secret.
// Enriches both Books and Audiobooks with community ratings, trending reads,
// series ordering, author portraits, and ISBN/edition metadata.

import { cacheGet, cachePut, fetchText } from "../cache.ts";
import {
  canonicalizeGenres,
  clampSummary,
  dedupeStrings,
  extractYear,
  normalizeIsbn,
  normalizeRating,
  parseIsoDateToUnix,
  parseSeriesPosition,
  safeHttpsUrl,
  stableExternalId,
} from "../text.ts";
import type { NormalizedEntry, PersonCredit, PluginSettings } from "../types.ts";

const HARDCOVER_GQL = "https://api.hardcover.app/v1/graphql";

interface HardcoverBookNode {
  id: number;
  slug?: string;
  title?: string;
  subtitle?: string;
  description?: string;
  release_date?: string;
  release_year?: number;
  pages?: number;
  audio_seconds?: number;
  rating?: number;
  ratings_count?: number;
  users_count?: number;
  image?: { url?: string } | null;
  contributions?: Array<{
    contribution?: string;
    author?: {
      id?: number;
      name?: string;
      image?: { url?: string } | null;
    } | null;
  }>;
  book_series?: Array<{
    position?: number | string | null;
    series?: {
      id?: number;
      name?: string;
    } | null;
  }>;
  cached_tags?: unknown;
  editions?: Array<{
    isbn_13?: string;
    isbn_10?: string;
    audio_seconds?: number;
    reading_format?: { format?: string } | null;
    publisher?: { name?: string } | null;
  }>;
}

interface HardcoverGraphQLResp<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

const BOOK_FIELDS_FULL = `
  id
  slug
  title
  subtitle
  description
  release_date
  release_year
  pages
  audio_seconds
  rating
  ratings_count
  users_count
  image { url }
  contributions(limit: 6) {
    contribution
    author { id name image { url } }
  }
  book_series(limit: 2) {
    position
    series { id name }
  }
  cached_tags
  editions(limit: 4) {
    isbn_13
    isbn_10
    audio_seconds
    publisher { name }
  }
`;

const BOOK_FIELDS_SAFE = `
  id
  slug
  title
  description
  release_date
  release_year
  pages
  rating
  users_count
  image { url }
  contributions(limit: 6) {
    author { id name }
  }
  book_series(limit: 2) {
    position
    series { id name }
  }
`;

function authHeader(token: string): string {
  const t = token.trim();
  if (!t) return "";
  return /^bearer\s+/i.test(t) ? t : `Bearer ${t}`;
}

function runHardcoverQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  settings: PluginSettings,
  cacheKey?: string,
  cacheTtlSec = 3600,
): T | null {
  if (!settings.hardcoverToken) return null;
  if (cacheKey) {
    const hit = cacheGet<T>(cacheKey);
    if (hit !== null) return hit;
  }
  const resp = fetchText(HARDCOVER_GQL, {
    method: "POST",
    provider: "hardcover",
    settings,
    headers: {
      Authorization: authHeader(settings.hardcoverToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp || resp.status < 200 || resp.status >= 300 || !resp.body) {
    return null;
  }
  try {
    const parsed = JSON.parse(resp.body) as HardcoverGraphQLResp<T>;
    if (parsed.errors && parsed.errors.length > 0 && !parsed.data) {
      return null;
    }
    if (parsed.data && cacheKey) {
      cachePut(cacheKey, parsed.data, cacheTtlSec);
    }
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

function extractTagsFromCached(raw: unknown): string[] {
  const tags: string[] = [];
  if (!raw || typeof raw !== "object") return tags;
  const obj = raw as Record<string, unknown>;
  for (const key of ["Genre", "genre", "Mood", "Tag", "tag"]) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === "string") tags.push(item);
        else if (item && typeof item === "object") {
          const t = (item as Record<string, unknown>)["tag"];
          if (typeof t === "string") tags.push(t);
        }
      }
    }
  }
  return tags;
}

function mapHardcoverBook(
  node: HardcoverBookNode,
  targetKind: "books" | "audiobooks",
  curatedTags: string[] = [],
): NormalizedEntry | null {
  const title = (node.title || "").trim();
  if (!node.id || !title) return null;

  const authors: PersonCredit[] = [];
  const narrators: PersonCredit[] = [];
  for (const c of node.contributions || []) {
    const name = c.author?.name?.trim();
    if (!name) continue;
    const roleStr = (c.contribution || "").toLowerCase();
    const thumb = safeHttpsUrl(c.author?.image?.url);
    if (roleStr.includes("narrat")) {
      narrators.push({ name, role: "Narrator", thumb });
    } else {
      authors.push({ name, role: "Author", thumb });
    }
  }

  const primarySeries = node.book_series?.find((bs) => bs.series?.name);
  const pos = parseSeriesPosition(primarySeries?.position);

  let isbn: string | undefined;
  let isbn13: string | undefined;
  let publisher: string | undefined;
  let editionAudioSec: number | undefined;
  for (const ed of node.editions || []) {
    if (!isbn13 && ed.isbn_13) isbn13 = normalizeIsbn(ed.isbn_13);
    if (!isbn && (ed.isbn_13 || ed.isbn_10)) {
      isbn = normalizeIsbn(ed.isbn_13) || normalizeIsbn(ed.isbn_10);
    }
    if (!publisher && ed.publisher?.name) publisher = ed.publisher.name.trim();
    if (!editionAudioSec && ed.audio_seconds && ed.audio_seconds > 0) {
      editionAudioSec = ed.audio_seconds;
    }
  }

  const audioSec =
    (node.audio_seconds && node.audio_seconds > 0 ? node.audio_seconds : undefined) ||
    editionAudioSec;

  const genres = canonicalizeGenres(extractTagsFromCached(node.cached_tags), 6);
  const year = extractYear(node.release_year || node.release_date);
  const released = parseIsoDateToUnix(node.release_date) || (year ? Math.floor(Date.UTC(year, 0, 1) / 1000) : undefined);
  const curated = [...curatedTags];
  if (primarySeries?.series?.name && pos.index === 1) {
    curated.push("Series to start");
  }

  return {
    kind: targetKind,
    source: "hardcover",
    sourceId: stableExternalId(targetKind === "books" ? "hc" : "hca", String(node.id)),
    title,
    subtitle: node.subtitle?.trim() || undefined,
    summary: clampSummary(node.description),
    year,
    released,
    releaseDate: node.release_date?.slice(0, 10),
    rating: normalizeRating(node.rating, 5),
    authors: authors.length > 0 ? authors : [{ name: "Unknown author", role: "Author" }],
    narrators: targetKind === "audiobooks" && narrators.length > 0 ? narrators : undefined,
    series: primarySeries?.series?.name?.trim(),
    seriesIndex: pos.index,
    seriesNumber: pos.display,
    genres: genres.length > 0 ? genres : ["Literary fiction"],
    curated: dedupeStrings(curated, 8),
    publisher,
    isbn,
    isbn13,
    pages: targetKind === "books" && node.pages && node.pages > 0 ? node.pages : undefined,
    durationSec: targetKind === "audiobooks" ? audioSec : undefined,
    unabridged: targetKind === "audiobooks" ? true : undefined,
    format: targetKind === "audiobooks" ? "m4b" : "epub",
    language: "English",
    coverUrl: safeHttpsUrl(node.image?.url),
  };
}

function queryHardcoverBooksWithFallback(
  whereClause: string,
  orderBy: string,
  limit: number,
  settings: PluginSettings,
  cacheKey: string,
): HardcoverBookNode[] {
  const buildQuery = (fields: string) => `
    query BooksCatalog($limit: Int!) {
      books(where: ${whereClause}, order_by: ${orderBy}, limit: $limit) {
        ${fields}
      }
    }
  `;
  const full = runHardcoverQuery<{ books?: HardcoverBookNode[] }>(
    buildQuery(BOOK_FIELDS_FULL),
    { limit },
    settings,
    cacheKey,
    3 * 3600,
  );
  if (full?.books) return full.books;

  const safe = runHardcoverQuery<{ books?: HardcoverBookNode[] }>(
    buildQuery(BOOK_FIELDS_SAFE),
    { limit },
    settings,
    cacheKey + ":safe",
    3 * 3600,
  );
  return safe?.books || [];
}

export function fetchHardcoverCatalog(
  kind: "books" | "audiobooks",
  settings: PluginSettings,
): NormalizedEntry[] {
  if (!settings.hardcoverToken) return [];
  const limit = settings.catalogSize === "compact" ? 20 : settings.catalogSize === "large" ? 50 : 32;
  const out: NormalizedEntry[] = [];

  const popWhere =
    kind === "audiobooks"
      ? `{ image_id: { _is_null: false }, audio_seconds: { _gt: 600 } }`
      : `{ image_id: { _is_null: false } }`;
  const popular = queryHardcoverBooksWithFallback(
    popWhere,
    `{ users_count: desc_nulls_last }`,
    limit,
    settings,
    `hc:pop:${kind}:${limit}`,
  );
  for (const node of popular) {
    const mapped = mapHardcoverBook(node, kind, ["Popular this week"]);
    if (mapped && mapped.coverUrl) out.push(mapped);
  }

  const recentWhere =
    kind === "audiobooks"
      ? `{ image_id: { _is_null: false }, audio_seconds: { _gt: 600 }, release_year: { _gte: 2024 } }`
      : `{ image_id: { _is_null: false }, release_year: { _gte: 2024 } }`;
  const recent = queryHardcoverBooksWithFallback(
    recentWhere,
    `{ users_count: desc_nulls_last }`,
    Math.ceil(limit * 0.6),
    settings,
    `hc:recent:${kind}:${limit}`,
  );
  for (const node of recent) {
    const mapped = mapHardcoverBook(node, kind, ["New and notable"]);
    if (mapped && mapped.coverUrl) out.push(mapped);
  }

  return out;
}

export function searchHardcover(
  kind: "books" | "audiobooks",
  query: string,
  settings: PluginSettings,
  limit = 16,
): NormalizedEntry[] {
  if (!settings.hardcoverToken || !query.trim()) return [];
  const gql = `
    query SearchBooks($q: String!, $limit: Int!) {
      books(
        where: {
          _or: [
            { title: { _ilike: $q } }
            { contributions: { author: { name: { _ilike: $q } } } }
            { book_series: { series: { name: { _ilike: $q } } } }
          ]
        }
        order_by: { users_count: desc_nulls_last }
        limit: $limit
      ) {
        ${BOOK_FIELDS_SAFE}
      }
    }
  `;
  const data = runHardcoverQuery<{ books?: HardcoverBookNode[] }>(
    gql,
    { q: `%${query.trim()}%`, limit },
    settings,
    `hc:s:${kind}:${query.trim().toLowerCase()}:${limit}`,
    1800,
  );
  if (!data?.books) return [];
  const out: NormalizedEntry[] = [];
  for (const node of data.books) {
    const mapped = mapHardcoverBook(node, kind);
    if (mapped) out.push(mapped);
  }
  return out;
}

export function testHardcoverConnection(settings: PluginSettings): { ok: boolean; note: string } {
  if (!settings.hardcoverToken) {
    return { ok: false, note: "Optional token not configured" };
  }
  const data = runHardcoverQuery<{ me?: Array<{ username?: string }> }>(
    `query { me { username } }`,
    {},
    settings,
  );
  if (data?.me) {
    const user = data.me[0]?.username;
    return { ok: true, note: user ? `Connected as ${user}` : "Connected" };
  }
  return { ok: false, note: "Token check failed or rate limited" };
}
