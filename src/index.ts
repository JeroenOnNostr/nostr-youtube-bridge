import { deriveChannelKey } from './derive';
import { ChannelStore, EventStore, PublishedStore, type ArchivedEvent, type ChannelRecord, type PublishedRecord } from './kv';
import {
  buildFollowPackEvent,
  buildKind0,
  buildVideoEvent,
  kind0Hash,
  publishToRelays,
  signEvent,
  type ChannelMetadata,
  type FollowPackChannel,
  type ShortsKind,
} from './publisher';
import { resolveYouTubeUrl } from './resolve';
import {
  fetchChannelFeeds,
  probeShorts,
  type FeedEntry,
} from './youtube';
import { INDEX_HTML } from './ui';
import { Relay } from 'nostr-tools/relay';

export interface Env {
  CHANNELS: KVNamespace;
  PUBLISHED: KVNamespace;
  EVENTS: KVNamespace;
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

function isAuthorized(req: Request, env: Env): boolean {
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
  channels: ChannelStore,
  archive: EventStore,
  ctx: ChannelContext,
  meta: ChannelMetadata,
  relayUrls: string[],
): Promise<void> {
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
    kind0PublishedAt: Math.floor(Date.now() / 1000),
    kind0Hash: newHash,
  };
  await channels.put(updated);
  ctx.record = updated;
}

async function publishVideoEntry(
  ctx: ChannelContext,
  published: PublishedStore,
  archive: EventStore,
  entry: FeedEntry,
  classification: 'long' | 'short',
  shortsKind: ShortsKind,
  relayUrls: string[],
): Promise<boolean> {
  if (await published.has(entry.videoId)) return false;
  const tmpl = buildVideoEvent({ entry, classification, shortsKind });
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

interface ProcessOptions {
  limitPerFeed?: number;
  videoIdFilter?: Set<string>;
  shortsKindOverride?: ShortsKind;
  relayUrlsOverride?: string[];
}

async function processChannel(
  env: Env,
  channels: ChannelStore,
  published: PublishedStore,
  archive: EventStore,
  channelId: string,
  opts: ProcessOptions = {},
): Promise<{ longPublished: number; shortPublished: number }> {
  const ctx = await ensureChannel(env, channels, channelId);
  const feeds = await fetchChannelFeeds(channelId);
  const relays = opts.relayUrlsOverride ?? getRelayUrls(env);
  const shortsKind = opts.shortsKindOverride ?? getShortsKind(env);

  if (feeds.channelInfo) {
    const meta: ChannelMetadata = {
      id: feeds.channelInfo.id,
      title: feeds.channelInfo.title || feeds.channelInfo.authorName || channelId,
      url: feeds.channelInfo.url,
    };
    await maybePublishKind0(channels, archive, ctx, meta, relays);
  }

  let longEntries = feeds.long;
  let shortEntries = feeds.short;

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

  if (opts.videoIdFilter) {
    longEntries = longEntries.filter((e) => opts.videoIdFilter!.has(e.videoId));
    shortEntries = shortEntries.filter((e) => opts.videoIdFilter!.has(e.videoId));
  }

  let longPublished = 0;
  let shortPublished = 0;
  for (const entry of longEntries) {
    if (await publishVideoEntry(ctx, published, archive, entry, 'long', shortsKind, relays)) longPublished++;
  }
  for (const entry of shortEntries) {
    if (await publishVideoEntry(ctx, published, archive, entry, 'short', shortsKind, relays)) shortPublished++;
  }
  return { longPublished, shortPublished };
}

interface PreviewEntry {
  videoId: string;
  title: string;
  classification: 'long' | 'short';
  kind: number;
  publishedAtUnix: number;
  watchUrl: string;
  thumbnailUrl: string;
  alreadyPublished: boolean;
}

async function buildPreview(
  env: Env,
  published: PublishedStore,
  channelId: string,
  shortsKind: ShortsKind,
  limit?: number,
): Promise<{
  channelId: string;
  channelTitle?: string;
  channelUrl?: string;
  longEntries: PreviewEntry[];
  shortEntries: PreviewEntry[];
}> {
  const feeds = await fetchChannelFeeds(channelId);
  let longEntries = feeds.long;
  let shortEntries = feeds.short;
  for (const entry of feeds.unclassified) {
    const probed = await probeShorts(entry.videoId);
    if (probed === 'short') shortEntries = shortEntries.concat({ ...entry, source: 'short' });
    else longEntries = longEntries.concat({ ...entry, source: 'long' });
  }
  if (typeof limit === 'number') {
    longEntries = longEntries.slice(0, limit);
    shortEntries = shortEntries.slice(0, limit);
  }
  const toPreview = async (entry: FeedEntry, classification: 'long' | 'short'): Promise<PreviewEntry> => ({
    videoId: entry.videoId,
    title: entry.title,
    classification,
    kind: classification === 'long' ? 21 : shortsKind,
    publishedAtUnix: entry.publishedAtUnix,
    watchUrl: entry.watchUrl,
    thumbnailUrl: entry.thumbnailUrl,
    alreadyPublished: await published.has(entry.videoId),
  });
  return {
    channelId,
    channelTitle: feeds.channelInfo?.title,
    channelUrl: feeds.channelInfo?.url,
    longEntries: await Promise.all(longEntries.map((e) => toPreview(e, 'long'))),
    shortEntries: await Promise.all(shortEntries.map((e) => toPreview(e, 'short'))),
  };
}

async function aggregatePublishedCounts(
  published: PublishedStore,
  channelIds: string[],
): Promise<Map<string, { long: number; short: number; lastPublishedAt?: number }>> {
  const out = new Map<string, { long: number; short: number; lastPublishedAt?: number }>();
  for (const id of channelIds) {
    const recs = await published.listByChannel(id, 200);
    let long = 0;
    let short = 0;
    let lastPublishedAt: number | undefined;
    for (const r of recs) {
      if (r.kind === 21) long++;
      else short++;
      if (!lastPublishedAt || r.publishedAt > lastPublishedAt) lastPublishedAt = r.publishedAt;
    }
    out.set(id, { long, short, lastPublishedAt });
  }
  return out;
}

// ─── route handlers ──────────────────────────────────────────────────────

async function handleAdminAddChannel(req: Request, env: Env): Promise<Response> {
  let body: { channelId?: string };
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
  const archive = new EventStore(env.EVENTS);

  const result = await processChannel(env, channels, published, archive, channelId, {
    limitPerFeed: getBackfillCount(env),
  });
  const ctx = await channels.get(channelId);
  return jsonResponse({ ok: true, channelId, npub: ctx?.npub, published: result });
}

async function handleAdminListChannels(env: Env): Promise<Response> {
  const channels = new ChannelStore(env.CHANNELS);
  const published = new PublishedStore(env.PUBLISHED);
  const all = await channels.list();
  const counts = await aggregatePublishedCounts(published, all.map((c) => c.channelId));
  const enriched = all.map((c) => ({
    ...c,
    counts: counts.get(c.channelId) ?? { long: 0, short: 0 },
  }));
  enriched.sort((a, b) => b.addedAt - a.addedAt);
  return jsonResponse({ channels: enriched });
}

async function handleAdminDeleteChannel(channelId: string, env: Env): Promise<Response> {
  if (!channelId.startsWith('UC')) {
    return new Response('channelId must be a UC... id', { status: 400 });
  }
  const channels = new ChannelStore(env.CHANNELS);
  await channels.delete(channelId);
  return jsonResponse({ ok: true });
}

async function handleAdminChannelVideos(channelId: string, env: Env): Promise<Response> {
  if (!channelId.startsWith('UC')) {
    return new Response('channelId must be a UC... id', { status: 400 });
  }
  const published = new PublishedStore(env.PUBLISHED);
  const recs: PublishedRecord[] = await published.listByChannel(channelId, 100);
  return jsonResponse({ channelId, videos: recs });
}

async function handleAdminResolve(req: Request): Promise<Response> {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  if (!body.url) return new Response('url required', { status: 400 });
  const resolved = await resolveYouTubeUrl(body.url);
  if (!resolved) return jsonResponse({ ok: false, error: 'could not resolve' }, 404);
  return jsonResponse({ ok: true, ...resolved });
}

async function handleAdminPreview(req: Request, env: Env): Promise<Response> {
  let body: { channelId?: string; shortsKind?: number; limit?: number };
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  const channelId = body.channelId?.trim();
  if (!channelId || !channelId.startsWith('UC')) {
    return new Response('channelId must be a UC... id', { status: 400 });
  }
  const shortsKind: ShortsKind = body.shortsKind === 34236 ? 34236 : 22;
  const published = new PublishedStore(env.PUBLISHED);
  const preview = await buildPreview(env, published, channelId, shortsKind, body.limit);
  return jsonResponse(preview);
}

async function handleAdminPublish(req: Request, env: Env): Promise<Response> {
  let body: {
    channelId?: string;
    shortsKind?: number;
    relayUrls?: string[];
    limit?: number;
    videoIds?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  const channelId = body.channelId?.trim();
  if (!channelId || !channelId.startsWith('UC')) {
    return new Response('channelId must be a UC... id', { status: 400 });
  }
  const opts: ProcessOptions = {};
  if (body.shortsKind === 22 || body.shortsKind === 34236) opts.shortsKindOverride = body.shortsKind;
  if (Array.isArray(body.relayUrls) && body.relayUrls.length > 0) {
    opts.relayUrlsOverride = body.relayUrls.map(String).filter(Boolean);
  }
  if (typeof body.limit === 'number') opts.limitPerFeed = body.limit;
  if (Array.isArray(body.videoIds) && body.videoIds.length > 0) {
    opts.videoIdFilter = new Set(body.videoIds.map(String));
  }
  const channels = new ChannelStore(env.CHANNELS);
  const published = new PublishedStore(env.PUBLISHED);
  const archive = new EventStore(env.EVENTS);
  const result = await processChannel(env, channels, published, archive, channelId, opts);
  return jsonResponse({ ok: true, channelId, published: result });
}

async function handleAdminFollowPackBuild(req: Request, env: Env): Promise<Response> {
  let body: {
    channelIds?: string[];
    name?: string;
    description?: string;
    dTag?: string;
    defaultRelay?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  const ids = (body.channelIds ?? []).filter((s) => typeof s === 'string' && s.startsWith('UC'));
  if (ids.length === 0) return new Response('channelIds required', { status: 400 });
  if (!body.name) return new Response('name required', { status: 400 });
  if (!body.dTag) return new Response('dTag required', { status: 400 });
  const channels = new ChannelStore(env.CHANNELS);
  const looked: FollowPackChannel[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const rec = await channels.get(id);
    if (!rec) {
      missing.push(id);
      continue;
    }
    looked.push({ pubkeyHex: rec.pubkeyHex, channelId: id });
  }
  if (looked.length === 0) {
    return jsonResponse({ ok: false, error: 'no known channels', missing }, 404);
  }
  const tmpl = buildFollowPackEvent({
    channels: looked,
    name: body.name,
    description: body.description,
    dTag: body.dTag,
    defaultRelay: body.defaultRelay,
  });
  return jsonResponse({ ok: true, event: tmpl, included: looked.map((c) => c.channelId), missing });
}

async function handleAdminFollowPackPublish(req: Request, env: Env): Promise<Response> {
  let body: { event?: unknown; relayUrls?: string[] };
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  const ev = body.event as { id?: string; sig?: string; pubkey?: string; kind?: number } | undefined;
  if (!ev || typeof ev !== 'object' || !ev.id || !ev.sig || !ev.pubkey || ev.kind !== 39089) {
    return new Response('invalid signed event', { status: 400 });
  }
  const relays =
    Array.isArray(body.relayUrls) && body.relayUrls.length > 0
      ? body.relayUrls.map(String).filter(Boolean)
      : getRelayUrls(env);
  const accepted = await publishToRelays(ev as never, relays);
  if (accepted > 0) {
    const archive = new EventStore(env.EVENTS);
    await archive.put(ev as ArchivedEvent);
  }
  return jsonResponse({ ok: true, accepted, relays });
}

interface RepublishOpts {
  relays: string[];
  channelId?: string;
  since?: number;
  kinds?: Set<number>;
  limit: number;
}

interface RepublishResult {
  relays: string[];
  scanned: number;
  attempted: number;
  acceptedAtLeastOnce: number;
  perRelay: Record<string, number>;
  lastCreatedAt?: number;
  truncated: boolean;
}

/**
 * Replay archived events to a set of relays. Connections are opened once and
 * kept open across all events for throughput; each event waits for all relays
 * to either OK/REJECT (or timeout) before moving on, so the perRelay counts
 * are accurate for the batch we attempted.
 */
async function republishFromArchive(env: Env, opts: RepublishOpts): Promise<RepublishResult> {
  const archive = new EventStore(env.EVENTS);

  // Open all relay connections up front; tolerate failures (we'll just count
  // 0 acceptances against any relay we couldn't reach).
  const conns = await Promise.all(
    opts.relays.map(async (url) => {
      try {
        const r = await Relay.connect(url);
        return { url, relay: r as Relay | null };
      } catch {
        return { url, relay: null };
      }
    }),
  );

  const perRelayAccepted: Record<string, number> = Object.fromEntries(opts.relays.map((r) => [r, 0]));
  let scanned = 0;
  let attempted = 0;
  let acceptedAtLeastOnce = 0;
  let lastCreatedAt: number | undefined;
  let truncated = false;

  try {
    for await (const ev of archive.scan({ channelId: opts.channelId, since: opts.since })) {
      scanned++;
      if (opts.kinds && !opts.kinds.has(ev.kind)) continue;
      if (attempted >= opts.limit) {
        truncated = true;
        break;
      }
      attempted++;
      lastCreatedAt = ev.created_at;
      const settled = await Promise.allSettled(
        conns.map(async (c) => {
          if (!c.relay) throw new Error('no connection');
          await c.relay.publish(ev);
          return c.url;
        }),
      );
      let anyOk = false;
      settled.forEach((res, i) => {
        if (res.status === 'fulfilled') {
          const url = conns[i]!.url;
          perRelayAccepted[url] = (perRelayAccepted[url] ?? 0) + 1;
          anyOk = true;
        }
      });
      if (anyOk) acceptedAtLeastOnce++;
    }
  } finally {
    for (const c of conns) {
      try { c.relay?.close(); } catch { /* ignore */ }
    }
  }

  return {
    relays: opts.relays,
    scanned,
    attempted,
    acceptedAtLeastOnce,
    perRelay: perRelayAccepted,
    lastCreatedAt,
    truncated,
  };
}

async function handleAdminArchiveStats(env: Env): Promise<Response> {
  const archive = new EventStore(env.EVENTS);
  const stats = await archive.stats();
  return jsonResponse({ ok: true, ...stats });
}

async function handleAdminRepublish(req: Request, env: Env): Promise<Response> {
  let body: {
    relayUrls?: string[];
    channelId?: string;
    sinceUnix?: number;
    kinds?: number[];
    limit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  const relays =
    Array.isArray(body.relayUrls) && body.relayUrls.length > 0
      ? body.relayUrls.map(String).filter(Boolean)
      : getRelayUrls(env);
  if (relays.length === 0) {
    return new Response('no relayUrls', { status: 400 });
  }
  const channelId = typeof body.channelId === 'string' && body.channelId.startsWith('UC') ? body.channelId : undefined;
  const since = typeof body.sinceUnix === 'number' ? body.sinceUnix : undefined;
  const kinds = Array.isArray(body.kinds)
    ? new Set(body.kinds.filter((k): k is number => typeof k === 'number'))
    : undefined;
  const limit = typeof body.limit === 'number' && body.limit > 0 ? Math.min(body.limit, 5000) : 5000;

  const result = await republishFromArchive(env, { relays, channelId, since, kinds, limit });
  return jsonResponse({ ok: true, ...result });
}

async function runCron(env: Env): Promise<void> {
  const channels = new ChannelStore(env.CHANNELS);
  const published = new PublishedStore(env.PUBLISHED);
  const archive = new EventStore(env.EVENTS);
  const all = await channels.list();
  for (const ch of all) {
    try {
      const r = await processChannel(env, channels, published, archive, ch.channelId);
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
    const m = request.method;

    if (m === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }
    if (m === 'GET' && url.pathname === '/') {
      return new Response(INDEX_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (m === 'GET' && url.pathname === '/admin/config') {
      // Public-ish: returns default relay list and default shorts kind so
      // the dashboard can pre-fill its forms before the user logs in.
      return jsonResponse({
        defaultRelays: getRelayUrls(env),
        defaultShortsKind: getShortsKind(env),
      });
    }

    if (url.pathname.startsWith('/admin/')) {
      if (!isAuthorized(request, env)) return new Response('unauthorized', { status: 401 });

      if (m === 'POST' && url.pathname === '/admin/channels') return handleAdminAddChannel(request, env);
      if (m === 'GET' && url.pathname === '/admin/channels') return handleAdminListChannels(env);

      const chMatch = url.pathname.match(/^\/admin\/channels\/(UC[\w-]{22})$/);
      if (chMatch && m === 'DELETE') return handleAdminDeleteChannel(chMatch[1]!, env);

      const vidsMatch = url.pathname.match(/^\/admin\/channels\/(UC[\w-]{22})\/videos$/);
      if (vidsMatch && m === 'GET') return handleAdminChannelVideos(vidsMatch[1]!, env);

      if (m === 'POST' && url.pathname === '/admin/resolve') return handleAdminResolve(request);
      if (m === 'POST' && url.pathname === '/admin/preview') return handleAdminPreview(request, env);
      if (m === 'POST' && url.pathname === '/admin/publish') return handleAdminPublish(request, env);
      if (m === 'POST' && url.pathname === '/admin/follow-pack/build')
        return handleAdminFollowPackBuild(request, env);
      if (m === 'POST' && url.pathname === '/admin/follow-pack/publish')
        return handleAdminFollowPackPublish(request, env);

      if (m === 'GET' && url.pathname === '/admin/archive/stats') return handleAdminArchiveStats(env);
      if (m === 'POST' && url.pathname === '/admin/archive/republish') return handleAdminRepublish(request, env);
    }

    return new Response('not found', { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
