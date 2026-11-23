// Console Status page ViewSpec (/ether/view/status) and owner actions.
// Every user-visible string in the ViewSpec uses a $t: key or {$: ...} data ref.

import { clearMetadataCache, fetchText, loadSyncStats } from "./cache.ts";
import { testHardcoverConnection } from "./providers/hardcover.ts";
import type { PluginSettings } from "./types.ts";

export function buildStatusView(settings: PluginSettings): {
  title: string;
  spec: Record<string, unknown>;
  data: Record<string, unknown>;
} {
  const stats = loadSyncStats();
  const booksCount = stats?.booksCount ?? 0;
  const audiobooksCount = stats?.audiobooksCount ?? 0;
  const lastSync = stats?.lastSyncAt
    ? new Date(stats.lastSyncAt * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "Pending first sync";

  const sourceRows = [
    {
      id: "openlibrary",
      name: "Open Library",
      library: "Books",
      state: settings.enableOpenLibrary ? "Enabled" : "Disabled",
      notes: stats?.sources?.openlibrary
        ? `${stats.sources.openlibrary.count} titles synced`
        : "Trending, genres, awards and author portraits",
    },
    {
      id: "standard-ebooks",
      name: "Standard Ebooks",
      library: "Books",
      state: settings.enableStandardEbooks ? "Enabled" : "Disabled",
      notes: stats?.sources?.standard_ebooks
        ? `${stats.sources.standard_ebooks.count} direct EPUB classics`
        : "Direct public-domain EPUB editions",
    },
    {
      id: "audible",
      name: "Audible catalog metadata",
      library: "Audiobooks",
      state: settings.enableAudibleMetadata ? "Enabled" : "Disabled",
      notes: stats?.sources?.audible
        ? `${stats.sources.audible.count} audiobook editions`
        : "Narrators, runtimes, series order and square art",
    },
    {
      id: "librivox",
      name: "LibriVox",
      library: "Audiobooks",
      state: settings.enableLibriVox ? "Enabled" : "Disabled",
      notes: stats?.sources?.librivox
        ? `${stats.sources.librivox.count} multi-part audiobooks`
        : "Direct public-domain MP3 chapters",
    },
    {
      id: "hardcover",
      name: "Hardcover GraphQL",
      library: "Books and Audiobooks",
      state: settings.hardcoverToken ? "Configured" : "Optional",
      notes: settings.hardcoverToken
        ? "Enriching community ratings, trending lists and series"
        : "Add optional API token in plugin settings",
    },
  ];

  return {
    title: "$t:view.status.title",
    spec: {
      specVersion: 1,
      layout: "detail",
      header: [
        {
          kind: "page-header",
          title: "$t:view.status.title",
          description: "$t:view.status.subtitle",
        },
      ],
      body: [
        {
          kind: "stat-tile",
          iconKey: "book",
          accent: "primary",
          label: "$t:view.status.stat_books",
          value: { $: "booksCount" },
        },
        {
          kind: "stat-tile",
          iconKey: "headphones",
          accent: "primary",
          label: "$t:view.status.stat_audiobooks",
          value: { $: "audiobooksCount" },
        },
        {
          kind: "stat-tile",
          iconKey: "clock",
          accent: "neutral",
          label: "$t:view.status.stat_sync",
          value: { $: "lastSync" },
        },
        {
          kind: "panel",
          title: "$t:view.status.sources_heading",
          blocks: [
            {
              kind: "repeat",
              items: { $: "sources" },
              itemKey: { $: "id" },
              blocks: [
                {
                  kind: "text",
                  content: { $: "summaryLine" },
                },
              ],
            },
          ],
        },
      ],
    },
    data: {
      booksCount: String(booksCount),
      audiobooksCount: String(audiobooksCount),
      lastSync,
      sources: sourceRows.map((s) => ({
        id: s.id,
        summaryLine: `${s.name} (${s.library}) - ${s.state}: ${s.notes}`,
      })),
    },
  };
}

export function runCatalogConnectivityTest(settings: PluginSettings): {
  ok: boolean;
  checks: Array<{ source: string; ok: boolean; note: string }>;
} {
  const checks: Array<{ source: string; ok: boolean; note: string }> = [];

  if (settings.enableOpenLibrary) {
    const r = fetchText("https://openlibrary.org/trending/weekly.json?limit=1", {
      provider: "openlibrary",
      settings,
    });
    checks.push({
      source: "Open Library",
      ok: Boolean(r && r.status >= 200 && r.status < 300),
      note: r ? `HTTP ${r.status}` : "Unreachable",
    });
  }

  if (settings.enableStandardEbooks) {
    const r = fetchText("https://standardebooks.org/feeds/atom/new-releases", {
      provider: "standardebooks",
      settings,
    });
    checks.push({
      source: "Standard Ebooks",
      ok: Boolean(r && r.status >= 200 && r.status < 300),
      note: r ? `HTTP ${r.status}` : "Unreachable",
    });
  }

  if (settings.enableAudibleMetadata) {
    const r = fetchText("https://api.audible.com/1.0/catalog/products?num_results=1", {
      provider: "audible",
      settings,
    });
    checks.push({
      source: "Audible catalog metadata",
      ok: Boolean(r && r.status >= 200 && r.status < 300),
      note: r ? `HTTP ${r.status}` : "Unreachable",
    });
  }

  if (settings.enableLibriVox) {
    const r = fetchText("https://librivox.org/api/feed/audiobooks/?format=json&limit=1", {
      provider: "librivox",
      settings,
    });
    checks.push({
      source: "LibriVox",
      ok: Boolean(r && r.status >= 200 && r.status < 300),
      note: r ? `HTTP ${r.status}` : "Unreachable",
    });
  }

  if (settings.hardcoverToken) {
    const hc = testHardcoverConnection(settings);
    checks.push({ source: "Hardcover", ok: hc.ok, note: hc.note });
  }

  const anyOk = checks.length === 0 || checks.some((c) => c.ok);
  return { ok: anyOk, checks };
}

export function handleClearCacheAction(): { ok: boolean; cleared: number; message: string } {
  const cleared = clearMetadataCache();
  return {
    ok: true,
    cleared,
    message: "$t:view.status.notice_cleared",
  };
}
