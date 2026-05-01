import { deriveChannelKey } from './derive';
import { ChannelStore, PublishedStore, type ChannelRecord } from './kv';
import {
  buildKind0,
  buildVideoEvent,
  kind0Hash,
  publishToRelays,
  signEvent,
  type ChannelMetadata,
  type ShortsKind,
} from './publisher';
import {
  fetchChannelFeeds,
  probeShorts,
  type FeedEntry,
} from './youtube';

export interface Env {
  CHANNELS: KVNamespace;
  PUBLISHED: KVNamespace;
  BRIDGE_MASTER_SEED: string;
  ADMIN_TOKEN: string;
  RELAY_URLS: string;
  SHORTS_KIND: string;
  BACKFILL_PER_FEED: string;
}

function getRelayUrls(env: Env): string[] {
  return env.RELAY_URLS.split(',').map((s) => s.trim()).filter(Boolean);
}

function getShortsKind(env: Env): ShortsKind {
  const v = parseInt(env.SHORTS_KIND, 10);
  return v === 34236 ? 34236 : 22;
}

function getBackfillCount(env: Env): number {
  const n = parseInt(env.BACKFILL_PER_FEED, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

interface ChannelContext {
  record: ChannelRecord;
  sk: Uint8Array;
}

async function ensureChannel(
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

async function maybePublishKind0(
  env: Env,
  channels: ChannelStore,
  ctx: ChannelContext,
  meta: ChannelMetadata,
): Promise<void> {
  const newHash = kind0Hash(meta);
  if (ctx.record.kind0Hash === newHash) return;
  const tmpl = buildKind0(meta);
  const signed = signEvent(tmpl, ctx.sk);
  const accepted = await publishToRelays(signed, getRelayUrls(env));
  if (accepted === 0) {
    console.warn(`kind:0 for ${meta.id} accepted by 0 relays — leaving hash unchanged for retry`);
    return;
  }
  const updated: ChannelRecord = {
    ...ctx.record,
    kind0PublishedAt: Math.floor(Date.now() / 1000),
    kind0Hash: newHash,
  };
  await channels.put(updated);
  ctx.record = updated;
}

async function publishVideoEntry(
  env: Env,
  ctx: ChannelContext,
  published: PublishedStore,
  entry: FeedEntry,
  classification: 'long' | 'short',
): Promise<boolean> {
  if (await published.has(entry.videoId)) return false;
  const tmpl = buildVideoEvent({
    entry,
    classification,
    shortsKind: getShortsKind(env),
  });
  const signed = signEvent(tmpl, ctx.sk);
  const accepted = await publishToRelays(signed, getRelayUrls(env));
  if (accepted === 0) {
    // Don't record dedup if no relay accepted — try again next cron.
    console.warn(`video ${entry.videoId} accepted by 0 relays — will retry`);
    return false;
  }
  await published.put({
    videoId: entry.videoId,
    eventId: signed.id,
    publishedAt: Math.floor(Date.now() / 1000),
    channelId: ctx.record.channelId,
    kind: signed.kind,
  });
  return true;
}

interface ProcessOptions {
  /** When set, only publish at most this many entries from each feed (for backfill on first add). */
  limitPerFeed?: number;
}

async function processChannel(
  env: Env,
  channels: ChannelStore,
  published: PublishedStore,
  channelId: string,
  opts: ProcessOptions = {},
): Promise<{ longPublished: number; shortPublished: number }> {
  const ctx = await ensureChannel(env, channels, channelId);
  const feeds = await fetchChannelFeeds(channelId);

  if (feeds.channelInfo) {
    const meta: ChannelMetadata = {
      id: feeds.channelInfo.id,
      title: feeds.channelInfo.title || feeds.channelInfo.authorName || channelId,
      url: feeds.channelInfo.url,
    };
    await maybePublishKind0(env, channels, ctx, meta);
  }

  let longEntries = feeds.long;
  let shortEntries = feeds.short;

  // Resolve unclassified entries (regular feed only) via redirect probe.
  for (const entry of feeds.unclassified) {
    const probed = await probeShorts(entry.videoId);
    if (probed === 'short') {
      shortEntries = shortEntries.concat({ ...entry, source: 'short' });
    } else {
      longEntries = longEntries.concat({ ...entry, source: 'long' });
    }
  }

  if (typeof opts.limitPerFeed === 'number') {
    longEntries = longEntries.slice(0, opts.limitPerFeed);
    shortEntries = shortEntries.slice(0, opts.limitPerFeed);
  }

  let longPublished = 0;
  let shortPublished = 0;
  for (const entry of longEntries) {
    if (await publishVideoEntry(env, ctx, published, entry, 'long')) longPublished++;
  }
  for (const entry of shortEntries) {
    if (await publishVideoEntry(env, ctx, published, entry, 'short')) shortPublished++;
  }
  return { longPublished, shortPublished };
}

async function handleAdminAddChannel(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response('unauthorized', { status: 401 });
  }
  let body: { channelId?: string; addedBy?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  const channelId = body.channelId?.trim();
  if (!channelId || !channelId.startsWith('UC')) {
    return new Response('channelId must be a UC... id', { status: 400 });
  }
  const channels = new ChannelStore(env.CHANNELS);
  const published = new PublishedStore(env.PUBLISHED);

  const result = await processChannel(env, channels, published, channelId, {
    limitPerFeed: getBackfillCount(env),
  });
  const ctx = await channels.get(channelId);
  return new Response(
    JSON.stringify({
      ok: true,
      channelId,
      npub: ctx?.npub,
      published: result,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function runCron(env: Env): Promise<void> {
  const channels = new ChannelStore(env.CHANNELS);
  const published = new PublishedStore(env.PUBLISHED);
  const all = await channels.list();
  for (const ch of all) {
    try {
      const r = await processChannel(env, channels, published, ch.channelId);
      if (r.longPublished > 0 || r.shortPublished > 0) {
        console.log(`channel ${ch.channelId}: +${r.longPublished} long, +${r.shortPublished} short`);
      }
    } catch (err) {
      console.error(`channel ${ch.channelId} failed:`, err);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/admin/channels') {
      return handleAdminAddChannel(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
