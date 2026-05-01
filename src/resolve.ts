const PROBE_HEADERS = {
  Cookie: 'SOCS=CAI',
  'User-Agent': 'Mozilla/5.0 (compatible; nostr-youtube-bridge/0.1)',
};

const CHANNEL_ID_RE = /"channelId":"(UC[\w-]{22})"/;
const EXTERNAL_ID_RE = /"externalId":"(UC[\w-]{22})"/;
const CHANNEL_TITLE_RE = /<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i;

export interface ResolvedChannel {
  channelId: string;
  title?: string;
  url?: string;
}

/**
 * Resolve a user-pasted YouTube reference to a UC... channel id.
 * Accepts:
 *   - bare `UC...` ids
 *   - `youtube.com/channel/UC...`
 *   - `youtube.com/watch?v=...`, `youtu.be/<videoId>`, `youtube.com/shorts/<videoId>`
 *   - `youtube.com/@handle`, `youtube.com/c/Name`, `youtube.com/user/Name`
 */
export async function resolveYouTubeUrl(input: string): Promise<ResolvedChannel | null> {
  const raw = input.trim();
  if (!raw) return null;

  if (/^UC[\w-]{22}$/.test(raw)) {
    return { channelId: raw, url: `https://www.youtube.com/channel/${raw}` };
  }

  let url: URL;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  // /channel/UC... — direct
  const channelMatch = url.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (channelMatch) {
    return await fetchChannelMeta(channelMatch[1]!);
  }

  const fetchUrl = canonicalize(url);
  if (!fetchUrl) return null;

  const html = await fetchHtml(fetchUrl);
  if (!html) return null;

  const id = html.match(EXTERNAL_ID_RE)?.[1] ?? html.match(CHANNEL_ID_RE)?.[1];
  if (!id) return null;
  const title = html.match(CHANNEL_TITLE_RE)?.[1];
  return {
    channelId: id,
    title,
    url: `https://www.youtube.com/channel/${id}`,
  };
}

async function fetchChannelMeta(channelId: string): Promise<ResolvedChannel> {
  const html = await fetchHtml(`https://www.youtube.com/channel/${channelId}`);
  const title = html?.match(CHANNEL_TITLE_RE)?.[1];
  return {
    channelId,
    title,
    url: `https://www.youtube.com/channel/${channelId}`,
  };
}

function canonicalize(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\//, '').split('/')[0];
    if (!id) return null;
    return `https://www.youtube.com/watch?v=${id}`;
  }
  if (!host.endsWith('youtube.com')) return null;

  const watch = url.pathname === '/watch';
  if (watch) {
    const v = url.searchParams.get('v');
    if (!v) return null;
    return `https://www.youtube.com/watch?v=${v}`;
  }
  const shorts = url.pathname.match(/^\/shorts\/([^/]+)/);
  if (shorts) return `https://www.youtube.com/watch?v=${shorts[1]}`;

  if (
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/c/') ||
    url.pathname.startsWith('/user/')
  ) {
    return `https://www.youtube.com${url.pathname}`;
  }
  return null;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, { headers: PROBE_HEADERS, redirect: 'follow' });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}
