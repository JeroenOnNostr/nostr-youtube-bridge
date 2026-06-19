import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyEvent, type NostrEvent } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2';

import { isRawYouTubeAvatarUrl, rehostAvatar, buildNip98Header } from './imageHost';
import { deriveServiceKey } from './derive';

// 32-byte hex seed → deterministic service signing key for tests.
const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const SERVICE = deriveServiceKey(SEED);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode an `Authorization: Nostr <base64>` value back to its kind-27235 event. */
function decodeNip98(authorization: string): NostrEvent {
  expect(authorization.startsWith('Nostr ')).toBe(true);
  const b64 = authorization.slice('Nostr '.length);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes)) as NostrEvent;
}

describe('isRawYouTubeAvatarUrl', () => {
  it('flags raw YouTube CDN avatars', () => {
    expect(isRawYouTubeAvatarUrl('https://yt3.googleusercontent.com/abc=s800')).toBe(true);
    expect(isRawYouTubeAvatarUrl('https://yt3.ggpht.com/abc')).toBe(true);
    expect(isRawYouTubeAvatarUrl('//yt3.ggpht.com/abc')).toBe(true);
    expect(isRawYouTubeAvatarUrl('https://lh3.googleusercontent.com/abc')).toBe(true);
  });

  it('passes rehosted nostr.build URLs and empties', () => {
    expect(isRawYouTubeAvatarUrl('https://image.nostr.build/abc.webp')).toBe(false);
    expect(isRawYouTubeAvatarUrl(undefined)).toBe(false);
    expect(isRawYouTubeAvatarUrl('')).toBe(false);
  });
});

describe('buildNip98Header', () => {
  const URL_ = 'https://nostr.build/api/v2/upload/files';

  it('builds a valid signed kind-27235 carrying the exact u/method/payload tags', () => {
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const header = buildNip98Header(URL_, 'POST', SERVICE.sk, body);
    const ev = decodeNip98(header);

    expect(ev.kind).toBe(27235);
    expect(ev.content).toBe('');
    expect(ev.pubkey).toBe(SERVICE.pkHex);
    // Signature valid + id correct (verifyEvent checks both).
    expect(verifyEvent(ev)).toBe(true);

    // `u` tag MUST match the request URL exactly — this is what nostr.build checks.
    expect(ev.tags).toContainEqual(['u', URL_]);
    expect(ev.tags).toContainEqual(['method', 'POST']);
    // payload = sha256 hex of the actual body bytes.
    expect(ev.tags).toContainEqual(['payload', bytesToHex(sha256(body))]);
  });

  it('omits the payload tag when no body is supplied', () => {
    const header = buildNip98Header(URL_, 'POST', SERVICE.sk);
    const ev = decodeNip98(header);
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.tags.some((t) => t[0] === 'payload')).toBe(false);
    expect(ev.tags).toContainEqual(['u', URL_]);
  });
});

describe('rehostAvatar retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retries the wsrv.nl hop and succeeds, sending a NIP-98 Authorization on upload', async () => {
    const okUpload = {
      ok: true,
      json: async () => ({ data: { tags: [['url', 'https://image.nostr.build/abc.webp']] } }),
    };
    const fetchMock = vi
      .fn()
      // wsrv hop: fail once (500), then succeed with bytes.
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
      // nostr.build hop: succeed.
      .mockResolvedValueOnce(okUpload);
    vi.stubGlobal('fetch', fetchMock);

    const url = await rehostAvatar('https://yt3.googleusercontent.com/x=s800', SERVICE.sk);
    expect(url).toBe('https://image.nostr.build/abc.webp');
    // 2 wsrv attempts + 1 upload = 3 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The upload POST (3rd fetch) must carry a valid NIP-98 header for the URL.
    const uploadCall = fetchMock.mock.calls[2]!;
    expect(uploadCall[0]).toBe('https://nostr.build/api/v2/upload/files');
    const headers = uploadCall[1].headers as Record<string, string>;
    const ev = decodeNip98(headers.Authorization!);
    expect(ev.kind).toBe(27235);
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.tags).toContainEqual(['u', 'https://nostr.build/api/v2/upload/files']);
    expect(ev.tags).toContainEqual(['method', 'POST']);
    expect(ev.tags.some((t) => t[0] === 'payload')).toBe(true);
  });

  it('returns null after exhausting the wsrv.nl hop attempts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);

    const url = await rehostAvatar('https://yt3.googleusercontent.com/x=s800', SERVICE.sk);
    expect(url).toBeNull();
    // 3 wsrv attempts, then bail before the upload hop.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
