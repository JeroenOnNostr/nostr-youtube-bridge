import { XMLParser } from 'fast-xml-parser';

export type FeedKind = 'long' | 'short' | 'unknown';

export interface FeedEntry {
  videoId: string;
  channelId: string;
  channelTitle: string;
  channelUrl: string;
  authorName: string;
  title: string;
  description: string;
  publishedAtUnix: number;
  watchUrl: string;
  thumbnailUrl: string;
  /** 'long' | 'short' if known from the source feed; 'unknown' if from regular feed and not yet probed. */
  source: FeedKind;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: true,
});

const PROBE_HEADERS = {
  // Bypass the EU consent wall — see researched note in plan.
  Cookie: 'SOCS=CAI',
  'User-Agent': 'Mozilla/5.0 (compatible; nostr-youtube-bridge/0.1)',
};

/** Build the long-form split-feed URL: UC<rest> -> UULF<rest>. */
export function longFeedUrl(channelId: string): string | null {
  if (!channelId.startsWith('UC')) return null;
  const suffix = channelId.slice(2);
  return `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${suffix}`;
}

/** Build the shorts split-feed URL: UC<rest> -> UUSH<rest>. */
export function shortsFeedUrl(channelId: string): string | null {
  if (!channelId.startsWith('UC')) return null;
  const suffix = channelId.slice(2);
  return `https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH${suffix}`;
}

/** Standard channel feed (covers everything; no shorts/long-form distinction). */
export function channelFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

function thumbnailFor(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function parseFeed(xml: string, sourceKind: FeedKind): FeedEntry[] {
  const parsed = xmlParser.parse(xml);
  const feed = parsed?.feed;
  if (!feed) return [];

  // The regular feed's <yt:channelId> drops the leading "UC" prefix; the
  // entry-level <yt:channelId> includes it. Read from an entry when possible
  // and fall back to re-prefixing the feed-level value.
  const rawFeedChannelId: string = feed['yt:channelId'] ?? '';
  const feedChannelId = rawFeedChannelId.startsWith('UC') ? rawFeedChannelId : 'UC' + rawFeedChannelId;
  const channelTitle: string = feed.title ?? '';
  // The feed's <author><name> is the channel name; <link rel="alternate"> is the channel URL.
  const authorName: string = feed.author?.name ?? channelTitle;
  let channelUrl = '';
  const links = Array.isArray(feed.link) ? feed.link : feed.link ? [feed.link] : [];
  for (const l of links) {
    const rel = l['@_rel'];
    const href = l['@_href'];
    if (rel === 'alternate' && href) {
      channelUrl = href;
      break;
    }
  }

  const rawEntries = feed.entry;
  const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : [];

  const out: FeedEntry[] = [];
  for (const e of entries) {
    const videoId: string | undefined = e['yt:videoId'];
    if (!videoId) continue;
    const title: string = e.title ?? '';
    const published: string = e.published ?? '';
    const publishedAtUnix = Math.floor(new Date(published).getTime() / 1000);
    if (!Number.isFinite(publishedAtUnix) || publishedAtUnix <= 0) continue;
    const description: string = e['media:group']?.['media:description'] ?? '';
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Entry-level channelId always has the UC prefix; prefer it.
    const entryChannelId: string = e['yt:channelId'] ?? feedChannelId;

    out.push({
      videoId,
      channelId: entryChannelId,
      channelTitle,
      channelUrl: channelUrl || `https://www.youtube.com/channel/${entryChannelId}`,
      authorName,
      title,
      description,
      publishedAtUnix,
      watchUrl,
      thumbnailUrl: thumbnailFor(videoId),
      source: sourceKind,
    });
  }
  return out;
}

async function fetchFeed(url: string | null, sourceKind: FeedKind): Promise<FeedEntry[]> {
  if (!url) return [];
  let resp: Response;
  try {
    resp = await fetch(url, { headers: PROBE_HEADERS });
  } catch {
    return [];
  }
  if (!resp.ok) return [];
  const xml = await resp.text();
  try {
    return parseFeed(xml, sourceKind);
  } catch {
    return [];
  }
}

export interface ChannelFeeds {
  long: FeedEntry[];
  short: FeedEntry[];
  /** Regular channel feed entries that did not appear in either split feed. */
  unclassified: FeedEntry[];
  channelInfo: {
    id: string;
    title: string;
    url: string;
    authorName: string;
  } | null;
}

/**
 * Fetch the split feeds and the regular feed for a channel, then bucket by
 * classification. The regular feed is used to detect entries that are missing
 * from both split feeds (e.g. if YouTube retires the UULF/UUSH prefixes) so the
 * caller can fall back to the redirect probe.
 *
 * Channel metadata (title, url) is sourced from the *regular* feed only —
 * UULF/UUSH split feeds title themselves "Videos" / "Short videos", which is
 * not the channel name.
 */
export async function fetchChannelFeeds(channelId: string): Promise<ChannelFeeds> {
  const [longEntries, shortEntries, regularEntries] = await Promise.all([
    fetchFeed(longFeedUrl(channelId), 'long'),
    fetchFeed(shortsFeedUrl(channelId), 'short'),
    fetchFeed(channelFeedUrl(channelId), 'unknown'),
  ]);

  const known = new Set<string>();
  for (const e of longEntries) known.add(e.videoId);
  for (const e of shortEntries) known.add(e.videoId);
  const unclassified = regularEntries.filter((e) => !known.has(e.videoId));

  // Channel info: prefer the regular feed; only fall back to a split feed
  // entry if the regular feed didn't return anything. Use authorName (which
  // comes from <author><name>) — it is the actual channel name in all feeds.
  const src = regularEntries[0] ?? longEntries[0] ?? shortEntries[0];
  const channelInfo = src
    ? {
        id: src.channelId || channelId,
        title: src.authorName || src.channelTitle,
        url: src.channelUrl,
        authorName: src.authorName,
      }
    : null;

  return { long: longEntries, short: shortEntries, unclassified, channelInfo };
}

/**
 * Redirect-probe fallback. HEAD https://www.youtube.com/shorts/<videoId>:
 *   - HTTP 200          => YouTube classifies as a Short
 *   - HTTP 3xx /watch?v => long-form
 *   - anything else     => unknown (caller should default to long-form)
 *
 * Used only for entries that appear in the regular feed but not in either split
 * feed. Returns 'long' on any error so we never block publishing on a probe
 * failure.
 */
export async function probeShorts(videoId: string): Promise<FeedKind> {
  const url = `https://www.youtube.com/shorts/${videoId}`;
  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: PROBE_HEADERS,
    });
    if (resp.status === 200) return 'short';
    if (resp.status >= 300 && resp.status < 400) return 'long';
    return 'long';
  } catch {
    return 'long';
  }
}
