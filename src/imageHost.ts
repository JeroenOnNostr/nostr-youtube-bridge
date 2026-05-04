/**
 * Rehosts an upstream avatar URL on nostr.build so the kind:0 we publish
 * points at a Nostr-native, referrer-safe, ~10-30 KB WebP instead of the
 * raw YouTube CDN URL (often hundreds of KB and flaky cross-origin).
 *
 * Pipeline: wsrv.nl resizes the upstream image to 400x400 WebP on the way
 * in, then we POST the bytes to nostr.build (NIP-96 anonymous upload).
 *
 * Why wsrv.nl rather than resizing in-Worker: Cloudflare's own Image
 * Resizing only works for origin-served images, and a WASM image library
 * would add 2-3 MB to the Worker bundle. wsrv is a free Cloudflare-fronted
 * service that takes any URL + resize params and hands back the bytes.
 *
 * All errors are swallowed and surfaced as `null` — callers fall back to
 * publishing the raw upstream URL, same behaviour as before this module
 * existed. The bridge must keep running even if either hop is down.
 */

const WSRV_BASE = 'https://wsrv.nl/';
const NOSTR_BUILD_UPLOAD = 'https://nostr.build/api/v2/upload/files';

export async function rehostAvatar(upstreamUrl: string): Promise<string | null> {
  try {
    const wsrvUrl = `${WSRV_BASE}?url=${encodeURIComponent(upstreamUrl)}&w=400&h=400&fit=cover&output=webp&q=80`;
    const resized = await fetch(wsrvUrl);
    if (!resized.ok) {
      console.warn(`rehostAvatar: wsrv.nl returned ${resized.status} for ${upstreamUrl}`);
      return null;
    }
    const blob = await resized.blob();

    const form = new FormData();
    form.append('file', new Blob([await blob.arrayBuffer()], { type: 'image/webp' }), 'avatar.webp');

    const upload = await fetch(NOSTR_BUILD_UPLOAD, { method: 'POST', body: form });
    if (!upload.ok) {
      console.warn(`rehostAvatar: nostr.build returned ${upload.status} for ${upstreamUrl}`);
      return null;
    }
    const json = (await upload.json()) as unknown;
    const url = extractUploadedUrl(json);
    if (!url) {
      console.warn('rehostAvatar: nostr.build response had no usable URL', json);
      return null;
    }
    return url;
  } catch (err) {
    console.warn(`rehostAvatar: failed for ${upstreamUrl}`, err);
    return null;
  }
}

// nostr.build's NIP-96 endpoint historically returns one of two shapes
// depending on version. Handle both: prefer NIP-94 tags, fall back to
// the legacy `data.link` string.
function extractUploadedUrl(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as { data?: unknown };
  const data = root.data;

  if (Array.isArray(data)) {
    for (const item of data) {
      const tagged = readTagsUrl(item);
      if (tagged) return tagged;
    }
    return null;
  }

  if (data && typeof data === 'object') {
    const tagged = readTagsUrl(data);
    if (tagged) return tagged;
    const link = (data as { link?: unknown }).link;
    if (typeof link === 'string' && link.startsWith('http')) return link;
  }

  return null;
}

function readTagsUrl(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const tags = (item as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === 'url' && typeof tag[1] === 'string' && tag[1].startsWith('http')) {
      return tag[1];
    }
  }
  return null;
}
