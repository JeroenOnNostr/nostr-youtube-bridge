/**
 * YouTube Bridge DVM — NIP-90 job listener (Cloudflare Durable Object).
 *
 * Dispatches each verified job request to a handler that publishes a signed
 * result back to the requester. Implements the bridge side of
 * docs/dvm-contract.md.
 *
 * Job kinds (permanent once on relays — see the contract):
 *   Search: request 5392 → result 6392
 *   Watch:  request 5393 → result 6393
 *   Status: 7000 (job feedback, used for long watch backfills)
 *
 * Identity: results/status (6392/6393/7000) are signed with the single bridge
 * DVM service key (deriveServiceKey) — NOT per-channel keys. Per-channel npubs
 * sign the channel's *video* events; the DVM is one stable service identity
 * that Kubo references via its kind-31990 naddr.
 *
 * ─── Execution model: poll-drain per alarm ─────────────────────────────────
 * Cloudflare stops executing a Durable Object isolate the moment its
 * fetch()/alarm() invocation returns — there is no event loop kept alive
 * between invocations. A persistent relay subscription with a fire-and-forget
 * onevent callback therefore NEVER fires: the socket goes dormant as soon as
 * the invocation that opened it returns.
 *
 * Instead, every alarm() does a short-lived, fully-AWAITED drain:
 *   1. Read the persisted `lastSeen` cursor (unix seconds; default now-60).
 *   2. Open fresh subscriptions to all relays with
 *      [{ kinds:[5392,5393], since: lastSeen }].
 *   3. Collect events into an array, resolving when EOSE has fired on every
 *      relay PLUS a short grace window (DRAIN_GRACE_MS) to catch stragglers —
 *      or a hard cap (DRAIN_HARD_CAP_MS) so a hung relay can't stall the tick.
 *      The await on that promise is what keeps the isolate alive long enough to
 *      actually receive the stored backlog.
 *   4. Dedup by event id (KV `dvm-seen:` survives across ticks so a request
 *      straddling two ticks isn't double-processed), then AWAIT handleRequest
 *      for each — sequentially, capped at MAX_REQUESTS_PER_TICK so one slow
 *      watch backfill can't blow the DO execution budget; the rest carry to the
 *      next tick (still inside the `since` window).
 *   5. Advance the cursor to (max created_at seen) - CURSOR_OVERLAP_SEC so the
 *      boundary is covered; the KV dedup absorbs the overlap. Persist it.
 *   6. Close all sockets (opened fresh each drain — nothing is leaked or relied
 *      upon between invocations).
 *   7. Re-arm the alarm ALARM_INTERVAL_MS later (~3s) so search latency is at
 *      most one drain cycle.
 *
 * `/start` (and POST /admin/dvm/start via index.ts) only ensures an alarm is
 * armed — it does NOT hold a subscription itself.
 */

import { verifyEvent, type NostrEvent } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

import { deriveChannelKey, deriveServiceKey } from './derive';
import {
  ensureChannel,
  getRelayUrls,
  getShortsKind,
  maybePublishKind0,
  publishVideoEntry,
  refreshChannelAvatar,
  type ChannelContext,
  type Env,
} from './channel';
import { ChannelStore, EventStore, InnertubeContextStore, PublishedStore, type ArchivedEvent } from './kv';
import { enumerateChannelTab, getInnertubeContext, searchChannels } from './innertube';
import { publishToRelays, signEvent, type ChannelMetadata } from './publisher';
import { resolveYouTubeUrl } from './resolve';
import { fetchChannelFeeds, longFeedUrl, type FeedEntry } from './youtube';

// ─── job kinds (single source of truth) ──────────────────────────────────
export const JOB_SEARCH = 5392;
export const JOB_SEARCH_RESULT = 6392;
export const JOB_WATCH = 5393;
export const JOB_WATCH_RESULT = 6393;
export const JOB_STATUS = 7000;

/** Default number of recent long-form videos a watch request backfills. */
const DEFAULT_BACKFILL_LONG = 20;
/** Hard ceiling on backfillLong so a malicious param can't blow the CPU budget. */
const MAX_BACKFILL_LONG = 50;
/** Search result cache TTL (seconds). */
const SEARCH_CACHE_TTL = 60 * 60;
/** Request-id dedup TTL (seconds) — the drain fans in from N relays and the
 *  `since` window is a generous rolling lookback (DRAIN_LOOKBACK_SEC), so the
 *  same request is re-delivered on most ticks; process it once. The KV dedup is
 *  the sole correctness guarantee, so this MUST comfortably exceed the lookback
 *  window: a request seen on tick N must still be recognised as seen for as long
 *  as it remains inside the `since` window and keeps being re-delivered. */
const SEEN_TTL = 60 * 30;
/** How often the poll-drain alarm fires (ms). Short so a parent typing a name
 *  waits at most ~one drain cycle for search results. */
const ALARM_INTERVAL_MS = 3_000;
/** On first run, look back this many seconds so a request published moments
 *  before the loop armed isn't missed. */
const INITIAL_LOOKBACK_SEC = 60;
/** Rolling lookback (seconds) every drain scans, regardless of how far the
 *  cursor has advanced: `since = min(cursor, now - DRAIN_LOOKBACK_SEC)`. A
 *  request can land in the sliver between two 3s ticks, or a busy relay can
 *  replay a stored event a beat late; a generous overlap eliminates that whole
 *  boundary-gap class of bug. Correctness comes entirely from the KV
 *  `dvm-seen:` dedup — the `since` only bounds how far back we scan, so a wide
 *  window is cheap (we just re-scan recent events and drop the dupes). */
const DRAIN_LOOKBACK_SEC = 30;
/** Grace window after the LAST relay EOSEs, to catch stragglers that arrive
 *  just after the relay declares the stored backlog drained. A busy relay
 *  (nos.lol) can deliver a stored event a beat after EOSE; keep this generous. */
const DRAIN_GRACE_MS = 2_500;
/** Hard cap on a single drain's collection window. A slow/hung relay that never
 *  EOSEs can't stall the whole tick beyond this. */
const DRAIN_HARD_CAP_MS = 8_000;
/** Small overlap (seconds) subtracted when advancing the cursor so nothing is
 *  missed at the tick boundary; the KV dedup absorbs the re-delivery. (Mostly
 *  belt-and-braces now that DRAIN_LOOKBACK_SEC forces a wide `since` regardless
 *  of the stored cursor.) */
const CURSOR_OVERLAP_SEC = 2;
/** Max requests handled per drain. A watch backfill publishes ~20 signed events
 *  and can take many seconds; cap so one tick can't exceed the DO budget. The
 *  remainder stay in the `since` window and are picked up next tick. */
const MAX_REQUESTS_PER_TICK = 5;

const SEARCH_CACHE_PREFIX = 'dvm-search:';
const SEEN_PREFIX = 'dvm-seen:';
/** Storage key for the persisted poll cursor (unix seconds). */
const CURSOR_KEY = 'dvm:lastSeen';

// ─── result payload shapes (mirror docs/dvm-contract.md) ──────────────────

interface SearchResult {
  channelId: string;
  title: string;
  thumbnail: string;
  npub: string;
  watching: boolean;
}

interface WatchResult {
  channelId: string;
  npub: string;
  title: string;
  picture?: string;
  backfilled: number;
  alreadyWatched: boolean;
}

// ─── small helpers ────────────────────────────────────────────────────────

function tagValue(ev: NostrEvent, name: string): string | undefined {
  const t = ev.tags.find((t) => t[0] === name);
  return t?.[1];
}

function paramValue(ev: NostrEvent, name: string): string | undefined {
  const t = ev.tags.find((t) => t[0] === 'param' && t[1] === name);
  return t?.[2];
}

/** The "i" input tag carries the query/url/channelId (3rd element is "text"). */
function inputValue(ev: NostrEvent): string | undefined {
  return ev.tags.find((t) => t[0] === 'i')?.[1];
}

function clientName(ev: NostrEvent): string | undefined {
  return ev.tags.find((t) => t[0] === 'client')?.[1];
}

/** True when the query is a direct reference (UC-id / URL / @handle) rather than
 *  free text — resolved via resolveYouTubeUrl, skipping InnerTube search. */
export function looksLikeChannelRef(q: string): boolean {
  const s = q.trim();
  if (/^UC[\w-]{22}$/.test(s)) return true;
  if (s.startsWith('@')) return true;
  if (/youtube\.com|youtu\.be/i.test(s)) return true;
  if (/^https?:\/\//i.test(s)) return true;
  return false;
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

export class YouTubeDvm implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  /**
   * Entry point. /start (from the cron/fetch path) only ensures an alarm is
   * armed so the poll-drain loop kicks off — it does NOT hold a subscription.
   * Any other path is a no-op 200 so a stray DO request can't error.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/start') {
      await this.ensureAlarmArmed();
      return new Response('started', { status: 200 });
    }
    if (url.pathname === '/diag') {
      return this.diag();
    }
    return new Response('ok', { status: 200 });
  }

  /**
   * Diagnostic snapshot of the poll-drain loop's live state: the stored cursor,
   * the relays it subscribes to, the alarm cadence, the rolling lookback window,
   * and the next-armed alarm time. Surfaced (admin-gated) via GET
   * /admin/dvm/diag so the cursor value can be read directly instead of inferred
   * from logs.
   */
  private async diag(): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const cursor = await this.ctx.storage.get<number>(CURSOR_KEY);
    const alarmAt = await this.ctx.storage.getAlarm();
    const body = {
      ok: true,
      cursorKey: CURSOR_KEY,
      cursor: typeof cursor === 'number' ? cursor : null,
      cursorAgeSec: typeof cursor === 'number' ? now - cursor : null,
      effectiveSince: typeof cursor === 'number' ? Math.min(cursor, now - DRAIN_LOOKBACK_SEC) : now - INITIAL_LOOKBACK_SEC,
      relayUrls: getRelayUrls(this.env),
      alarmIntervalMs: ALARM_INTERVAL_MS,
      drainLookbackSec: DRAIN_LOOKBACK_SEC,
      drainGraceMs: DRAIN_GRACE_MS,
      drainHardCapMs: DRAIN_HARD_CAP_MS,
      seenTtlSec: SEEN_TTL,
      nextAlarmAtMs: alarmAt,
      nextAlarmInMs: typeof alarmAt === 'number' ? alarmAt - Date.now() : null,
      nowUnix: now,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * One poll-drain cycle: collect the backlog since the cursor, process it
   * (fully awaited), advance + persist the cursor, then re-arm. Everything that
   * matters happens INSIDE this awaited call — the isolate is alive only here.
   */
  async alarm(): Promise<void> {
    // Re-arm BEFORE the (potentially multi-second) drain. If the isolate is
    // evicted mid-drain — e.g. during a new-channel backfill that publishes
    // ~20 signed events — the finally-block re-arm never runs and the loop
    // would die until the next /start or cron poke. Scheduling a fallback
    // alarm up front (past the hard cap so it can't fire mid-drain on this
    // same DO) guarantees a pending alarm always exists. setAlarm overwrites
    // the single pending alarm, so the finally-block reset to the tight
    // cadence on a clean completion is harmless.
    await this.ctx.storage.setAlarm(Date.now() + DRAIN_HARD_CAP_MS + ALARM_INTERVAL_MS);
    try {
      await this.drain();
    } catch (err) {
      console.error('dvm: drain failed:', err);
    } finally {
      // Clean completion: tighten back to the normal poll cadence.
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /** Arm an immediate alarm if none is pending, kicking off the drain loop. */
  private async ensureAlarmArmed(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1);
    }
  }

  // ─── poll-drain core ──────────────────────────────────────────────────────

  /**
   * Open short-lived subscriptions to every relay, collect all job requests
   * since the persisted cursor (awaiting EOSE-on-all + grace, or a hard cap),
   * dedup, await processing each, then advance + persist the cursor and close
   * all sockets.
   */
  private async drain(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const stored = await this.ctx.storage.get<number>(CURSOR_KEY);
    const cursor = typeof stored === 'number' ? stored : now - INITIAL_LOOKBACK_SEC;
    // Always scan at least DRAIN_LOOKBACK_SEC back, regardless of how far the
    // cursor has advanced. The KV dedup (not the cursor) guarantees correctness,
    // so a wide rolling window is cheap and closes the tick-boundary gap.
    const since = Math.min(cursor, now - DRAIN_LOOKBACK_SEC);

    console.log(`dvm: drain start since=${since} cursor=${cursor} now=${now}`);

    const { events, relayOf, relaysConnected } = await this.collect(since);

    let processed = 0;
    let carried = 0;
    for (const ev of events) {
      if (processed >= MAX_REQUESTS_PER_TICK) {
        // Leave the rest for the next tick: they're NOT marked seen and stay in
        // the rolling `since` window, so the next drain re-delivers them.
        carried = events.length - processed;
        break;
      }
      try {
        if (await this.handleRequest(ev, relayOf.get(ev.id))) processed++;
      } catch (err) {
        console.error(`dvm: handler for ${ev.id} threw:`, err);
        // A throw means the request was NOT marked seen (mark-seen happens only
        // after a fully successful handler), so it's re-delivered next tick and
        // retried — at-least-once. It still counts toward THIS tick's budget so
        // a single poison request can't monopolise one drain.
        processed++;
      }
    }

    // Advance the cursor MONOTONICALLY toward a rolling `now - DRAIN_LOOKBACK_SEC`
    // window, INDEPENDENT of what was collected. This is deliberate:
    //   - It must never move backward (max with prevCursor), or a quiet tick
    //     could rewind the window.
    //   - It must NOT be pinned to max(created_at) of the batch: if it were, a
    //     tick that collected nothing (or hit the per-tick cap) would freeze the
    //     cursor (the old maxCreatedAt=lastSeen bug), and `since` would then be
    //     pinned to that frozen value forever, growing the scan window without
    //     bound as `now` marches on.
    // Correctness against the resulting re-scan/overlap is guaranteed entirely by
    // the KV `dvm-seen:` dedup, not by the cursor. CURSOR_OVERLAP_SEC keeps a
    // little slack at the trailing edge so a request landing exactly on the
    // boundary isn't skipped.
    const rollingFloor = now - DRAIN_LOOKBACK_SEC - CURSOR_OVERLAP_SEC;
    const nextCursor = Math.max(cursor, rollingFloor);
    await this.ctx.storage.put(CURSOR_KEY, nextCursor);

    console.log(
      `dvm: drain done collected=${events.length} processed=${processed}` +
        (carried > 0 ? ` carried=${carried}` : '') +
        ` cursor→${nextCursor} relaysConnected=${relaysConnected}`,
    );
  }

  /**
   * Open subscriptions to all relays with the job-kind filter, collect events
   * into an array, and resolve when every relay has EOSE'd (plus a grace
   * window) or the hard cap elapses — whichever comes first. Always closes the
   * sockets it opened. Returns the deduped-by-id event list (relay fan-in can
   * deliver the same id from multiple relays) and a map id→firstRelaySeenOn.
   */
  private async collect(
    since: number,
  ): Promise<{ events: NostrEvent[]; relayOf: Map<string, string>; relaysConnected: number }> {
    const urls = getRelayUrls(this.env);
    const byId = new Map<string, NostrEvent>();
    const relayOf = new Map<string, string>();
    const relays: Relay[] = [];

    const collected = new Promise<void>((resolve) => {
      let eosed = 0;
      let expected = 0;
      // Becomes true only once every relay connection has been attempted, so an
      // early relay that EOSEs before a slower relay has even connected can't
      // trip the "all done" check prematurely.
      let connectPhaseDone = false;
      let settled = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        clearTimeout(hardCap);
        resolve();
      };

      const armGrace = () => {
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = setTimeout(finish, DRAIN_GRACE_MS);
      };

      // Once connecting is done AND every connected relay has drained its stored
      // backlog (EOSE), arm the grace window for late stragglers.
      const maybeAllEosed = () => {
        if (connectPhaseDone && eosed >= expected) armGrace();
      };

      const hardCap = setTimeout(finish, DRAIN_HARD_CAP_MS);

      // Open all relays concurrently; subscribe on each as it connects.
      Promise.all(
        urls.map(async (url) => {
          try {
            const relay = await Relay.connect(url);
            relays.push(relay);
            expected++;
            relay.subscribe([{ kinds: [JOB_SEARCH, JOB_WATCH], since }], {
              onevent: (ev) => {
                const e = ev as NostrEvent;
                console.log(`dvm: collected ${e.id} kind=${e.kind} from ${url}`);
                if (!byId.has(e.id)) {
                  byId.set(e.id, e);
                  relayOf.set(e.id, url);
                }
              },
              // An event whose signature/id fails verifyEvent, or that doesn't
              // match the filter, never reaches onevent — it lands here and is
              // otherwise silently dropped. Log it so a "collected=0 but the
              // request is on the relay" mystery is no longer invisible.
              oninvalidevent: (ev) => {
                const e = ev as NostrEvent;
                console.warn(`dvm: INVALID event ${e?.id} kind=${e?.kind} from ${url} (failed verify/filter)`);
              },
              oneose: () => {
                console.log(`dvm: eose from ${url}`);
                eosed++;
                maybeAllEosed();
              },
            });
          } catch (err) {
            console.warn(`dvm: subscribe to ${url} failed:`, err);
          }
        }),
      )
        .then(() => {
          connectPhaseDone = true;
          // No relay connected at all → nothing to wait for.
          if (expected === 0) {
            finish();
            return;
          }
          // Cover the case where every connected relay already EOSE'd before
          // the connect phase finished (so maybeAllEosed never armed grace).
          maybeAllEosed();
        })
        .catch(() => finish());
    });

    try {
      await collected;
    } finally {
      for (const r of relays) {
        try {
          r.close();
        } catch {
          /* ignore */
        }
      }
    }

    return { events: [...byId.values()], relayOf, relaysConnected: relays.length };
  }

  /**
   * Verify, dedup, log analytics, dispatch. Returns true if the request was
   * actually dispatched (counts toward the per-tick budget); false if dropped
   * (bad signature) or already seen on a prior tick. The relay the event
   * arrived on is added to the publish target set so the requester sees the
   * result.
   *
   * AT-LEAST-ONCE: the seen-key is written ONLY after the handler has fully
   * completed (including publishing the 6392/6393). If the handler throws OR the
   * DO isolate is evicted mid-flight, the request is NOT marked seen, so the next
   * drain re-delivers it (still inside the rolling `since` window) and retries.
   * This is safe because every handler is idempotent: search is naturally
   * idempotent; watch re-runs ensureChannel + the PublishedStore `published.has`
   * dedup + the kind:0 hash guard, so a replay republishes nothing new and just
   * re-emits the same npub — a duplicate 6393 is harmless (Kubo resolves on the
   * first). Drains are serialised within one DO (single-threaded alarm; the next
   * alarm is armed in `alarm()`'s finally only after the current returns), so a
   * request can never be processed concurrently across overlapping drains.
   */
  private async handleRequest(ev: NostrEvent, fromRelay: string | undefined): Promise<boolean> {
    if (!verifyEvent(ev)) {
      console.warn(`dvm: dropping ${ev.id} — invalid signature`);
      return false;
    }
    // Dedup across the relay fan-in AND across alarm ticks (the rolling `since`
    // window re-delivers requests every tick). KV TTL outlives the window.
    if (await this.alreadySeen(ev.id)) return false;

    const client = clientName(ev);
    console.log(
      `dvm: kind=${ev.kind} from pubkey=${ev.pubkey}${client ? ` client=${client}` : ''}` +
        (fromRelay ? ` via ${fromRelay}` : ''),
    );

    const targets = this.publishTargets(fromRelay);
    if (ev.kind === JOB_SEARCH) {
      await this.handleSearch(ev, targets);
    } else if (ev.kind === JOB_WATCH) {
      await this.handleWatch(ev, targets);
    }

    // Mark seen ONLY after the handler (and its result publish) fully succeeded.
    // A throw above propagates to drain() WITHOUT marking seen → retried next
    // tick. This is the decisive at-least-once fix for the long watch handler
    // being evicted before it could reply.
    await this.markSeen(ev.id);
    return true;
  }

  /** Has this request id already been fully processed on a prior drain? */
  private async alreadySeen(id: string): Promise<boolean> {
    return !!(await this.env.CHANNELS.get(SEEN_PREFIX + id));
  }

  /** Record a request id as fully processed (TTL outlives the rolling window). */
  private async markSeen(id: string): Promise<void> {
    await this.env.CHANNELS.put(SEEN_PREFIX + id, '1', { expirationTtl: SEEN_TTL });
  }

  private publishTargets(fromRelay: string | undefined): string[] {
    const base = getRelayUrls(this.env);
    if (!fromRelay || base.includes(fromRelay)) return base;
    return [...base, fromRelay];
  }

  private serviceSk(): Uint8Array {
    return deriveServiceKey(this.env.BRIDGE_MASTER_SEED).sk;
  }

  /** Publish a signed result/status event from the DVM service identity. */
  private async publishServiceEvent(
    kind: number,
    content: string,
    extraTags: string[][],
    relays: string[],
  ): Promise<void> {
    const tmpl = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: extraTags,
      content,
    };
    const signed = signEvent(tmpl, this.serviceSk());
    await publishToRelays(signed, relays);
    // Archive results too so the dashboard's archive views can see DVM traffic.
    try {
      await new EventStore(this.env.EVENTS).put(signed as ArchivedEvent);
    } catch {
      /* archive is best-effort */
    }
  }

  // ─── 5392 search ────────────────────────────────────────────────────────

  private async handleSearch(ev: NostrEvent, relays: string[]): Promise<void> {
    const query = inputValue(ev);
    const baseTags: string[][] = [
      ['e', ev.id],
      ['p', ev.pubkey],
      ['request', JSON.stringify(ev)],
    ];

    if (!query || !query.trim()) {
      await this.publishServiceEvent(JOB_SEARCH_RESULT, '[]', baseTags, relays);
      return;
    }

    let results: SearchResult[];
    try {
      results = await this.runSearch(query.trim());
    } catch (err) {
      console.warn(`dvm: search "${query}" failed:`, err);
      results = [];
    }
    await this.publishServiceEvent(JOB_SEARCH_RESULT, JSON.stringify(results), baseTags, relays);
  }

  private async runSearch(query: string): Promise<SearchResult[]> {
    const cacheKey = SEARCH_CACHE_PREFIX + normalizeQuery(query);
    const cached = await this.env.CHANNELS.get<SearchResult[]>(cacheKey, 'json');
    if (cached) {
      // watching can have changed since the cache write — refresh it cheaply.
      return this.refreshWatching(cached);
    }

    const channels = new ChannelStore(this.env.CHANNELS);
    let raw: Array<{ channelId: string; title: string; thumbnail?: string }> = [];

    if (looksLikeChannelRef(query)) {
      const resolved = await resolveYouTubeUrl(query);
      if (resolved) {
        raw = [{ channelId: resolved.channelId, title: resolved.title ?? resolved.channelId }];
      }
    } else {
      const itStore = new InnertubeContextStore(this.env.CHANNELS);
      const itCtx = await getInnertubeContext(itStore);
      raw = await searchChannels(itCtx, query);
    }

    const results: SearchResult[] = [];
    for (const r of raw) {
      const derived = deriveChannelKey(this.env.BRIDGE_MASTER_SEED, r.channelId);
      const rec = await channels.get(r.channelId);
      results.push({
        channelId: r.channelId,
        title: r.title,
        thumbnail: rec?.uploadedPictureUrl ?? r.thumbnail ?? '',
        npub: derived.npub,
        watching: !!rec,
      });
    }

    await this.env.CHANNELS.put(cacheKey, JSON.stringify(results), { expirationTtl: SEARCH_CACHE_TTL });
    return results;
  }

  /** Re-read the `watching` flag (and rehosted thumbnail) for cached results. */
  private async refreshWatching(results: SearchResult[]): Promise<SearchResult[]> {
    const channels = new ChannelStore(this.env.CHANNELS);
    return Promise.all(
      results.map(async (r) => {
        const rec = await channels.get(r.channelId);
        return {
          ...r,
          watching: !!rec,
          thumbnail: rec?.uploadedPictureUrl ?? r.thumbnail,
        };
      }),
    );
  }

  // ─── 5393 watch ───────────────────────────────────────────────────────────

  private async handleWatch(ev: NostrEvent, relays: string[]): Promise<void> {
    const input = inputValue(ev);

    if (!input || !input.trim()) {
      await this.emitStatus(ev, relays, 'error', 'missing input');
      return;
    }

    // Resolve to a UC id (accepts a bare UC id, URL, or @handle).
    let channelId: string | undefined;
    let resolvedTitle: string | undefined;
    if (/^UC[\w-]{22}$/.test(input.trim())) {
      channelId = input.trim();
    } else {
      const resolved = await resolveYouTubeUrl(input.trim());
      channelId = resolved?.channelId;
      resolvedTitle = resolved?.title;
    }
    if (!channelId) {
      await this.emitStatus(ev, relays, 'error', 'could not resolve channel');
      return;
    }

    const channels = new ChannelStore(this.env.CHANNELS);
    const published = new PublishedStore(this.env.PUBLISHED);
    const archive = new EventStore(this.env.EVENTS);
    const derived = deriveChannelKey(this.env.BRIDGE_MASTER_SEED, channelId);

    const alreadyWatched = !!(await channels.get(channelId));

    // ── FAST PATH: already-watched channel ──────────────────────────────────
    // The channel is already in CHANNELS (kind:0 published, 15-min cron owns
    // future uploads), so re-watching has nothing new to do. Reply with the
    // 6393 IMMEDIATELY — no kind:0 republish, no backfill, no extra subrequests.
    // This is the common re-add case (and the Veritasium test case): it must not
    // do the multi-second work that can get the isolate evicted before it replies.
    if (alreadyWatched) {
      const ctx = await ensureChannel(this.env, channels, channelId);
      const result: WatchResult = {
        channelId,
        npub: derived.npub,
        title: ctx.record.title ?? resolvedTitle ?? channelId,
        picture: ctx.record.uploadedPictureUrl,
        backfilled: 0,
        alreadyWatched: true,
      };
      console.log(`dvm: watch ${channelId} alreadyWatched=true backfilled=0 (fast path)`);
      await this.publishServiceEvent(
        JOB_WATCH_RESULT,
        JSON.stringify(result),
        [['e', ev.id], ['p', ev.pubkey]],
        relays,
      );
      await this.emitStatus(ev, relays, 'success', 'already watching');
      return;
    }

    // ── NEW CHANNEL ─────────────────────────────────────────────────────────
    // Emit `processing` BEFORE the long work so the client sees progress, then
    // do kind:0 + a (capped) backfill. Even if the backfill can't fully finish,
    // we still publish the 6393 with the npub + however many got backfilled: the
    // channel is now in CHANNELS, so the 15-min cron finishes future uploads. The
    // user gets the npub to follow immediately — that's what matters.
    const backfillLong = clampBackfill(paramValue(ev, 'backfillLong'));
    await this.emitStatus(ev, relays, 'processing', `backfilling ${backfillLong} videos`);

    const ctx = await ensureChannel(this.env, channels, channelId);

    // Ensure kind:0 (with a rehosted, suppression-safe avatar) is published.
    const picture = await this.ensureChannelProfile(ctx, channels, archive, channelId, resolvedTitle, relays);

    let backfilled = 0;
    try {
      backfilled = await this.backfillLongOnly(ctx, published, archive, channelId, backfillLong);
    } catch (err) {
      // A backfill failure must NOT swallow the 6393 — the npub is the payload
      // that matters; the cron backfills the videos later. Log and reply anyway.
      console.warn(`dvm: backfill for ${channelId} failed, replying with backfilled=0:`, err);
    }

    const result: WatchResult = {
      channelId,
      npub: derived.npub,
      title: ctx.record.title ?? resolvedTitle ?? channelId,
      picture,
      backfilled,
      alreadyWatched: false,
    };
    console.log(`dvm: watch ${channelId} alreadyWatched=false backfilled=${backfilled}`);
    await this.publishServiceEvent(
      JOB_WATCH_RESULT,
      JSON.stringify(result),
      [['e', ev.id], ['p', ev.pubkey]],
      relays,
    );
    await this.emitStatus(ev, relays, 'success', `backfilled ${backfilled}`);
  }

  /** Publish kind:0 for the channel, reusing the shared avatar-rehost + raw-url
   *  suppression path. Returns the picture URL that ended up in kind:0 (if any). */
  private async ensureChannelProfile(
    ctx: ChannelContext,
    channels: ChannelStore,
    archive: EventStore,
    channelId: string,
    fallbackTitle: string | undefined,
    relays: string[],
  ): Promise<string | undefined> {
    // Prefer the RSS feed for an authoritative title/url; fall back to what we
    // resolved. The avatar comes from InnerTube via refreshChannelAvatar.
    let title = ctx.record.title ?? fallbackTitle ?? channelId;
    let url = ctx.record.url ?? `https://www.youtube.com/channel/${channelId}`;
    try {
      const feeds = await fetchChannelFeeds(channelId);
      if (feeds.channelInfo) {
        title = feeds.channelInfo.title || feeds.channelInfo.authorName || title;
        url = feeds.channelInfo.url || url;
      }
    } catch (err) {
      console.warn(`dvm: fetchChannelFeeds for ${channelId} failed:`, err);
    }

    const picture = await refreshChannelAvatar(this.env, channels, ctx, channelId);
    const meta: ChannelMetadata = { id: channelId, title, url, pictureUrl: picture };
    await maybePublishKind0(channels, archive, ctx, meta, relays);
    // ctx.record.title/url may differ from RSS the first time — keep KV current.
    if (ctx.record.title !== title || ctx.record.url !== url) {
      const updated = { ...ctx.record, title, url };
      await channels.put(updated);
      ctx.record = updated;
    }
    // refreshChannelAvatar may have rehosted but maybePublishKind0 suppresses a
    // raw URL; report only the rehosted (non-raw) picture.
    return ctx.record.uploadedPictureUrl;
  }

  /**
   * Publish up to `limit` most-recent LONG-FORM videos as kind 21. NEVER touches
   * the shorts tab. Source order: the UULF split feed first (precise upload
   * times); if it yields nothing, fall back to the InnerTube `videos` tab
   * capped at `limit` (approximate times). Idempotent via PublishedStore.
   */
  private async backfillLongOnly(
    ctx: ChannelContext,
    published: PublishedStore,
    archive: EventStore,
    channelId: string,
    limit: number,
  ): Promise<number> {
    const shortsKind = getShortsKind(this.env);
    const relays = getRelayUrls(this.env);

    // Source 1: UULF split feed (long-form only, precise <published>).
    const feedUrl = longFeedUrl(channelId);
    let entries: FeedEntry[] = [];
    let approximate = false;
    if (feedUrl) {
      try {
        const feeds = await fetchChannelFeeds(channelId);
        entries = feeds.long.slice(0, limit);
      } catch (err) {
        console.warn(`dvm: long feed for ${channelId} failed:`, err);
      }
    }

    // Source 2 (fallback): InnerTube videos tab, capped at limit. Approximate.
    if (entries.length === 0) {
      try {
        const itStore = new InnertubeContextStore(this.env.CHANNELS);
        const itCtx = await getInnertubeContext(itStore);
        const ies = await enumerateChannelTab(itCtx, channelId, 'videos', { maxEntries: limit });
        entries = ies.slice(0, limit).map((ie) => ({
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
          source: 'long' as const,
        }));
        approximate = true;
      } catch (err) {
        console.warn(`dvm: videos-tab backfill for ${channelId} failed:`, err);
      }
    }

    let published_count = 0;
    for (const entry of entries) {
      if (await publishVideoEntry(ctx, published, archive, entry, 'long', shortsKind, relays, approximate)) {
        published_count++;
      }
    }
    return published_count;
  }

  private async emitStatus(
    ev: NostrEvent,
    relays: string[],
    status: 'processing' | 'error' | 'success',
    message: string,
  ): Promise<void> {
    await this.publishServiceEvent(
      JOB_STATUS,
      '',
      [['e', ev.id], ['p', ev.pubkey], ['status', status, message]],
      relays,
    );
  }
}

export function clampBackfill(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BACKFILL_LONG;
  return Math.min(n, MAX_BACKFILL_LONG);
}

export const DVM_DEFAULTS = {
  DEFAULT_BACKFILL_LONG,
  MAX_BACKFILL_LONG,
} as const;
