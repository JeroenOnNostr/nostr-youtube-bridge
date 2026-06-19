import { deriveChannelKey, deriveServiceKey } from './derive';
import { BackfillEntriesStore, BackfillRunStore, ChannelStore, EventStore, InnertubeContextStore, PublishedStore, type ArchivedEvent, type BackfillRun, type ChannelRecord, type PublishedRecord } from './kv';
import { isRawYouTubeAvatarUrl } from './imageHost';
import { enumerateChannelTab, getInnertubeContext, type InnertubeEntry } from './innertube';
import {
  buildDvmHandlerEvent,
  buildFollowPackEvent,
  buildVideoEvent,
  publishToRelaysDetailed,
  RelayPool,
  signEvent,
  type ChannelMetadata,
  type FollowPackChannel,
  type ShortsKind,
} from './publisher';
import {
  ensureChannel,
  getBackfillCount,
  getRelayUrls,
  getShortsKind,
  maybePublishKind0,
  publishVideoEntry,
  refreshChannelAvatar,
  type ChannelContext,
  type Env,
} from './channel';
import { resolveYouTubeUrl } from './resolve';
import {
  fetchChannelFeeds,
  probeShorts,
  type FeedEntry,
} from './youtube';
import { INDEX_HTML } from './ui';
import { Relay } from 'nostr-tools/relay';
import { nip19 } from 'nostr-tools';
import { JOB_SEARCH, JOB_WATCH, YouTubeDvm } from './dvm';

export { YouTubeDvm };
export type { Env };

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
    const pictureUrl = await refreshChannelAvatar(env, channels, ctx, channelId);

    const meta: ChannelMetadata = {
      id: feeds.channelInfo.id,
      title: feeds.channelInfo.title || feeds.channelInfo.authorName || channelId,
      url: feeds.channelInfo.url,
      pictureUrl,
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

interface OverviewEntry {
  videoId: string;
  title: string;
  classification: 'long' | 'short';
  kind: number;
  publishedAtUnix: number;
  watchUrl: string;
  thumbnailUrl: string;
}

/**
 * Build a read-only overview of every Nostr event the bridge has published for
 * a channel. Sourced from KV (no YouTube fetches): listByChannel for the index,
 * EventStore for tags. Title/thumbnail/watchUrl come from the archived event's
 * NIP-71 tags so the view shows what was actually published, not what RSS
 * currently exposes.
 */
async function buildOverview(
  published: PublishedStore,
  archive: EventStore,
  channels: ChannelStore,
  channelId: string,
): Promise<{
  channelId: string;
  channelTitle?: string;
  channelUrl?: string;
  entries: OverviewEntry[];
}> {
  const channelRec = await channels.get(channelId);
  const recs = await published.listByChannel(channelId, 1000);
  const entries = await Promise.all(recs.map(async (r): Promise<OverviewEntry> => {
    const ev = await archive.get(r.eventId);
    let title = '';
    let thumbnailUrl = `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`;
    let watchUrl = `https://www.youtube.com/watch?v=${r.videoId}`;
    if (ev) {
      for (const tag of ev.tags) {
        if (tag[0] === 'title' && tag[1]) title = tag[1];
        else if (tag[0] === 'r' && tag[1]) watchUrl = tag[1];
        else if (tag[0] === 'imeta') {
          for (const part of tag.slice(1)) {
            if (part.startsWith('image ')) thumbnailUrl = part.slice(6);
          }
        }
      }
    }
    const classification: 'long' | 'short' = r.kind === 21 ? 'long' : 'short';
    return {
      videoId: r.videoId,
      title: title || r.videoId,
      classification,
      kind: r.kind,
      publishedAtUnix: r.publishedAt,
      watchUrl,
      thumbnailUrl,
    };
  }));
  return {
    channelId,
    channelTitle: channelRec?.title,
    channelUrl: channelRec?.url,
    entries,
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

async function handleAdminOverview(req: Request, env: Env): Promise<Response> {
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
  const published = new PublishedStore(env.PUBLISHED);
  const archive = new EventStore(env.EVENTS);
  const channels = new ChannelStore(env.CHANNELS);
  const overview = await buildOverview(published, archive, channels, channelId);
  return jsonResponse(overview);
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
  const results = await publishToRelaysDetailed(ev as never, relays);
  const accepted = results.filter((r) => r.ok).length;
  if (accepted > 0) {
    const archive = new EventStore(env.EVENTS);
    await archive.put(ev as ArchivedEvent);
  }
  return jsonResponse({ ok: true, accepted, relays, results });
}

async function handleAdminFollowPackList(env: Env): Promise<Response> {
  const archive = new EventStore(env.EVENTS);
  const channels = new ChannelStore(env.CHANNELS);

  const channelList = await channels.list();
  const byPubkey = new Map<string, { channelId: string; title?: string; url?: string }>();
  for (const c of channelList) {
    byPubkey.set(c.pubkeyHex, { channelId: c.channelId, title: c.title, url: c.url });
  }

  // Dedupe addressable kind:39089 events by (pubkey, d-tag), keeping newest.
  const newest = new Map<string, ArchivedEvent>();
  for await (const ev of archive.scan({})) {
    if (ev.kind !== 39089) continue;
    const dTag = ev.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    const key = `${ev.pubkey}:${dTag}`;
    const prev = newest.get(key);
    if (!prev || ev.created_at > prev.created_at) newest.set(key, ev);
  }

  const packs = Array.from(newest.values())
    .sort((a, b) => b.created_at - a.created_at)
    .map((ev) => {
      const dTag = ev.tags.find((t) => t[0] === 'd')?.[1] ?? '';
      const title = ev.tags.find((t) => t[0] === 'title')?.[1] ?? '';
      const description = ev.tags.find((t) => t[0] === 'description')?.[1] ?? '';
      const pTags = ev.tags.filter((t) => t[0] === 'p');
      const channels = pTags.map((t) => {
        const pubkey = t[1] ?? '';
        const known = byPubkey.get(pubkey);
        return {
          pubkey,
          relayHint: t[2] || undefined,
          petname: t[3] || undefined,
          channelId: known?.channelId,
          channelTitle: known?.title,
          channelUrl: known?.url,
        };
      });
      return {
        id: ev.id,
        pubkey: ev.pubkey,
        created_at: ev.created_at,
        dTag,
        title,
        description,
        channels,
      };
    });

  return jsonResponse({ ok: true, packs });
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

// ─── Backfill: chunked, resumable across Worker invocations ─────────────
//
// Cloudflare caps each invocation at ~30s CPU. Signing nostr events is CPU-
// heavy, so a single channel of ~120+ videos exhausts the budget mid-walk —
// previously the worker was hard-killed and the run record was left as
// `status: running` forever. Now the run is split into chunks: each chunk
// publishes events until BACKFILL_BUDGET_MS, persists progress + cursor,
// then self-triggers the next chunk via fetch() to /admin/backfill/:runId/resume.
// Cloudflare treats that as a fresh invocation with a fresh CPU budget.

/** Wall-clock budget per chunk. Aggressive; the hard CPU cap is ~30s. */
const BACKFILL_BUDGET_MS = 25_000;
/** Max self-resume hops per run. With ~120 publishes per chunk that's a
 *  ceiling of ~12,000 events — comfortably above the 10,000 maxEntries cap. */
const MAX_RESUME_CHAIN = 100;
/** How often to persist the run record during the publish loop. */
const PERSIST_EVERY = 5;

/**
 * Run a single backfill chunk. Initializes the run on first invocation
 * (enumerates InnerTube, persists entries), or picks up from `cursor` on
 * resume. Returns when the chunk has either: completed the whole run,
 * exhausted the wall-time budget, or aborted on a fatal error.
 */
async function runBackfillChunk(env: Env, runId: string): Promise<void> {
  const invocationStart = Date.now();
  const channels = new ChannelStore(env.CHANNELS);
  const published = new PublishedStore(env.PUBLISHED);
  const archive = new EventStore(env.EVENTS);
  const runs = new BackfillRunStore(env.CHANNELS);
  const entriesStore = new BackfillEntriesStore(env.CHANNELS);

  const run = await runs.get(runId);
  if (!run) {
    console.warn(`backfill chunk for ${runId}: run record missing (TTL expired or never created)`);
    return;
  }
  if (run.status !== 'running') {
    // Already done or aborted; another chunk got here first or the watchdog
    // gave up on us. Either way: do nothing.
    return;
  }
  if (run.resumeChain >= MAX_RESUME_CHAIN) {
    run.status = 'aborted';
    run.abortReason = `hit MAX_RESUME_CHAIN (${MAX_RESUME_CHAIN}) — channel too large or stuck looping`;
    run.updatedAt = Math.floor(Date.now() / 1000);
    await runs.put(run);
    return;
  }

  const persist = async () => {
    run.updatedAt = Math.floor(Date.now() / 1000);
    await runs.put(run);
  };
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

  const overBudget = () => Date.now() - invocationStart >= BACKFILL_BUDGET_MS;

  // Channel and signing key are needed for the publishing phases.
  const existing = await channels.get(run.channelId);
  if (!existing) {
    run.status = 'aborted';
    run.abortReason = 'channel not in CHANNELS — add it first via the regular add flow';
    await flush();
    return;
  }
  const channelCtx: ChannelContext = {
    record: existing,
    sk: deriveChannelKey(env.BRIDGE_MASTER_SEED, run.channelId).sk,
  };
  const shortsKind = getShortsKind(env);
  const pool = new RelayPool(getRelayUrls(env));

  try {
    // ─── First-chunk-only: enumerate both tabs and persist entry lists ──
    let entries = await entriesStore.get(runId);
    if (!entries) {
      const itStore = new InnertubeContextStore(env.CHANNELS);
      let itCtx;
      try {
        itCtx = await getInnertubeContext(itStore);
      } catch (err) {
        run.status = 'aborted';
        run.abortReason = 'innertube bootstrap failed: ' + String(err);
        await flush();
        return;
      }

      run.phase = 'innertube-videos';
      await flush();
      let longEntries: InnertubeEntry[];
      try {
        longEntries = await enumerateChannelTab(itCtx, run.channelId, 'videos', { maxEntries: run.maxEntries });
      } catch (err) {
        run.status = 'aborted';
        run.abortReason = 'videos tab enumeration: ' + String(err);
        await flush();
        return;
      }
      run.longSeen = longEntries.length;
      await flush();

      run.phase = 'innertube-shorts';
      await flush();
      let shortEntries: InnertubeEntry[];
      try {
        shortEntries = await enumerateChannelTab(itCtx, run.channelId, 'shorts', { maxEntries: run.maxEntries });
      } catch (err) {
        run.status = 'aborted';
        run.abortReason = 'shorts tab enumeration: ' + String(err);
        await flush();
        return;
      }
      run.shortSeen = shortEntries.length;
      await flush();

      entries = { long: longEntries, short: shortEntries };
      await entriesStore.put(runId, entries);

      // Initialize the cursor at the start of the videos tab.
      run.cursor = { tab: 'videos', index: 0 };
      run.phase = 'publishing-videos';
      await flush();
    }

    // ─── Publishing loop, resumable from cursor ─────────────────────────
    if (!run.cursor) run.cursor = { tab: 'videos', index: 0 };

    if (run.cursor.tab === 'videos') {
      run.phase = 'publishing-videos';
      while (run.cursor.index < entries.long.length) {
        if (overBudget()) {
          await flush();
          await scheduleResume(env, run);
          return;
        }
        const ie = entries.long[run.cursor.index]!;
        try {
          if (await published.has(ie.videoId)) {
            run.alreadyPublished++;
          } else {
            const fe = feedEntryFromInnertube(ie, run.channelId);
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
        run.cursor.index++;
        await tick();
      }
      // Videos tab done — advance cursor to shorts.
      run.cursor = { tab: 'shorts', index: 0 };
      run.phase = 'publishing-shorts';
      await flush();
    }

    if (run.cursor.tab === 'shorts') {
      run.phase = 'publishing-shorts';
      while (run.cursor.index < entries.short.length) {
        if (overBudget()) {
          await flush();
          await scheduleResume(env, run);
          return;
        }
        const ie = entries.short[run.cursor.index]!;
        try {
          if (await published.has(ie.videoId)) {
            run.alreadyPublished++;
          } else {
            const fe = feedEntryFromInnertube(ie, run.channelId);
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
        run.cursor.index++;
        await tick();
      }
    }

    // Both tabs walked to completion.
    run.phase = 'done';
    run.status = 'done';
    await flush();
  } finally {
    pool.close();
  }
}

/**
 * Persist the resumeChain bump and fire a fresh request to /admin/backfill/:runId/resume,
 * which Cloudflare schedules as a new invocation with a fresh CPU budget.
 *
 * Note: we don't await the response — the next chunk lives in its own worker.
 * We do await the send so the request reliably leaves before this invocation
 * tears down (a Worker that's exited won't have outbound fetches retried).
 */
async function scheduleResume(env: Env, run: BackfillRun): Promise<void> {
  run.resumeChain++;
  const runs = new BackfillRunStore(env.CHANNELS);
  run.updatedAt = Math.floor(Date.now() / 1000);
  await runs.put(run);

  const url = run.selfOrigin.replace(/\/$/, '') + '/admin/backfill/' + run.runId + '/resume';
  try {
    await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN },
    });
  } catch (err) {
    // If we can't even kick off the next chunk, the watchdog will surface
    // it: stale heartbeat + status still 'running' → aborted on next poll.
    console.warn(`backfill ${run.runId}: resume fetch failed:`, err);
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
  const now = Math.floor(Date.now() / 1000);
  const reqUrl = new URL(req.url);
  const run: BackfillRun = {
    runId,
    channelId,
    startedAt: now,
    updatedAt: now,
    status: 'running',
    phase: 'starting',
    longSeen: 0,
    shortSeen: 0,
    longPublished: 0,
    shortPublished: 0,
    alreadyPublished: 0,
    errors: 0,
    resumeChain: 0,
    maxEntries,
    selfOrigin: reqUrl.origin,
  };
  // Seed the record before kicking off the background task so a fast first
  // poll from the dashboard doesn't see "not found".
  const runs = new BackfillRunStore(env.CHANNELS);
  await runs.put(run);

  // First chunk runs in this invocation via waitUntil; subsequent chunks
  // self-trigger via /admin/backfill/:runId/resume.
  exCtx.waitUntil(runBackfillChunk(env, runId));
  return jsonResponse({ ok: true, runId, channelId });
}

/**
 * POST /admin/backfill/:runId/resume — internal: continue a paused run.
 * Self-triggered by scheduleResume() so each chunk gets a fresh CPU budget.
 */
async function handleAdminBackfillResume(
  runId: string,
  env: Env,
  exCtx: ExecutionContext,
): Promise<Response> {
  exCtx.waitUntil(runBackfillChunk(env, runId));
  return jsonResponse({ ok: true, runId });
}

/**
 * GET /admin/backfill/:runId — poll a backfill's progress.
 *
 * Acts as a watchdog: if a run is still `status: running` but has gone silent
 * for longer than STALE_HEARTBEAT_MS, the resume chain has broken (worker
 * killed mid-chunk before scheduleResume fired, or the resume fetch failed).
 * Flip it to `aborted` so the dashboard stops showing stale progress forever.
 */
const STALE_HEARTBEAT_MS = 90_000;
async function handleAdminBackfillStatus(runId: string, env: Env): Promise<Response> {
  const runs = new BackfillRunStore(env.CHANNELS);
  const run = await runs.get(runId);
  if (!run) return jsonResponse({ ok: false, error: 'run not found (24h TTL)' }, 404);
  if (run.status === 'running' && Date.now() - run.updatedAt * 1000 > STALE_HEARTBEAT_MS) {
    run.status = 'aborted';
    run.abortReason = `worker died — no heartbeat for >${Math.floor(STALE_HEARTBEAT_MS / 1000)}s`;
    run.updatedAt = Math.floor(Date.now() / 1000);
    await runs.put(run);
  }
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

// ─── DVM service wiring ───────────────────────────────────────────────────

/** Single, well-known DO instance name — there is exactly one DVM listener. */
const DVM_INSTANCE_NAME = '__dvm_singleton__';

/** Poke the DVM Durable Object so it (re)opens its relay subscription. Called
 *  from cron so the listener self-heals if the DO was evicted between ticks. */
async function startDvm(env: Env): Promise<void> {
  try {
    const id = env.DVM.idFromName(DVM_INSTANCE_NAME);
    const stub = env.DVM.get(id);
    await stub.fetch('https://dvm.internal/start');
  } catch (err) {
    console.warn('startDvm failed:', err);
  }
}

/**
 * POST /admin/dvm/start — manually (re)start the DVM listener. Cron does this
 * every tick too; this is for a hands-on kick after deploy.
 */
async function handleAdminDvmStart(env: Env): Promise<Response> {
  await startDvm(env);
  return jsonResponse({ ok: true });
}

/**
 * GET /admin/dvm/diag — read the DVM Durable Object's live poll-drain state
 * (stored cursor, relay list, alarm cadence/next-fire, lookback window). Proxies
 * straight through to the DO's /diag so the cursor can be inspected directly.
 */
async function handleAdminDvmDiag(env: Env): Promise<Response> {
  try {
    const id = env.DVM.idFromName(DVM_INSTANCE_NAME);
    const stub = env.DVM.get(id);
    const res = await stub.fetch('https://dvm.internal/diag');
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
}

/**
 * POST /admin/dvm/announce — sign + publish the NIP-89 kind-31990 handler
 * announcement for the DVM service key (advertising kinds 5392 & 5393).
 * Returns the service npub and the addressable naddr so Kubo can reference it.
 */
async function handleAdminDvmAnnounce(req: Request, env: Env): Promise<Response> {
  let body: { name?: string; about?: string; picture?: string; website?: string; relayUrls?: string[]; dTag?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — use defaults */
  }
  const service = deriveServiceKey(env.BRIDGE_MASTER_SEED);
  const dTag = body.dTag?.trim() || 'youtube-bridge-dvm';
  const tmpl = buildDvmHandlerEvent({
    jobKinds: [JOB_SEARCH, JOB_WATCH],
    dTag,
    name: body.name?.trim() || 'YouTube Bridge',
    about:
      body.about?.trim() ||
      'Search YouTube channels and add them to your feed. Bridged uploads are republished as Nostr video events.',
    picture: body.picture?.trim() || undefined,
    website: body.website?.trim() || undefined,
  });
  const signed = signEvent(tmpl, service.sk);
  const relays =
    Array.isArray(body.relayUrls) && body.relayUrls.length > 0
      ? body.relayUrls.map(String).filter(Boolean)
      : getRelayUrls(env);
  const results = await publishToRelaysDetailed(signed, relays);
  const accepted = results.filter((r) => r.ok).length;
  if (accepted > 0) {
    try {
      await new EventStore(env.EVENTS).put(signed as ArchivedEvent);
    } catch {
      /* archive best-effort */
    }
  }
  const naddr = nip19.naddrEncode({ kind: 31990, pubkey: service.pkHex, identifier: dTag, relays: relays.slice(0, 3) });
  return jsonResponse({
    ok: true,
    serviceNpub: service.npub,
    servicePubkey: service.pkHex,
    naddr,
    dTag,
    accepted,
    relays,
    event: signed,
  });
}

/**
 * Detect channels whose avatar never made it into kind:0 (missing
 * uploadedPictureUrl, e.g. rehost was failing when they were added or a kind:0
 * shipped a raw googleusercontent URL) and re-attempt the rehost + republish.
 * The kind0Hash guard in maybePublishKind0 prevents redundant republishes for
 * channels that already have a clean avatar, so this is safe to run repeatedly.
 */
async function healAvatars(env: Env, limit?: number): Promise<{ scanned: number; healed: number; channels: string[] }> {
  const channels = new ChannelStore(env.CHANNELS);
  const archive = new EventStore(env.EVENTS);
  const all = await channels.list();
  let scanned = 0;
  let healed = 0;
  const healedChannels: string[] = [];
  for (const rec of all) {
    if (typeof limit === 'number' && healed >= limit) break;
    scanned++;
    // Stuck = we have no rehosted avatar on file. (A channel with a clean
    // uploadedPictureUrl is healthy; refreshChannelAvatar keeps it current.)
    if (rec.uploadedPictureUrl && !isRawYouTubeAvatarUrl(rec.uploadedPictureUrl)) continue;
    const ctx: ChannelContext = { record: rec, sk: deriveChannelKey(env.BRIDGE_MASTER_SEED, rec.channelId).sk };
    const picture = await refreshChannelAvatar(env, channels, ctx, rec.channelId);
    if (!picture || isRawYouTubeAvatarUrl(picture)) continue; // still failing; next pass retries
    const meta: ChannelMetadata = {
      id: rec.channelId,
      title: ctx.record.title ?? rec.channelId,
      url: ctx.record.url ?? `https://www.youtube.com/channel/${rec.channelId}`,
      pictureUrl: picture,
    };
    await maybePublishKind0(channels, archive, ctx, meta, getRelayUrls(env));
    healed++;
    healedChannels.push(rec.channelId);
  }
  return { scanned, healed, channels: healedChannels };
}

/** POST /admin/heal-avatars — on-demand avatar back-fill (cron does it too). */
async function handleAdminHealAvatars(req: Request, env: Env): Promise<Response> {
  let body: { limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  const limit = typeof body.limit === 'number' && body.limit > 0 ? body.limit : undefined;
  const result = await healAvatars(env, limit);
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
  // Back-fill any channels still missing a rehosted avatar (cap so a big stuck
  // backlog can't blow the cron CPU budget; the next tick continues).
  try {
    const heal = await healAvatars(env, 10);
    if (heal.healed > 0) console.log(`heal-avatars: healed ${heal.healed}/${heal.scanned}`);
  } catch (err) {
    console.error('heal-avatars failed:', err);
  }
  // Keep the DVM listener warm.
  await startDvm(env);
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

      const backfillResumeMatch = url.pathname.match(/^\/admin\/backfill\/([A-Za-z0-9-]+)\/resume$/);
      if (backfillResumeMatch && m === 'POST') return handleAdminBackfillResume(backfillResumeMatch[1]!, env, exCtx);

      if (m === 'POST' && url.pathname === '/admin/resolve') return handleAdminResolve(request);
      if (m === 'POST' && url.pathname === '/admin/overview') return handleAdminOverview(request, env);
      if (m === 'POST' && url.pathname === '/admin/publish') return handleAdminPublish(request, env);
      if (m === 'POST' && url.pathname === '/admin/follow-pack/build')
        return handleAdminFollowPackBuild(request, env);
      if (m === 'POST' && url.pathname === '/admin/follow-pack/publish')
        return handleAdminFollowPackPublish(request, env);
      if (m === 'GET' && url.pathname === '/admin/follow-pack/list')
        return handleAdminFollowPackList(env);

      if (m === 'GET' && url.pathname === '/admin/archive/stats') return handleAdminArchiveStats(env);
      if (m === 'POST' && url.pathname === '/admin/archive/republish') return handleAdminRepublish(request, env);
      if (m === 'POST' && url.pathname === '/admin/reindex') return handleAdminReindex(request, env);

      if (m === 'POST' && url.pathname === '/admin/dvm/start') return handleAdminDvmStart(env);
      if (m === 'GET' && url.pathname === '/admin/dvm/diag') return handleAdminDvmDiag(env);
      if (m === 'POST' && url.pathname === '/admin/dvm/announce') return handleAdminDvmAnnounce(request, env);
      if (m === 'POST' && url.pathname === '/admin/heal-avatars') return handleAdminHealAvatars(request, env);
    }

    return new Response('not found', { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
