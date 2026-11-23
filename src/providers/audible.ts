// Audible public catalog metadata provider (https://api.audible.com/1.0/catalog/products).
// Metadata-only: supplies audiobook editions, narrators, authors, series order,
// durations, unabridged flags, ratings, release dates, and crisp square covers.

import { fetchJson, nowSec } from "../cache.ts";
import {
  canonicalizeSeriesName,
  inferGenresFromMetadata,
  isBoxSetOrOmnibus,
  isDramatizedAudioEdition,
  isNonBookProduct,
  isSplitPartEdition,
} from "../hygiene.ts";
import {
  canonicalizeGenres,
  clampSummary,
  dedupeStrings,
  encodeQuery,
  extractYear,
  normalizeAsin,
  normalizeIsbn,
  normalizeLanguage,
  normalizeRating,
  parseIsoDateToUnix,
  parseSeriesPosition,
  safeHttpsUrl,
  stableExternalId,
} from "../text.ts";
import type { NormalizedEntry, PersonCredit, PluginSettings } from "../types.ts";

const AUDIBLE_API = "https://api.audible.com/1.0/catalog/products";
const RESPONSE_GROUPS =
  "contributors,media,product_attrs,product_desc,product_extended_attrs,rating,series,category_ladders";

interface AudiblePerson {
  asin?: string;
  name?: string;
}

interface AudibleSeries {
  asin?: string;
  sequence?: string;
  title?: string;
}

interface AudibleLadder {
  ladder?: Array<{ id?: string; name?: string }>;
}

interface AudibleProduct {
  asin?: string;
  title?: string;
  subtitle?: string;
  authors?: AudiblePerson[];
  narrators?: AudiblePerson[];
  publisher_name?: string;
  publisher_summary?: string;
  merchandising_summary?: string;
  release_date?: string;
  runtime_length_min?: number;
  format_type?: string;
  content_type?: string;
  content_delivery_type?: string;
  language?: string;
  isbn?: string;
  product_images?: Record<string, string>;
  series?: AudibleSeries[];
  category_ladders?: AudibleLadder[];
  rating?: {
    overall_distribution?: {
      display_average_rating?: number;
      num_ratings?: number;
    };
  };
}

interface AudibleCatalogResponse {
  products?: AudibleProduct[];
}

interface AudibleProductResponse {
  product?: AudibleProduct;
}

const AUDIBLE_GENRE_TO_CATEGORY: Record<string, string> = {
  "science fiction": "18580606011",
  fantasy: "18580606011",
  "mystery and thriller": "18574597011",
  "literary fiction": "18574426011",
  history: "18573518011",
  "biography and memoir": "18571951011",
  "non-fiction": "18571910011",
};

function isVirtualVoice(p: AudibleProduct): boolean {
  return (p.narrators || []).some((n) => /virtual voice/i.test(n.name || ""));
}

function isNonAudiobookProduct(p: AudibleProduct): boolean {
  const delivery = (p.content_delivery_type || "").toLowerCase();
  if (delivery && delivery !== "singlepartbook" && delivery !== "multipartbook") {
    return true;
  }
  const ctype = (p.content_type || "").toLowerCase();
  if (ctype && /\b(podcast|show|episode|speech|lecture|newspaper|magazine)\b/.test(ctype)) {
    return true;
  }
  const fmt = (p.format_type || "").toLowerCase();
  if (fmt && /\b(podcast|show|episode)\b/.test(fmt)) {
    return true;
  }
  return false;
}

const NON_SERIES_RE =
  /^(audible originals?|audible original stories|a random house audiobook original|forward collection|audio drama|bbc radio|dramatized adaptation|full cast audio|unabridged|modern library|penguin classics|oxford world's classics)$/i;

function cleanSeriesTitle(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 2) return undefined;
  if (NON_SERIES_RE.test(trimmed)) return undefined;
  if (/audible original|random house audiobook|podcast/i.test(trimmed)) return undefined;
  return canonicalizeSeriesName(trimmed);
}

const WORD_BOOK_NUM: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function pickBestAudibleSeries(
  list: AudibleSeries[] | undefined,
  title: string,
): { series?: string; index?: number; display?: string } {
  const valid = (list || [])
    .map((s) => ({ raw: s.title || "", canon: cleanSeriesTitle(s.title), seq: s.sequence }))
    .filter((s) => Boolean(s.canon));
  if (valid.length === 0) return {};

  // Prefer the core series entry over omnibus/prequel-inclusive sequences like "The Dune Sequence"
  const preferred =
    valid.find((s) => !/\bsequence\b/i.test(s.raw)) ||
    valid[0];
  let pos = parseSeriesPosition(preferred.seq);

  // If sequence comes from a chronological prequel-inclusive sequence (e.g. Dune Messiah = #13),
  // prefer the explicit "Book Two in the Dune Chronicles" number from the title.
  const wordMatch = /\bbook\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+in\s+the\b/i.exec(title);
  if (wordMatch && (!pos.index || pos.index > 10)) {
    const n = WORD_BOOK_NUM[wordMatch[1].toLowerCase()];
    if (n) pos = { index: n, display: String(n) };
  }
  return {
    series: preferred.canon,
    index: pos.index,
    display: pos.display,
  };
}

function isFuturePreorder(released?: number): boolean {
  if (!released) return false;
  return released > nowSec() + 7 * 86400;
}

function mapAudibleProduct(
  p: AudibleProduct,
  opts?: {
    extraGenres?: string[];
    curatedTags?: string[];
    awardTags?: string[];
    minRatings?: number;
    skipPreorders?: boolean;
  },
): NormalizedEntry | null {
  const asin = normalizeAsin(p.asin);
  const title = (p.title || "").trim();
  const subtitle = p.subtitle?.trim() || undefined;
  if (!asin || !title) return null;
  if (isNonAudiobookProduct(p)) return null;
  if (isVirtualVoice(p)) return null;

  const seriesPick = pickBestAudibleSeries(p.series, title);
  const seriesName = seriesPick.series;
  if (
    isNonBookProduct({
      kind: "audiobooks",
      title,
      subtitle,
      publishers: p.publisher_name ? [p.publisher_name] : [],
      series: seriesName,
    }) ||
    isBoxSetOrOmnibus(title, subtitle, seriesName) ||
    isSplitPartEdition(title, subtitle, "audiobooks", Boolean(seriesName))
  ) {
    return null;
  }

  const numRatings = p.rating?.overall_distribution?.num_ratings ?? 0;
  if (opts?.minRatings && numRatings < opts.minRatings) return null;

  const releaseDate = p.release_date ? p.release_date.slice(0, 10) : undefined;
  const released = parseIsoDateToUnix(p.release_date);
  if (opts?.skipPreorders && isFuturePreorder(released)) return null;

  const coverUrl =
    safeHttpsUrl(p.product_images?.["500"]) ||
    safeHttpsUrl(p.product_images?.["1000"]) ||
    safeHttpsUrl(p.product_images ? Object.values(p.product_images)[0] : undefined);

  const authors: PersonCredit[] = (p.authors || [])
    .filter((a) => a.name && a.name.trim())
    .slice(0, 6)
    .map((a) => ({ name: a.name!.trim(), role: "Author" }));
  if (authors.length === 0) return null;

  const narrators: PersonCredit[] = (p.narrators || [])
    .filter((n) => n.name && n.name.trim() && !/virtual voice/i.test(n.name))
    .slice(0, 6)
    .map((n) => ({ name: n.name!.trim(), role: "Narrator" }));

  // Prefer specific ladder nodes over umbrella parents like "Science Fiction & Fantasy"
  // so science fiction titles don't bleed into the Fantasy shelf and vice versa.
  const rawCats: string[] = [];
  for (const cl of p.category_ladders || []) {
    const steps = (cl.ladder || []).map((s) => (s.name || "").trim()).filter(Boolean);
    if (steps.length === 0) continue;
    const specific = steps.filter(
      (name) =>
        !/^science fiction & fantasy$/i.test(name) &&
        !/^literature & fiction$/i.test(name),
    );
    rawCats.push(...(specific.length > 0 ? specific : steps));
  }
  const genres = inferGenresFromMetadata(title, subtitle, rawCats, opts?.extraGenres || []);

  const durationSec =
    typeof p.runtime_length_min === "number" && p.runtime_length_min > 0
      ? Math.round(p.runtime_length_min * 60)
      : undefined;

  const formatType = (p.format_type || "").toLowerCase();
  const unabridged = formatType !== "abridged";

  const year = extractYear(p.release_date);
  const rating = normalizeRating(p.rating?.overall_distribution?.display_average_rating, 5);

  const curated = [...(opts?.curatedTags || [])];
  const isDramatized = isDramatizedAudioEdition(title, subtitle, p.publisher_name);
  if (seriesName && seriesPick.index === 1 && !isDramatized) {
    curated.push("Series to start");
  }
  if (year && year >= 2024 && !isFuturePreorder(released)) {
    curated.push("New and notable");
  }

  return {
    kind: "audiobooks",
    source: "audible",
    sourceId: stableExternalId("aud", asin),
    title,
    subtitle,
    summary: clampSummary(p.publisher_summary || p.merchandising_summary),
    year,
    released,
    releaseDate,
    rating,
    authors,
    narrators: narrators.length > 0 ? narrators : undefined,
    series: seriesName,
    seriesIndex: seriesName ? seriesPick.index : undefined,
    seriesNumber: seriesName ? seriesPick.display : undefined,
    genres,
    awards: opts?.awardTags && opts.awardTags.length > 0 ? dedupeStrings(opts.awardTags, 6) : undefined,
    curated: dedupeStrings(curated, 8),
    publisher: p.publisher_name?.trim() || undefined,
    asin,
    isbn: normalizeIsbn(p.isbn),
    durationSec,
    unabridged,
    format: "m4b",
    language: normalizeLanguage(p.language || "english") || "English",
    coverUrl,
  };
}

function queryAudible(
  params: Record<string, string | number | boolean | undefined>,
  settings: PluginSettings,
  cacheKey: string,
  opts?: {
    extraGenres?: string[];
    curatedTags?: string[];
    awardTags?: string[];
    minRatings?: number;
    skipPreorders?: boolean;
  },
): NormalizedEntry[] {
  const qs = encodeQuery({
    response_groups: RESPONSE_GROUPS,
    image_sizes: 500,
    ...params,
  });
  const data = fetchJson<AudibleCatalogResponse>(`${AUDIBLE_API}?${qs}`, {
    provider: "audible",
    settings,
    cacheKey,
    cacheTtlSec: 6 * 3600,
  });
  if (!data?.products) return [];
  const out: NormalizedEntry[] = [];
  for (const prod of data.products) {
    if (
      settings.language === "en" &&
      prod.language &&
      prod.language.toLowerCase() !== "english"
    ) {
      continue;
    }
    const mapped = mapAudibleProduct(prod, opts);
    if (mapped && mapped.coverUrl) out.push(mapped);
  }
  return out;
}

const AUDIBLE_CURATED_SLICES: Array<{
  params: Record<string, string | number>;
  key: string;
  genres?: string[];
  curated?: string[];
  awards?: string[];
  minRatings: number;
}> = [
  // Flagship bestsellers & recent notable hits
  {
    params: { keywords: "New York Times bestseller", products_sort_by: "Relevance", num_results: 24 },
    key: "nyt-best",
    curated: ["Popular this week"],
    minRatings: 500,
  },
  // Curated genre bestseller slices (high-signal human-narrated editions)
  {
    params: { category_id: "18574597011", keywords: "bestseller", products_sort_by: "Relevance", num_results: 16 },
    key: "cat-mystery",
    genres: ["Mystery and thriller"],
    minRatings: 300,
  },
  {
    params: { category_id: "18574426011", keywords: "bestseller", products_sort_by: "Relevance", num_results: 16 },
    key: "cat-lit",
    genres: ["Literary fiction"],
    minRatings: 300,
  },
  {
    params: { category_id: "18573518011", keywords: "bestseller", products_sort_by: "Relevance", num_results: 14 },
    key: "cat-history",
    genres: ["History", "Non-fiction"],
    minRatings: 300,
  },
  {
    params: { category_id: "18571951011", keywords: "bestseller", products_sort_by: "Relevance", num_results: 14 },
    key: "cat-bio",
    genres: ["Biography and memoir", "Non-fiction"],
    minRatings: 300,
  },
  // Iconic sci-fi, fantasy, non-fiction, and flagship series catalogs
  {
    params: { keywords: "Andy Weir", products_sort_by: "Relevance", num_results: 6 },
    key: "sf-weir",
    genres: ["Science fiction"],
    curated: ["Popular this week"],
    minRatings: 1000,
  },
  {
    params: { keywords: "Frank Herbert Dune", products_sort_by: "Relevance", num_results: 6 },
    key: "sf-dune",
    genres: ["Science fiction"],
    curated: ["Popular this week"],
    minRatings: 1000,
  },
  {
    params: { keywords: "Brandon Sanderson Stormlight Mistborn", products_sort_by: "Relevance", num_results: 10 },
    key: "fan-sanderson",
    genres: ["Fantasy"],
    curated: ["Popular this week"],
    minRatings: 1000,
  },
  {
    params: { keywords: "James S. A. Corey Expanse", products_sort_by: "Relevance", num_results: 6 },
    key: "sf-expanse",
    genres: ["Science fiction"],
    minRatings: 1000,
  },
  {
    params: { keywords: "Pierce Brown Red Rising", products_sort_by: "Relevance", num_results: 6 },
    key: "sf-redrising",
    genres: ["Science fiction"],
    minRatings: 1000,
  },
  {
    params: { keywords: "Martha Wells Murderbot", products_sort_by: "Relevance", num_results: 6 },
    key: "sf-murderbot",
    genres: ["Science fiction"],
    minRatings: 500,
  },
  {
    params: { keywords: "J. R. R. Tolkien Hobbit", products_sort_by: "Relevance", num_results: 6 },
    key: "fan-tolkien",
    genres: ["Fantasy"],
    minRatings: 1000,
  },
  {
    params: { keywords: "Joe Abercrombie First Law", products_sort_by: "Relevance", num_results: 5 },
    key: "fan-abercrombie",
    genres: ["Fantasy"],
    minRatings: 1000,
  },
  {
    params: { keywords: "Patrick Rothfuss Name of the Wind", products_sort_by: "Relevance", num_results: 4 },
    key: "fan-rothfuss",
    genres: ["Fantasy"],
    curated: ["Popular this week"],
    minRatings: 1000,
  },
  {
    params: { keywords: "Robin Hobb Farseer", products_sort_by: "Relevance", num_results: 4 },
    key: "fan-hobb",
    genres: ["Fantasy"],
    minRatings: 500,
  },
  {
    params: { keywords: "Neil Gaiman fantasy", products_sort_by: "Relevance", num_results: 5 },
    key: "fan-gaiman",
    genres: ["Fantasy"],
    minRatings: 1000,
  },
  {
    params: { keywords: "Yuval Noah Harari Sapiens", products_sort_by: "Relevance", num_results: 5 },
    key: "nf-harari",
    genres: ["Non-fiction", "History"],
    minRatings: 1000,
  },
  {
    params: { keywords: "Atomic Habits James Clear", products_sort_by: "Relevance", num_results: 4 },
    key: "nf-clear",
    genres: ["Non-fiction"],
    curated: ["Popular this week"],
    minRatings: 1000,
  },
  {
    params: { keywords: "Erik Larson", products_sort_by: "Relevance", num_results: 6 },
    key: "hist-larson",
    genres: ["History", "Non-fiction"],
    minRatings: 1000,
  },
  // Award winners (Audie, Hugo, Pulitzer, Booker)
  {
    params: { keywords: "Audie Award", products_sort_by: "Relevance", num_results: 10 },
    key: "aw-audie",
    curated: ["Award winners"],
    awards: ["Audie Award"],
    minRatings: 500,
  },
  {
    params: { keywords: "Hugo Award", products_sort_by: "Relevance", num_results: 10 },
    key: "aw-hugo",
    genres: ["Science fiction"],
    curated: ["Award winners"],
    awards: ["Hugo Award"],
    minRatings: 500,
  },
  {
    params: { keywords: "Pulitzer Prize", products_sort_by: "Relevance", num_results: 10 },
    key: "aw-pulitzer",
    curated: ["Award winners"],
    awards: ["Pulitzer Prize"],
    minRatings: 500,
  },
];

export function fetchAudibleCatalog(settings: PluginSettings): NormalizedEntry[] {
  if (!settings.enableAudibleMetadata) return [];
  const maxSlices =
    settings.catalogSize === "compact"
      ? 10
      : settings.catalogSize === "large"
        ? AUDIBLE_CURATED_SLICES.length
        : AUDIBLE_CURATED_SLICES.length;

  const out: NormalizedEntry[] = [];
  for (let i = 0; i < maxSlices; i++) {
    const slice = AUDIBLE_CURATED_SLICES[i];
    out.push(
      ...queryAudible(
        slice.params,
        settings,
        `aud:v2:${slice.key}:${settings.language}`,
        {
          extraGenres: slice.genres,
          curatedTags: slice.curated,
          awardTags: slice.awards,
          minRatings: slice.minRatings,
          skipPreorders: true,
        },
      ),
    );
  }
  return out;
}

export function searchAudible(
  query: string,
  settings: PluginSettings,
  opts?: { limit?: number; author?: string; narrator?: string; genre?: string; page?: number },
): NormalizedEntry[] {
  if (!settings.enableAudibleMetadata) return [];
  const limit = opts?.limit || 20;
  const params: Record<string, string | number | undefined> = {
    num_results: limit,
    page: opts?.page && opts.page > 1 ? opts.page - 1 : 0,
    products_sort_by: "Relevance",
  };
  if (opts?.author) {
    params.author = opts.author;
  } else if (opts?.narrator) {
    params.narrator = opts.narrator;
  } else if (opts?.genre) {
    const catId = AUDIBLE_GENRE_TO_CATEGORY[opts.genre.toLowerCase()];
    if (catId) {
      params.category_id = catId;
      params.keywords = "bestseller";
    } else {
      params.keywords = opts.genre;
    }
  } else if (query.trim()) {
    params.keywords = query.trim();
  } else {
    params.keywords = "New York Times bestseller";
  }

  return queryAudible(
    params,
    settings,
    `aud:s2:${JSON.stringify(params)}:${settings.language}`,
    {
      extraGenres: opts?.genre ? [opts.genre] : [],
      skipPreorders: true,
    },
  );
}

export function fetchAudibleByAsin(
  asinOrId: string,
  settings: PluginSettings,
): NormalizedEntry | null {
  if (!settings.enableAudibleMetadata) return null;
  const asin = normalizeAsin(asinOrId.replace(/^aud-/, ""));
  if (!asin) return null;
  const qs = encodeQuery({ response_groups: RESPONSE_GROUPS, image_sizes: 500 });
  const data = fetchJson<AudibleProductResponse>(`${AUDIBLE_API}/${asin}?${qs}`, {
    provider: "audible",
    settings,
    cacheKey: `aud:asin:${asin}`,
    cacheTtlSec: 24 * 3600,
  });
  if (!data?.product) return null;
  return mapAudibleProduct(data.product);
}
