/**
 * Rehosts an upstream avatar URL on nostr.build so the kind:0 we publish
 * points at a Nostr-native, referrer-safe, ~10-30 KB WebP instead of the
 * raw YouTube CDN URL (often hundreds of KB and flaky cross-origin).
 *
 * Pipeline: wsrv.nl resizes the upstream image to 400x400 WebP on the way
 * in, then we POST the bytes to nostr.build's NIP-96 endpoint with a NIP-98
 * `Authorization: Nostr <base64 kind-27235>` header signed by the bridge's
 * DVM service key (nostr.build now rejects anonymous uploads).
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

import { sha256 } from '@noble/hashes/sha2';
import { finalizeEvent } from 'nostr-tools';

const WSRV_BASE = 'https://wsrv.nl/';
const NOSTR_BUILD_UPLOAD = 'https://nostr.build/api/v2/upload/files';

/** Per-hop attempts before giving up. Both hops sit behind flaky third-party
 *  services (wsrv.nl, nostr.build) that intermittently 5xx or time out, so a
 *  short retry meaningfully lifts the success rate without slowing the happy
 *  path. Backoff is linear: 0ms, 400ms, 800ms. */
const REHOST_ATTEMPTS = 3;
const REHOST_BACKOFF_MS = 400;

/**
 * True when a URL is a raw YouTube avatar CDN URL (yt3/googleusercontent).
 * These are referrer-flaky and large; the bridge must never put one in a
 * kind:0 `picture` field — see maybePublishKind0 in index.ts.
 */
export function isRawYouTubeAvatarUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return /googleusercontent\.com/i.test(url) || /(^|\/\/)yt\d\./i.test(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` up to REHOST_ATTEMPTS times with linear backoff. Returns the first
 * non-null result; returns null if every attempt returned null or threw.
 * `label` is only used for log lines.
 */
async function withRetry<T>(label: string, fn: () => Promise<T | null>): Promise<T | null> {
  for (let attempt = 1; attempt <= REHOST_ATTEMPTS; attempt++) {
    try {
      const result = await fn();
      if (result !== null) return result;
    } catch (err) {
      console.warn(`rehostAvatar: ${label} attempt ${attempt}/${REHOST_ATTEMPTS} threw`, err);
    }
    if (attempt < REHOST_ATTEMPTS) await sleep(attempt * REHOST_BACKOFF_MS);
  }
  return null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Base64-encode raw bytes, UTF-8/binary-safe. `btoa` only accepts a binary
 * string (one char per byte), so map the bytes into that form first. (The
 * NIP-98 event JSON is ASCII, but encoding bytes directly is robust regardless.)
 */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Build a NIP-98 `Authorization` header value (`Nostr <base64>`) for an HTTP
 * request. Signs a kind-27235 event with `serviceSk` carrying the exact request
 * URL (`u`), method, and — when `bodyBytes` is supplied — the sha256 of the
 * request body (`payload`, RECOMMENDED by NIP-98 for uploads). The `u` tag MUST
 * match the request URL exactly; that plus a valid signature is what nostr.build
 * checks. Exported for testing.
 */
export function buildNip98Header(
  url: string,
  method: string,
  serviceSk: Uint8Array,
  bodyBytes?: Uint8Array,
): string {
  const tags: string[][] = [
    ['u', url],
    ['method', method],
  ];
  if (bodyBytes) {
    tags.push(['payload', bytesToHex(sha256(bodyBytes))]);
  }
  const signed = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    },
    serviceSk,
  );
  return `Nostr ${base64FromBytes(new TextEncoder().encode(JSON.stringify(signed)))}`;
}

export async function rehostAvatar(upstreamUrl: string, serviceSk: Uint8Array): Promise<string | null> {
  // Hop 1: wsrv.nl resize → WebP bytes.
  const blobBytes = await withRetry('wsrv.nl', async () => {
    const wsrvUrl = `${WSRV_BASE}?url=${encodeURIComponent(upstreamUrl)}&w=400&h=400&fit=cover&output=webp&q=80`;
    const resized = await fetch(wsrvUrl);
    if (!resized.ok) {
      console.warn(`rehostAvatar: wsrv.nl returned ${resized.status} for ${upstreamUrl}`);
      return null;
    }
    return resized.arrayBuffer();
  });
  if (!blobBytes) return null;

  // Hop 2: upload the bytes to nostr.build's NIP-96 endpoint, authenticated
  // with a NIP-98 header. nostr.build now rejects anonymous uploads.
  return withRetry('nostr.build', async () => {
    const form = new FormData();
    form.append('file', new Blob([blobBytes], { type: 'image/webp' }), 'avatar.webp');

    // Materialize the exact multipart body bytes the request will send so the
    // NIP-98 `payload` tag (sha256 of the body) matches what nostr.build
    // receives. Reading the Request once fixes the boundary; we then resend the
    // identical Content-Type + body. (FormData picks a fresh boundary each time
    // it's serialized, so we cannot hash one Request's body and send another.)
    const baked = new Request(NOSTR_BUILD_UPLOAD, { method: 'POST', body: form });
    const contentType = baked.headers.get('content-type') ?? 'multipart/form-data';
    const bodyBytes = new Uint8Array(await baked.arrayBuffer());

    const authorization = buildNip98Header(NOSTR_BUILD_UPLOAD, 'POST', serviceSk, bodyBytes);
    const upload = await fetch(NOSTR_BUILD_UPLOAD, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': contentType },
      body: bodyBytes,
    });
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
  });
}

// nostr.build's NIP-96 endpoint has returned several shapes across versions.
// Handle all known ones: a plain `data[].url` / `data.url` string (current
// /v2/upload/files response, e.g. https://image.nostr.build/<sha>.jpg), the
// NIP-94 `tags` array, and the legacy `data.link` string.
function extractUploadedUrl(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as { data?: unknown };
  const data = root.data;

  if (Array.isArray(data)) {
    for (const item of data) {
      const direct = readDirectUrl(item);
      if (direct) return direct;
      const tagged = readTagsUrl(item);
      if (tagged) return tagged;
    }
    return null;
  }

  if (data && typeof data === 'object') {
    const direct = readDirectUrl(data);
    if (direct) return direct;
    const tagged = readTagsUrl(data);
    if (tagged) return tagged;
    const link = (data as { link?: unknown }).link;
    if (typeof link === 'string' && link.startsWith('http')) return link;
  }

  return null;
}

/** The current nostr.build response carries the URL as a plain `url` string. */
function readDirectUrl(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const url = (item as { url?: unknown }).url;
  return typeof url === 'string' && url.startsWith('http') ? url : null;
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
