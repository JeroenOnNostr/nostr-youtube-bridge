import { sha256 } from '@noble/hashes/sha2';
import { finalizeEvent, type EventTemplate, type NostrEvent } from 'nostr-tools';
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';

import type { FeedEntry } from './youtube';

// Cloudflare Workers exposes a global WebSocket; nostr-tools' relay client
// expects a `ws` module at import time. Wire the platform's WebSocket up.
useWebSocketImplementation(WebSocket);

export type ShortsKind = 22 | 34236;

/**
 * NIP-71 video-event kinds, isolated behind named constants so the
 * "is kind-21 the right kind for a YouTube watch-page URL?" question stays a
 * one-line change. Resolved: we stay on kind 21/22 (keeps the events in
 * kind-filtered video feeds like Kubo's) and instead make the event *honest* —
 * see buildVideoEvent below.
 */
export const VIDEO_LONG_KIND = 21 as const;
export const VIDEO_SHORT_KIND = 22 as const;

export interface ChannelMetadata {
  id: string;
  title: string;
  url: string;
  pictureUrl?: string;
}

export function buildKind0(meta: ChannelMetadata): EventTemplate {
  const profile = {
    name: meta.title,
    display_name: meta.title,
    about: `Bridged from YouTube. This profile is operated by the nostr-youtube-bridge and republishes new uploads from ${meta.url}. Not the channel owner.`,
    website: meta.url,
    picture: meta.pictureUrl,
    bot: true,
  };
  // Strip undefined fields so the JSON is clean.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profile)) {
    if (v !== undefined && v !== null && v !== '') cleaned[k] = v;
  }
  return {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['i', `youtube:${meta.id}`, '-'],
    ],
    content: JSON.stringify(cleaned),
  };
}

export function kind0Hash(meta: ChannelMetadata): string {
  const blob = JSON.stringify({
    title: meta.title,
    url: meta.url,
    picture: meta.pictureUrl ?? '',
  });
  const bytes = sha256(new TextEncoder().encode(blob));
  return Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface VideoEventInput {
  entry: FeedEntry;
  /** 'long' or 'short' — caller decides based on which feed/probe classified the entry. */
  classification: 'long' | 'short';
  /** Which kind to use for shorts (default 22; 34236 is the addressable variant). */
  shortsKind: ShortsKind;
  /**
   * When true, signals the entry came from a backfill source (InnerTube)
   * where the upload timestamp is approximate — not the precise RSS
   * <published> value. The alt tag is annotated accordingly so downstream
   * clients can distinguish exact-time events from approximate ones.
   */
  approximate?: boolean;
}

export function buildVideoEvent({ entry, classification, shortsKind, approximate }: VideoEventInput): EventTemplate {
  const kind = classification === 'long' ? VIDEO_LONG_KIND : shortsKind;

  const tags: string[][] = [];

  // kind:34236 is addressable — needs a stable `d` tag so re-publishing replaces.
  if (kind === 34236) {
    tags.push(['d', `youtube:${entry.videoId}`]);
  }

  const altPrefix = approximate ? 'Video (approx upload time)' : 'Video';
  tags.push(
    ['title', entry.title],
    ['published_at', String(entry.publishedAtUnix)],
    ['alt', `${altPrefix}: ${entry.title}`],
  );

  // NIP-73 external-content tags: this event is *about* an external web
  // resource (the YouTube watch page), not a Nostr-hosted video file. The
  // optional 3rd element on `i` is a URL hint. `k web` lets downstream clients
  // (e.g. a YouTube-alternative pulling all kind-21/22 events) cleanly tell our
  // events are external references and include or exclude them on purpose.
  tags.push(['i', entry.watchUrl, entry.watchUrl]);
  tags.push(['k', 'web']);

  // NIP-71 `r` = links to web pages — the spec-blessed home for the watch URL.
  tags.push(['r', entry.watchUrl]);

  // NIP-92 imeta. The `url` is the watch page (the seam clients use to detect &
  // embed the YouTube player); the only *media variant* described here is the
  // thumbnail image, with its real mimetype. We deliberately do NOT claim a
  // `video/*` (or the old bogus `text/html`) variant — there is no hosted file,
  // so a downstream "does this have a playable video file?" check fails cleanly.
  tags.push([
    'imeta',
    `url ${entry.watchUrl}`,
    `image ${entry.thumbnailUrl}`,
    `m image/jpeg`,
  ]);

  return {
    kind,
    // created_at = original YouTube upload time when known (RSS path); for
    // backfill (InnerTube), an approximate value derived from the relative
    // "X ago" string or, for shorts, the channel-tab order.
    created_at: entry.publishedAtUnix,
    tags,
    content: entry.description,
  };
}

export function signEvent(template: EventTemplate, sk: Uint8Array): NostrEvent {
  return finalizeEvent(template, sk);
}

export interface DvmHandlerInput {
  /** NIP-90 job request kinds this DVM handles (advertised as `k` tags). */
  jobKinds: number[];
  /** Stable `d` tag so the kind-31990 event is addressable/replaceable. */
  dTag: string;
  name: string;
  about: string;
  picture?: string;
  website?: string;
}

/**
 * Build an unsigned NIP-89 kind-31990 DVM handler announcement. The DVM service
 * key signs this so Kubo (and any NIP-90 client) can discover the bridge as a
 * handler for the search/watch job kinds and reference its naddr. `content` is
 * a profile-shaped JSON blob per NIP-89; each handled kind also gets a `k` tag.
 */
export function buildDvmHandlerEvent(input: DvmHandlerInput): EventTemplate {
  const profile: Record<string, unknown> = {
    name: input.name,
    display_name: input.name,
    about: input.about,
  };
  if (input.picture) profile.picture = input.picture;
  if (input.website) profile.website = input.website;

  const tags: string[][] = [['d', input.dTag]];
  for (const k of input.jobKinds) tags.push(['k', String(k)]);

  return {
    kind: 31990,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify(profile),
  };
}

export interface FollowPackChannel {
  pubkeyHex: string;
  channelId: string;
  petname?: string;
}

export interface FollowPackInput {
  channels: FollowPackChannel[];
  name: string;
  description?: string;
  /** Stable identifier for this addressable kind:39089 event. */
  dTag: string;
  /** Optional relay hint embedded in each `p` tag. */
  defaultRelay?: string;
}

/**
 * Build an unsigned NIP-51 follow pack (kind 39089). The signing key is
 * supplied by the caller — typically the user's existing Nostr identity via
 * NIP-46, signed in the browser. The Worker never sees that key.
 */
export function buildFollowPackEvent(input: FollowPackInput): EventTemplate {
  const tags: string[][] = [
    ['d', input.dTag],
    ['title', input.name],
  ];
  if (input.description) tags.push(['description', input.description]);
  for (const ch of input.channels) {
    const tag = ['p', ch.pubkeyHex];
    if (input.defaultRelay) tag.push(input.defaultRelay);
    if (ch.petname) {
      if (!input.defaultRelay) tag.push('');
      tag.push(ch.petname);
    }
    tags.push(tag);
  }
  return {
    kind: 39089,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/**
 * Publish a signed event to all configured relays. Returns the count of relays
 * that accepted it. Failure on any single relay is logged and ignored — the
 * goal is best-effort fan-out.
 */
/** Hard upper bound on a single relay handshake-or-publish step. Without this
 *  a hung relay (e.g. unreachable from Cloudflare egress) can stall an entire
 *  long-running backfill, since nostr-tools' Relay.connect await never
 *  resolves on a silently-dropped TCP. */
const RELAY_OP_TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export async function publishToRelays(event: NostrEvent, relayUrls: string[]): Promise<number> {
  const results = await publishToRelaysDetailed(event, relayUrls);
  return results.filter((r) => r.ok).length;
}

export interface RelayPublishResult {
  url: string;
  ok: boolean;
  error?: string;
}

export async function publishToRelaysDetailed(
  event: NostrEvent,
  relayUrls: string[],
): Promise<RelayPublishResult[]> {
  return Promise.all(
    relayUrls.map(async (url): Promise<RelayPublishResult> => {
      let relay: Relay | null = null;
      try {
        relay = await withTimeout(Relay.connect(url), RELAY_OP_TIMEOUT_MS, `${url} connect`);
        await withTimeout(relay.publish(event), RELAY_OP_TIMEOUT_MS, `${url} publish`);
        return { url, ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`relay ${url} rejected event ${event.id}:`, err);
        return { url, ok: false, error: message };
      } finally {
        try {
          relay?.close();
        } catch {
          // ignore
        }
      }
    }),
  );
}

/**
 * Pool of long-lived relay connections for batch publishing (backfill). Opens
 * each relay once on demand, reuses the socket across many events, and drops
 * relays that fail repeatedly so a single dead relay doesn't slow the rest.
 */
export class RelayPool {
  private readonly relays = new Map<string, Relay>();
  private readonly failures = new Map<string, number>();
  private readonly maxFailures: number;

  constructor(private readonly urls: string[], maxFailures = 3) {
    this.maxFailures = maxFailures;
  }

  private async getOrConnect(url: string): Promise<Relay | null> {
    const existing = this.relays.get(url);
    if (existing) return existing;
    if ((this.failures.get(url) ?? 0) >= this.maxFailures) return null;
    try {
      const relay = await withTimeout(Relay.connect(url), RELAY_OP_TIMEOUT_MS, `${url} connect`);
      this.relays.set(url, relay);
      return relay;
    } catch (err) {
      this.failures.set(url, (this.failures.get(url) ?? 0) + 1);
      console.warn(`relay ${url} connect failed:`, err);
      return null;
    }
  }

  async publish(event: NostrEvent): Promise<number> {
    let accepted = 0;
    await Promise.all(
      this.urls.map(async (url) => {
        const relay = await this.getOrConnect(url);
        if (!relay) return;
        try {
          await withTimeout(relay.publish(event), RELAY_OP_TIMEOUT_MS, `${url} publish`);
          accepted++;
          this.failures.set(url, 0);
        } catch (err) {
          const n = (this.failures.get(url) ?? 0) + 1;
          this.failures.set(url, n);
          console.warn(`relay ${url} rejected event ${event.id}:`, err);
          if (n >= this.maxFailures) {
            try { relay.close(); } catch { /* ignore */ }
            this.relays.delete(url);
          }
        }
      }),
    );
    return accepted;
  }

  close(): void {
    for (const relay of this.relays.values()) {
      try { relay.close(); } catch { /* ignore */ }
    }
    this.relays.clear();
  }
}
