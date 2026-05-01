# nostr-youtube-bridge

Cloudflare Worker that bridges YouTube channels into Nostr.

For each curated channel:
- derives a deterministic `nsec` from a master seed + channel ID
- polls YouTube's per-channel RSS feeds every 15 min
- publishes new uploads as NIP-71 video events (kind:21 long-form, kind:22 shorts; kind:34236 optional via env flag)
- publishes a kind:0 metadata profile so the bridged channel is discoverable in Nostr clients

## Identity / key derivation

```
sk = HKDF-SHA256(
  ikm  = BRIDGE_MASTER_SEED (32 bytes),
  salt = "youtube:" + channel_id,
  info = "nostr-bridge-v1",
  length = 32
)
```

Derivation reduces mod n if needed (overwhelmingly never). Same `(master_seed, channel_id)` always produces the same `nsec`. **The bridge retains custody indefinitely** — there is no claim/handoff flow. kind:0 metadata explicitly states the profile is bridge-operated.

## Setup

```bash
npm install

# Create KV namespaces
wrangler kv namespace create CHANNELS
wrangler kv namespace create PUBLISHED
# Paste the returned ids into wrangler.toml

# Generate a fresh 32-byte hex master seed
openssl rand -hex 32

# Set secrets
wrangler secret put BRIDGE_MASTER_SEED  # paste the hex above
wrangler secret put ADMIN_TOKEN         # any random bearer string

wrangler deploy
```

## Adding a channel

```bash
curl -X POST https://<your-worker>/admin/channels \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"channelId":"UCxxxxxxxxxxxxxxxxxxxxxx","addedBy":"manual"}'
```

Response includes the derived `npub`. Use that npub when assembling NIP-51 follow packs.

The endpoint:
1. Validates the channel exists by fetching its UULF (long-form) split feed.
2. Writes the channel record to `CHANNELS` KV.
3. Publishes kind:0 metadata.
4. Backfills the most recent N entries from each split feed (default 5; set `BACKFILL_PER_FEED`).

## How shorts are detected

YouTube exposes two undocumented per-channel split feeds:

- `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF<channel_id_suffix>` — long-form only
- `https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH<channel_id_suffix>` — shorts only

(Where `<channel_id_suffix>` = the channel ID with the leading `UC` stripped.)

The bridge polls both. Any video that appears in only the regular feed (which means UULF/UUSH didn't return it for some reason) gets a HEAD-redirect probe to `/shorts/<videoId>` as fallback: HTTP 200 = short, redirect = long-form, error = default to long-form.

## Configuration

Env vars (in `wrangler.toml`):
- `RELAY_URLS` — comma-separated relay list
- `SHORTS_KIND` — `"22"` (default) or `"34236"`. Switching to 34236 makes shorts addressable (relay-level dedup); kind:22 is append-only but more universally supported.
- `BACKFILL_PER_FEED` — number of historical entries to publish on first channel add (default 5)

Secrets (`wrangler secret put`):
- `BRIDGE_MASTER_SEED` — 32-byte hex
- `ADMIN_TOKEN` — bearer token

## Known limitations

- **Created-at limits on relays.** Backfill events have `created_at` set to the original YouTube upload time. Some strict relays reject events more than a few hours in the past; pick relays that accept historical events.
- **No takedown handling.** If a YouTube video is removed, the bridged kind:21/22 event remains on relays. We do not publish kind:5 deletions.
- **Split feeds are undocumented.** If YouTube retires the UULF/UUSH prefixes, the bridge falls back to redirect-probing (8× more subrequests but still well under the 50/invocation limit).
- **Embedding-disabled videos.** A small fraction of YouTube videos have embedding disabled by their owner; the bridged event still publishes, but the embedded player will show "Video unavailable" inside the client. Users can still click through to YouTube.

## Layout

```
src/
  index.ts       Worker entry: cron + /admin/channels
  derive.ts      HKDF-based deterministic nsec derivation
  youtube.ts     RSS fetch (UULF/UUSH/regular) + redirect-probe fallback
  publisher.ts   kind:0 / kind:21 / kind:22 / kind:34236 builders, signing, relay publish
  kv.ts          Typed wrappers around CHANNELS and PUBLISHED KV namespaces
```
