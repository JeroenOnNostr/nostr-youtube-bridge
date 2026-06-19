/**
 * Shared channel-onboarding + publishing helpers.
 *
 * Extracted from index.ts so both the cron/admin path (index.ts) and the DVM
 * watch handler (dvm.ts) drive channels through the exact same machinery:
 * deterministic per-channel key, kind:0 publish (with avatar rehosting + the
 * raw-googleusercontent suppression rule), and per-video publishing. Keeping
 * one implementation avoids the two paths drifting (e.g. one publishing a raw
 * CDN avatar the other suppresses).
 */

import { deriveChannelKey, deriveServiceKey } from './derive';
import {
  ChannelStore,
  EventStore,
  InnertubeContextStore,
  PublishedStore,
  type ArchivedEvent,
  type ChannelRecord,
} from './kv';
import { isRawYouTubeAvatarUrl, rehostAvatar } from './imageHost';
import { fetchChannelPicture, getInnertubeContext } from './innertube';
import {
  buildKind0,
  buildVideoEvent,
  kind0Hash,
  publishToRelays,
  signEvent,
  type ChannelMetadata,
  type ShortsKind,
} from './publisher';
import type { FeedEntry } from './youtube';

export interface Env {
  CHANNELS: KVNamespace;
  PUBLISHED: KVNamespace;
  EVENTS: KVNamespace;
  BRIDGE_MASTER_SEED: string;
  ADMIN_TOKEN: string;
  RELAY_URLS: string;
  SHORTS_KIND: string;
  BACKFILL_PER_FEED: string;
  DVM: DurableObjectNamespace;
}

export function getRelayUrls(env: Env): string[] {
  return env.RELAY_URLS.split(',').map((s) => s.trim()).filter(Boolean);
}

export function getShortsKind(env: Env): ShortsKind {
  const v = parseInt(env.SHORTS_KIND, 10);
  return v === 34236 ? 34236 : 22;
}

export function getBackfillCount(env: Env): number {
  const n = parseInt(env.BACKFILL_PER_FEED, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

export interface ChannelContext {
  record: ChannelRecord;
  sk: Uint8Array;
}

export async function ensureChannel(
  env: Env,
  channels: ChannelStore,
  channelId: string,
): Promise<ChannelContext> {
  const existing = await channels.get(channelId);
  const derived = deriveChannelKey(env.BRIDGE_MASTER_SEED, channelId);
  if (existing) {
    return { record: existing, sk: derived.sk };
  }
  const record: ChannelRecord = {
    channelId,
    addedAt: Math.floor(Date.now() / 1000),
    npub: derived.npub,
    pubkeyHex: derived.pkHex,
  };
  await channels.put(record);
  return { record, sk: derived.sk };
}

export async function maybePublishKind0(
  channels: ChannelStore,
  archive: EventStore,
  ctx: ChannelContext,
  meta: ChannelMetadata,
  relayUrls: string[],
): Promise<void> {
  // Never publish a raw yt3/googleusercontent avatar URL. If rehosting failed
  // this tick, publish kind:0 *without* a picture rather than with the raw URL
  // (next tick / heal pass retries). The kind0Hash below is computed over the
  // sanitized meta so a later successful rehost still produces a changed hash
  // and republishes.
  if (isRawYouTubeAvatarUrl(meta.pictureUrl)) {
    meta = { ...meta, pictureUrl: undefined };
  }
  const newHash = kind0Hash(meta);
  if (ctx.record.kind0Hash === newHash) return;
  const tmpl = buildKind0(meta);
  const signed = signEvent(tmpl, ctx.sk);
  const accepted = await publishToRelays(signed, relayUrls);
  if (accepted === 0) {
    console.warn(`kind:0 for ${meta.id} accepted by 0 relays — leaving hash unchanged for retry`);
    return;
  }
  await archive.put(signed as ArchivedEvent, ctx.record.channelId);
  const updated: ChannelRecord = {
    ...ctx.record,
    title: meta.title,
    url: meta.url,
    kind0PublishedAt: Math.floor(Date.now() / 1000),
    kind0Hash: newHash,
  };
  await channels.put(updated);
  ctx.record = updated;
}

/**
 * Resolve the channel's avatar to a rehosted nostr.build URL, honouring the
 * uploadedFromYtUrl/uploadedPictureUrl cache so an unchanged avatar isn't
 * re-uploaded every tick. Returns the rehosted URL, or undefined if there is
 * no upstream avatar or the rehost failed this tick (caller suppresses the
 * picture in that case via maybePublishKind0). Mutates ctx.record on cache
 * write so the caller sees the persisted cache fields.
 */
export async function refreshChannelAvatar(
  env: Env,
  channels: ChannelStore,
  ctx: ChannelContext,
  channelId: string,
): Promise<string | undefined> {
  let ytPictureUrl: string | undefined;
  try {
    const itStore = new InnertubeContextStore(env.CHANNELS);
    const itCtx = await getInnertubeContext(itStore);
    ytPictureUrl = (await fetchChannelPicture(itCtx, channelId)) ?? undefined;
  } catch (err) {
    console.warn(`fetchChannelPicture for ${channelId} failed:`, err);
  }
  if (!ytPictureUrl) return ctx.record.uploadedPictureUrl;

  if (ctx.record.uploadedFromYtUrl === ytPictureUrl && ctx.record.uploadedPictureUrl) {
    return ctx.record.uploadedPictureUrl;
  }
  // Sign the nostr.build NIP-98 upload with the bridge's DVM service identity,
  // so all rehosted avatars come from a single "uploader" rather than each
  // channel's per-channel key.
  const serviceSk = deriveServiceKey(env.BRIDGE_MASTER_SEED).sk;
  const rehosted = await rehostAvatar(ytPictureUrl, serviceSk);
  if (rehosted) {
    const updated: ChannelRecord = {
      ...ctx.record,
      uploadedFromYtUrl: ytPictureUrl,
      uploadedPictureUrl: rehosted,
    };
    await channels.put(updated);
    ctx.record = updated;
    return rehosted;
  }
  // Rehost failed this tick — return the previously-uploaded URL if we have one
  // (better than nothing), else undefined (caller publishes no picture).
  return ctx.record.uploadedPictureUrl;
}

export async function publishVideoEntry(
  ctx: ChannelContext,
  published: PublishedStore,
  archive: EventStore,
  entry: FeedEntry,
  classification: 'long' | 'short',
  shortsKind: ShortsKind,
  relayUrls: string[],
  approximate = false,
): Promise<boolean> {
  if (await published.has(entry.videoId)) return false;
  const tmpl = buildVideoEvent({ entry, classification, shortsKind, approximate });
  const signed = signEvent(tmpl, ctx.sk);
  const accepted = await publishToRelays(signed, relayUrls);
  if (accepted === 0) {
    console.warn(`video ${entry.videoId} accepted by 0 relays — will retry`);
    return false;
  }
  await archive.put(signed as ArchivedEvent, ctx.record.channelId);
  await published.put({
    videoId: entry.videoId,
    eventId: signed.id,
    publishedAt: Math.floor(Date.now() / 1000),
    channelId: ctx.record.channelId,
    kind: signed.kind,
  });
  return true;
}
