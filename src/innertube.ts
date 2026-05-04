/**
 * YouTube InnerTube enumeration — full channel video history without an API key.
 *
 * Uses youtube.com's internal /youtubei/v1/browse JSON endpoint, the same one
 * the website itself calls. Key + clientVersion are scraped from ytcfg on the
 * homepage HTML; cached in KV; refreshed periodically.
 *
 * Limits: undocumented endpoint. Response shape can change without notice.
 * Cloudflare egress IPs occasionally get bot-flagged. Used only for the manual
 * "Backfill all history" button — RSS continues to drive the cron path.
 */

import type { InnertubeContextStore, InnertubeContext } from './kv';

// Tab params are stable URL-safe base64 tokens. They identify which channel
// tab to load and don't depend on the channel id. If YouTube ever rotates
// these, the homepage HTML or any channel page exposes the current tokens
// next to the tab links.
const VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';
const SHORTS_TAB_PARAMS = 'EgZzaG9ydHPyBgUKA5oBAA%3D%3D';

const COMMON_HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  cookie: 'SOCS=CAI',
};

const CONTEXT_TTL_SECONDS = 24 * 60 * 60;

export interface InnertubeEntry {
  videoId: string;
  title: string;
  /** Approximate unix seconds. For long-form, parsed from "X ago"; for shorts,
   *  synthesized from the channel-tab order (newest first). */
  publishedAtApproxUnix: number;
  /** True when publishedAtApproxUnix is *very* approximate (no upstream date
   *  signal at all). Always true for shorts; true for long-form when we
   *  couldn't parse the relative-time string. */
  veryApproximate: boolean;
}

/** Bootstrap or refresh InnerTube context from the YouTube homepage. */
export async function getInnertubeContext(store: InnertubeContextStore): Promise<InnertubeContext> {
  const cached = await store.get();
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.fetchedAt < CONTEXT_TTL_SECONDS) {
    return cached;
  }
  const fresh = await fetchInnertubeContext();
  await store.put(fresh);
  return fresh;
}

async function fetchInnertubeContext(): Promise<InnertubeContext> {
  const resp = await fetch('https://www.youtube.com/?hl=en', {
    headers: {
      'user-agent': COMMON_HEADERS['user-agent'],
      cookie: COMMON_HEADERS.cookie,
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!resp.ok) throw new Error(`youtube.com homepage returned ${resp.status}`);
  const html = await resp.text();
  const apiKey = match(html, /"INNERTUBE_API_KEY":"([^"]+)"/);
  const clientVersion = match(html, /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  if (!apiKey || !clientVersion) {
    throw new Error('failed to bootstrap InnerTube — could not parse ytcfg from homepage');
  }
  return { apiKey, clientVersion, fetchedAt: Math.floor(Date.now() / 1000) };
}

function match(s: string, re: RegExp): string | null {
  const m = s.match(re);
  return m ? (m[1] ?? null) : null;
}

interface BrowseRequestBody {
  context: { client: { clientName: string; clientVersion: string; hl: string; gl: string } };
  browseId?: string;
  params?: string;
  continuation?: string;
}

function buildContext(ctx: InnertubeContext): BrowseRequestBody['context'] {
  return {
    client: { clientName: 'WEB', clientVersion: ctx.clientVersion, hl: 'en', gl: 'US' },
  };
}

async function postBrowse(ctx: InnertubeContext, body: BrowseRequestBody): Promise<unknown> {
  const url = `https://www.youtube.com/youtubei/v1/browse?key=${ctx.apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: COMMON_HEADERS,
    body: JSON.stringify(body),
  });
  if (resp.status === 429) throw new Error('youtube returned 429 — rate-limited');
  if (!resp.ok) throw new Error(`youtube /browse returned ${resp.status}`);
  const ct = resp.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new Error('youtube /browse returned non-JSON — likely a consent/bot wall');
  }
  return resp.json();
}

// ─── parsers ────────────────────────────────────────────────────────────

interface RawItem {
  richItemRenderer?: {
    content?: {
      videoRenderer?: {
        videoId?: string;
        title?: { runs?: Array<{ text?: string }>; simpleText?: string };
        publishedTimeText?: { simpleText?: string };
      };
      shortsLockupViewModel?: {
        accessibilityText?: string;
        onTap?: {
          innertubeCommand?: {
            reelWatchEndpoint?: { videoId?: string };
          };
        };
      };
    };
  };
  continuationItemRenderer?: {
    continuationEndpoint?: { continuationCommand?: { token?: string } };
  };
}

interface InitialBrowseResponse {
  contents?: {
    twoColumnBrowseResultsRenderer?: {
      tabs?: Array<{
        tabRenderer?: {
          selected?: boolean;
          content?: { richGridRenderer?: { contents?: RawItem[] } };
        };
      }>;
    };
  };
}

interface ContinuationResponse {
  onResponseReceivedActions?: Array<{
    appendContinuationItemsAction?: { continuationItems?: RawItem[] };
  }>;
}

function extractInitialItems(json: unknown): RawItem[] {
  const r = json as InitialBrowseResponse;
  const tabs = r.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  for (const t of tabs) {
    if (t.tabRenderer?.selected) {
      return t.tabRenderer.content?.richGridRenderer?.contents ?? [];
    }
  }
  return [];
}

function extractContinuationItems(json: unknown): RawItem[] {
  const r = json as ContinuationResponse;
  const actions = r.onResponseReceivedActions ?? [];
  for (const a of actions) {
    if (a.appendContinuationItemsAction?.continuationItems) {
      return a.appendContinuationItemsAction.continuationItems;
    }
  }
  return [];
}

function splitItems(items: RawItem[]): { entries: ParsedEntry[]; nextToken: string | null } {
  const entries: ParsedEntry[] = [];
  let nextToken: string | null = null;
  for (const it of items) {
    if (it.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
      nextToken = it.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      continue;
    }
    const c = it.richItemRenderer?.content;
    if (!c) continue;
    if (c.videoRenderer?.videoId) {
      const vr = c.videoRenderer;
      const vid: string = vr.videoId!;
      const title =
        (vr.title?.runs?.[0]?.text ?? '') ||
        (vr.title?.simpleText ?? '') ||
        '';
      entries.push({
        kind: 'long',
        videoId: vid,
        title,
        publishedRelative: vr.publishedTimeText?.simpleText ?? null,
      });
    } else if (c.shortsLockupViewModel?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId) {
      const sm = c.shortsLockupViewModel;
      const vid = sm.onTap!.innertubeCommand!.reelWatchEndpoint!.videoId!;
      entries.push({
        kind: 'short',
        videoId: vid,
        title: titleFromAccessibility(sm.accessibilityText ?? ''),
        publishedRelative: null,
      });
    }
  }
  return { entries, nextToken };
}

interface ParsedEntry {
  kind: 'long' | 'short';
  videoId: string;
  title: string;
  publishedRelative: string | null;
}

/**
 * Extract the title from a short's accessibilityText. Format examples:
 *   "Subscribe for $10,000, 1.1 million views - play Short"
 *   "Title with, commas, in it, 42K views - play Short"
 *
 * Strategy: drop the trailing " - play Short", then drop the last comma-
 * separated segment that ends in "views" (case-insensitive). What's left is
 * the title.
 */
export function titleFromAccessibility(text: string): string {
  if (!text) return '';
  let t = text.replace(/\s*-\s*play Short\s*$/i, '');
  // remove trailing ", N views" segment
  t = t.replace(/,\s*[^,]+\bviews?\s*$/i, '');
  return t.trim();
}

/**
 * Parse "3 weeks ago" / "1 year ago" / "5 days ago" → approximate unix seconds.
 * Returns null when the text doesn't match the expected shape.
 */
export function parseRelativeTime(text: string | null, nowMs: number = Date.now()): number | null {
  if (!text) return null;
  const m = text.trim().toLowerCase().match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2]!;
  const dayMs = 86_400_000;
  const multipliers: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: dayMs,
    week: 7 * dayMs,
    month: 30 * dayMs,
    year: 365 * dayMs,
  };
  const mul = multipliers[unit];
  if (!mul) return null;
  return Math.floor((nowMs - n * mul) / 1000);
}

// ─── public enumeration API ─────────────────────────────────────────────

export interface EnumerateOptions {
  /** Stop after collecting this many entries (across pages). */
  maxEntries?: number;
  /** Hard cap on continuation pages walked, defensive against runaway loops. */
  maxPages?: number;
}

/**
 * Enumerate every video in a channel's Videos or Shorts tab. Yields entries
 * with synthesized approximate timestamps:
 *   - Videos tab: parsed from "X ago" when present; otherwise an order-derived
 *     synthetic value.
 *   - Shorts tab: always order-derived (one day apart, newest first), since
 *     the shortsLockupViewModel carries no time signal.
 */
export async function enumerateChannelTab(
  ctx: InnertubeContext,
  channelId: string,
  tab: 'videos' | 'shorts',
  opts: EnumerateOptions = {},
): Promise<InnertubeEntry[]> {
  const maxEntries = opts.maxEntries ?? 10_000;
  const maxPages = opts.maxPages ?? 200;

  const out: InnertubeEntry[] = [];
  const params = tab === 'videos' ? VIDEOS_TAB_PARAMS : SHORTS_TAB_PARAMS;
  const initial = (await postBrowse(ctx, {
    context: buildContext(ctx),
    browseId: channelId,
    params,
  })) as unknown;

  const initialItems = extractInitialItems(initial);
  const initialSplit = splitItems(initialItems);
  pushEntries(out, initialSplit.entries, tab);

  let token = initialSplit.nextToken;
  let pages = 0;
  while (token && out.length < maxEntries && pages < maxPages) {
    pages++;
    const next = (await postBrowse(ctx, {
      context: buildContext(ctx),
      continuation: token,
    })) as unknown;
    const nextItems = extractContinuationItems(next);
    const nextSplit = splitItems(nextItems);
    pushEntries(out, nextSplit.entries, tab);
    token = nextSplit.nextToken;
  }

  return out.slice(0, maxEntries);
}

// ─── channel avatar lookup ──────────────────────────────────────────────

interface ThumbnailEntry {
  url?: string;
  width?: number;
  height?: number;
}

interface ChannelHomeResponse {
  header?: {
    c4TabbedHeaderRenderer?: {
      avatar?: { thumbnails?: ThumbnailEntry[] };
    };
    pageHeaderRenderer?: {
      content?: {
        pageHeaderViewModel?: {
          image?: {
            decoratedAvatarViewModel?: {
              avatar?: {
                avatarViewModel?: {
                  image?: { sources?: ThumbnailEntry[] };
                };
              };
            };
          };
        };
      };
    };
  };
}

function pickLargest(thumbs: ThumbnailEntry[] | undefined): string | null {
  if (!thumbs || thumbs.length === 0) return null;
  let best: ThumbnailEntry | null = null;
  for (const t of thumbs) {
    if (!t.url) continue;
    if (!best || (t.width ?? 0) > (best.width ?? 0)) best = t;
  }
  // Fall back to last entry if no widths were present at all.
  if (!best) {
    for (let i = thumbs.length - 1; i >= 0; i--) {
      if (thumbs[i]?.url) return thumbs[i]!.url!;
    }
    return null;
  }
  return best.url ?? null;
}

function extractAvatarUrl(json: unknown): string | null {
  const r = json as ChannelHomeResponse;
  const legacy = pickLargest(r.header?.c4TabbedHeaderRenderer?.avatar?.thumbnails);
  if (legacy) return legacy;
  const modern = pickLargest(
    r.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.image
      ?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources,
  );
  return modern;
}

/**
 * Fetch the channel's profile picture URL via InnerTube /browse with no tab
 * params (so the response carries the `header` block, which tab-scoped calls
 * omit). Returns null on any failure — bot walls, 4xx/5xx, JSON parse errors,
 * or when neither known header shape yields a URL. Callers should treat null
 * as "skip the avatar this tick" and rely on the next cron retry.
 */
export async function fetchChannelPicture(
  ctx: InnertubeContext,
  channelId: string,
): Promise<string | null> {
  try {
    const json = await postBrowse(ctx, {
      context: buildContext(ctx),
      browseId: channelId,
    });
    const url = extractAvatarUrl(json);
    if (!url) return null;
    if (url.startsWith('//')) return `https:${url}`;
    return url;
  } catch (err) {
    console.warn(`fetchChannelPicture for ${channelId} failed:`, err);
    return null;
  }
}

function pushEntries(out: InnertubeEntry[], entries: ParsedEntry[], tab: 'videos' | 'shorts'): void {
  const dayMs = 86_400_000;
  const now = Date.now();
  for (const e of entries) {
    let publishedAtApproxUnix: number;
    let veryApproximate: boolean;
    if (tab === 'videos') {
      const parsed = parseRelativeTime(e.publishedRelative);
      if (parsed != null) {
        publishedAtApproxUnix = parsed;
        veryApproximate = false;
      } else {
        // Fallback: order-derived. Older entries get older timestamps.
        publishedAtApproxUnix = Math.floor((now - (out.length + 1) * dayMs) / 1000);
        veryApproximate = true;
      }
    } else {
      // Shorts have no relative-time signal at all; spread one day apart by
      // their order in the response (which is upload-date-descending).
      publishedAtApproxUnix = Math.floor((now - (out.length + 1) * dayMs) / 1000);
      veryApproximate = true;
    }
    out.push({
      videoId: e.videoId,
      title: e.title,
      publishedAtApproxUnix,
      veryApproximate,
    });
  }
}
