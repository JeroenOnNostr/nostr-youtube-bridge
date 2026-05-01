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

export class ChannelStore {
  constructor(private kv: KVNamespace) {}

  async get(channelId: string): Promise<ChannelRecord | null> {
    return this.kv.get<ChannelRecord>(CHANNEL_PREFIX + channelId, 'json');
  }

  async put(record: ChannelRecord): Promise<void> {
    await this.kv.put(CHANNEL_PREFIX + record.channelId, JSON.stringify(record));
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
    await this.kv.put(VIDEO_PREFIX + record.videoId, JSON.stringify(record));
  }
}
