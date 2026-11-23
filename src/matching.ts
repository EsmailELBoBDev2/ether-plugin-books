// Strict edition matching and release file selection for books & audiobooks.
// Handles title boundary checks, author/narrator matching, ISBN/ASIN exact hits,
// hard abridged rejection, duration-vs-size sanity checks, and exact file/part selection.

import { extractSurname, foldDiacritics, normalizeText, tokenize } from "./text.ts";
import type { ItemHints, KindItem, PluginSettings, ReleaseFile, SourceCandidate } from "./types.ts";

export interface MatchEvaluation {
  score: number;
  rejected: boolean;
  reasons: string[];
}

export interface SelectedReleaseFile {
  file?: ReleaseFile;
  orderedFiles?: ReleaseFile[];
  mime: string;
  format: string;
  fileHint?: string;
  isArchive: boolean;
}

const BOOK_FORMATS: Array<{ ext: string; format: string; mime: string; rank: number }> = [
  { ext: ".epub", format: "epub", mime: "application/epub+zip", rank: 100 },
  { ext: ".cbz", format: "cbz", mime: "application/vnd.comicbook+zip", rank: 80 },
  { ext: ".pdf", format: "pdf", mime: "application/pdf", rank: 65 },
];

const AUDIO_FORMATS: Array<{ ext: string; format: string; mime: string; rank: number }> = [
  { ext: ".m4b", format: "m4b", mime: "audio/mp4", rank: 100 },
  { ext: ".m4a", format: "m4a", mime: "audio/mp4", rank: 80 },
  { ext: ".mp3", format: "mp3", mime: "audio/mpeg", rank: 70 },
  { ext: ".ogg", format: "ogg", mime: "audio/ogg", rank: 55 },
  { ext: ".opus", format: "opus", mime: "audio/opus", rank: 55 },
  { ext: ".flac", format: "flac", mime: "audio/flac", rank: 50 },
];

const ARCHIVE_EXTS = [".rar", ".zip", ".7z", ".r00", ".part1.rar"];
const JUNK_PATH_RE = /(^|\/)(__macosx|sample|extras?|covers?|bonus)\//i;
const DERIVATIVE_TITLE_RE =
  /\b(summary of|study guide|reading guide|cliff ?notes|spark ?notes|book summary|workbook|trivia|quiz|companion guide|analysis of|key takeaways)\b/i;
const ABRIDGED_RE = /(?:^|[^a-z])abridged(?:$|[^a-z])/i;
const UNABRIDGED_RE = /\bunabridged\b/i;
const GRAPHIC_AUDIO_RE = /\b(graphic ?audio|dramatized|full cast)\b/i;

const FOREIGN_RE =
  /\b(swedish|svensk|german|deutsch|french|francais|spanish|espanol|castellano|italian|italiano|dutch|nederlands|danish|dansk|norwegian|norsk|finnish|polish|polski|czech|russian|portuguese|portugues|nordic|turkish|hungarian|greek|hebrew|arabic|hindi|japanese|korean|chinese)\b/gi;

const EXTRA_TITLE_NOISE = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "in",
  "to",
  "for",
  "epub",
  "mobi",
  "azw3",
  "pdf",
  "cbz",
  "cbr",
  "ebook",
  "ebooks",
  "retail",
  "edition",
  "editions",
  "anniversary",
  "illustrated",
  "annotated",
  "unabridged",
  "abridged",
  "audiobook",
  "m4b",
  "mp3",
  "novel",
  "book",
  "books",
  "vol",
  "volume",
  "part",
  "complete",
  "collection",
  "series",
  "revised",
  "updated",
  "deluxe",
  "special",
  "tenth",
  "first",
  "second",
  "third",
  "fifth",
  "20th",
  "25th",
  "30th",
  "40th",
  "50th",
  "by",
  "v5",
  "v4",
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findForeignLanguageTag(
  releaseTitle: string,
  targetTitle: string,
  targetSeries: string | undefined,
  authors: string[],
  narrators: string[],
): string | null {
  const relFolded = foldDiacritics(releaseTitle);
  if (!relFolded.match(FOREIGN_RE)) return null;

  const allowedTitleLangs = new Set<string>();
  const titleContext = foldDiacritics(`${targetTitle} ${targetSeries || ""}`);
  for (const m of titleContext.match(FOREIGN_RE) || []) {
    allowedTitleLangs.add(m.toLowerCase());
  }

  let scrubbed = relFolded;
  const strippedFullPersonLangs = new Set<string>();
  const personLangTokens = new Set<string>();
  for (const person of [...authors, ...narrators]) {
    const foldedPerson = foldDiacritics(person).trim();
    if (!foldedPerson) continue;
    const personLangs = (foldedPerson.match(FOREIGN_RE) || []).map((w) => w.toLowerCase());
    for (const w of personLangs) personLangTokens.add(w);
    const tokens = tokenize(foldedPerson, false);
    if (tokens.length >= 2) {
      const patterns = [
        tokens.map(escapeRegex).join("[\\s.,_-]+"),
        `${escapeRegex(tokens[tokens.length - 1])}[,\\s]+${tokens
          .slice(0, -1)
          .map(escapeRegex)
          .join("[\\s.,_-]+")}`,
      ];
      for (const pat of patterns) {
        const re = new RegExp(`\\b${pat}\\b`, "gi");
        if (re.test(scrubbed)) {
          scrubbed = scrubbed.replace(re, " ");
          for (const w of personLangs) strippedFullPersonLangs.add(w);
        }
      }
    }
  }

  const remaining = scrubbed.match(FOREIGN_RE);
  if (!remaining) return null;

  for (const rawWord of remaining) {
    const word = rawWord.toLowerCase();
    if (allowedTitleLangs.has(word)) continue;
    if (personLangTokens.has(word) && !strippedFullPersonLangs.has(word)) {
      const explicitLangTag = new RegExp(
        `[\\(\\[]\\s*${escapeRegex(word)}(?:\\s+(?:edition|ed\\.?|version|lang(?:uage)?|translation))?\\s*[\\)\\]]|\\b${escapeRegex(word)}\\s+(?:edition|version|translation)\\b`,
        "i",
      );
      if (!explicitLangTag.test(scrubbed)) {
        continue;
      }
    }
    return word;
  }
  return null;
}

export function isAbridgedReleaseName(name: string): boolean {
  if (!name) return false;
  if (UNABRIDGED_RE.test(name)) return false;
  return ABRIDGED_RE.test(name);
}

export function extractTargetMeta(item: KindItem): {
  kind: "books" | "audiobooks";
  title: string;
  mainTitle: string;
  authors: string[];
  narrators: string[];
  series?: string;
  year?: number;
  isbn?: string;
  isbn13?: string;
  asin?: string;
  durationSec?: number;
  unabridged: boolean;
} {
  const hints = (item.hints || {}) as Partial<ItemHints>;
  const kind: "books" | "audiobooks" =
    hints.kind === "audiobooks" || item.level === "audiobook" ? "audiobooks" : "books";
  const title = (hints.title || item.title || "").trim();
  const mainTitle = title.split(/\s*[:|-]\s*/)[0]?.trim() || title;

  const authors = Array.isArray(hints.authors) ? hints.authors.filter(Boolean) : [];
  if (authors.length === 0 && Array.isArray(item.fields?.authors)) {
    for (const a of item.fields.authors as unknown[]) {
      if (typeof a === "string") authors.push(a);
      else if (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string") {
        authors.push((a as { name: string }).name);
      }
    }
  }

  const narrators = Array.isArray(hints.narrators) ? hints.narrators.filter(Boolean) : [];
  if (narrators.length === 0 && Array.isArray(item.fields?.narrators)) {
    for (const n of item.fields.narrators as unknown[]) {
      if (typeof n === "string") narrators.push(n);
      else if (n && typeof n === "object" && typeof (n as { name?: unknown }).name === "string") {
        narrators.push((n as { name: string }).name);
      }
    }
  }

  const seriesRaw =
    hints.series || (typeof item.fields?.series === "string" ? item.fields.series : undefined);
  const series = seriesRaw ? seriesRaw.trim() || undefined : undefined;

  const fieldDuration =
    typeof item.fields?.duration === "number" ? (item.fields.duration as number) : undefined;
  const fieldUnabridged =
    typeof item.fields?.unabridged === "boolean" ? (item.fields.unabridged as boolean) : undefined;

  return {
    kind,
    title,
    mainTitle,
    authors,
    narrators,
    series,
    year: hints.year || item.year,
    isbn: hints.isbn || (typeof item.fields?.isbn === "string" ? item.fields.isbn : undefined),
    isbn13: hints.isbn13,
    asin: hints.asin || (typeof item.fields?.asin === "string" ? item.fields.asin : undefined),
    durationSec: hints.durationSec || fieldDuration,
    unabridged: hints.unabridged !== false && fieldUnabridged !== false,
  };
}

function containsTokenBoundary(haystackNorm: string, needleNorm: string): boolean {
  if (!haystackNorm || !needleNorm) return false;
  return ` ${haystackNorm} `.includes(` ${needleNorm} `);
}

function computeTitleScore(
  targetTitle: string,
  targetMainTitle: string,
  releaseTitle: string,
  knownPersonTokens: Set<string>,
): { score: number; exactPhrase: boolean; sequelMismatch: boolean } {
  const relNorm = normalizeText(releaseTitle);
  const fullNorm = normalizeText(targetTitle);
  const mainNorm = normalizeText(targetMainTitle);
  if (!relNorm || !mainNorm) {
    return { score: 0, exactPhrase: false, sequelMismatch: false };
  }

  const exactFull = containsTokenBoundary(relNorm, fullNorm);
  const exactMain = containsTokenBoundary(relNorm, mainNorm);

  // Detect wrong sequel or extended title when target is a short base title
  // (e.g. "Dune" must not score equally on "Dune Messiah" or "Dune 2").
  let sequelMismatch = false;
  if (exactMain && mainNorm.split(" ").length <= 3) {
    const padded = ` ${relNorm} `;
    const needle = ` ${mainNorm} `;
    const idx = padded.indexOf(needle);
    if (idx >= 0) {
      const after = padded.slice(idx + needle.length).trim();
      const nextWord = after.split(/\s+/)[0] || "";
      const allowedFollow = new Set([
        "",
        "by",
        "epub",
        "pdf",
        "cbz",
        "m4b",
        "m4a",
        "mp3",
        "ogg",
        "flac",
        "audiobook",
        "audio",
        "unabridged",
        "abridged",
        "ebook",
        "retail",
        "edition",
        "anniversary",
        "illustrated",
        "complete",
        "deluxe",
        "revised",
        "updated",
        "narrated",
        "read",
        "book",
        "vol",
        "volume",
        "novel",
        "a",
        "the",
        "english",
        "eng",
        "en",
        "v1",
        "v2",
        "v3",
        "hq",
        "64k",
        "128k",
        "64kbps",
        "128kbps",
      ]);
      const isYear = /^(1[4-9]\d{2}|20\d{2})$/.test(nextWord);
      const isBookOne = nextWord === "1" || nextWord === "01" || nextWord === "i";
      if (
        nextWord &&
        !isYear &&
        !isBookOne &&
        !allowedFollow.has(nextWord) &&
        !knownPersonTokens.has(nextWord)
      ) {
        // Explicit sequel numerals or extra title words right after a 1-2 word base title
        const isExplicitSequel =
          /^([2-9]|1\d|ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(nextWord) ||
          mainNorm.split(" ").length <= 2;
        if (isExplicitSequel) {
          sequelMismatch = true;
        }
      }
    }
  }

  const targetTokens = tokenize(mainNorm, true);
  const relTokenSet = new Set(tokenize(relNorm, false));
  if (targetTokens.length === 0) return { score: 0, exactPhrase: false, sequelMismatch: false };

  let matched = 0;
  for (const tok of targetTokens) {
    if (relTokenSet.has(tok)) matched++;
  }
  const coverage = matched / targetTokens.length;

  let score = 0;
  if (exactFull) score = 0.52;
  else if (exactMain) score = 0.48;
  else if (coverage >= 0.99) score = 0.42;
  else if (coverage >= 0.75) score = 0.30;
  else if (coverage >= 0.5 && targetTokens.length >= 3) score = 0.16;

  if (sequelMismatch) {
    score = Math.max(0, score - 0.38);
  }

  return { score, exactPhrase: exactFull || exactMain, sequelMismatch };
}

export function scoreCandidate(
  item: KindItem,
  cand: SourceCandidate,
  settings?: Partial<PluginSettings>,
): MatchEvaluation {
  const target = extractTargetMeta(item);
  const releaseTitle = (cand.title || "").trim();
  const relNorm = normalizeText(releaseTitle);
  const reasons: string[] = [];

  if (!releaseTitle) {
    return { score: 0, rejected: true, reasons: ["empty release title"] };
  }

  // Reject study guides / summaries unless the target book itself is one
  if (DERIVATIVE_TITLE_RE.test(releaseTitle) && !DERIVATIVE_TITLE_RE.test(target.title)) {
    return { score: 0.05, rejected: true, reasons: ["rejected summary/study guide"] };
  }

  // Hard reject abridged audiobooks when unabridged is desired
  const preferUnabridged = settings?.preferUnabridged !== false;
  if (target.kind === "audiobooks" && preferUnabridged && target.unabridged) {
    if (isAbridgedReleaseName(releaseTitle)) {
      return { score: 0, rejected: true, reasons: ["rejected abridged audiobook"] };
    }
  }

  // Reject wrong media family when clearly mismatched
  if (target.kind === "books") {
    if (/\b(audiobook|m4b|mp3\s*\d+kbps|narrated by|unabridged audio)\b/i.test(releaseTitle) &&
        !/\b(epub|pdf|cbz|ebook)\b/i.test(releaseTitle)) {
      return { score: 0.05, rejected: true, reasons: ["rejected audiobook release for book item"] };
    }
  } else {
    if (/\b(epub|mobi|azw3|cbz|cbr|pdf)\b/i.test(releaseTitle) &&
        !/\b(m4b|mp3|audiobook|audio|unabridged|narrated)\b/i.test(releaseTitle)) {
      return { score: 0.05, rejected: true, reasons: ["rejected ebook release for audiobook item"] };
    }
  }

  let score = 0;

  // 1. Exact ISBN / ASIN match
  const relCompact = releaseTitle.toUpperCase().replace(/[^A-Z0-9]/g, "");
  let idMatch = false;
  for (const id of [target.isbn13, target.isbn, target.asin]) {
    if (id && id.length >= 10 && relCompact.includes(id.toUpperCase())) {
      score += 0.4;
      idMatch = true;
      reasons.push(`matched id ${id}`);
      break;
    }
  }

  // 2. Title match
  const knownPersonTokens = new Set<string>();
  for (const p of [...target.authors, ...target.narrators]) {
    for (const tok of tokenize(p, false)) knownPersonTokens.add(tok);
  }
  const tRes = computeTitleScore(target.title, target.mainTitle, releaseTitle, knownPersonTokens);
  score += tRes.score;
  if (tRes.exactPhrase) reasons.push("title phrase match");
  if (tRes.sequelMismatch) reasons.push("possible sequel mismatch");

  // 3. Author surname match
  let authorMatched = false;
  for (const author of target.authors) {
    const surname = extractSurname(author);
    if (surname.length >= 2 && containsTokenBoundary(relNorm, surname)) {
      authorMatched = true;
      score += 0.24;
      reasons.push(`author ${surname}`);
      break;
    }
  }

  // 3b. Reject foreign-language editions for English items (diacritics folded; ignores
  // author/narrator names such as "Tana French" and words in the target title/series).
  const itemLanguage = String(item.hints?.language || item.fields?.language || "").toLowerCase();
  if (!idMatch && (itemLanguage === "" || itemLanguage.startsWith("en"))) {
    const foreign = findForeignLanguageTag(
      releaseTitle,
      target.title,
      target.series,
      target.authors,
      target.narrators,
    );
    if (foreign) {
      return {
        score: 0.05,
        rejected: true,
        reasons: [...reasons, `other language (${foreign})`],
      };
    }
  }

  // 3c. Penalize "Author - Longer Title Containing Ours" (e.g. "Princess of Dune" for
  // "Dune", "Pride and Prejudice and Zombies" for "Pride and Prejudice") and authorless
  // segmented releases. subtitleRe uses non-stopword-stripped title tokens so titles
  // with "and"/"of"/"the" (e.g. "Pride and Prejudice: ...") still recognize subtitles.
  if (!idMatch) {
    const allowed = new Set<string>([
      ...tokenize(target.title, false),
      ...tokenize(target.mainTitle || "", false),
      ...knownPersonTokens,
    ]);
    if (target.series) {
      for (const tok of tokenize(target.series, false)) allowed.add(tok);
    }
    const baseTitle = target.mainTitle || target.title;
    const titleTokens = tokenize(baseTitle, false).filter((tok) => !EXTRA_TITLE_NOISE.has(tok));
    const rawSubtitleTokens = tokenize(baseTitle.replace(/\s*&\s*/g, " and "), false);
    const subtitleTokens =
      rawSubtitleTokens.length > 1 &&
      (rawSubtitleTokens[0] === "the" ||
        rawSubtitleTokens[0] === "a" ||
        rawSubtitleTokens[0] === "an")
        ? rawSubtitleTokens.slice(1)
        : rawSubtitleTokens;
    const subtitleRe =
      subtitleTokens.length > 0
        ? new RegExp(
            `^\\W*(?:the\\s+|a\\s+|an\\s+)?${subtitleTokens.join("\\W+")}\\s*(?:[-–—:,(]|$)`,
            "i",
          )
        : null;

    const segments = releaseTitle
      .split(/\s+[-–—]\s+|[\[\]]/)
      .map((seg) => seg.trim())
      .filter(Boolean);
    if (segments.length >= 2 && titleTokens.length > 0 && titleTokens.length <= 4) {
      let best: string[] | null = null;
      for (const seg of segments) {
        const segTokens = tokenize(seg, false);
        const hits = titleTokens.filter((tok) => segTokens.includes(tok)).length;
        if (hits === titleTokens.length) {
          const segForSubtitle = foldDiacritics(seg)
            .replace(/['’`]/g, "")
            .replace(/\s*&\s*/g, " and ");
          if (subtitleRe && subtitleRe.test(segForSubtitle)) {
            best = [];
            break;
          }
          const extras = segTokens.filter(
            (tok) =>
              !allowed.has(tok) &&
              !EXTRA_TITLE_NOISE.has(tok) &&
              !/^\d+$/.test(tok) &&
              tok.length >= 3,
          );
          if (!best || extras.length < best.length) best = extras;
        }
      }
      if (best && best.length > 0) {
        score -= Math.min(0.45, 0.25 + 0.1 * best.length);
        reasons.push(`different title (extra: ${best.slice(0, 3).join(", ")})`);
      }
    }
    if (!authorMatched && target.authors.length > 0 && segments.length >= 2) {
      score -= 0.2;
      reasons.push("author not in release name");
    }
  }

  if (!idMatch && !authorMatched && tRes.score < 0.45) {
    return {
      score: Math.min(score, 0.3),
      rejected: true,
      reasons: [...reasons, "missing author and weak title match"],
    };
  }

  // 4. Narrator match (audiobooks)
  if (target.kind === "audiobooks" && target.narrators.length > 0) {
    for (const narr of target.narrators) {
      const surname = extractSurname(narr);
      if (surname.length >= 3 && containsTokenBoundary(relNorm, surname)) {
        score += 0.12;
        reasons.push(`narrator ${surname}`);
        break;
      }
    }
  }

  // 5. Format quality bonuses
  if (target.kind === "books") {
    if (/\bepub\b/i.test(releaseTitle)) {
      score += 0.1;
      reasons.push("epub format");
    } else if (/\bcbz\b/i.test(releaseTitle)) {
      score += 0.07;
      reasons.push("cbz format");
    } else if (/\bpdf\b/i.test(releaseTitle)) {
      score += 0.04;
      reasons.push("pdf format");
    }
  } else {
    if (/\bm4b\b/i.test(releaseTitle)) {
      score += 0.12;
      reasons.push("m4b chaptered format");
    } else if (/\bmp3\b/i.test(releaseTitle)) {
      score += 0.06;
      reasons.push("mp3 format");
    }
    if (UNABRIDGED_RE.test(releaseTitle)) {
      score += 0.04;
      reasons.push("unabridged");
    }
    if (GRAPHIC_AUDIO_RE.test(releaseTitle) && !GRAPHIC_AUDIO_RE.test(target.title)) {
      score -= 0.05;
      reasons.push("dramatized edition penalty");
    }
  }

  // 6. Audiobook duration vs size sanity check (24 kbps .. 384 kbps generous envelope)
  if (target.kind === "audiobooks" && target.durationSec && target.durationSec > 1800 && cand.size && cand.size > 0) {
    const minReasonable = target.durationSec * 2500; // ~20 kbps
    const maxReasonable = target.durationSec * 55000; // ~440 kbps
    if (cand.size < minReasonable) {
      score -= 0.25;
      reasons.push("size too small for runtime");
    } else if (cand.size > maxReasonable * 3) {
      score -= 0.1;
      reasons.push("size much larger than single book (possible collection)");
    } else {
      score += 0.05;
      reasons.push("size matches runtime");
    }
  }

  // 7. Book size sanity check (reject suspiciously huge 5GB+ bundles or tiny <5KB junk)
  if (target.kind === "books" && cand.size && cand.size > 0) {
    if (cand.size < 5000) {
      score -= 0.3;
      reasons.push("file suspiciously tiny");
    } else if (cand.size > 2 * 1024 * 1024 * 1024) {
      score -= 0.12;
      reasons.push("very large anthology pack");
    }
  }

  // 8. Availability bonus (cached debrid / NZB / seeders)
  if (settings?.preferCached !== false && cand.cached) {
    score += 0.08;
    reasons.push("debrid cached");
  } else if (cand.nzbUrl) {
    score += 0.05;
    reasons.push("usenet nzb");
  } else if (cand.seeders && cand.seeders >= 10) {
    score += 0.03;
    reasons.push("healthy seeders");
  }

  const clamped = Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
  return {
    score: clamped,
    rejected: clamped < 0.45,
    reasons,
  };
}

function naturalCompare(a: string, b: string): number {
  const ax = a.toLowerCase().split(/(\d+)/);
  const bx = b.toLowerCase().split(/(\d+)/);
  const len = Math.max(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const as = ax[i] ?? "";
    const bs = bx[i] ?? "";
    if (as === bs) continue;
    const an = /^\d+$/.test(as) ? parseInt(as, 10) : NaN;
    const bn = /^\d+$/.test(bs) ? parseInt(bs, 10) : NaN;
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      return an - bn;
    }
    return as < bs ? -1 : 1;
  }
  return 0;
}

function extOf(path: string): string {
  const lower = path.toLowerCase().trim();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function fileTitleAffinity(path: string, targetTitle: string): number {
  const base = path.split("/").pop() || path;
  const relNorm = normalizeText(base);
  const targetTokens = tokenize(targetTitle, true);
  if (targetTokens.length === 0) return 0;
  let hits = 0;
  for (const t of targetTokens) {
    if (containsTokenBoundary(relNorm, t)) hits++;
  }
  return hits / targetTokens.length;
}

export function selectReleaseFiles(
  item: KindItem,
  files: ReleaseFile[],
  partIndex?: number,
): SelectedReleaseFile | null {
  const target = extractTargetMeta(item);
  const cleanFiles = files.filter((f) => f.path && !JUNK_PATH_RE.test(f.path));

  if (target.kind === "books") {
    const matched: Array<{ file: ReleaseFile; rank: number; format: string; mime: string; affinity: number }> = [];
    for (const f of cleanFiles) {
      const ext = extOf(f.path);
      const spec = BOOK_FORMATS.find((b) => b.ext === ext);
      if (!spec) continue;
      if (f.size > 0 && f.size < 4096) continue; // skip tiny stub files
      matched.push({
        file: f,
        rank: spec.rank,
        format: spec.format,
        mime: spec.mime,
        affinity: fileTitleAffinity(f.path, target.mainTitle),
      });
    }
    if (matched.length > 0) {
      matched.sort((a, b) => {
        // When selecting inside an omnibus/author pack, filename affinity breaks ties and overrides weaker formats
        if (Math.abs(b.affinity - a.affinity) >= 0.3) return b.affinity - a.affinity;
        if (b.rank !== a.rank) return b.rank - a.rank;
        return b.file.size - a.file.size;
      });
      const best = matched[0];
      return {
        file: best.file,
        mime: best.mime,
        format: best.format,
        isArchive: false,
      };
    }

    // Archive-wrapped ebook (e.g. Usenet NZB .rar/.zip): per W186 #659, omit guessed fileHint
    // and set accurate mime so Ether picks the largest matching member inside the archive.
    const hasArchive = cleanFiles.some((f) =>
      ARCHIVE_EXTS.some((ext) => f.path.toLowerCase().endsWith(ext)),
    );
    if (hasArchive) {
      const joined = cleanFiles.map((f) => f.path).join(" ");
      const isPdf = /\bpdf\b/i.test(joined) && !/\bepub\b/i.test(joined);
      const isCbz = /\b(cbz|cbr|comic)\b/i.test(joined) && !/\bepub\b/i.test(joined);
      return {
        mime: isPdf
          ? "application/pdf"
          : isCbz
            ? "application/vnd.comicbook+zip"
            : "application/epub+zip",
        format: isPdf ? "pdf" : isCbz ? "cbz" : "epub",
        isArchive: true,
      };
    }
    return null;
  }

  // Audiobooks: prefer single chaptered .m4b, else ordered .mp3/.m4a parts
  const m4bFiles = cleanFiles
    .filter((f) => extOf(f.path) === ".m4b" && (f.size === 0 || f.size > 50_000))
    .sort((a, b) => {
      const diff = fileTitleAffinity(b.path, target.mainTitle) - fileTitleAffinity(a.path, target.mainTitle);
      if (Math.abs(diff) >= 0.3) return diff;
      return naturalCompare(a.path, b.path);
    });

  if (m4bFiles.length === 1) {
    return {
      file: m4bFiles[0],
      orderedFiles: m4bFiles,
      mime: "audio/mp4",
      format: "m4b",
      isArchive: false,
    };
  }
  if (m4bFiles.length > 1) {
    // Multi-part M4B audiobook (e.g., Part 1..N)
    const ordered = [...m4bFiles].sort((a, b) => naturalCompare(a.path, b.path));
    const idx = partIndex !== undefined ? Math.max(0, Math.min(partIndex, ordered.length - 1)) : 0;
    return {
      file: ordered[idx],
      orderedFiles: ordered,
      mime: "audio/mp4",
      format: "m4b",
      isArchive: false,
    };
  }

  // Check MP3 / M4A / OGG / OPUS / FLAC ordered chapters
  for (const spec of AUDIO_FORMATS) {
    if (spec.ext === ".m4b") continue;
    const matching = cleanFiles
      .filter((f) => extOf(f.path) === spec.ext && (f.size === 0 || f.size > 20_000))
      .sort((a, b) => naturalCompare(a.path, b.path));
    if (matching.length > 0) {
      const idx = partIndex !== undefined ? Math.max(0, Math.min(partIndex, matching.length - 1)) : 0;
      return {
        file: matching[idx],
        orderedFiles: matching,
        mime: spec.mime,
        format: spec.format,
        isArchive: false,
      };
    }
  }

  // Archive-wrapped audiobook (e.g. Usenet NZB .rar/.zip): per W186 #659, omit guessed fileHint
  // and set accurate mime so Ether picks the largest matching audio member inside the archive.
  const hasArchive = cleanFiles.some((f) =>
    ARCHIVE_EXTS.some((ext) => f.path.toLowerCase().endsWith(ext)),
  );
  if (hasArchive) {
    const joined = cleanFiles.map((f) => f.path).join(" ");
    const isMp3 = /\bmp3\b/i.test(joined) && !/\bm4[ab]\b/i.test(joined);
    return {
      mime: isMp3 ? "audio/mpeg" : "audio/mp4",
      format: isMp3 ? "mp3" : "m4b",
      isArchive: true,
    };
  }

  return null;
}

export function buildSearchQueries(item: KindItem): string[] {
  const meta = extractTargetMeta(item);
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (q?: string) => {
    const s = (q || "").trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    queries.push(s);
  };

  const primarySurname = meta.authors[0] ? extractSurname(meta.authors[0]) : "";
  const cleanMain = meta.mainTitle.replace(/[:"'?!()]/g, " ").replace(/\s+/g, " ").trim();

  // Prefer "Title AuthorSurname" first (highest recall + precision on indexers)
  if (cleanMain && primarySurname) {
    add(`${cleanMain} ${primarySurname}`);
  }
  if (meta.isbn13) add(meta.isbn13);
  else if (meta.isbn) add(meta.isbn);
  if (meta.kind === "audiobooks" && meta.asin) add(meta.asin);
  if (cleanMain) add(cleanMain);

  return queries.slice(0, 3);
}

export function candidateRefOf(c: SourceCandidate, fallbackIdx: number): string {
  if (c.infoHash) return c.infoHash.toLowerCase();
  if (c.nzbUrl) return c.nzbUrl;
  if (c.magnet) return c.magnet;
  return `cand-${fallbackIdx}`;
}
