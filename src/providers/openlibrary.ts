// Open Library public catalog provider (https://openlibrary.org, https://covers.openlibrary.org).
// Supplies trending books, genre shelves, award winners, author portraits, search, and facet expand.

import { fetchJson } from "../cache.ts";
import {
  AUDIO_ONLY_PUBLISHER_RE,
  canonicalizeSeriesName,
  FOREIGN_BOOK_PUBLISHER_RE,
  inferGenresFromMetadata,
  isAudioOrDramatizedForBooks,
  isBoxSetOrOmnibus,
  isJunkFirstSentence,
  isLikelyNonEnglishText,
  isNonBookProduct,
  isSplitPartEdition,
  MAJOR_ENGLISH_PRINT_PUBLISHER_RE,
  pickBestPrintPublisher,
} from "../hygiene.ts";
import {
  canonicalizeGenres,
  clampSummary,
  dedupeStrings,
  encodeQuery,
  extractYear,
  FICTION_GENRES,
  normalizeIsbn,
  normalizeLanguage,
  normalizeRating,
  parseSeriesPosition,
  stableExternalId,
} from "../text.ts";
import type { NormalizedEntry, PersonCredit, PluginSettings } from "../types.ts";

const OL_BASE = "https://openlibrary.org";
const OL_COVER_BASE = "https://covers.openlibrary.org";

interface OpenLibraryInlineEdition {
  key?: string;
  title?: string;
  language?: string[];
  cover_i?: number;
  publisher?: string[];
  isbn?: string[];
  publish_year?: number[];
  format?: string[];
}

interface OpenLibrarySearchDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  author_key?: string[];
  first_publish_year?: number;
  isbn?: string[];
  cover_i?: number;
  subject?: string[];
  publisher?: string[];
  format?: string[];
  number_of_pages_median?: number;
  ratings_average?: number;
  ratings_count?: number;
  language?: string[];
  edition_count?: number;
  first_sentence?: string | string[];
  editions?: {
    numFound?: number;
    docs?: OpenLibraryInlineEdition[];
  };
}

interface OpenLibraryEditionEntry {
  key?: string;
  title?: string;
  publishers?: string[];
  physical_format?: string;
  publish_date?: string;
  number_of_pages?: number;
  covers?: number[];
  isbn_13?: string[];
  isbn_10?: string[];
  languages?: Array<{ key?: string } | string>;
}

interface OpenLibraryEditionsResponse {
  size?: number;
  entries?: OpenLibraryEditionEntry[];
}

export interface PreferredLanguageEdition {
  coverUrl?: string;
  publisher?: string;
  isbn?: string;
  isbn13?: string;
  year?: number;
  totalEditions?: number;
}

interface OpenLibrarySearchResponse {
  docs?: OpenLibrarySearchDoc[];
}

interface OpenLibraryTrendingWork {
  key?: string;
  title?: string;
  author_name?: string[];
  author_key?: string[];
  first_publish_year?: number;
  cover_i?: number;
  language?: string[];
  edition_count?: number;
}

interface OpenLibraryTrendingResponse {
  works?: OpenLibraryTrendingWork[];
}

interface OpenLibrarySubjectWork {
  key?: string;
  title?: string;
  authors?: Array<{ key?: string; name?: string }>;
  first_publish_year?: number;
  cover_id?: number;
  subject?: string[];
  edition_count?: number;
}

interface OpenLibrarySubjectResponse {
  works?: OpenLibrarySubjectWork[];
}

interface OpenLibraryWorkDetail {
  key?: string;
  title?: string;
  description?: string | { value?: string };
  subjects?: string[];
  covers?: number[];
  first_publish_date?: string;
}

const SEARCH_FIELDS =
  "key,title,subtitle,author_name,author_key,first_publish_year,isbn,cover_i,subject,publisher,format,number_of_pages_median,ratings_average,ratings_count,language,edition_count,first_sentence,editions,editions.key,editions.title,editions.language,editions.cover_i,editions.publisher,editions.isbn,editions.publish_year,editions.format";

const AUDIO_FORMAT_RE = /\b(audio|eaudiobook|mp3|cd|cassette|playaway|sound\s*recording)\b/i;
const PRINT_FORMAT_RE = /^(?:hardcover|paperback|trade\s*paperback|mass\s*market\s*paperback|ebook|electronic\s*resource|library\s*binding|softcover|kindle)$/i;

function editionMatchesLanguage(langs: Array<{ key?: string } | string> | undefined, language: string): boolean {
  if (language !== "en") return true;
  if (!Array.isArray(langs) || langs.length === 0) return false;
  return langs.some((l) => {
    const raw = typeof l === "string" ? l : l?.key || "";
    const code = raw.replace(/^\/languages\//i, "").trim().toLowerCase();
    return code === "eng" || code === "en" || code === "english";
  });
}

function isCleanPrintEdition(opts: {
  title?: string;
  publishers?: string[];
  formats?: string[];
  language: string;
}): boolean {
  const title = (opts.title || "").trim();
  if (title) {
    if (opts.language === "en" && isLikelyNonEnglishText(title)) return false;
    if (isBoxSetOrOmnibus(title) || isSplitPartEdition(title, undefined, "books", true)) return false;
    if (isAudioOrDramatizedForBooks({ kind: "books", title })) return false;
  }
  const formats = (opts.formats || []).filter(Boolean);
  if (formats.some((f) => AUDIO_FORMAT_RE.test(f))) return false;
  const pubs = (opts.publishers || []).filter(Boolean);
  if (pubs.length > 0 && pubs.every((p) => AUDIO_ONLY_PUBLISHER_RE.test(p))) return false;
  if (opts.language === "en" && pubs.length > 0 && pubs.every((p) => FOREIGN_BOOK_PUBLISHER_RE.test(p))) {
    return false;
  }
  return true;
}

function pickInlinePreferredEdition(
  doc: OpenLibrarySearchDoc,
  language: string,
): PreferredLanguageEdition | null {
  const eds = doc.editions?.docs;
  if (!Array.isArray(eds) || eds.length === 0) return null;
  for (const ed of eds) {
    if (!ed.cover_i || ed.cover_i <= 0) continue;
    if (!editionMatchesLanguage(ed.language, language)) continue;
    if (
      !isCleanPrintEdition({
        title: ed.title,
        publishers: ed.publisher,
        formats: ed.format,
        language,
      })
    ) {
      continue;
    }
    const { isbn, isbn13 } = pickBestIsbn(ed.isbn);
    const pub = pickBestPrintPublisher(ed.publisher, language);
    const years = (ed.publish_year || []).filter((y) => y >= 1400 && y <= new Date().getUTCFullYear() + 2);
    const minYear = years.length > 0 ? Math.min(...years) : undefined;
    return {
      coverUrl: olCoverUrl(ed.cover_i),
      publisher: pub,
      isbn,
      isbn13,
      year: minYear,
    };
  }
  return null;
}

function hasMultipleLanguages(langs?: string[]): boolean {
  if (!Array.isArray(langs) || langs.length <= 1) return false;
  return langs.some((l) => {
    const lc = String(l || "").trim().toLowerCase();
    return lc !== "eng" && lc !== "en" && lc !== "english";
  });
}

export function resolvePreferredLanguageEdition(
  workId: string,
  settings: PluginSettings,
): PreferredLanguageEdition | null {
  if (!settings.enableOpenLibrary) return null;
  const cleaned = workId.replace(/^ol-/, "").replace(/^\/works\//, "").trim();
  if (!/^OL\d+W$/i.test(cleaned)) return null;

  const data = fetchJson<OpenLibraryEditionsResponse>(
    `${OL_BASE}/works/${cleaned}/editions.json?limit=35`,
    {
      provider: "openlibrary",
      settings,
      cacheKey: `ol:prefed:${cleaned}:${settings.language}`,
      cacheTtlSec: 14 * 24 * 3600,
    },
  );
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) return null;

  const totalEditions = typeof data.size === "number" ? data.size : data.entries.length;
  interface ScoredEdition {
    score: number;
    year: number;
    entry: OpenLibraryEditionEntry;
    coverId: number;
  }
  const scored: ScoredEdition[] = [];
  let minValidEngYear = Number.POSITIVE_INFINITY;

  for (const e of data.entries) {
    if (!editionMatchesLanguage(e.languages, settings.language)) continue;
    const title = (e.title || "").trim();
    const pubs = Array.isArray(e.publishers) ? e.publishers.filter(Boolean) : [];
    const fmt = (e.physical_format || "").trim();
    if (
      !isCleanPrintEdition({
        title,
        publishers: pubs,
        formats: fmt ? [fmt] : [],
        language: settings.language,
      })
    ) {
      continue;
    }

    const yr = extractYear(e.publish_date);
    if (yr && yr >= 1400 && yr < minValidEngYear) {
      minValidEngYear = yr;
    }

    const covers = Array.isArray(e.covers)
      ? e.covers.filter((c): c is number => typeof c === "number" && c > 0)
      : [];
    if (covers.length === 0) continue;

    let score = 0;
    if (pubs.some((p) => MAJOR_ENGLISH_PRINT_PUBLISHER_RE.test(p) && !FOREIGN_BOOK_PUBLISHER_RE.test(p))) {
      score += 20;
    } else if (pubs.some((p) => !FOREIGN_BOOK_PUBLISHER_RE.test(p))) {
      score += 6;
    }
    if (fmt && PRINT_FORMAT_RE.test(fmt)) score += 8;
    const allIsbns = [...(e.isbn_13 || []), ...(e.isbn_10 || [])];
    if (allIsbns.some((i) => /^978[01]/.test(normalizeIsbn(i) || ""))) score += 6;
    if (typeof e.number_of_pages === "number" && e.number_of_pages >= 100) score += 5;
    if (title && !/:/.test(title)) score += 2;

    scored.push({
      score,
      year: yr || 9999,
      entry: e,
      coverId: covers[0],
    });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.year - b.year);
  const best = scored[0];
  const { isbn, isbn13 } = pickBestIsbn([
    ...(best.entry.isbn_13 || []),
    ...(best.entry.isbn_10 || []),
  ]);
  const resolvedYear =
    Number.isFinite(minValidEngYear) && minValidEngYear >= 1980 && totalEditions <= 35
      ? minValidEngYear
      : best.year < 9999
        ? best.year
        : undefined;

  return {
    coverUrl: olCoverUrl(best.coverId),
    publisher: pickBestPrintPublisher(best.entry.publishers, settings.language),
    isbn,
    isbn13,
    year: resolvedYear,
    totalEditions,
  };
}

function applyPreferredEditionToEntry(
  entry: NormalizedEntry,
  doc: OpenLibrarySearchDoc,
  settings: PluginSettings,
): void {
  const inlineEd = pickInlinePreferredEdition(doc, settings.language);
  const needsEditionsLookup =
    settings.language === "en" &&
    (hasMultipleLanguages(doc.language) ||
      !inlineEd ||
      (entry.publisher ? FOREIGN_BOOK_PUBLISHER_RE.test(entry.publisher) : false));
  const preferred = needsEditionsLookup
    ? resolvePreferredLanguageEdition(entry.sourceId, settings) || inlineEd
    : inlineEd;
  if (!preferred) return;

  if (preferred.coverUrl) entry.coverUrl = preferred.coverUrl;
  if (preferred.publisher) entry.publisher = preferred.publisher;
  if (preferred.isbn) entry.isbn = preferred.isbn;
  if (preferred.isbn13) entry.isbn13 = preferred.isbn13;
  if (
    preferred.year &&
    preferred.totalEditions !== undefined &&
    preferred.totalEditions <= 35 &&
    preferred.year >= 1980
  ) {
    entry.year = preferred.year;
    entry.released = Math.floor(Date.UTC(preferred.year, 0, 1) / 1000);
  }
}

function olCoverUrl(coverId?: number): string | undefined {
  if (!coverId || coverId <= 0) return undefined;
  return `${OL_COVER_BASE}/b/id/${coverId}-L.jpg`;
}

function olAuthorThumb(authorKey?: string): string | undefined {
  if (!authorKey) return undefined;
  const olid = authorKey.replace(/^\/authors\//, "").trim();
  if (!/^OL\d+A$/i.test(olid)) return undefined;
  return `${OL_COVER_BASE}/a/olid/${olid}-M.jpg`;
}

function workIdFromKey(key?: string): string | undefined {
  if (!key) return undefined;
  const cleaned = key.replace(/^\/works\//, "").replace(/^\/books\//, "").trim();
  return cleaned || undefined;
}

function extractSeriesFromTitleOrSubjects(
  title: string,
  subjects: string[],
): { cleanTitle: string; series?: string; seriesIndex?: number; seriesNumber?: string } {
  // Pattern 1: "Title (Series Name, #1)" or "Title (Series Name, Book 2)"
  const paren = /^(.+?)\s*\(([^()]+?)(?:,\s*(?:#|Book\s*|Vol\.?\s*)?(\d+(?:\.\d+)?))\)\s*$/i.exec(
    title,
  );
  if (paren) {
    const pos = parseSeriesPosition(paren[3]);
    return {
      cleanTitle: paren[1].trim(),
      series: canonicalizeSeriesName(paren[2].trim()),
      seriesIndex: pos.index,
      seriesNumber: pos.display,
    };
  }
  // Pattern 2: Open Library subject tags like "series:Dune" or "series:Harry_Potter"
  for (const s of subjects) {
    const sm = /^series:(.+)$/i.exec(s.trim());
    if (sm && sm[1].trim().length >= 2) {
      const cleanedSeries = canonicalizeSeriesName(
        sm[1].replace(/_/g, " ").replace(/\s+/g, " ").trim(),
      );
      return { cleanTitle: title, series: cleanedSeries };
    }
  }
  return { cleanTitle: title };
}

function pickBestLanguage(langs?: string[]): string {
  if (!Array.isArray(langs) || langs.length === 0) return "English";
  for (const raw of langs) {
    const lc = String(raw || "").trim().toLowerCase();
    if (lc === "eng" || lc === "en" || lc === "english") return "English";
  }
  return normalizeLanguage(langs[0]) || "English";
}

function pickBestIsbn(isbns?: string[]): { isbn?: string; isbn13?: string } {
  if (!Array.isArray(isbns)) return {};
  let en13: string | undefined;
  let en10: string | undefined;
  let any13: string | undefined;
  let any10: string | undefined;
  for (const raw of isbns) {
    const n = normalizeIsbn(raw);
    if (!n) continue;
    if (n.length === 13) {
      if (!any13) any13 = n;
      if (!en13 && (n.startsWith("9780") || n.startsWith("9781"))) en13 = n;
    } else if (n.length === 10) {
      if (!any10) any10 = n;
      if (!en10 && (n.startsWith("0") || n.startsWith("1"))) en10 = n;
    }
    if (en13 && en10) break;
  }
  const isbn13 = en13 || any13;
  const isbn10 = en10 || any10;
  return { isbn: isbn13 || isbn10, isbn13 };
}

function mapAuthors(names?: string[], keys?: string[]): PersonCredit[] {
  const out: PersonCredit[] = [];
  const seen = new Set<string>();
  const list = names || [];
  for (let i = 0; i < list.length && out.length < 6; i++) {
    const name = (list[i] || "").trim();
    if (!name) continue;
    const norm = name.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({
      name,
      role: "Author",
      thumb: olAuthorThumb(keys?.[i]),
    });
  }
  return out;
}

function buildFallbackSummary(opts: {
  title: string;
  authors: PersonCredit[];
  genres: string[];
  year?: number;
  series?: string;
  seriesNumber?: string;
}): string {
  const authorNames = opts.authors
    .map((a) => a.name)
    .filter((n) => n && !/^unknown/i.test(n))
    .slice(0, 2)
    .join(" and ");
  const parts: string[] = [];
  if (opts.series) {
    const serLabel = /^the\s+/i.test(opts.series) ? opts.series : `the ${opts.series} series`;
    parts.push(
      opts.seriesNumber
        ? `Book ${opts.seriesNumber} of ${opts.series}`
        : `Part of ${serLabel}`,
    );
  } else if (opts.genres.length > 0) {
    const primary = opts.genres[0];
    if (primary === "Biography and memoir") {
      parts.push("A biography");
    } else if (primary === "Classics") {
      parts.push("A classic book");
    } else {
      parts.push(`A ${primary.toLowerCase()} book`);
    }
  } else {
    parts.push("A book");
  }
  if (authorNames) parts.push(`by ${authorNames}`);
  if (opts.year) parts.push(`(${opts.year})`);
  return `${parts.join(" ")}.`;
}

function mapSearchDoc(
  doc: OpenLibrarySearchDoc,
  extraGenres: string[] = [],
  curatedTags: string[] = [],
  awardTags: string[] = [],
  language = "en",
): NormalizedEntry | null {
  const workId = workIdFromKey(doc.key);
  const rawTitle = (doc.title || "").trim();
  if (!workId || !rawTitle) return null;

  const rawSubtitle = doc.subtitle?.trim() || undefined;
  const subjects = Array.isArray(doc.subject) ? doc.subject : [];
  const publishers = Array.isArray(doc.publisher) ? doc.publisher : [];
  const formats = Array.isArray(doc.format) ? doc.format : [];
  const rawAuthors = Array.isArray(doc.author_name) ? doc.author_name : [];

  const hygieneInput = {
    kind: "books" as const,
    title: rawTitle,
    subtitle: rawSubtitle,
    authors: rawAuthors,
    publishers,
    subjects,
    formats,
    year: extractYear(doc.first_publish_year),
    language,
  };
  if (isNonBookProduct(hygieneInput)) return null;
  if (isAudioOrDramatizedForBooks(hygieneInput)) return null;

  const seriesInfo = extractSeriesFromTitleOrSubjects(rawTitle, subjects);
  if (isBoxSetOrOmnibus(rawTitle, rawSubtitle, seriesInfo.series)) return null;
  if (isSplitPartEdition(rawTitle, rawSubtitle, "books", Boolean(seriesInfo.series))) return null;
  if (language === "en" && isLikelyNonEnglishText(rawTitle)) return null;

  const inlineEd = pickInlinePreferredEdition(doc, language);
  const coverUrl = inlineEd?.coverUrl || olCoverUrl(doc.cover_i);
  const { isbn, isbn13 } = inlineEd?.isbn
    ? { isbn: inlineEd.isbn, isbn13: inlineEd.isbn13 }
    : pickBestIsbn(doc.isbn);
  const authors = mapAuthors(doc.author_name, doc.author_key);
  const genres = inferGenresFromMetadata(seriesInfo.cleanTitle, rawSubtitle, subjects, extraGenres);
  const rating =
    normalizeRating(doc.ratings_average, 5) ||
    (doc.edition_count && doc.edition_count >= 50 ? 8.3 : doc.edition_count && doc.edition_count >= 15 ? 7.8 : undefined);
  const curated = [...curatedTags];
  if (seriesInfo.series && seriesInfo.seriesIndex === 1) {
    curated.push("Series to start");
  }
  const rawFirstSentence = Array.isArray(doc.first_sentence)
    ? doc.first_sentence[0]
    : doc.first_sentence;
  const firstSentence =
    rawFirstSentence && !isJunkFirstSentence(rawFirstSentence, language)
      ? rawFirstSentence
      : undefined;

  const year = extractYear(doc.first_publish_year);
  const finalAuthors = authors.length > 0 ? authors : [{ name: "Unknown author", role: "Author" }];

  return {
    kind: "books",
    source: "openlibrary",
    sourceId: stableExternalId("ol", workId),
    title: seriesInfo.cleanTitle,
    subtitle: rawSubtitle,
    summary:
      clampSummary(firstSentence) ||
      buildFallbackSummary({
        title: seriesInfo.cleanTitle,
        authors: finalAuthors,
        genres,
        year,
        series: seriesInfo.series,
        seriesNumber: seriesInfo.seriesNumber,
      }),
    year,
    released: year ? Math.floor(Date.UTC(year, 0, 1) / 1000) : undefined,
    rating,
    authors: finalAuthors,
    series: seriesInfo.series,
    seriesIndex: seriesInfo.seriesIndex,
    seriesNumber: seriesInfo.seriesNumber,
    genres,
    awards: awardTags.length > 0 ? dedupeStrings(awardTags, 6) : undefined,
    curated: dedupeStrings(curated, 8),
    publisher: inlineEd?.publisher || pickBestPrintPublisher(publishers, language),
    isbn,
    isbn13,
    pages: doc.number_of_pages_median && doc.number_of_pages_median > 0 ? doc.number_of_pages_median : undefined,
    format: "epub",
    language: pickBestLanguage(doc.language),
    coverUrl,
  };
}

export function fetchOpenLibraryTrending(
  settings: PluginSettings,
  limit = 32,
): NormalizedEntry[] {
  if (!settings.enableOpenLibrary) return [];
  const data = fetchJson<OpenLibraryTrendingResponse>(
    `${OL_BASE}/trending/weekly.json?limit=${limit}`,
    {
      provider: "openlibrary",
      settings,
      cacheKey: `ol:trending:${limit}`,
      cacheTtlSec: 3 * 3600,
    },
  );
  if (!data?.works) return [];
  const out: NormalizedEntry[] = [];
  for (const w of data.works) {
    const workId = workIdFromKey(w.key);
    const title = (w.title || "").trim();
    const coverUrl = olCoverUrl(w.cover_i);
    if (!workId || !title || !coverUrl) continue;
    if (
      settings.language === "en" &&
      Array.isArray(w.language) &&
      w.language.length > 0 &&
      !w.language.includes("eng") &&
      !w.language.includes("en")
    ) {
      continue;
    }
    if (settings.language === "en" && isLikelyNonEnglishText(title)) continue;
    if (
      isNonBookProduct({
        kind: "books",
        title,
        authors: w.author_name || [],
      }) ||
      isAudioOrDramatizedForBooks({ kind: "books", title }) ||
      isBoxSetOrOmnibus(title) ||
      isSplitPartEdition(title, undefined, "books", false)
    ) {
      continue;
    }
    const authors = mapAuthors(w.author_name, w.author_key);
    const year = extractYear(w.first_publish_year);
    const curated = ["Popular this week"];
    if (year && year >= 2022) curated.push("New and notable");
    const finalAuthors = authors.length > 0 ? authors : [{ name: "Unknown author", role: "Author" }];
    const genres = inferGenresFromMetadata(title, undefined, [], []);
    out.push({
      kind: "books",
      source: "openlibrary",
      sourceId: stableExternalId("ol", workId),
      title,
      summary: buildFallbackSummary({
        title,
        authors: finalAuthors,
        genres,
        year,
      }),
      year,
      released: year ? Math.floor(Date.UTC(year, 0, 1) / 1000) : undefined,
      rating: w.edition_count && w.edition_count > 40 ? 8.4 : 8.0,
      authors: finalAuthors,
      genres,
      curated,
      format: "epub",
      language: pickBestLanguage(w.language),
      coverUrl,
    });
  }
  return out;
}

const OL_CURATED_SUBJECTS: Array<{ slug: string; genre: string }> = [
  { slug: "science_fiction", genre: "Science fiction" },
  { slug: "fantasy", genre: "Fantasy" },
  { slug: "mystery", genre: "Mystery and thriller" },
  { slug: "thriller", genre: "Mystery and thriller" },
  { slug: "literary_fiction", genre: "Literary fiction" },
  { slug: "history", genre: "History" },
  { slug: "biography", genre: "Biography and memoir" },
  { slug: "horror", genre: "Horror" },
  { slug: "nonfiction", genre: "Non-fiction" },
];

const OL_AWARD_QUERIES: Array<{ query: string; award: string; genre?: string }> = [
  { query: 'subject:"Hugo Award"', award: "Hugo Award", genre: "Science fiction" },
  { query: 'subject:"Nebula Award"', award: "Nebula Award", genre: "Science fiction" },
  { query: 'subject:"Pulitzer Prize"', award: "Pulitzer Prize", genre: "Literary fiction" },
  { query: 'subject:"Booker Prize"', award: "Booker Prize", genre: "Literary fiction" },
];

const OL_CURATED_SERIES: Array<{
  query: string;
  series: string;
  bookNum: number;
  genre: string;
}> = [
  { query: "Dune Frank Herbert", series: "Dune", bookNum: 1, genre: "Science fiction" },
  { query: "Dune Messiah Frank Herbert", series: "Dune", bookNum: 2, genre: "Science fiction" },
  { query: "Children of Dune Frank Herbert", series: "Dune", bookNum: 3, genre: "Science fiction" },
  { query: "The Fellowship of the Ring Tolkien", series: "The Lord of the Rings", bookNum: 1, genre: "Fantasy" },
  { query: "The Two Towers Tolkien", series: "The Lord of the Rings", bookNum: 2, genre: "Fantasy" },
  { query: "The Return of the King Tolkien", series: "The Lord of the Rings", bookNum: 3, genre: "Fantasy" },
  { query: "The Way of Kings Brandon Sanderson", series: "The Stormlight Archive", bookNum: 1, genre: "Fantasy" },
  { query: "Words of Radiance Brandon Sanderson", series: "The Stormlight Archive", bookNum: 2, genre: "Fantasy" },
  { query: "Oathbringer Brandon Sanderson", series: "The Stormlight Archive", bookNum: 3, genre: "Fantasy" },
  { query: "Rhythm of War Brandon Sanderson", series: "The Stormlight Archive", bookNum: 4, genre: "Fantasy" },
  { query: "Wind and Truth Brandon Sanderson", series: "The Stormlight Archive", bookNum: 5, genre: "Fantasy" },
  { query: "The Final Empire Brandon Sanderson", series: "Mistborn", bookNum: 1, genre: "Fantasy" },
  { query: "Leviathan Wakes James S. A. Corey", series: "The Expanse", bookNum: 1, genre: "Science fiction" },
  { query: "Caliban's War James S. A. Corey", series: "The Expanse", bookNum: 2, genre: "Science fiction" },
  { query: "Foundation Isaac Asimov", series: "Foundation", bookNum: 1, genre: "Science fiction" },
  { query: "Foundation and Empire Isaac Asimov", series: "Foundation", bookNum: 2, genre: "Science fiction" },
  { query: "The Three-Body Problem Liu Cixin", series: "Remembrance of Earth's Past", bookNum: 1, genre: "Science fiction" },
  { query: "All Systems Red Martha Wells", series: "The Murderbot Diaries", bookNum: 1, genre: "Science fiction" },
  { query: "A Wizard of Earthsea Ursula K. Le Guin", series: "Earthsea Cycle", bookNum: 1, genre: "Fantasy" },
  { query: "Red Rising Pierce Brown", series: "Red Rising", bookNum: 1, genre: "Science fiction" },
  { query: "Golden Son Pierce Brown", series: "Red Rising", bookNum: 2, genre: "Science fiction" },
  { query: "Morning Star Pierce Brown", series: "Red Rising", bookNum: 3, genre: "Science fiction" },
  { query: "A Game of Thrones George R. R. Martin", series: "A Song of Ice and Fire", bookNum: 1, genre: "Fantasy" },
  { query: "The Eye of the World Robert Jordan", series: "The Wheel of Time", bookNum: 1, genre: "Fantasy" },
  { query: "The Hunger Games Suzanne Collins", series: "The Hunger Games", bookNum: 1, genre: "Science fiction" },
];

function pickBestSearchDoc(
  docs: OpenLibrarySearchDoc[] | undefined,
  language: string,
): OpenLibrarySearchDoc | undefined {
  if (!docs || docs.length === 0) return undefined;
  const eligible = docs.filter((d) => {
    if (!d.cover_i || !d.title) return false;
    if (language === "en" && isLikelyNonEnglishText(d.title)) return false;
    const h = {
      kind: "books" as const,
      title: d.title,
      subtitle: d.subtitle,
      authors: d.author_name || [],
      publishers: d.publisher || [],
      subjects: d.subject || [],
      formats: d.format || [],
    };
    if (isNonBookProduct(h) || isAudioOrDramatizedForBooks(h)) return false;
    if (isBoxSetOrOmnibus(d.title, d.subtitle) || isSplitPartEdition(d.title, d.subtitle, "books", true)) {
      return false;
    }
    return true;
  });
  if (eligible.length === 0) return undefined;
  eligible.sort((a, b) => (b.edition_count || 0) - (a.edition_count || 0));
  return eligible[0];
}

export function fetchOpenLibraryCatalog(settings: PluginSettings): NormalizedEntry[] {
  if (!settings.enableOpenLibrary) return [];
  const depth = settings.catalogSize;
  const trendLimit = depth === "compact" ? 18 : depth === "large" ? 48 : 30;
  const subjLimit = depth === "compact" ? 8 : depth === "large" ? 20 : 14;
  const awardLimit = depth === "compact" ? 6 : depth === "large" ? 14 : 10;

  const out: NormalizedEntry[] = [];
  out.push(...fetchOpenLibraryTrending(settings, trendLimit));

  // Subject shelves
  for (const s of OL_CURATED_SUBJECTS) {
    const data = fetchJson<OpenLibrarySubjectResponse>(
      `${OL_BASE}/subjects/${s.slug}.json?limit=${subjLimit}`,
      {
        provider: "openlibrary",
        settings,
        cacheKey: `ol:subj:${s.slug}:${subjLimit}`,
        cacheTtlSec: 6 * 3600,
      },
    );
    if (!data?.works) continue;
    for (const w of data.works) {
      const workId = workIdFromKey(w.key);
      const title = (w.title || "").trim();
      const coverUrl = olCoverUrl(w.cover_id);
      if (!workId || !title || !coverUrl) continue;
      if (settings.language === "en" && isLikelyNonEnglishText(title)) continue;
      const authorNames = (w.authors || []).map((a) => a.name || "").filter(Boolean);
      const rawSubjects = Array.isArray(w.subject) ? w.subject : [];
      if (
        isNonBookProduct({ kind: "books", title, authors: authorNames, subjects: rawSubjects }) ||
        isAudioOrDramatizedForBooks({ kind: "books", title, subjects: rawSubjects }) ||
        isBoxSetOrOmnibus(title) ||
        isSplitPartEdition(title, undefined, "books", false)
      ) {
        continue;
      }

      // Guard non-fiction / biography / history shelves against fiction/drama/poetry classics
      // tagged with tangential biography subjects in Open Library (e.g. Shakespeare plays, Anne of Green Gables).
      const derivedGenres = canonicalizeGenres(rawSubjects, 5);
      const isNonFictionShelf =
        s.slug === "biography" || s.slug === "nonfiction" || s.slug === "history";
      if (isNonFictionShelf) {
        const looksFiction =
          derivedGenres.some((g) => FICTION_GENRES.has(g)) ||
          rawSubjects.some((rs) => /\b(fiction|drama|plays|tragedies|comedies|poetry|poems)\b/i.test(rs));
        const explicitlyMemoir =
          /\b(autobiography|memoir|narrative\s+of\s+the\s+life|twelve\s+years\s+a\s+slave|walden)\b/i.test(
            title,
          );
        if (looksFiction && !explicitlyMemoir) {
          continue;
        }
      }

      const authors: PersonCredit[] = (w.authors || [])
        .filter((a) => a.name)
        .slice(0, 6)
        .map((a) => ({
          name: a.name!.trim(),
          role: "Author",
          thumb: olAuthorThumb(a.key),
        }));
      const seriesInfo = extractSeriesFromTitleOrSubjects(title, rawSubjects);
      const genres = dedupeStrings([s.genre, ...derivedGenres], 6);
      const year = extractYear(w.first_publish_year);
      const curated: string[] = [];
      if (year && year >= 2022) curated.push("New and notable");
      if (seriesInfo.series && seriesInfo.seriesIndex === 1) curated.push("Series to start");

      const finalAuthors = authors.length > 0 ? authors : [{ name: "Unknown author", role: "Author" }];
      out.push({
        kind: "books",
        source: "openlibrary",
        sourceId: stableExternalId("ol", workId),
        title: seriesInfo.cleanTitle,
        summary: buildFallbackSummary({
          title: seriesInfo.cleanTitle,
          authors: finalAuthors,
          genres,
          year,
          series: seriesInfo.series,
          seriesNumber: seriesInfo.seriesNumber,
        }),
        year,
        released: year ? Math.floor(Date.UTC(year, 0, 1) / 1000) : undefined,
        rating: w.edition_count && w.edition_count >= 50 ? 8.4 : 7.9,
        authors: finalAuthors,
        series: seriesInfo.series,
        seriesIndex: seriesInfo.seriesIndex,
        seriesNumber: seriesInfo.seriesNumber,
        genres,
        curated,
        format: "epub",
        language: "English",
        coverUrl,
      });
    }
  }

  // Award winners shelf & Awards tab
  for (const aw of OL_AWARD_QUERIES) {
    const qs = encodeQuery({
      q: settings.language === "en" ? `${aw.query} language:eng` : aw.query,
      lang: settings.language === "en" ? "en" : undefined,
      sort: "editions",
      limit: awardLimit,
      fields: SEARCH_FIELDS,
    });
    const data = fetchJson<OpenLibrarySearchResponse>(`${OL_BASE}/search.json?${qs}`, {
      provider: "openlibrary",
      settings,
      cacheKey: `ol:aw2:${aw.award}:${settings.language}:${awardLimit}`,
      cacheTtlSec: 12 * 3600,
    });
    if (!data?.docs) continue;
    for (const doc of data.docs) {
      if (!doc.cover_i) continue;
      const mapped = mapSearchDoc(
        doc,
        aw.genre ? [aw.genre] : [],
        ["Award winners"],
        [aw.award],
        settings.language,
      );
      if (mapped) out.push(mapped);
    }
  }

  // Curated series & Series to start shelf (ensures ordered multi-book Series tab out of the box)
  const seriesLimit = depth === "compact" ? 10 : OL_CURATED_SERIES.length;
  for (let i = 0; i < seriesLimit; i++) {
    const sp = OL_CURATED_SERIES[i];
    const qs = encodeQuery({
      q: sp.query,
      language: settings.language === "en" ? "eng" : undefined,
      lang: settings.language === "en" ? "en" : undefined,
      limit: 5,
      fields: SEARCH_FIELDS,
    });
    const sData = fetchJson<OpenLibrarySearchResponse>(`${OL_BASE}/search.json?${qs}`, {
      provider: "openlibrary",
      settings,
      cacheKey: `ol:ser3:${sp.series}:${sp.bookNum}`,
      cacheTtlSec: 24 * 3600,
    });
    const doc = pickBestSearchDoc(sData?.docs, settings.language);
    if (!doc) continue;
    const curated = sp.bookNum === 1 ? ["Series to start", "Popular this week"] : [];
    const mapped = mapSearchDoc(doc, [sp.genre], curated, [], settings.language);
    if (mapped) {
      applyPreferredEditionToEntry(mapped, doc, settings);
      mapped.series = sp.series;
      mapped.seriesIndex = sp.bookNum;
      mapped.seriesNumber = String(sp.bookNum);
      if (!mapped.summary || /^(?:A |Part of |Book \d+)/i.test(mapped.summary)) {
        mapped.summary = buildFallbackSummary({
          title: mapped.title,
          authors: mapped.authors,
          genres: mapped.genres,
          year: mapped.year,
          series: mapped.series,
          seriesNumber: mapped.seriesNumber,
        });
      }
      out.push(mapped);
    }
  }

  // Curated non-fiction & memoir anchors (so Non-fiction, History, and Biography shelves feel editorial)
  const editorialQueries: Array<{ q: string; genres: string[]; curated?: string[] }> = [
    { q: "Sapiens Yuval Noah Harari", genres: ["Non-fiction", "History"] },
    { q: "Atomic Habits James Clear", genres: ["Non-fiction", "Self-help"], curated: ["Popular this week"] },
    { q: "Educated Tara Westover", genres: ["Biography and memoir", "Non-fiction"] },
    { q: "The Devil in the White City Erik Larson", genres: ["History", "Non-fiction"] },
    { q: "Killers of the Flower Moon David Grann", genres: ["History", "Non-fiction"] },
    { q: "Steve Jobs Walter Isaacson", genres: ["Biography and memoir", "Non-fiction"] },
    { q: "Thinking Fast and Slow Daniel Kahneman", genres: ["Non-fiction", "Science"] },
    { q: "The Warmth of Other Suns Isabel Wilkerson", genres: ["History", "Non-fiction"] },
    { q: "Becoming Michelle Obama", genres: ["Biography and memoir", "Non-fiction"] },
    { q: "Into Thin Air Jon Krakauer", genres: ["Non-fiction", "Biography and memoir"] },
  ];
  for (const eq of editorialQueries) {
    const eqs = encodeQuery({
      q: eq.q,
      language: settings.language === "en" ? "eng" : undefined,
      lang: settings.language === "en" ? "en" : undefined,
      limit: 5,
      fields: SEARCH_FIELDS,
    });
    const eData = fetchJson<OpenLibrarySearchResponse>(`${OL_BASE}/search.json?${eqs}`, {
      provider: "openlibrary",
      settings,
      cacheKey: `ol:ed3:${eq.q}`,
      cacheTtlSec: 24 * 3600,
    });
    const doc = pickBestSearchDoc(eData?.docs, settings.language);
    if (!doc) continue;
    const mapped = mapSearchDoc(doc, eq.genres, eq.curated || [], [], settings.language);
    if (mapped) {
      applyPreferredEditionToEntry(mapped, doc, settings);
      mapped.genres = dedupeStrings([...eq.genres, ...mapped.genres.filter((g) => g !== "Literary fiction" && g !== "Classics")], 5);
      out.push(mapped);
    }
  }

  // Recent notable releases (curated 2024-2026 acclaimed fiction & non-fiction; avoids academic proceedings)
  const recentQueries: Array<{ q: string; genres: string[] }> = [
    { q: "Sunrise on the Reaping Suzanne Collins", genres: ["Science fiction", "Young adult"] },
    { q: "Wind and Truth Brandon Sanderson", genres: ["Fantasy"] },
    { q: "The Women Kristin Hannah", genres: ["Historical fiction", "Literary fiction"] },
    { q: "James Percival Everett", genres: ["Literary fiction", "Historical fiction"] },
    { q: "The God of the Woods Liz Moore", genres: ["Mystery and thriller", "Literary fiction"] },
    { q: "Intermezzo Sally Rooney", genres: ["Literary fiction"] },
    { q: "The Ministry of Time Kaliane Bradley", genres: ["Science fiction", "Literary fiction"] },
    { q: "Nexus Yuval Noah Harari", genres: ["Non-fiction", "History"] },
    { q: "Funny Story Emily Henry", genres: ["Romance", "Literary fiction"] },
    { q: "Onyx Storm Rebecca Yarros", genres: ["Fantasy", "Romance"] },
    { q: "Martyr Kaveh Akbar", genres: ["Literary fiction"] },
    { q: "All the Colors of the Dark Chris Whitaker", genres: ["Mystery and thriller"] },
  ];
  const recentLimit = depth === "compact" ? 6 : recentQueries.length;
  for (let i = 0; i < recentLimit; i++) {
    const rq = recentQueries[i];
    const rqs = encodeQuery({
      q: rq.q,
      language: settings.language === "en" ? "eng" : undefined,
      lang: settings.language === "en" ? "en" : undefined,
      limit: 4,
      fields: SEARCH_FIELDS,
    });
    const rData = fetchJson<OpenLibrarySearchResponse>(`${OL_BASE}/search.json?${rqs}`, {
      provider: "openlibrary",
      settings,
      cacheKey: `ol:rec4:${rq.q}`,
      cacheTtlSec: 12 * 3600,
    });
    const doc = pickBestSearchDoc(rData?.docs, settings.language);
    if (!doc) continue;
    const mapped = mapSearchDoc(doc, rq.genres, ["New and notable"], [], settings.language);
    if (mapped) {
      applyPreferredEditionToEntry(mapped, doc, settings);
      out.push(mapped);
    }
  }

  return out;
}

export function searchOpenLibrary(
  query: string,
  settings: PluginSettings,
  opts?: { limit?: number; author?: string; subject?: string; page?: number },
): NormalizedEntry[] {
  if (!settings.enableOpenLibrary) return [];
  const limit = opts?.limit || 20;
  const params: Record<string, string | number | undefined> = {
    limit,
    page: opts?.page && opts.page > 1 ? opts.page : undefined,
    fields: SEARCH_FIELDS,
  };
  if (opts?.author) {
    params.author = opts.author;
    params.sort = "editions";
  } else if (opts?.subject) {
    params.subject = opts.subject;
    params.sort = "editions";
  } else {
    params.q = query.trim();
  }
  if (settings.language === "en") {
    params.language = "eng";
    params.lang = "en";
  }
  const qs = encodeQuery(params);
  const data = fetchJson<OpenLibrarySearchResponse>(`${OL_BASE}/search.json?${qs}`, {
    provider: "openlibrary",
    settings,
    cacheKey: `ol:q3:${qs}`,
    cacheTtlSec: 3600,
  });
  if (!data?.docs) return [];
  const out: NormalizedEntry[] = [];
  for (const doc of data.docs) {
    const mapped = mapSearchDoc(doc, [], [], [], settings.language);
    if (mapped) out.push(mapped);
  }
  return out;
}

export function hydrateOpenLibraryWork(
  workId: string,
  settings: PluginSettings,
): { summary?: string; genres?: string[]; coverUrl?: string } | null {
  if (!settings.enableOpenLibrary) return null;
  const cleaned = workId.replace(/^ol-/, "").trim();
  if (!/^OL\d+W$/i.test(cleaned)) return null;
  const data = fetchJson<OpenLibraryWorkDetail>(`${OL_BASE}/works/${cleaned}.json`, {
    provider: "openlibrary",
    settings,
    cacheKey: `ol:work:${cleaned}`,
    cacheTtlSec: 24 * 3600,
  });
  if (!data) return null;
  const rawDesc =
    typeof data.description === "string"
      ? data.description
      : data.description?.value || "";
  return {
    summary: clampSummary(rawDesc),
    genres: Array.isArray(data.subjects) ? canonicalizeGenres(data.subjects, 6) : undefined,
    coverUrl: olCoverUrl(data.covers?.[0]),
  };
}
