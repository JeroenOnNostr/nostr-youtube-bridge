import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import * as secp from '@noble/secp256k1';
import { getPublicKey, nip19 } from 'nostr-tools';

const HKDF_INFO = new TextEncoder().encode('nostr-bridge-v1');

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface DerivedKey {
  sk: Uint8Array;
  skHex: string;
  pkHex: string;
  npub: string;
  nsec: string;
}

/**
 * Core HKDF-SHA256 derivation shared by deriveChannelKey and deriveServiceKey.
 *
 *   - ikm  = bridge master seed (32 bytes)
 *   - salt = `saltPrefix` + `label`
 *   - info = "nostr-bridge-v1"
 *
 * Reduces mod n to land in the valid secp256k1 range. The (master_seed,
 * saltPrefix, label) -> nsec mapping is deterministic, auditable, and
 * reproducible — documented as the canonical derivation in the bridge README.
 */
function deriveKey(masterSeedHex: string, saltPrefix: string, label: string): DerivedKey {
  const ikm = hexToBytes(masterSeedHex);
  if (ikm.length !== 32) throw new Error('BRIDGE_MASTER_SEED must be 32 bytes');

  const salt = new TextEncoder().encode(saltPrefix + label);

  // HKDF expand to 32 bytes; reduce mod n to ensure validity.
  let candidate = hkdf(sha256, ikm, salt, HKDF_INFO, 32);
  // secp256k1 group order n
  const n = secp.CURVE.n;
  let value = BigInt('0x' + bytesToHex(candidate));
  // If 0 or >= n, re-expand with a counter suffix until valid. In practice the
  // first attempt is overwhelmingly likely to succeed; this loop is belt-and-
  // suspenders so the function never returns an invalid key.
  let counter = 0;
  while (value === 0n || value >= n) {
    counter++;
    const altSalt = new TextEncoder().encode(saltPrefix + label + ':' + counter);
    candidate = hkdf(sha256, ikm, altSalt, HKDF_INFO, 32);
    value = BigInt('0x' + bytesToHex(candidate));
    if (counter > 10) throw new Error('HKDF derivation failed');
  }

  const sk = candidate;
  const skHex = bytesToHex(sk);
  const pkHex = getPublicKey(sk);
  const npub = nip19.npubEncode(pkHex);
  const nsec = nip19.nsecEncode(sk);

  return { sk, skHex, pkHex, npub, nsec };
}

/**
 * Derive a deterministic Nostr secret key for a YouTube channel. Per-channel
 * keys sign the channel's video events (kind 21/22) and kind:0 profile only.
 * Salt domain "youtube:" — must never collide with the DVM service salt.
 */
export function deriveChannelKey(masterSeedHex: string, channelId: string): DerivedKey {
  return deriveKey(masterSeedHex, 'youtube:', channelId);
}

/**
 * Derive the single bridge DVM service key. This is the identity that signs
 * the DVM's result/status events (6392/6393/7000) and its NIP-89 kind-31990
 * handler announcement — NOT a per-channel key. It uses a distinct salt domain
 * ("dvm-service:") so it can never alias any channel's "youtube:<id>" key, even
 * if a channel were ever named "service".
 */
export function deriveServiceKey(masterSeedHex: string): DerivedKey {
  return deriveKey(masterSeedHex, 'dvm-service:', 'v1');
}
