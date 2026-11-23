// Public-domain EPUB catalog providers:
// 1. Standard Ebooks (https://standardebooks.org/feeds/atom/new-releases)
// 2. Optional Gutendex / Project Gutenberg (https://gutendex.com/books/)

import { fetchJson, fetchText } from "../cache.ts";
import {
  canonicalizeGenres,
  clampSummary,
  decodeXmlEntities,
  dedupeStrings,
  extractYear,
  normalizeLanguage,
  normalizeText,
  parseIsoDateToUnix,
  safeHttpsUrl,
  stableExternalId,
} from "../text.ts";
import type { BookDirectSource, NormalizedEntry, PersonCredit, PluginSettings } from "../types.ts";

const SE_FEED_URL = "https://standardebooks.org/feeds/atom/new-releases";
const GUTENDEX_BASE = "https://gutendex.com/books/";

function extractTagContent(block: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(block);
  return m ? decodeXmlEntities(m[1].trim()) : "";
}

function extractAllTags(block: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function parseAttributes(tagStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagStr)) !== null) {
    attrs[m[1].toLowerCase()] = decodeXmlEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

export function parseStandardEbooksAtom(xml: string, limit = 60): NormalizedEntry[] {
  if (!xml) return [];
  const entries: NormalizedEntry[] = [];
  const entryRe = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;
  let rank = 0;

  while ((match = entryRe.exec(xml)) !== null && entries.length < limit) {
    const block = match[1];
    const rawId = extractTagContent(block, "id");
    const title = extractTagContent(block, "title");
    if (!title || !rawId) continue;

    // Extract authors from <author><name>...</name></author>
    const authorBlocks = extractAllTags(block, "author");
    const authors: PersonCredit[] = [];
    for (const ab of authorBlocks) {
      const name = extractTagContent(ab, "name");
      if (name) authors.push({ name, role: "Author" });
    }

    const summaryRaw = extractTagContent(block, "content") || extractTagContent(block, "summary");
    const summary = clampSummary(summaryRaw);
    const published = extractTagContent(block, "published") || extractTagContent(block, "updated");
    const issued = extractTagContent(block, "dc:issued") || extractTagContent(block, "dcterms:issued");
    const rawIssuedYear = extractYear(issued);
    // Standard Ebooks <published>/<updated> is the ebook release timestamp (2026), not original publication year.
    const year = rawIssuedYear && rawIssuedYear < 2000 ? rawIssuedYear : undefined;
    const released = year ? Math.floor(Date.UTC(year, 0, 1) / 1000) : undefined;
    const langRaw = extractTagContent(block, "dc:language") || "en";

    // Extract categories
    const rawCats: string[] = ["Classics"];
    const catRe = /<category\s+([^>]+?)\/?>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = catRe.exec(block)) !== null) {
      const a = parseAttributes(cm[1]);
      if (a["label"]) rawCats.push(a["label"]);
      else if (a["term"]) rawCats.push(a["term"]);
    }
    const genres = dedupeStrings(["Classics", ...canonicalizeGenres(rawCats, 5)], 6);

    // Extract cover image & EPUB acquisition links
    let coverUrl: string | undefined;
    let thumbUrl: string | undefined;
    let epubUrl: string | undefined;
    let advancedEpubUrl: string | undefined;

    const linkRe = /<link\s+([^>]+?)\/?>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(block)) !== null) {
      const a = parseAttributes(lm[1]);
      const rel = (a["rel"] || "").toLowerCase();
      const type = (a["type"] || "").toLowerCase();
      const href = safeHttpsUrl(a["href"]);
      if (!href) continue;

      if (rel === "http://opds-spec.org/image" || rel === "image") {
        coverUrl = href;
      } else if (rel === "http://opds-spec.org/image/thumbnail" || rel === "thumbnail") {
        thumbUrl = href;
      } else if (
        type.includes("application/epub+zip") &&
        (rel.includes("acquisition") || rel === "enclosure" || href.endsWith(".epub"))
      ) {
        if (href.includes("_advanced.epub") || href.includes("kepub")) {
          if (!advancedEpubUrl) advancedEpubUrl = href;
        } else if (!epubUrl) {
          epubUrl = href;
        }
      }
    }

    const bestEpub = epubUrl || advancedEpubUrl;
    const directSources: BookDirectSource[] = [];
    if (bestEpub) {
      directSources.push({
        url: bestEpub,
        mime: "application/epub+zip",
        format: "epub",
        label: "Standard Ebooks EPUB",
      });
    }

    const slugPart = rawId.replace(/^https?:\/\/standardebooks\.org\/ebooks\//i, "").replace(/\/+$/, "");
    const curated = ["Free classics"];
    rank++;

    entries.push({
      kind: "books",
      source: "standard-ebooks",
      sourceId: stableExternalId("se", slugPart || title),
      title,
      summary,
      year,
      released,
      releaseDate: year ? String(year) : undefined,
      rating: 8.5,
      authors: authors.length > 0 ? authors : [{ name: "Various authors", role: "Author" }],
      genres,
      curated,
      publisher: "Standard Ebooks",
      format: "epub",
      language: normalizeLanguage(langRaw) || "English",
      coverUrl: coverUrl || thumbUrl,
      directSources: directSources.length > 0 ? directSources : undefined,
    });
  }

  return entries;
}

export function fetchStandardEbooks(settings: PluginSettings, limit = 45): NormalizedEntry[] {
  if (!settings.enableStandardEbooks) return [];
  const resp = fetchText(SE_FEED_URL, {
    provider: "standardebooks",
    settings,
    headers: { Accept: "application/atom+xml, application/xml, text/xml" },
  });
  if (!resp || resp.status < 200 || resp.status >= 300 || !resp.body) {
    return [];
  }
  return parseStandardEbooksAtom(resp.body, limit);
}

export function searchStandardEbooks(
  query: string,
  settings: PluginSettings,
  limit = 12,
): NormalizedEntry[] {
  const all = fetchStandardEbooks(settings, 60);
  const q = normalizeText(query);
  if (!q) return all.slice(0, limit);
  const terms = q.split(/\s+/).filter(Boolean);
  return all
    .filter((item) => {
      const hay = normalizeText(
        `${item.title} ${item.authors.map((a) => a.name).join(" ")} ${item.genres.join(" ")}`,
      );
      return terms.every((t) => hay.includes(t));
    })
    .slice(0, limit);
}

interface GutendexAuthor {
  name?: string;
}

interface GutendexBook {
  id: number;
  title?: string;
  authors?: GutendexAuthor[];
  subjects?: string[];
  bookshelves?: string[];
  languages?: string[];
  formats?: Record<string, string>;
  download_count?: number;
}

interface GutendexResponse {
  results?: GutendexBook[];
}

function flipLastFirst(name: string): string {
  const parts = name.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`;
  return name.trim();
}

export function fetchGutendexBooks(
  settings: PluginSettings,
  query = "",
  limit = 20,
): NormalizedEntry[] {
  if (!settings.enableGutenberg) return [];
  const params: string[] = ["mime_type=application%2Fepub%2Bzip"];
  if (settings.language === "en") params.push("languages=en");
  if (query.trim()) params.push(`search=${encodeURIComponent(query.trim())}`);
  const url = `${GUTENDEX_BASE}?${params.join("&")}`;
  const data = fetchJson<GutendexResponse>(url, {
    provider: "gutendex",
    settings,
    cacheKey: `gdx:${settings.language}:${query.trim().toLowerCase()}`,
    cacheTtlSec: 6 * 3600,
  });
  if (!data?.results) return [];

  const out: NormalizedEntry[] = [];
  for (const b of data.results) {
    if (!b.title || out.length >= limit) continue;
    const formats = b.formats || {};
    const epubUrl =
      safeHttpsUrl(formats["application/epub+zip"]) ||
      safeHttpsUrl(
        Object.entries(formats).find(([k]) => k.toLowerCase().includes("epub"))?.[1],
      );
    const coverUrl = safeHttpsUrl(formats["image/jpeg"]);
    const authors: PersonCredit[] = (b.authors || [])
      .map((a) => (a.name ? flipLastFirst(a.name) : ""))
      .filter(Boolean)
      .map((name) => ({ name, role: "Author" }));
    const rawSubjects = [...(b.subjects || []), ...(b.bookshelves || []), "Classics"];
    const genres = dedupeStrings(["Classics", ...canonicalizeGenres(rawSubjects, 5)], 6);
    const directSources: BookDirectSource[] = epubUrl
      ? [{ url: epubUrl, mime: "application/epub+zip", format: "epub", label: "Project Gutenberg EPUB" }]
      : [];

    out.push({
      kind: "books",
      source: "gutenberg",
      sourceId: stableExternalId("gutenberg", String(b.id)),
      title: b.title.trim(),
      rating: b.download_count && b.download_count > 5000 ? 8.2 : 7.8,
      authors: authors.length > 0 ? authors : [{ name: "Various authors", role: "Author" }],
      genres,
      curated: ["Free classics"],
      publisher: "Project Gutenberg",
      format: "epub",
      language: normalizeLanguage(b.languages?.[0] || "en") || "English",
      coverUrl,
      directSources: directSources.length > 0 ? directSources : undefined,
    });
  }
  return out;
}
