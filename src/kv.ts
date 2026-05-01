export interface ChannelRecord {
  channelId: string;
  addedAt: number;
  npub: string;
  pubkeyHex: string;
  kind0PublishedAt?: number;
  kind0Hash?: string;
}

export interface PublishedRecord {
  videoId: string;
  eventId: string;
  publishedAt: number;
  channelId: string;
  kind: number;
}

const CHANNEL_PREFIX = 'channel:';
const VIDEO_PREFIX = 'video:';
const CHANNEL_VIDEO_PREFIX = 'chvid:';

const EVENT_PREFIX = 'evt:';
const EVENT_INDEX_PREFIX = 'evtidx:';
const EVENT_CHANNEL_PREFIX = 'evtch:';

// Secondary index key. Sort component is (Number.MAX_SAFE_INTEGER - publishedAt)
// zero-padded so a prefix `list` returns newest-first lexicographically.
function channelVideoKey(channelId: string, publishedAt: number, videoId: string): string {
  const inv = (Number.MAX_SAFE_INTEGER - publishedAt).toString().padStart(16, '0');
  return `${CHANNEL_VIDEO_PREFIX}${channelId}:${inv}:${videoId}`;
}

export class ChannelStore {
  constructor(private kv: KVNamespace) {}

  async get(channelId: string): Promise<ChannelRecord | null> {
    return this.kv.get<ChannelRecord>(CHANNEL_PREFIX + channelId, 'json');
  }

  async put(record: ChannelRecord): Promise<void> {
    await this.kv.put(CHANNEL_PREFIX + record.channelId, JSON.stringify(record));
  }

  async delete(channelId: string): Promise<void> {
    await this.kv.delete(CHANNEL_PREFIX + channelId);
  }

  async list(): Promise<ChannelRecord[]> {
    const out: ChannelRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: CHANNEL_PREFIX, cursor });
      for (const k of page.keys) {
        const rec = await this.kv.get<ChannelRecord>(k.name, 'json');
        if (rec) out.push(rec);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }
}

export class PublishedStore {
  constructor(private kv: KVNamespace) {}

  async has(videoId: string): Promise<boolean> {
    const v = await this.kv.get(VIDEO_PREFIX + videoId);
    return v !== null;
  }

  async get(videoId: string): Promise<PublishedRecord | null> {
    return this.kv.get<PublishedRecord>(VIDEO_PREFIX + videoId, 'json');
  }

  async put(record: PublishedRecord): Promise<void> {
    await Promise.all([
      this.kv.put(VIDEO_PREFIX + record.videoId, JSON.stringify(record)),
      this.kv.put(channelVideoKey(record.channelId, record.publishedAt, record.videoId), record.videoId),
    ]);
  }

  /** Newest-first list of published videos for a channel. */
  async listByChannel(channelId: string, limit = 50): Promise<PublishedRecord[]> {
    const out: PublishedRecord[] = [];
    let cursor: string | undefined;
    const prefix = `${CHANNEL_VIDEO_PREFIX}${channelId}:`;
    do {
      const page = await this.kv.list({ prefix, cursor, limit: Math.min(limit - out.length, 100) });
      for (const k of page.keys) {
        const videoId = await this.kv.get(k.name);
        if (!videoId) continue;
        const rec = await this.kv.get<PublishedRecord>(VIDEO_PREFIX + videoId, 'json');
        if (rec) out.push(rec);
        if (out.length >= limit) break;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && out.length < limit);
    return out;
  }
}

/**
 * Archive of every signed event the bridge has emitted, keyed by event id.
 * Used to replay events to additional or replacement relays without needing
 * to re-fetch them from the network.
 *
 * Sort keys use (Number.MAX_SAFE_INTEGER - created_at) so a prefix list
 * returns newest-first; reverse the inverse to scan oldest-first.
 */
export interface ArchivedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function eventIndexKey(createdAt: number, id: string): string {
  const inv = (Number.MAX_SAFE_INTEGER - createdAt).toString().padStart(16, '0');
  return `${EVENT_INDEX_PREFIX}${inv}:${id}`;
}

function eventChannelKey(channelId: string, createdAt: number, id: string): string {
  const inv = (Number.MAX_SAFE_INTEGER - createdAt).toString().padStart(16, '0');
  return `${EVENT_CHANNEL_PREFIX}${channelId}:${inv}:${id}`;
}

export class EventStore {
  constructor(private kv: KVNamespace) {}

  /**
   * Archive a signed event. Idempotent: writing the same event twice is
   * harmless. The optional channelId scopes a secondary index so per-channel
   * replays are cheap; pass undefined for events not tied to a channel
   * (e.g. follow-pack events the user signs externally).
   */
  async put(event: ArchivedEvent, channelId?: string): Promise<void> {
    const writes: Promise<unknown>[] = [
      this.kv.put(EVENT_PREFIX + event.id, JSON.stringify(event)),
      this.kv.put(eventIndexKey(event.created_at, event.id), event.id),
    ];
    if (channelId) {
      writes.push(this.kv.put(eventChannelKey(channelId, event.created_at, event.id), event.id));
    }
    await Promise.all(writes);
  }

  async get(id: string): Promise<ArchivedEvent | null> {
    return this.kv.get<ArchivedEvent>(EVENT_PREFIX + id, 'json');
  }

  /**
   * Stream archived events newest-first. Yields in batches; honours an
   * optional channelId filter and a created_at lower bound (events with
   * created_at < since are not yielded).
   */
  async *scan(opts: { channelId?: string; since?: number; pageSize?: number } = {}):
    AsyncGenerator<ArchivedEvent, void, unknown>
  {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 1000);
    const prefix = opts.channelId
      ? `${EVENT_CHANNEL_PREFIX}${opts.channelId}:`
      : EVENT_INDEX_PREFIX;
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix, cursor, limit: pageSize });
      for (const k of page.keys) {
        const id = await this.kv.get(k.name);
        if (!id) continue;
        const ev = await this.kv.get<ArchivedEvent>(EVENT_PREFIX + id, 'json');
        if (!ev) continue;
        if (typeof opts.since === 'number' && ev.created_at < opts.since) continue;
        yield ev;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  /** Aggregate counts across the archive. */
  async stats(): Promise<{ total: number; byKind: Record<number, number> }> {
    let total = 0;
    const byKind: Record<number, number> = {};
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: EVENT_INDEX_PREFIX, cursor, limit: 1000 });
      for (const k of page.keys) {
        const id = await this.kv.get(k.name);
        if (!id) continue;
        const ev = await this.kv.get<ArchivedEvent>(EVENT_PREFIX + id, 'json');
        if (!ev) continue;
        total++;
        byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return { total, byKind };
  }
}
