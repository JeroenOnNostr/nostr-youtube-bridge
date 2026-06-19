# YouTube Bridge DVM — event contract (v1)

The shared interface between the **Kubo client** (publishes signed job requests) and the
**bridge DVM** (subscribes, processes, publishes signed results). Both sides code against
this doc. NIP-90 shaped, with custom job kinds in the open custom range.

## Job kinds (DECISION — permanent once on relays)

| Job    | Request kind | Result kind | Status kind |
|--------|--------------|-------------|-------------|
| Search | **5392**     | **6392**    | 7000        |
| Watch  | **5393**     | **6393**    | 7000        |

- 5392/5393 sit in NIP-90's 5000–5999 request range, outside the well-known job-type map
  (5000–5099 etc.), so they don't collide with standard DVM jobs. 6392/6393 are the +1000
  result pairs per NIP-90. 7000 is the standard job-feedback/status kind.
- These are **ephemeral** (< 10000): not replaceable/addressable, no `d` tag, no `published_at`.
- The DVM publishes results to the **same relays** the request arrived on (and the bridge's
  default relay set), so Kubo subscribing on `relay.kubo.watch` will see them.

## Search — request 5392 → result 6392

**Request (Kubo → relays), signed by the parent key:**
```
kind: 5392,
content: "",
tags: [
  ["i", "<query-or-url-or-@handle>", "text"],   // free-text name, OR a youtube URL/@handle (DVM resolves either)
  ["client", "Kubo", "31990:<pubkey>:<d>", "<relay>"],  // stamped automatically by useNostrPublish
]
```

**Result (DVM → relays), signed by the bridge key:**
```
kind: 6392,
content: <JSON string>,            // see ResultPayload below
tags: [
  ["e", "<request-id>"],           // REQUIRED — Kubo subscribes by this to match its request
  ["p", "<requester-pubkey>"],     // the parent who asked
  ["request", <full request event JSON>],  // NIP-90 convention (optional but nice for audit)
]
```

`content` JSON (`SearchResult[]`):
```jsonc
[
  {
    "channelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
    "title": "Veritasium",
    "thumbnail": "https://image.nostr.build/....webp",  // rehosted if possible, else yt url
    "npub": "npub1...",            // derived per-channel npub (public key only)
    "watching": true               // already in CHANNELS (so videos already flow)
  }
]
```
Ranked best-match-first. Empty array = no matches (Kubo shows "no results, paste a URL").

## Watch — request 5393 → result 6393 (+ 7000 status)

**Request (Kubo → relays), signed by the parent key:**
```
kind: 5393,
content: "",
tags: [
  ["i", "<channelId-or-url>", "text"],   // UC… id preferred; DVM resolves a URL/@handle if given
  ["param", "backfillLong", "20"],       // default 20 if absent
  ["param", "shorts", "false"],          // v1 always false
  ["client", "Kubo", ...],               // stamped automatically
]
```

**Status (DVM → relays), optional, signed by bridge key** — for long backfills:
```
kind: 7000,
content: "",
tags: [
  ["e", "<request-id>"], ["p", "<requester-pubkey>"],
  ["status", "processing", "backfilling 20 videos"],   // "processing" | "error" | "success"
]
```

**Result (DVM → relays), signed by bridge key:**
```
kind: 6393,
content: <JSON string>,            // see below
tags: [ ["e", "<request-id>"], ["p", "<requester-pubkey>"] ]
```

`content` JSON (`WatchResult`):
```jsonc
{
  "channelId": "UC...",
  "npub": "npub1...",          // follow THIS to get the channel's videos
  "title": "Veritasium",
  "picture": "https://image.nostr.build/....webp",
  "backfilled": 20,            // how many long-form kind:21 were published this call
  "alreadyWatched": false
}
```
Idempotent: re-requesting an already-watched channel returns the same npub with
`alreadyWatched: true` and `backfilled: 0`.

## Auth & client detection

- **Authorization keys off the signing pubkey** of the request (cryptographic). v1: accept
  any valid signature, but log/meter per pubkey so subscription/allowlist/zap gating can be
  added later without a protocol change (NIP-90 `["amount", …]`).
- The **`["client","Kubo",…]` tag is advisory only** — anyone can forge it. Use it for
  analytics ("served N Kubo families") and soft-signal, NEVER as a security boundary.

## Kubo client behaviour (`src/lib/youtubeDvm.ts`)

1. Build the request `EventTemplate`, publish via `useNostrPublish` (parent signer — the
   `client` tag is added automatically; the parent key signs).
2. Immediately subscribe: `[{ kinds: [6392|6393, 7000], "#e": [<request-id>], since: <now-5s> }]`.
3. Resolve on the first matching result event; surface 7000 `processing` as progress.
4. Timeout (e.g. 20s search, 60s watch) + one retry; on final timeout show a graceful
   "couldn't reach the YouTube service, try again" — relays are best-effort.

## Bridge DVM behaviour (`src/dvm.ts`)

1. An always-on listener (Cloudflare Durable Object w/ WebSocket Hibernation, recommended)
   holds a `REQ` for `[{ kinds: [5392, 5393], since: <boot> }]` on the shared relays.
2. On each request: verify sig; read `client` tag (analytics) + pubkey (auth); dispatch.
   - 5392 → search handler (InnerTube search; cache in KV).
   - 5393 → watch handler (ensure CHANNELS, kind:0, long-only last-N backfill via UULF feed
     / InnerTube videos tab capped at N; never the shorts tab).
3. Sign results with the **bridge master key derived per the bridge's own identity** (the
   DVM service key — NOT a per-channel key; the per-channel npubs sign the *video* events).
4. Publish 6392/6393 (+ optional 7000) `e`-tagging the request id, to the request's relays.
```
```
