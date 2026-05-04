import { deriveChannelKey } from './derive';
import { BackfillRunStore, ChannelStore, EventStore, InnertubeContextStore, PublishedStore, type ArchivedEvent, type BackfillRun, type ChannelRecord, type PublishedRecord } from './kv';
import { enumerateChannelTab, getInnertubeContext, type InnertubeEntry } from './innertube';
import {
  buildFollowPackEvent,
  buildKind0,
  buildVideoEvent,
  kind0Hash,
  publishToRelays,
  RelayPool,
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
    title: meta.title,
    url: meta.url,
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

async function publishVideoEntryPooled(
  ctx: ChannelContext,
  published: PublishedStore,
  archive: EventStore,
  entry: FeedEntry,
  classification: 'long' | 'short',
  shortsKind: ShortsKind,
  pool: RelayPool,
  approximate: boolean,
): Promise<boolean> {
  if (await published.has(entry.videoId)) return false;
  const tmpl = buildVideoEvent({ entry, classification, shortsKind, approximate });
  const signed = signEvent(tmpl, ctx.sk);
  const accepted = await pool.publish(signed);
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
    if (ctx.record.title !== meta.title || ctx.record.url !== meta.url) {
      const updated: ChannelRecord = { ...ctx.record, title: meta.title, url: meta.url };
      await channels.put(updated);
      ctx.record = updated;
    }
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

async function handleAdminReindex(req: Request, env: Env): Promise<Response> {
  let body: { channelId?: string } = {};
  try {
    body = await req.json();
  } catch { /* empty body is ok */ }
  const published = new PublishedStore(env.PUBLISHED);
  const r = await published.reindexChannel(body.channelId);
  return jsonResponse({ ok: true, ...r });
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

/**
 * Convert an InnerTube entry to a FeedEntry shape so it can flow through the
 * existing publishVideoEntry path. Description is empty (InnerTube doesn't
 * expose it from the channel-tab response); thumbnail uses the standard
 * /vi/<id>/hqdefault pattern.
 */
function feedEntryFromInnertube(ie: InnertubeEntry, channelId: string): FeedEntry {
  return {
    videoId: ie.videoId,
    channelId,
    channelTitle: '',
    channelUrl: `https://www.youtube.com/channel/${channelId}`,
    authorName: '',
    title: ie.title,
    description: '',
    publishedAtUnix: ie.publishedAtApproxUnix,
    watchUrl: `https://www.youtube.com/watch?v=${ie.videoId}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${ie.videoId}/hqdefault.jpg`,
    source: 'unknown',
  };
}

/**
 * Generate a runId. Sortable by time (lexicographically) so dashboards
 * scanning runs see newest-first when prefix-listed if we ever add that.
 */
function newRunId(): string {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${now}-${rand}`;
}

/**
 * Background worker: walk the channel and publish, updating the run record
 * in KV as we go. Lives behind ctx.waitUntil so the HTTP response returns
 * immediately. Robust to any single-event failure — keeps going.
 */
async function runBackfill(env: Env, runId: string, channelId: string, maxEntries: number): Promise<void> {
  const channels = new ChannelStore(env.CHANNELS);
  const published = new PublishedStore(env.PUBLISHED);
  const archive = new EventStore(env.EVENTS);
  const itStore = new InnertubeContextStore(env.CHANNELS);
  const runs = new BackfillRunStore(env.CHANNELS);

  // Snapshot helper: read current run from local state and persist. We avoid
  // re-reading from KV between writes because the only writer for this runId
  // is this function.
  const run: BackfillRun = {
    runId,
    channelId,
    startedAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    status: 'running',
    phase: 'starting',
    longSeen: 0,
    shortSeen: 0,
    longPublished: 0,
    shortPublished: 0,
    alreadyPublished: 0,
    errors: 0,
  };
  const persist = async () => {
    run.updatedAt = Math.floor(Date.now() / 1000);
    await runs.put(run);
  };
  await persist();

  // Channel must exist; otherwise we have no derived nsec to sign with.
  const existing = await channels.get(channelId);
  if (!existing) {
    run.status = 'aborted';
    run.abortReason = 'channel not in CHANNELS — add it first via the regular add flow';
    await persist();
    return;
  }
  const channelCtx: ChannelContext = {
    record: existing,
    sk: deriveChannelKey(env.BRIDGE_MASTER_SEED, channelId).sk,
  };

  let itCtx;
  try {
    itCtx = await getInnertubeContext(itStore);
  } catch (err) {
    run.status = 'aborted';
    run.abortReason = 'innertube bootstrap failed: ' + String(err);
    await persist();
    return;
  }

  const relays = getRelayUrls(env);
  const shortsKind = getShortsKind(env);
  const pool = new RelayPool(relays);

  // Persist every Nth event instead of every event — KV writes are ~10-30ms
  // each and the toast only refreshes every 2s, so per-event persists were
  // pure overhead. Phase transitions and terminal states still flush.
  const PERSIST_EVERY = 5;
  let sinceLastPersist = 0;
  const tick = async () => {
    sinceLastPersist++;
    if (sinceLastPersist >= PERSIST_EVERY) {
      sinceLastPersist = 0;
      await persist();
    }
  };
  const flush = async () => {
    sinceLastPersist = 0;
    await persist();
  };

  try {
    // ─── walk Videos tab ────────────────────────────────────────────────
    run.phase = 'innertube-videos';
    await flush();
    let longEntries: InnertubeEntry[] = [];
    try {
      longEntries = await enumerateChannelTab(itCtx, channelId, 'videos', { maxEntries });
      run.longSeen = longEntries.length;
      await flush();
    } catch (err) {
      run.status = 'aborted';
      run.abortReason = 'videos tab enumeration: ' + String(err);
      await flush();
      return;
    }

    run.phase = 'publishing-videos';
    await flush();
    for (const ie of longEntries) {
      try {
        if (await published.has(ie.videoId)) {
          run.alreadyPublished++;
        } else {
          const fe = feedEntryFromInnertube(ie, channelId);
          const ok = await publishVideoEntryPooled(channelCtx, published, archive, fe, 'long', shortsKind, pool, true);
          if (ok) {
            run.longPublished++;
            run.lastVideoId = ie.videoId;
            run.lastVideoTitle = ie.title;
          } else {
            run.errors++;
          }
        }
      } catch (err) {
        run.errors++;
        console.warn(`backfill long ${ie.videoId} failed:`, err);
      }
      await tick();
    }
    await flush();

    // ─── walk Shorts tab ────────────────────────────────────────────────
    run.phase = 'innertube-shorts';
    await flush();
    let shortEntries: InnertubeEntry[] = [];
    try {
      shortEntries = await enumerateChannelTab(itCtx, channelId, 'shorts', { maxEntries });
      run.shortSeen = shortEntries.length;
      await flush();
    } catch (err) {
      run.status = 'aborted';
      run.abortReason = 'shorts tab enumeration: ' + String(err);
      await flush();
      return;
    }

    run.phase = 'publishing-shorts';
    await flush();
    for (const ie of shortEntries) {
      try {
        if (await published.has(ie.videoId)) {
          run.alreadyPublished++;
        } else {
          const fe = feedEntryFromInnertube(ie, channelId);
          const ok = await publishVideoEntryPooled(channelCtx, published, archive, fe, 'short', shortsKind, pool, true);
          if (ok) {
            run.shortPublished++;
            run.lastVideoId = ie.videoId;
            run.lastVideoTitle = ie.title;
          } else {
            run.errors++;
          }
        }
      } catch (err) {
        run.errors++;
        console.warn(`backfill short ${ie.videoId} failed:`, err);
      }
      await tick();
    }
    await flush();

    run.phase = 'done';
    run.status = 'done';
    await flush();
  } finally {
    pool.close();
  }
}

/**
 * POST /admin/channels/:id/backfill — kick off a background backfill.
 * Returns {runId} immediately; client polls GET /admin/backfill/:runId.
 */
async function handleAdminBackfillChannel(
  channelId: string,
  req: Request,
  env: Env,
  exCtx: ExecutionContext,
): Promise<Response> {
  if (!channelId.startsWith('UC')) {
    return new Response('channelId must be a UC... id', { status: 400 });
  }
  let body: { maxEntries?: number } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }
  const maxEntries = typeof body.maxEntries === 'number' && body.maxEntries > 0
    ? Math.min(body.maxEntries, 10_000)
    : 10_000;

  // Sanity: channel must exist before we kick off background work.
  const channels = new ChannelStore(env.CHANNELS);
  const existing = await channels.get(channelId);
  if (!existing) {
    return jsonResponse({ ok: false, error: 'channel not in CHANNELS — add it first via the regular add flow' }, 404);
  }

  const runId = newRunId();
  // Kick off the background work; the Worker stays alive until the promise
  // resolves. ctx.waitUntil is what makes a Worker "hold itself open" past
  // the HTTP response.
  exCtx.waitUntil(runBackfill(env, runId, channelId, maxEntries));
  return jsonResponse({ ok: true, runId, channelId });
}

/**
 * GET /admin/backfill/:runId — poll a backfill's progress.
 */
async function handleAdminBackfillStatus(runId: string, env: Env): Promise<Response> {
  const runs = new BackfillRunStore(env.CHANNELS);
  const run = await runs.get(runId);
  if (!run) return jsonResponse({ ok: false, error: 'run not found (24h TTL)' }, 404);
  return jsonResponse({ ok: true, run });
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
  async fetch(request: Request, env: Env, exCtx: ExecutionContext): Promise<Response> {
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

      const backfillMatch = url.pathname.match(/^\/admin\/channels\/(UC[\w-]{22})\/backfill$/);
      if (backfillMatch && m === 'POST') return handleAdminBackfillChannel(backfillMatch[1]!, request, env, exCtx);

      const backfillStatusMatch = url.pathname.match(/^\/admin\/backfill\/([A-Za-z0-9-]+)$/);
      if (backfillStatusMatch && m === 'GET') return handleAdminBackfillStatus(backfillStatusMatch[1]!, env);

      if (m === 'POST' && url.pathname === '/admin/resolve') return handleAdminResolve(request);
      if (m === 'POST' && url.pathname === '/admin/preview') return handleAdminPreview(request, env);
      if (m === 'POST' && url.pathname === '/admin/publish') return handleAdminPublish(request, env);
      if (m === 'POST' && url.pathname === '/admin/follow-pack/build')
        return handleAdminFollowPackBuild(request, env);
      if (m === 'POST' && url.pathname === '/admin/follow-pack/publish')
        return handleAdminFollowPackPublish(request, env);

      if (m === 'GET' && url.pathname === '/admin/archive/stats') return handleAdminArchiveStats(env);
      if (m === 'POST' && url.pathname === '/admin/archive/republish') return handleAdminRepublish(request, env);
      if (m === 'POST' && url.pathname === '/admin/reindex') return handleAdminReindex(request, env);
    }

    return new Response('not found', { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
