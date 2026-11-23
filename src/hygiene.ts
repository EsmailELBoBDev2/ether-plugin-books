// Catalogue hygiene, non-book/merchandise filtering, biography/non-fiction genre
// inference, canonical series & work normalization, and per-series edition
// deduplication (one canonical edition per work; dramatised audio belongs only
// to audiobooks, never books).

import { canonicalizeGenres, dedupeStrings, extractSurname, normalizeText } from "./text.ts";
import type { KindItem, NormalizedEntry } from "./types.ts";

// Non-book physical products, merchandise, sheet music, RPG rulebooks, study guides,
// conference proceedings, and government calibration/maintenance manuals.
const NON_BOOK_TITLE_RE =
  /\b(wall\s*poster|poster\s*print|poster\s*book|mini\s*poster|wall\s*calendar|desk\s*calendar|advent\s*calendar|mini\s*calendar|sticker\s*book|activity\s*book|coloring\s*book|colouring\s*book|blank\s*(?:notebook|journal|lined)|lined\s*(?:notebook|journal)|composition\s*notebook|sketchbook|daily\s*planner|weekly\s*planner|action\s*figure|bobblehead|t-?shirt|coffee\s*mug|jigsaw\s*puzzle|playing\s*cards|tarot\s*deck|vinyl\s*(?:lp|record)|blu-?ray|dvd|vhs|cd-?rom|audio\s*cassette|playaway|sheet\s*music|guitar\s*tab(?:lature)?|bass\s*tab|drum\s*tab|piano\s*vocal\s*guitar|songbook|chord\s*book|fake\s*book|play[- ]?along|play\s+(?:guitar|drums|bass|piano)\s+with|jam\s+with|roleplaying\s*game|international\s+conference\s+on|proceedings\s+of\s+the|difference\s+calibrations|maintenance\s+training\s+manual)\b/i;

const TRAILING_POSTER_OR_MERCH_RE =
  /(?:[-–—:(]\s*|\b)(?:wall\s*)?(?:poster|calendar|merchandise|songbook|sheet\s*music|guitar\s*tab|dvd|blu-?ray)\s*\)?\s*$/i;

const RPG_HANDBOOK_RE =
  /\brpg\b.*\b(?:handbook|rulebook|sourcebook|starter\s*set|campaign|adventure|guide)\b|\b(?:handbook|rulebook|sourcebook)\b.*\brpg\b/i;

const ADAPTATION_OR_STUDY_GUIDE_RE =
  /\[\s*adaptation\s*\]|^(?:summary\s+(?:&|and)\s+(?:analysis|study\s+guide)|summary\s+of\b|study\s+guide\s*[:\-]|cliffsnotes|sparknotes|quickread|instaread|supersummary)\b/i;

const NON_BOOK_PUBLISHER_RE =
  /\b(merchandising|aquarius\s+entertainment|trends\s+international|pyramid\s+(?:international|posters)|browntrout|calendars\.com|graphique\s+de\s+france|hal\s+leonard|leonard\s+corporation,\s*hal|music\s+sales|wise\s+publications|amsco\s+publications|cherry\s+lane\s+music|alfred\s+music|mel\s+bay|bookcaps|instaread|supersummary|cliffsnotes|sparknotes|quickread|national\s+institute\s+of\s+standards|u\.s\.\s*govt\.\s*print\.\s*off\.|brotherwise\s+games)\b/i;

const RECORD_LABEL_PUBLISHER_RE =
  /^(?:atco|atlantic\s*records?|columbia\s*records?|epic\s*records?|albert\s*productions?|emi|sony\s*music|warner\s*bros\.?\s*records?|capitol\s*records?|polydor|rca\s*records?|geffen|island\s*records?|virgin\s*records?|elektra)$/i;

const MUSICAL_GROUP_AUTHOR_RE = /\(\s*(?:musical\s+group|rock\s+band|band)\s*\)/i;
const REPEATED_TOKEN_AUTHOR_RE = /^([a-z0-9/&.-]{2,20})\s+\1$/i;

const SHEET_MUSIC_SUBJECT_RE =
  /\b(guitar\s+music|guitar,\s*instruction|tablature|percussion\s+music|drum\s+set\s+music|songbooks?|musical\s+scores?|vocal\s+scores?|piano\s+music|sheet\s+music|scores\s+and\s+parts)\b/i;

const REAL_BOOK_SUBJECT_RE =
  /\b(biography|biographies|autobiography|memoir|memoirs|history\s+and\s+criticism|interviews|fiction|novel|novels|literature)\b/i;

// Audio / dramatised editions that must never appear in the Books library.
export const AUDIO_ONLY_PUBLISHER_RE =
  /\b(graphic\s*audio|blackstone\s*audio(?:books)?|brilliance\s*audio|recorded\s*books|macmillan\s*audio|random\s*house\s*audio|penguin\s*audio|harper\s*audio|hachette\s*audio|simon\s*&?\s*schuster\s*audio|audible(?:\s*studios)?|tantor(?:\s*audio|\s*media)?|podium\s*audio|dreamscape\s*media|bolinda\s*audio|wf\s*howes|highbridge\s*audio|oasis\s*audio|listening\s*library|books\s*on\s*tape|bookcassette|soundbooth\s*theater)\b/i;

export const DRAMATIZED_PUBLISHER_RE = /\b(graphic\s*audio|soundbooth\s*theater)\b/i;

export const AUDIO_EDITION_TITLE_RE =
  /\b(graphic\s*audio|dramatiz(?:ed|ation)|dramatis(?:ed|ation)|full\s*cast\s*audio|audio\s*(?:book|edition|drama|cd|cassette)|unabridged\s*audio|mp3\s*cd|compact\s*disc|a\s*movie\s*in\s*your\s*mind)\b/i;

const AUDIO_OR_NONBOOK_FORMAT_RE =
  /^(?:audio\s*cd|mp3\s*cd|audiobook|eaudiobook|audio\s*cassette|compact\s*disc|sound\s*recording|playaway|cd|dvd|vhs|poster|calendar|sheet\s*music|musical\s*score)$/i;

// Box sets, omnibuses, multi-book collections, samplers, and split-part editions.
const BOX_SET_OR_OMNIBUS_RE =
  /\b(box(?:ed)?\s*set|\d+\s*[-–]?\s*books?\s*(?:set|collection|bundle|box)|books?\s+\d+\s*[-–,]\s*\d+|book\s+\d+\s*,\s*\d+|vol(?:ume)?s?\.?\s*\d+\s*[-–]\s*\d+|omnibus|complete\s+(?:series|trilogy|collection|saga)|series\s+collection|\d+\s*in\s*1\b|bundle\s+pack|collector'?s\s*(?:set|box)|trilogy\s*:\s*[^:]+book\s+1\s*,\s*2|fantasy\s+firsts|sanderson\s+sampler|\bbook\s+sampler\b)\b|^the\s+complete\s+[a-z0-9']+\s*$/i;

const FRACTIONAL_SPLIT_RE = /\(\s*(?:part\s*)?\d+\s+of\s+\d+\s*\)/i;

const TRAILING_SPLIT_PART_RE =
  /(?:[,:\-–—]|\s)\s*part\s+(?:one|two|three|four|five|six|\d+)(?:\s+of\s+\d+)?(?:\s*[:(\[]|$)|\(\s*part\s+(?:one|two|three|four|five|six|\d+)(?:\s+of\s+\d+)?\s*\)/i;

const CLASSIC_PART_EXEMPT_RE = /^(?:king\s+)?henry\s+(?:iv|vi)\b|^faust\b/i;

const NON_ENGLISH_TITLE_RE =
  /\b(trotzdem\s+ja\s+zum\s+leben|lecciones\s+de\s+liderazgo|el\s+camino\s+de\s+los\s+reyes|palabras\s+radiantes|juramentada|el\s+ritmo\s+de\s+la\s+guerra|viento\s+y\s+verdad|el\s+archivo\s+de\s+las\s+tormentas|rüzgar\s+ve\s+hakikat|comment\s+se\s+faire\s+des\s+amis|der\s+weg\s+der\s+könige|die\s+worte\s+des\s+lichts|la\s+voie\s+des\s+rois)\b/i;

export const FOREIGN_BOOK_PUBLISHER_RE =
  /\b(trama|nova|ediciones\s+b|timun\s+mas|grupo\s+editorial|livre\s+de\s+poche|heyne\s+verlag|wydawnictwo|akil\s+[cç]elen|planeta|plaza\s*&\s*jan[eé]s|debolsillo|salamandra|mondadori|gallimard|bompiani|blanvalet|klett-cotta|fischer\s+verlag|piper\s+verlag|editorial\s+minotauro|bragelonne)\b/i;

export const MAJOR_ENGLISH_PRINT_PUBLISHER_RE =
  /\b(tor(?:\s+(?:books|fantasy|teen|publishing))?|doherty\s+associates|orion(?:\s+publishing)?|gollancz|orbit|del\s*rey|penguin(?:\s+(?:books|random|usa|classics|press))?|random\s+house|harper(?:collins|perennial|voyager|entertainment)?|simon\s*&?\s*schuster|little,\s*brown|hachette|bloomsbury|ace\s+books?|daw\s+books?|bantam|hodder|knopf|doubleday|scribner|farrar,\s*straus|st\.?\s*martin'?s|vintage|anchor\s+books|putnam|dutton|crown|ballantine|berkley|macmillan(?!\s*audio)|viking|w\.?\s*w\.?\s*norton|oxford\s+university\s+press|cambridge\s+university\s+press|mit\s+press|dragonsteel|titan\s+books|tachyon|delacorte)\b/i;

const NON_ENGLISH_SUMMARY_RE =
  /\b(sempre\s+dissera|estava\s+a|que\s+tinha|trotzdem|nicht\s+nur|avec\s+un|dans\s+le|pour\s+les|lecciones\s+de)\b/i;

const LYRIC_OR_TAB_SNIPPET_RE = /\b[a-z]+\s+-\s+[a-z]{1,4}[,!?]|\b[a-z]+_\s+/i;

export interface HygieneInput {
  kind: "books" | "audiobooks";
  title: string;
  subtitle?: string;
  authors?: string[];
  publishers?: string[];
  subjects?: string[];
  formats?: string[];
  series?: string;
  year?: number;
  language?: string;
}

function combinedTitle(title: string, subtitle?: string): string {
  return subtitle ? `${title} ${subtitle}`.trim() : title.trim();
}

export function isLikelyNonEnglishText(text?: string): boolean {
  if (!text) return false;
  return NON_ENGLISH_TITLE_RE.test(text) || NON_ENGLISH_SUMMARY_RE.test(text);
}

export function isJunkFirstSentence(text?: string, language = "en"): boolean {
  if (!text) return true;
  if (LYRIC_OR_TAB_SNIPPET_RE.test(text)) return true;
  if (language === "en" && NON_ENGLISH_SUMMARY_RE.test(text)) return true;
  return false;
}

export function isNonBookProduct(input: HygieneInput): boolean {
  const full = combinedTitle(input.title, input.subtitle);
  if (!full) return true;

  if (
    NON_BOOK_TITLE_RE.test(full) ||
    TRAILING_POSTER_OR_MERCH_RE.test(full) ||
    RPG_HANDBOOK_RE.test(full) ||
    ADAPTATION_OR_STUDY_GUIDE_RE.test(full)
  ) {
    return true;
  }

  const publishers = (input.publishers || []).map((p) => p.trim()).filter(Boolean);
  const subjects = (input.subjects || []).map((s) => s.trim()).filter(Boolean);
  const authors = (input.authors || []).map((a) => a.trim()).filter(Boolean);

  if (publishers.some((p) => NON_BOOK_PUBLISHER_RE.test(p))) {
    return true;
  }

  if (subjects.some((s) => /\bcongresses\b/i.test(s))) {
    return true;
  }

  const hasBookSubject = subjects.some((s) => REAL_BOOK_SUBJECT_RE.test(s));
  const hasBioTitleCue =
    /\b(biography|autobiography|memoir|hard\s+rock\s+band|rock\s+band|story\s+of|life\s+of|why\s+.+\s+matters)\b/i.test(
      full,
    );

  // Sheet music / tab collections without real biography/book subjects
  if (subjects.some((s) => SHEET_MUSIC_SUBJECT_RE.test(s)) && !hasBookSubject && !hasBioTitleCue) {
    return true;
  }

  // Record/album catalog entries credited directly to a musical group or repeated band token
  const bandAuthor = authors.some(
    (a) => MUSICAL_GROUP_AUTHOR_RE.test(a) || REPEATED_TOKEN_AUTHOR_RE.test(a),
  );
  if (bandAuthor && !hasBookSubject && !hasBioTitleCue) {
    return true;
  }

  // Pure record label publisher with no biography/book subjects
  if (
    publishers.length > 0 &&
    publishers.every((p) => RECORD_LABEL_PUBLISHER_RE.test(p)) &&
    !hasBookSubject &&
    !hasBioTitleCue
  ) {
    return true;
  }

  return false;
}

export function isAudioOrDramatizedForBooks(input: HygieneInput): boolean {
  if (input.kind !== "books") return false;
  const full = combinedTitle(input.title, input.subtitle);
  if (AUDIO_EDITION_TITLE_RE.test(full)) return true;

  const publishers = (input.publishers || []).map((p) => p.trim()).filter(Boolean);
  // Only reject on publisher when EVERY listed publisher is audio-only: real print/ebook
  // works in Open Library (e.g. The Way of Kings) often list Graphic Audio or Macmillan Audio
  // alongside Tor/Orion/Gollancz across their many editions.
  if (publishers.length > 0 && publishers.every((p) => AUDIO_ONLY_PUBLISHER_RE.test(p))) {
    return true;
  }

  const formats = (input.formats || []).map((f) => f.trim()).filter(Boolean);
  if (formats.length > 0 && formats.every((f) => AUDIO_OR_NONBOOK_FORMAT_RE.test(f))) {
    return true;
  }

  return false;
}

export function isBoxSetOrOmnibus(title: string, subtitle?: string, series?: string): boolean {
  const full = combinedTitle(title, subtitle);
  if (!full) return false;
  if (BOX_SET_OR_OMNIBUS_RE.test(full)) return true;

  // Multi-book comma bundle such as "Dune, Dune Messiah, Children of Dune"
  if (series) {
    const sNorm = normalizeText(series).replace(/^the\s+/, "");
    const tNorm = normalizeText(title);
    if (sNorm.length >= 3 && (title.match(/,/g) || []).length >= 2) {
      const occurrences = tNorm.split(sNorm).length - 1;
      if (occurrences >= 2) return true;
    }
  }
  return false;
}

export function isSplitPartEdition(
  title: string,
  subtitle?: string,
  kind: "books" | "audiobooks" = "books",
  hasSeries = false,
): boolean {
  const full = combinedTitle(title, subtitle);
  if (!full) return false;
  if (CLASSIC_PART_EXEMPT_RE.test(title.trim())) return false;

  // "(1 of 5)", "(Part 1 of 2)", "(Part 2 of 2)" are always split editions.
  if (FRACTIONAL_SPLIT_RE.test(full)) return true;

  if (TRAILING_SPLIT_PART_RE.test(full)) {
    if (kind === "books") return true;
    // For audiobooks, reject split dramatized editions or split parts within a series.
    if (hasSeries || AUDIO_EDITION_TITLE_RE.test(full)) return true;
  }
  return false;
}

export function isDramatizedAudioEdition(
  title: string,
  subtitle?: string,
  publisher?: string,
): boolean {
  const full = combinedTitle(title, subtitle);
  if (/\b(dramatiz(?:ed|ation)|dramatis(?:ed|ation)|graphic\s*audio|full\s*cast\s*audio)\b/i.test(full)) {
    return true;
  }
  if (publisher && DRAMATIZED_PUBLISHER_RE.test(publisher)) return true;
  return false;
}

export function pickBestPrintPublisher(
  publishers?: string[],
  language = "en",
): string | undefined {
  if (!Array.isArray(publishers) || publishers.length === 0) return undefined;
  const cleaned = publishers
    .map((p) => String(p || "").replace(/^Brand:\s*/i, "").trim())
    .filter(Boolean);
  if (cleaned.length === 0) return undefined;
  const printOnly = cleaned.filter(
    (p) => !AUDIO_ONLY_PUBLISHER_RE.test(p) && !NON_BOOK_PUBLISHER_RE.test(p),
  );
  if (language === "en" && printOnly.length > 0) {
    const majorEn = printOnly.find(
      (p) => MAJOR_ENGLISH_PRINT_PUBLISHER_RE.test(p) && !FOREIGN_BOOK_PUBLISHER_RE.test(p),
    );
    if (majorEn) return majorEn;
    const nonForeign = printOnly.find((p) => !FOREIGN_BOOK_PUBLISHER_RE.test(p));
    if (nonForeign) return nonForeign;
  }
  return printOnly[0] || cleaned[0];
}

// Canonicalize well-known series aliases so books in the same series never split
// across duplicate series pages (e.g. "Stormlight Archive" vs "The Stormlight Archive").
const SERIES_CANONICAL_MAP: Record<string, string> = {
  "stormlight archive": "The Stormlight Archive",
  "the stormlight archive": "The Stormlight Archive",
  "red rising": "Red Rising",
  "red rising saga": "Red Rising",
  "red rising trilogy": "Red Rising",
  "iron gold tetralogy": "Red Rising",
  mistborn: "Mistborn",
  "the mistborn saga": "Mistborn",
  "mistborn saga": "Mistborn",
  "mistborn trilogy": "Mistborn",
  "murderbot diaries": "The Murderbot Diaries",
  "the murderbot diaries": "The Murderbot Diaries",
  "lord of the rings": "The Lord of the Rings",
  "the lord of the rings": "The Lord of the Rings",
  expanse: "The Expanse",
  "the expanse": "The Expanse",
  "wheel of time": "The Wheel of Time",
  "the wheel of time": "The Wheel of Time",
  dune: "Dune",
  "dune chronicles": "Dune",
  "the dune chronicles": "Dune",
  "dune sequence": "Dune",
  "the dune sequence": "Dune",
  "first law": "The First Law Trilogy",
  "first law trilogy": "The First Law Trilogy",
  "the first law trilogy": "The First Law Trilogy",
  farseer: "Farseer Trilogy",
  "farseer trilogy": "Farseer Trilogy",
  "the farseer trilogy": "Farseer Trilogy",
  "hunger games": "The Hunger Games",
  "the hunger games": "The Hunger Games",
  "song of ice and fire": "A Song of Ice and Fire",
  "a song of ice and fire": "A Song of Ice and Fire",
  earthsea: "Earthsea Cycle",
  "earthsea cycle": "Earthsea Cycle",
  "the earthsea cycle": "Earthsea Cycle",
  "remembrance of earths past": "Remembrance of Earth's Past",
};

export function canonicalizeSeriesName(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw
    .replace(/\s*[:\-–—]\s*(?:book|vol\.?|#)\s*\d+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed || trimmed.length < 2) return undefined;
  const norm = normalizeText(trimmed);
  return SERIES_CANONICAL_MAP[norm] || trimmed;
}

// Strip edition/format/series subtitle clutter to produce a canonical work title
// key so multiple editions of the same book collapse to a single canonical record.
export function canonicalWorkTitle(rawTitle: string): string {
  let s = rawTitle.trim();
  // Remove leading series prefix like "The Stormlight Archive 1: The Way of Kings"
  s = s.replace(/^(?:the\s+)?[a-z0-9'\s]+?\s+\d+\s*:\s*/i, "");
  // Remove bracketed/parenthetical edition & split suffixes
  s = s.replace(
    /\s*[\(\[](?:[^()\[\]]*(?:unabridged|abridged|dramatiz|dramatis|dramatic\s+reading|version\s*\d+|full\s+cast|multi-?cast|solo\s+reading|graphic\s*audio|part\s+\d+|of\s+\d+|edition|classics|annotated|illustrated|signature\s+performance|book\s+\w+|#\d+|adaptation)[^()\[\]]*)[\)\]]/gi,
    "",
  );
  // Remove trailing edition/series/novel subtitles after colon
  s = s.replace(
    /\s*:\s*(?:a\s+novel|a\s+memoir|book\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+|[ivx]+)\b.*|the\s+original\s+\d{4}.*|a\s+signature\s+performance.*|complete\s+and\s+unabridged.*|[^:]+,\s*book\s+\d+.*)$/i,
    "",
  );
  // Remove trailing split part markers
  s = s.replace(/(?:[,:\-–—]|\s)\s*part\s+(?:one|two|three|four|five|six|\d+).*$/i, "");
  // Normalize text & strip leading article for matching
  const norm = normalizeText(s).replace(/^(?:the|a|an)\s+/, "").trim();
  return norm || normalizeText(rawTitle);
}

// Infer clean genres from title/subtitle + subjects (ensuring biographies &
// non-fiction with sparse subjects are categorized accurately instead of
// falling back to "Literary fiction").
export function inferGenresFromMetadata(
  title: string,
  subtitle: string | undefined,
  subjects: string[],
  extraGenres: string[] = [],
): string[] {
  const fromSubjects = canonicalizeGenres(subjects, 5);
  const cues: string[] = [];
  const full = combinedTitle(title, subtitle);

  if (
    /\b(biography|autobiography|memoir|memoirs|hard\s+rock\s+band|rock\s+band|the\s+life\s+of|lives\s+of|the\s+unauthorized\s+story|why\s+.+\s+matters)\b/i.test(
      full,
    )
  ) {
    cues.push("Biography and memoir", "Non-fiction");
  } else if (/\b(photo\s*book|encyclopedia|chronology|history\s+of)\b/i.test(full)) {
    cues.push("Non-fiction");
  } else if (
    /\b(electric\s+circuits?|microgrids?|ac\/dc\s+principles|engineering|calibrations?)\b/i.test(
      full,
    )
  ) {
    cues.push("Science", "Non-fiction");
  }

  const combined = dedupeStrings([...extraGenres, ...fromSubjects, ...cues], 6);
  // If Biography and memoir is present and no fiction genre is present, ensure Non-fiction is available
  // as a secondary genre if space permits, while keeping Biography and memoir primary.
  return combined;
}

export function isRejectedEntry(entry: NormalizedEntry, language = "en"): boolean {
  const authorNames = entry.authors.map((a) => a.name);
  const input: HygieneInput = {
    kind: entry.kind,
    title: entry.title,
    subtitle: entry.subtitle,
    authors: authorNames,
    publishers: entry.publisher ? [entry.publisher] : [],
    series: entry.series,
    year: entry.year,
    language: entry.language,
  };
  if (isNonBookProduct(input)) return true;
  if (isAudioOrDramatizedForBooks(input)) return true;
  if (isBoxSetOrOmnibus(entry.title, entry.subtitle, entry.series)) return true;
  if (isSplitPartEdition(entry.title, entry.subtitle, entry.kind, Boolean(entry.series))) {
    return true;
  }
  if (language === "en" && isLikelyNonEnglishText(entry.title)) return true;
  return false;
}

export function editionQualityScore(entry: NormalizedEntry): number {
  let score = 0;
  if (entry.directSources && entry.directSources.length > 0) score += 100;
  switch (entry.source) {
    case "standard-ebooks":
    case "librivox":
      score += 95;
      break;
    case "audible":
      score += 85;
      break;
    case "hardcover":
      score += 80;
      break;
    case "openlibrary":
      score += 70;
      break;
    case "gutenberg":
      score += 65;
      break;
    default:
      score += 50;
  }
  if (entry.seriesIndex && entry.seriesIndex > 0) score += 18;
  if (entry.coverUrl) score += 10;
  if (entry.pages || entry.durationSec) score += 6;
  if (entry.unabridged !== false) score += 5;
  if (entry.rating && entry.rating >= 7.5) score += 4;
  if (entry.curated.length > 0) score += 4;

  if (isDramatizedAudioEdition(entry.title, entry.subtitle, entry.publisher)) score -= 70;
  if (entry.unabridged === false) score -= 45;
  if (/\b(signature\s+performance|original\s+\d{4}|annotated|illustrated)\b/i.test(entry.title)) {
    score -= 12;
  }
  if (
    entry.authors.length === 0 ||
    entry.authors.every((a) => !extractSurname(a.name))
  ) {
    score -= 30;
  }
  // Prefer cleaner shorter titles when everything else is tied
  score -= Math.min(8, Math.floor(entry.title.length / 25));
  return score;
}

// Enforce one canonical edition per work and per integer series position within each
// series, and filter out coincidental unrelated authors / comics spinoffs in prose series.
export function dedupeSeriesEditions(entries: NormalizedEntry[]): NormalizedEntry[] {
  const bySeries = new Map<string, NormalizedEntry[]>();
  const nonSeries: NormalizedEntry[] = [];

  for (const e of entries) {
    const canon = canonicalizeSeriesName(e.series);
    if (canon) {
      e.series = canon;
      const key = `${e.kind}:${normalizeText(canon)}`;
      const bucket = bySeries.get(key) || [];
      bucket.push(e);
      bySeries.set(key, bucket);
    } else {
      nonSeries.push(e);
    }
  }

  const keptSeries = new Set<NormalizedEntry>();

  for (const [, group] of bySeries) {
    // Compute dominant author surname(s) for series with >= 2 entries
    const surnameCounts = new Map<string, number>();
    let proseCount = 0;
    for (const e of group) {
      for (const a of e.authors) {
        const sn = extractSurname(a.name);
        if (sn) surnameCounts.set(sn, (surnameCounts.get(sn) || 0) + 1);
      }
      if (!e.genres.includes("Comics and graphic novels")) proseCount++;
    }
    let dominantSurname = "";
    let dominantCount = 0;
    for (const [sn, cnt] of surnameCounts) {
      if (cnt > dominantCount) {
        dominantSurname = sn;
        dominantCount = cnt;
      }
    }
    const enforceDominantAuthor = dominantCount >= 2;
    const isProseSeries = proseCount >= 2;

    // Sort highest-scoring canonical editions first so they claim work & index slots
    const ranked = [...group].sort((a, b) => editionQualityScore(b) - editionQualityScore(a));
    const claimedWorks = new Set<string>();
    const claimedSlots = new Set<string>();

    for (const e of ranked) {
      // Reject comics spinoffs (or comic "Vol. N" spinoffs) from prose novel series
      if (
        isProseSeries &&
        e.kind === "books" &&
        !e.seriesIndex &&
        (e.genres.includes("Comics and graphic novels") || /\bvol\.?\s*\d+\b/i.test(e.title))
      ) {
        continue;
      }

      // If series has a clear primary author (2+ books), drop unrelated books that don't share
      // the primary author's surname (e.g. Ted Starkey's hockey book "Red Rising" or "Little Red Rising").
      if (enforceDominantAuthor) {
        const surnames = e.authors.map((a) => extractSurname(a.name)).filter(Boolean);
        const sharesAuthor = surnames.includes(dominantSurname);
        if (!sharesAuthor && !e.seriesIndex) {
          continue;
        }
      }

      const workKey = canonicalWorkTitle(e.title);
      if (claimedWorks.has(workKey)) {
        continue;
      }

      // Fractional novellas (e.g. "2.5") keep their distinct display slot; whole book numbers
      // (1, 2, 3...) allow only one canonical edition per slot.
      const slotKey =
        e.seriesIndex && e.seriesIndex > 0
          ? e.seriesNumber && e.seriesNumber.includes(".")
            ? `f:${e.seriesNumber}`
            : `i:${e.seriesIndex}`
          : "";
      if (slotKey && claimedSlots.has(slotKey)) {
        continue;
      }

      claimedWorks.add(workKey);
      if (slotKey) claimedSlots.add(slotKey);
      keptSeries.add(e);
    }
  }

  // Preserve original relative order
  const nonSeriesSet = new Set(nonSeries);
  return entries.filter((e) => nonSeriesSet.has(e) || keptSeries.has(e));
}

// Evaluate an already-stored KindItem (from ether.kinds.items during /changes audit).
export function shouldDeleteStoredKindItem(
  kind: "books" | "audiobooks",
  item: KindItem,
  language = "en",
): boolean {
  const fields = item.fields || {};
  const authors = Array.isArray(fields.authors)
    ? (fields.authors as Array<{ name?: string } | string>).map((a) =>
        typeof a === "string" ? a : a?.name || "",
      )
    : item.hints?.authors || [];
  const pub = typeof fields.publisher === "string" ? fields.publisher.trim() : "";
  const series = typeof fields.series === "string" ? fields.series.trim() : "";
  const title = (item.title || "").trim();

  if (
    isNonBookProduct({
      kind,
      title,
      authors,
      publishers: pub ? [pub] : [],
      series,
      year: item.year,
    })
  ) {
    return true;
  }

  if (kind === "books") {
    if (AUDIO_EDITION_TITLE_RE.test(title)) return true;
    if (pub && DRAMATIZED_PUBLISHER_RE.test(pub)) return true;
    // Reject audio-only book entries (no pages and audio-only publisher like Blackstone Audio)
    const pages = typeof fields.pages === "number" ? fields.pages : 0;
    if (
      pub &&
      AUDIO_ONLY_PUBLISHER_RE.test(pub) &&
      pages <= 0 &&
      !series
    ) {
      return true;
    }
  }

  if (isBoxSetOrOmnibus(title, undefined, series)) return true;
  if (isSplitPartEdition(title, undefined, kind, Boolean(series))) return true;
  if (kind === "audiobooks" && isDramatizedAudioEdition(title, undefined, pub) && Boolean(series)) {
    return true;
  }
  if (language === "en" && isLikelyNonEnglishText(title)) return true;
  return false;
}

// Repair misclassified genres, duplicated subtitles, series names, or fabricated
// "A literary fiction book..." summaries on retained stored KindItems during /changes.
export function repairStoredKindItem(
  kind: "books" | "audiobooks",
  item: KindItem,
): KindItem | null {
  let changed = false;
  const next: KindItem = {
    ...item,
    fields: { ...(item.fields || {}) },
    hints: { ...(item.hints || {}) },
  };

  // Fix doubled subtitle like "Title: Foo: Foo"
  const dupSub = /^(.+?:\s*([^:]{3,})):\s*\2$/i.exec(next.title);
  if (dupSub) {
    next.title = dupSub[1].trim();
    changed = true;
  }

  // Canonicalize series name
  const rawSeries = typeof next.fields.series === "string" ? next.fields.series : undefined;
  const canonSeries = canonicalizeSeriesName(rawSeries);
  if (rawSeries && canonSeries && canonSeries !== rawSeries) {
    next.fields.series = canonSeries;
    next.hints.series = canonSeries;
    changed = true;
  }

  // Fix misclassified genres on biography / non-fiction / science books that fell back to "Literary fiction"
  // or fiction classics that accidentally picked up "Biography and memoir" / "Non-fiction"
  const existingGenres = Array.isArray(next.fields.genres)
    ? (next.fields.genres as string[]).filter((g) => typeof g === "string")
    : [];
  const cleanedGenres = existingGenres.length > 0 ? canonicalizeGenres(existingGenres, 6) : [];
  if (
    cleanedGenres.length > 0 &&
    cleanedGenres.join("|") !== existingGenres.join("|")
  ) {
    next.fields.genres = cleanedGenres;
    changed = true;
  }
  const activeGenres = Array.isArray(next.fields.genres)
    ? (next.fields.genres as string[])
    : [];
  const inferred = inferGenresFromMetadata(next.title, undefined, [], []);
  if (
    kind === "books" &&
    activeGenres.length === 1 &&
    activeGenres[0] === "Literary fiction" &&
    inferred.length > 0
  ) {
    next.fields.genres = inferred;
    changed = true;
  } else if (
    kind === "books" &&
    activeGenres.length === 1 &&
    activeGenres[0] === "Literary fiction" &&
    /\bac\/dc\b/i.test(next.title)
  ) {
    // Known AC/DC band biographies with sparse OL subjects (e.g. Ethan Schlesinger)
    next.fields.genres = ["Biography and memoir", "Non-fiction"];
    changed = true;
  }

  // Repair fabricated fallback summary if genre changed or summary mislabels as literary fiction / biography
  const curGenres = Array.isArray(next.fields.genres) ? (next.fields.genres as string[]) : [];
  if (
    next.summary &&
    /^A (?:literary fiction|biography and memoir|non-fiction) book\b/i.test(next.summary)
  ) {
    const lead =
      curGenres[0] === "Biography and memoir"
        ? "A biography"
        : curGenres[0] === "Classics"
          ? "A classic book"
          : curGenres[0]
            ? `A ${curGenres[0].toLowerCase()} book`
            : "A book";
    const updatedSummary = next.summary.replace(
      /^A (?:literary fiction|biography and memoir|non-fiction) book\b/i,
      lead,
    );
    if (updatedSummary !== next.summary) {
      next.summary = updatedSummary;
      changed = true;
    }
  }

  return changed ? next : null;
}
