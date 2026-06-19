import { describe, it, expect } from 'vitest';
import { verifyEvent } from 'nostr-tools';

import { deriveChannelKey, deriveServiceKey } from './derive';
import { signEvent, buildDvmHandlerEvent } from './publisher';

// 32-byte hex seed for deterministic derivation in tests.
const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const CHANNEL = 'UCabcdefghijklmnopqrstuv';

describe('deriveServiceKey', () => {
  it('is deterministic for a given seed', () => {
    const a = deriveServiceKey(SEED);
    const b = deriveServiceKey(SEED);
    expect(a.pkHex).toBe(b.pkHex);
    expect(a.npub).toBe(b.npub);
  });

  it('produces a different pubkey than any per-channel key (distinct salt domain)', () => {
    const service = deriveServiceKey(SEED);
    const channel = deriveChannelKey(SEED, CHANNEL);
    expect(service.pkHex).not.toBe(channel.pkHex);
    // Even a channel literally named "v1" must not collide with the service key.
    const channelV1 = deriveChannelKey(SEED, 'v1');
    expect(service.pkHex).not.toBe(channelV1.pkHex);
  });

  it('changes with the seed', () => {
    const other = deriveServiceKey('ff'.repeat(32));
    const base = deriveServiceKey(SEED);
    expect(other.pkHex).not.toBe(base.pkHex);
  });

  it('yields a valid npub and a signable secret key', () => {
    const { sk, npub } = deriveServiceKey(SEED);
    expect(npub.startsWith('npub1')).toBe(true);
    const tmpl = buildDvmHandlerEvent({
      jobKinds: [5392, 5393],
      dTag: 'youtube-bridge-dvm',
      name: 'YouTube Bridge',
      about: 'test',
    });
    const signed = signEvent(tmpl, sk);
    expect(verifyEvent(signed)).toBe(true);
  });
});
