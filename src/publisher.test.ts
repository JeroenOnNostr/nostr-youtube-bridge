import { describe, it, expect } from 'vitest';

import { buildDvmHandlerEvent, buildVideoEvent, VIDEO_LONG_KIND, VIDEO_SHORT_KIND } from './publisher';
import type { FeedEntry } from './youtube';

const VIDEO_ID = 'dQw4w9WgXcQ';

const entry: FeedEntry = {
  videoId: VIDEO_ID,
  channelId: 'UCabcdefghijklmnopqrstuv',
  channelTitle: 'Test Channel',
  channelUrl: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
  authorName: 'Test Channel',
  title: 'My Video Title',
  description: 'Line one of the description.\nLine two with a link https://example.com',
  publishedAtUnix: 1718791200,
  watchUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  thumbnailUrl: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
  source: 'long',
};

/** Find the single imeta tag and split its space-prefixed parts into a map. */
function imetaParts(tags: string[][]): Record<string, string> {
  const imeta = tags.find((t) => t[0] === 'imeta');
  expect(imeta, 'event should have an imeta tag').toBeDefined();
  const parts: Record<string, string> = {};
  for (let i = 1; i < imeta!.length; i++) {
    const p = imeta![i]!;
    const sp = p.indexOf(' ');
    if (sp !== -1) parts[p.slice(0, sp)] = p.slice(sp + 1);
  }
  return parts;
}

describe('buildVideoEvent', () => {
  it('publishes long-form videos as kind 21 with no addressable d tag', () => {
    const ev = buildVideoEvent({ entry, classification: 'long', shortsKind: 22 });
    expect(ev.kind).toBe(VIDEO_LONG_KIND);
    expect(ev.kind).toBe(21);
    expect(ev.tags.find((t) => t[0] === 'd')).toBeUndefined();
  });

  it('publishes shorts as kind 22 by default with no d tag', () => {
    const ev = buildVideoEvent({ entry, classification: 'short', shortsKind: 22 });
    expect(ev.kind).toBe(VIDEO_SHORT_KIND);
    expect(ev.kind).toBe(22);
    expect(ev.tags.find((t) => t[0] === 'd')).toBeUndefined();
  });

  it('publishes addressable shorts (kind 34236) with a stable d tag', () => {
    const ev = buildVideoEvent({ entry, classification: 'short', shortsKind: 34236 });
    expect(ev.kind).toBe(34236);
    expect(ev.tags).toContainEqual(['d', `youtube:${VIDEO_ID}`]);
  });

  it('keeps the title in a top-level title tag and the description in content', () => {
    const ev = buildVideoEvent({ entry, classification: 'long', shortsKind: 22 });
    expect(ev.tags).toContainEqual(['title', 'My Video Title']);
    expect(ev.tags).toContainEqual(['published_at', '1718791200']);
    // content (description) is preserved verbatim — formatting unchanged.
    expect(ev.content).toBe(entry.description);
  });

  it('adds NIP-73 external-content tags pointing at the watch page', () => {
    const ev = buildVideoEvent({ entry, classification: 'long', shortsKind: 22 });
    expect(ev.tags).toContainEqual(['i', entry.watchUrl, entry.watchUrl]);
    expect(ev.tags).toContainEqual(['k', 'web']);
  });

  it('keeps the watch URL in an r tag (NIP-71 web link)', () => {
    const ev = buildVideoEvent({ entry, classification: 'long', shortsKind: 22 });
    expect(ev.tags).toContainEqual(['r', entry.watchUrl]);
  });

  it('imeta describes the thumbnail honestly and never claims a media file', () => {
    const ev = buildVideoEvent({ entry, classification: 'long', shortsKind: 22 });
    const parts = imetaParts(ev.tags);
    // Clients read `url` to detect + embed the YouTube player.
    expect(parts.url).toBe(entry.watchUrl);
    // The only media variant described is the thumbnail image, real mimetype.
    expect(parts.image).toBe(entry.thumbnailUrl);
    expect(parts.m).toBe('image/jpeg');
  });

  it('NEVER emits the old bogus `m text/html` (the dev complaint) or a video/* variant', () => {
    for (const classification of ['long', 'short'] as const) {
      const ev = buildVideoEvent({ entry, classification, shortsKind: 22 });
      const flat = ev.tags.flat().join(' ');
      expect(flat).not.toContain('text/html');
      expect(flat).not.toMatch(/\bvideo\//);
    }
  });

  it('annotates approximate-time backfill in the alt tag', () => {
    const exact = buildVideoEvent({ entry, classification: 'long', shortsKind: 22 });
    expect(exact.tags).toContainEqual(['alt', 'Video: My Video Title']);

    const approx = buildVideoEvent({ entry, classification: 'long', shortsKind: 22, approximate: true });
    expect(approx.tags).toContainEqual(['alt', 'Video (approx upload time): My Video Title']);
  });

  it('sets created_at to the original upload time', () => {
    const ev = buildVideoEvent({ entry, classification: 'long', shortsKind: 22 });
    expect(ev.created_at).toBe(entry.publishedAtUnix);
  });
});

describe('buildDvmHandlerEvent', () => {
  it('builds an addressable kind-31990 with a k tag per advertised job kind', () => {
    const ev = buildDvmHandlerEvent({
      jobKinds: [5392, 5393],
      dTag: 'youtube-bridge-dvm',
      name: 'YouTube Bridge',
      about: 'Search and watch YouTube channels.',
      picture: 'https://image.nostr.build/x.webp',
      website: 'https://relay.kubo.watch',
    });
    expect(ev.kind).toBe(31990);
    expect(ev.tags).toContainEqual(['d', 'youtube-bridge-dvm']);
    expect(ev.tags).toContainEqual(['k', '5392']);
    expect(ev.tags).toContainEqual(['k', '5393']);
    const profile = JSON.parse(ev.content);
    expect(profile.name).toBe('YouTube Bridge');
    expect(profile.picture).toBe('https://image.nostr.build/x.webp');
    expect(profile.website).toBe('https://relay.kubo.watch');
  });

  it('omits picture/website when not provided', () => {
    const ev = buildDvmHandlerEvent({
      jobKinds: [5392],
      dTag: 'd',
      name: 'n',
      about: 'a',
    });
    const profile = JSON.parse(ev.content);
    expect(profile.picture).toBeUndefined();
    expect(profile.website).toBeUndefined();
  });
});
