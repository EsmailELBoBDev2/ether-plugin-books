// Pure text, normalization, URL, date, series, genre, and host-fault helpers.

import type { LengthBucket } from "./types.ts";

const HOST_FAULT_MARKER = "__ETHER_FAULT__";

export function isHostFault(err: unknown): boolean {
  if (!err) return false;
  const obj = err as { code?: unknown; message?: unknown };
  if (typeof obj.code === "string" && obj.code.length > 0) {
    return (
      obj.code === "check_dependency" ||
      obj.code === "forbidden" ||
      obj.code === "aborted" ||
      obj.code === "deadline_exceeded" ||
      obj.code === "budget_exceeded"
    );
  }
  const msg = String(obj.message ?? err);
  return msg.indexOf(HOST_FAULT_MARKER) >= 0;
}

export function rethrowIfHostFault(err: unknown): void {
  if (isHostFault(err)) {
    throw err;
  }
}

export function foldDiacritics(input: string): string {
  if (!input) return "";
  try {
    return input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  } catch {
    return input;
  }
}

export function normalizeText(input: string): string {
  return foldDiacritics(input)
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "to",
  "in",
  "on",
  "for",
  "with",
  "by",
  "at",
  "from",
]);

export function tokenize(input: string, dropStopWords = false): string[] {
  const norm = normalizeText(input);
  if (!norm) return [];
  const raw = norm.split(/\s+/);
  if (!dropStopWords) return raw;
  const filtered = raw.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return filtered.length > 0 ? filtered : raw;
}

const PLACEHOLDER_AUTHORS = new Set([
  "unknown",
  "unknown author",
  "anonymous",
  "various",
  "various authors",
  "full cast",
  "audible studios",
]);

export function extractSurname(fullName: string): string {
  const normFull = normalizeText(fullName);
  if (!normFull || PLACEHOLDER_AUTHORS.has(normFull)) return "";
  const cleaned = foldDiacritics(fullName)
    .replace(/\b(jr|sr|ii|iii|iv|phd|md)\.?$/i, "")
    .trim();
  if (!cleaned) return "";
  if (cleaned.includes(",")) {
    const first = cleaned.split(",")[0].trim();
    return normalizeText(first);
  }
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? normalizeText(parts[parts.length - 1]) : "";
}

export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function slugify(input: string, maxLen = 48): string {
  const s = foldDiacritics(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, maxLen).replace(/-+$/g, "");
}

// External IDs must satisfy ^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$ (no ':' or '/').
export function stableExternalId(prefix: string, rawKey: string): string {
  const p = prefix.replace(/[^A-Za-z0-9_-]/g, "") || "item";
  const cleaned = rawKey.replace(/[^A-Za-z0-9._~-]/g, "-").replace(/^-+|-+$/g, "");
  const candidate = `${p}-${cleaned}`;
  if (cleaned && candidate.length <= 120 && /^[A-Za-z0-9]/.test(candidate)) {
    return candidate;
  }
  const shortSlug = slugify(rawKey, 48) || "ref";
  return `${p}-${shortSlug}-${fnv1aHex(rawKey)}`;
}

export function safeHttpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.trim();
  if (!s) return undefined;
  if (s.startsWith("//")) s = "https:" + s;
  if (s.startsWith("http://")) s = "https://" + s.slice(7);
  if (!s.startsWith("https://")) return undefined;
  if (/[\s<>"]/.test(s)) return undefined;
  return s;
}

export function normalizeIsbn(raw: unknown): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const cleaned = String(raw).toUpperCase().replace(/[^0-9X]/g, "");
  if (cleaned.length === 13 && /^\d{13}$/.test(cleaned)) return cleaned;
  if (cleaned.length === 10 && /^\d{9}[0-9X]$/.test(cleaned)) return cleaned;
  return undefined;
}

export function normalizeAsin(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.trim().toUpperCase();
  if (/^[A-Z0-9]{10}$/.test(cleaned)) return cleaned;
  return undefined;
}

export function decodeXmlEntities(input: string): string {
  if (!input) return "";
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, " - ")
    .replace(/&ndash;/g, "-")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

export function stripHtml(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  const noTags = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeXmlEntities(noTags)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function clampSummary(raw: unknown, maxLen = 1400): string | undefined {
  const cleaned = stripHtml(raw);
  if (!cleaned) return undefined;
  if (cleaned.length <= maxLen) return cleaned;
  const cut = cleaned.slice(0, maxLen - 3);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + "...";
}

export function deriveSortTitle(title: string): string {
  const trimmed = title.trim();
  const m = /^(the|a|an)\s+(.+)$/i.exec(trimmed);
  return m ? `${m[2]}, ${m[1]}` : trimmed;
}

export function parseSeriesPosition(raw: unknown): { index?: number; display?: string } {
  if (raw == null) return {};
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    const display = Number.isInteger(raw) ? String(raw) : String(Math.round(raw * 100) / 100);
    return { index: Math.floor(raw), display };
  }
  const s = String(raw).trim();
  if (!s) return {};
  const match = /(\d+(?:\.\d+)?)/.exec(s);
  if (!match) {
    return { display: s.slice(0, 24) };
  }
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num < 0 || num > 9999) {
    return { display: s.slice(0, 24) };
  }
  const display = match[1];
  return { index: Math.floor(num), display };
}

export function durationLengthBucket(durationSec?: number): LengthBucket | undefined {
  if (!durationSec || durationSec <= 0) return undefined;
  const hours = durationSec / 3600;
  if (hours < 6) return "Under 6 hours";
  if (hours < 12) return "6 to 12 hours";
  if (hours < 20) return "12 to 20 hours";
  return "Over 20 hours";
}

export function parseIsoDateToUnix(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (/^\d{4}$/.test(s)) {
    const y = parseInt(s, 10);
    if (y >= 1000 && y <= 2100) return Math.floor(Date.UTC(y, 0, 1) / 1000);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.floor(t / 1000);
  return undefined;
}

export function extractYear(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const y = Math.floor(raw);
    if (y >= 1000 && y <= 2100) return y;
  }
  if (typeof raw === "string") {
    const m = /\b(1[4-9]\d{2}|20\d{2}|2100)\b/.exec(raw);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

export function normalizeRating(raw: unknown, scale: 5 | 10 = 5): number | undefined {
  const num = typeof raw === "string" ? parseFloat(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const onTen = scale === 5 ? num * 2 : num;
  const clamped = Math.max(0.1, Math.min(10, onTen));
  return Math.round(clamped * 10) / 10;
}

export function normalizeLanguage(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  const map: Record<string, string> = {
    en: "English",
    eng: "English",
    english: "English",
    "en-us": "English",
    "en-gb": "English",
    fr: "French",
    fre: "French",
    fra: "French",
    french: "French",
    de: "German",
    ger: "German",
    deu: "German",
    german: "German",
    es: "Spanish",
    spa: "Spanish",
    spanish: "Spanish",
    it: "Italian",
    ita: "Italian",
    italian: "Italian",
    pt: "Portuguese",
    por: "Portuguese",
    portuguese: "Portuguese",
    ja: "Japanese",
    jpn: "Japanese",
    japanese: "Japanese",
    zh: "Chinese",
    chi: "Chinese",
    zho: "Chinese",
    chinese: "Chinese",
    ru: "Russian",
    rus: "Russian",
    russian: "Russian",
  };
  return map[s] ?? (s.length <= 24 ? s.charAt(0).toUpperCase() + s.slice(1) : undefined);
}

const GENRE_RULES: Array<{ match: RegExp; canonical: string }> = [
  { match: /\b(sci[- ]?fi|science fiction|cyberpunk|space opera|dystopi|time travel)\b/i, canonical: "Science fiction" },
  { match: /\b(fantasy|epic fantasy|urban fantasy|high fantasy|sword and sorcery|magic|litrpg)\b/i, canonical: "Fantasy" },
  { match: /\b(mystery|thriller|suspense|detective|crime fiction|noir|espionage|spy)\b/i, canonical: "Mystery and thriller" },
  { match: /\b(horror|gothic|supernatural|ghost|vampire|lovecraft)\b/i, canonical: "Horror" },
  { match: /\b(biography|biographies|autobiography|autobiographies|memoir|memoirs|personal narratives|rock musicians|musicians|singers|composers|musical group|rock groups?|rock bands?|hard rock band)\b/i, canonical: "Biography and memoir" },
  { match: /\b(historical fiction)\b/i, canonical: "Historical fiction" },
  { match: /\b(history|world war|civil war|ancient history|military history)\b/i, canonical: "History" },
  { match: /\b(literary fiction|contemporary fiction|general fiction|short stories)\b/i, canonical: "Literary fiction" },
  { match: /\b(romance|love stories)\b/i, canonical: "Romance" },
  { match: /\b(young adult|teen|ya fiction|coming of age)\b/i, canonical: "Young adult" },
  { match: /\b(classics?|classic literature)\b/i, canonical: "Classics" },
  { match: /\b(true crime)\b/i, canonical: "True crime" },
  { match: /\b(philosophy|ethics|stoicism)\b/i, canonical: "Philosophy" },
  { match: /\b(science|physics|astronomy|biology|mathematics|nature|technology|computer|engineering|electricity|electronics|electric circuits?|microgrids?)\b/i, canonical: "Science" },
  { match: /\b(business|economics|finance|leadership|management|investing)\b/i, canonical: "Business" },
  { match: /\b(self[- ]help|personal development|psychology|productivity|health|wellness)\b/i, canonical: "Self-help" },
  { match: /\b(poetry|poems)\b/i, canonical: "Poetry" },
  { match: /\b(comics?|graphic novel|manga)\b/i, canonical: "Comics and graphic novels" },
  { match: /\b(non[- ]?fiction|essays|journalism|politics|geopolitics|sociology|travel|history and criticism|rock music|popular music|encyclopedias|photo\s*book)\b/i, canonical: "Non-fiction" },
];

export const FICTION_GENRES = new Set([
  "Science fiction",
  "Fantasy",
  "Mystery and thriller",
  "Horror",
  "Literary fiction",
  "Historical fiction",
  "Romance",
  "Young adult",
  "Classics",
  "Poetry",
]);

export function canonicalizeGenres(rawList: string[], maxGenres = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (g: string) => {
    if (!g || seen.has(g) || out.length >= maxGenres) return;
    seen.add(g);
    out.push(g);
  };
  for (const raw of rawList) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    // Skip Open Library compound tags like "Fiction, biography" or drama/plays
    if (/fiction/i.test(cleaned) && /biograph/i.test(cleaned)) {
      add("Literary fiction");
      continue;
    }
    if (/\b(drama|plays|tragedies|comedies)\b/i.test(cleaned)) {
      add("Classics");
      continue;
    }
    // Skip generic "Juvenile literature" / "American literature" subject tags so they
    // don't misclassify non-fiction or biographies as Literary fiction.
    if (/\bjuvenile\s+literature\b/i.test(cleaned)) {
      continue;
    }
    let matched = false;
    for (const rule of GENRE_RULES) {
      if (rule.match.test(cleaned)) {
        add(rule.canonical);
        matched = true;
      }
    }
    if (!matched && /^fiction$/i.test(cleaned)) {
      add("Literary fiction");
    }
  }
  // If clearly fiction/classics/poetry, drop accidental "Non-fiction" or "Biography and memoir"
  const hasFiction = out.some((g) => FICTION_GENRES.has(g));
  const hasSpeculative = out.includes("Science fiction") || out.includes("Fantasy");
  if (hasFiction) {
    return out.filter(
      (g) =>
        g !== "Non-fiction" &&
        g !== "Biography and memoir" &&
        !(hasSpeculative && g === "History"),
    );
  }
  return out;
}

export function encodeQuery(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const key of Object.keys(params)) {
    const val = params[key];
    if (val === undefined || val === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
  }
  return parts.join("&");
}

export function dedupeStrings(values: string[], max = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = v.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
