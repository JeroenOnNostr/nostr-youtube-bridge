import { sha256 } from '@noble/hashes/sha2';
import { finalizeEvent, type EventTemplate, type NostrEvent } from 'nostr-tools';
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';

import type { FeedEntry } from './youtube';

// Cloudflare Workers exposes a global WebSocket; nostr-tools' relay client
// expects a `ws` module at import time. Wire the platform's WebSocket up.
useWebSocketImplementation(WebSocket);

export type ShortsKind = 22 | 34236;

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
      ['t', 'bridged'],
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
}

export function buildVideoEvent({ entry, classification, shortsKind }: VideoEventInput): EventTemplate {
  const isShort = classification === 'short';
  const kind = classification === 'long' ? 21 : shortsKind;

  const tags: string[][] = [];

  // kind:34236 is addressable — needs a stable `d` tag so re-publishing replaces.
  if (kind === 34236) {
    tags.push(['d', `youtube:${entry.videoId}`]);
  }

  tags.push(
    ['title', entry.title],
    ['published_at', String(entry.publishedAtUnix)],
    ['alt', `Video: ${entry.title}`],
    ['t', 'youtube'],
    ['t', 'bridged'],
  );
  if (isShort) tags.push(['t', 'short']);
  tags.push(['r', entry.watchUrl]);
  tags.push([
    'imeta',
    `url ${entry.watchUrl}`,
    `m text/html`,
    `image ${entry.thumbnailUrl}`,
  ]);

  return {
    kind,
    // created_at = original YouTube upload time, so feeds sort the bridged
    // event into its true place in time (not the moment the bridge ran).
    created_at: entry.publishedAtUnix,
    tags,
    content: entry.description,
  };
}

export function signEvent(template: EventTemplate, sk: Uint8Array): NostrEvent {
  return finalizeEvent(template, sk);
}

/**
 * Publish a signed event to all configured relays. Returns the count of relays
 * that accepted it. Failure on any single relay is logged and ignored — the
 * goal is best-effort fan-out.
 */
export async function publishToRelays(event: NostrEvent, relayUrls: string[]): Promise<number> {
  let accepted = 0;
  await Promise.all(
    relayUrls.map(async (url) => {
      let relay: Relay | null = null;
      try {
        relay = await Relay.connect(url);
        await relay.publish(event);
        accepted++;
      } catch (err) {
        console.warn(`relay ${url} rejected event ${event.id}:`, err);
      } finally {
        try {
          relay?.close();
        } catch {
          // ignore
        }
      }
    }),
  );
  return accepted;
}
