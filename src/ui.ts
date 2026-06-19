// Single-file dashboard. Vanilla JS + nostr-tools loaded from esm.sh in the
// browser, so the Worker bundle doesn't grow. Inlined as a TS string so a
// single `wrangler deploy` ships both API and UI.

export const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>nostr-youtube-bridge — dashboard</title>
<style>
  :root {
    --bg: #0f1115;
    --panel: #181b22;
    --panel-2: #1f232c;
    --border: #2a2f3a;
    --text: #e7e9ee;
    --muted: #9aa3b2;
    --accent: #ff5e3a;
    --accent-2: #ffb84d;
    --ok: #3fcf8e;
    --bad: #ff6b6b;
    --shorts: #c47bff;
    --long: #4dc9ff;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  a { color: var(--accent-2); }
  header { padding: 16px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--panel-2); color: var(--muted); }
  nav { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
  nav button { background: transparent; color: var(--muted); border: none; padding: 12px 16px; cursor: pointer; font: inherit; border-bottom: 2px solid transparent; }
  nav button.active { color: var(--text); border-bottom-color: var(--accent); }
  main { padding: 20px 24px 60px; max-width: 1200px; }
  section.tab { display: none; }
  section.tab.active { display: block; }
  h2 { font-size: 18px; margin: 0 0 12px; }
  h3 { font-size: 14px; margin: 16px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .row > * { flex: 0 0 auto; }
  .grow { flex: 1 1 auto; min-width: 200px; }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  input[type=text], input[type=url], textarea, select {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 10px; font: inherit; width: 100%;
  }
  textarea { min-height: 60px; resize: vertical; }
  button.btn {
    background: var(--accent); color: #fff; border: none; border-radius: 6px;
    padding: 8px 14px; cursor: pointer; font: inherit; font-weight: 500;
  }
  button.btn:hover { filter: brightness(1.1); }
  button.btn.secondary { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); }
  button.btn.danger { background: var(--bad); }
  button.btn:disabled { opacity: 0.5; cursor: not-allowed; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  td.kind-21 { color: var(--long); }
  td.kind-22, td.kind-34236 { color: var(--shorts); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .pill.long { background: rgba(77,201,255,.15); color: var(--long); }
  .pill.short { background: rgba(196,123,255,.15); color: var(--shorts); }
  .pill.dup { background: rgba(154,163,178,.15); color: var(--muted); }
  .npub { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
  pre { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow: auto; font-size: 12px; }
  .toast { position: fixed; bottom: 16px; right: 16px; background: var(--panel); border: 1px solid var(--border); padding: 12px 16px; border-radius: 8px; max-width: 360px; white-space: pre-line; }
  .toast.error { border-color: var(--bad); }
  .toast.ok { border-color: var(--ok); }
  .relay-list { display: flex; flex-direction: column; gap: 4px; }
  .relay-list label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text); margin: 0; }
  .empty { color: var(--muted); padding: 16px; text-align: center; }
  .thumb { width: 64px; height: 36px; object-fit: cover; border-radius: 4px; background: #000; }
</style>
</head>
<body>
<header>
  <h1>nostr-youtube-bridge</h1>
  <span class="badge" id="auth-badge">not connected</span>
  <div class="grow"></div>
  <button class="btn secondary" id="btn-logout" style="display:none">Forget token</button>
</header>
<nav>
  <button data-tab="channels" class="active">Channels</button>
  <button data-tab="overview">Overview</button>
  <button data-tab="follow-pack">Follow Pack</button>
  <button data-tab="archive">Archive</button>
  <button data-tab="settings">Settings</button>
</nav>
<main>

<section class="tab active" id="tab-channels">
  <h2>Channels</h2>
  <div class="card">
    <h3>Add channel</h3>
    <div class="row">
      <div class="grow">
        <label>YouTube URL or UC… id</label>
        <input type="text" id="add-input" placeholder="https://www.youtube.com/@veritasium" />
      </div>
      <div>
        <label>&nbsp;</label>
        <button class="btn secondary" id="btn-resolve">Resolve</button>
      </div>
      <div>
        <label>&nbsp;</label>
        <button class="btn" id="btn-add" disabled>Add &amp; backfill</button>
      </div>
    </div>
    <div id="resolve-result" style="margin-top:8px;color:var(--muted)"></div>
  </div>
  <div class="card">
    <div class="row" style="margin-bottom:8px">
      <h3 style="margin:0">Managed channels</h3>
      <div class="grow"></div>
      <button class="btn secondary" id="btn-refresh">Refresh</button>
      <button class="btn" id="btn-to-pack" disabled>Use selected in pack →</button>
    </div>
    <div id="channel-list"><div class="empty">log in to load…</div></div>
  </div>
</section>

<section class="tab" id="tab-overview">
  <h2>Overview</h2>
  <div class="card">
    <div class="row">
      <div class="grow">
        <label>Channel URL or UC… id</label>
        <input type="text" id="overview-input" placeholder="https://www.youtube.com/@veritasium" />
      </div>
      <div>
        <label>&nbsp;</label>
        <button class="btn secondary" id="btn-overview">Show</button>
      </div>
    </div>
    <p class="empty" style="text-align:left;padding:0;margin-top:8px">
      Read-only view of every Nostr event the bridge has published for this channel, sourced from the local archive.
    </p>
    <h3 style="margin-top:16px">Relays</h3>
    <div class="relay-list" id="relay-list"></div>
    <div class="row" style="margin-top:8px">
      <input type="text" id="relay-add" placeholder="wss://example.relay" />
      <button class="btn secondary" id="btn-add-relay">Add relay</button>
    </div>
  </div>
  <div id="overview-result"></div>
</section>

<section class="tab" id="tab-follow-pack">
  <h2>Follow Pack (kind 39089)</h2>
  <div class="card">
    <div class="row">
      <div class="grow">
        <label>Pack name</label>
        <input type="text" id="pack-name" placeholder="My favorite YouTubers" />
      </div>
      <div class="grow">
        <label>d-tag (stable id)</label>
        <input type="text" id="pack-dtag" value="favorites-v1" placeholder="favorites-v1" />
        <div style="font-size:11px;color:var(--muted);margin-top:4px">
          A short ID that identifies this pack. Reuse the same d-tag to update an existing pack; pick a new one (e.g. <code>kids-v1</code>) to publish a separate pack.
        </div>
      </div>
    </div>
    <label style="margin-top:8px">Description</label>
    <textarea id="pack-description" placeholder="A pack of bridged YouTube channels."></textarea>
    <h3 style="margin-top:16px">Selected channels</h3>
    <div id="pack-channels"><div class="empty">go to Channels tab and tick some boxes…</div></div>
    <h3 style="margin-top:16px">Signing method</h3>
    <div class="row" style="gap:16px">
      <label style="display:flex;align-items:center;gap:6px;margin:0;font-size:13px;color:var(--text)">
        <input type="radio" name="signer-method" value="nip07" checked /> Browser extension (NIP-07)
      </label>
      <label style="display:flex;align-items:center;gap:6px;margin:0;font-size:13px;color:var(--text)">
        <input type="radio" name="signer-method" value="nip46" /> Remote bunker (NIP-46)
      </label>
    </div>
    <div id="signer-nip07" style="margin-top:8px;font-size:12px;color:var(--muted)">
      Signs with <code>window.nostr</code> — works with Alby, nos2x, Flamingo, and other NIP-07 extensions. No setup needed.
    </div>
    <div id="signer-nip46" style="margin-top:8px;display:none">
      <label>Bunker URL</label>
      <div class="row">
        <input type="text" id="bunker-url" class="grow" placeholder="bunker://npub…?relay=wss://…&secret=…" />
        <button class="btn secondary" id="btn-save-bunker">Save</button>
      </div>
    </div>
    <div class="row" style="margin-top:16px">
      <button class="btn" id="btn-pack-build">Build &amp; sign</button>
      <button class="btn" id="btn-pack-publish" disabled>Publish to relays</button>
    </div>
    <h3 style="margin-top:16px">Event</h3>
    <pre id="pack-event">(no event yet)</pre>
    <h3 style="margin-top:16px">Publish status</h3>
    <div id="pack-publish-status" class="empty" style="text-align:left;padding:0">(not published yet)</div>
  </div>

  <div class="card">
    <div class="row" style="justify-content:space-between">
      <h3 style="margin:0">Published follow packs</h3>
      <button class="btn secondary" id="btn-packs-refresh">Refresh</button>
    </div>
    <p class="empty" style="text-align:left;padding:0;margin-top:4px">
      Pulled from the worker's archive. Edit reuses the same d-tag, so re-publishing replaces the existing pack on relays.
    </p>
    <div id="packs-list" style="margin-top:12px">(click refresh to load)</div>
  </div>
</section>

<section class="tab" id="tab-archive">
  <h2>Archive &amp; Republish</h2>
  <div class="card">
    <h3>Archive stats</h3>
    <p class="empty" style="text-align:left;padding:0">Every event the bridge signs is stored in KV. Republish to any relay without re-fetching from the network.</p>
    <div class="row" style="margin-top:8px">
      <button class="btn secondary" id="btn-archive-stats">Refresh stats</button>
      <div class="grow"></div>
    </div>
    <pre id="archive-stats">(click refresh to load)</pre>
  </div>
  <div class="card">
    <h3>Republish to relays</h3>
    <p class="empty" style="text-align:left;padding:0">Stream archived events to one or more target relays. Useful for seeding a fresh relay (e.g. wss://relay.kubo.watch) with the full back-catalog.</p>

    <label style="margin-top:8px">Target relays (one per line)</label>
    <textarea id="republish-relays" placeholder="wss://relay.kubo.watch"></textarea>

    <div class="row" style="margin-top:8px">
      <div class="grow">
        <label>Channel filter (optional UC… id)</label>
        <input type="text" id="republish-channel" placeholder="(all channels)" />
      </div>
      <div>
        <label>Kinds</label>
        <select id="republish-kinds">
          <option value="">all</option>
          <option value="0">0 (profiles only)</option>
          <option value="21,22,34236">21/22/34236 (videos only)</option>
          <option value="0,21,22,34236">0/21/22/34236 (profiles + videos)</option>
        </select>
      </div>
      <div>
        <label>Limit</label>
        <input type="text" id="republish-limit" placeholder="500" style="width:100px" />
      </div>
    </div>

    <div class="row" style="margin-top:12px">
      <button class="btn" id="btn-republish">Republish</button>
      <div class="grow"></div>
    </div>
    <pre id="republish-result" style="margin-top:8px">(no run yet)</pre>
  </div>
</section>

<section class="tab" id="tab-settings">
  <h2>Settings</h2>
  <div class="card">
    <h3>Admin token</h3>
    <p class="empty" style="text-align:left;padding:0">Stored in this browser's localStorage; sent as <code>Authorization: Bearer …</code> on every API call.</p>
    <div class="row">
      <input type="text" id="settings-token" class="grow" placeholder="ADMIN_TOKEN" />
      <button class="btn" id="btn-save-token">Save</button>
    </div>
  </div>
  <div class="card">
    <h3>Default relays (from worker)</h3>
    <pre id="settings-relays">…</pre>
  </div>
  <div class="card">
    <h3>Maintenance</h3>
    <p class="empty" style="text-align:left;padding:0">Re-build the per-channel video index from the master video log. Safe to run any time; needed once after upgrading from a worker version that did not write the secondary index.</p>
    <div class="row" style="margin-top:8px">
      <button class="btn secondary" id="btn-reindex">Reindex video counts</button>
      <span id="reindex-result" style="color:var(--muted)"></span>
    </div>
  </div>
</section>

</main>
<div id="toast" class="toast" style="display:none"></div>

<script type="module">
import { finalizeEvent } from 'https://esm.sh/nostr-tools@2.10.0';
import { BunkerSigner, parseBunkerInput } from 'https://esm.sh/nostr-tools@2.10.0/nip46';
import { SimplePool } from 'https://esm.sh/nostr-tools@2.10.0/pool';
import { generateSecretKey } from 'https://esm.sh/nostr-tools@2.10.0/pure';

// ─── auth + storage ─────────────────────────────────────────────────────
const LS = {
  token: 'bridge.adminToken',
  bunker: 'bridge.bunkerUrl',
  relays: 'bridge.relays',
};
function getToken() { return localStorage.getItem(LS.token) || ''; }
function setToken(t) { if (t) localStorage.setItem(LS.token, t); else localStorage.removeItem(LS.token); }
function getRelays() {
  try { return JSON.parse(localStorage.getItem(LS.relays) || '[]'); } catch { return []; }
}
function setRelays(arr) { localStorage.setItem(LS.relays, JSON.stringify(arr)); }
function getBunker() { return localStorage.getItem(LS.bunker) || ''; }
function setBunker(s) { if (s) localStorage.setItem(LS.bunker, s); else localStorage.removeItem(LS.bunker); }

// ─── api helpers ────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (path.startsWith('/admin/')) {
    const t = getToken();
    if (!t) throw new Error('no admin token — set one in Settings');
    headers.authorization = 'Bearer ' + t;
  }
  const resp = await fetch(path, { ...opts, headers });
  if (resp.status === 401) {
    toast('admin token rejected', 'error');
    throw new Error('unauthorized');
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || ('http ' + resp.status));
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  return resp.text();
}

// ─── ui helpers ─────────────────────────────────────────────────────────
function toast(msg, kind, opts) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + (kind || '');
  el.style.display = 'block';
  clearTimeout(toast._t);
  if (!(opts && opts.sticky)) {
    toast._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
  }
}
function hideToast() {
  clearTimeout(toast._t);
  document.getElementById('toast').style.display = 'none';
}
function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('copied', 'ok');
  } catch (e) { toast('copy failed: ' + e.message, 'error'); }
}
function npubCell(npub) {
  if (!npub) return el('span', { class: 'npub' }, '(unknown)');
  const wrap = el('span', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' });
  const linkUrl = 'https://njump.me/' + npub;
  wrap.appendChild(el('a', { class: 'npub', href: linkUrl, target: '_blank', title: npub }, npub.slice(0, 16) + '…'));
  const btn = el('button', { class: 'btn secondary', style: 'padding:2px 6px;font-size:11px', title: 'Copy ' + npub }, '⧉');
  btn.addEventListener('click', () => copyToClipboard(npub));
  wrap.appendChild(btn);
  return wrap;
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'on') for (const [evt, fn] of Object.entries(v)) e.addEventListener(evt, fn);
    else if (k === 'html') e.innerHTML = v;
    else if (v != null) e.setAttribute(k, v);
  }
  for (const k of kids) {
    if (k == null) continue;
    e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  }
  return e;
}

// ─── tab switching ──────────────────────────────────────────────────────
document.querySelectorAll('nav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('section.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('tab-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'follow-pack') { renderPackChannels(); loadPacksList(); }
  });
});

// ─── auth bootstrap ─────────────────────────────────────────────────────
function refreshAuthBadge() {
  const t = getToken();
  document.getElementById('auth-badge').textContent = t ? 'connected' : 'not connected';
  document.getElementById('auth-badge').style.color = t ? 'var(--ok)' : 'var(--muted)';
  document.getElementById('btn-logout').style.display = t ? '' : 'none';
}
document.getElementById('btn-logout').addEventListener('click', () => {
  setToken('');
  refreshAuthBadge();
  toast('token forgotten');
});
document.getElementById('btn-save-token').addEventListener('click', () => {
  const v = document.getElementById('settings-token').value.trim();
  setToken(v);
  refreshAuthBadge();
  toast('token saved', 'ok');
  loadChannels();
});
document.getElementById('settings-token').value = getToken();

document.getElementById('btn-reindex').addEventListener('click', async () => {
  const out = document.getElementById('reindex-result');
  out.textContent = 'reindexing…';
  try {
    const r = await api('/admin/reindex', { method: 'POST', body: JSON.stringify({}) });
    out.textContent = 'scanned ' + r.scanned + ', indexed ' + r.indexed;
    toast('reindex complete', 'ok');
    loadChannels();
  } catch (e) { out.textContent = 'error: ' + e.message; toast(e.message, 'error'); }
});

// ─── public config (default relays etc.) ────────────────────────────────
async function loadConfig() {
  try {
    const c = await fetch('/admin/config').then((r) => r.json());
    document.getElementById('settings-relays').textContent = (c.defaultRelays || []).join('\\n');
    if (getRelays().length === 0) setRelays(c.defaultRelays || []);
    renderRelayList();
  } catch (e) { /* ignore */ }
}

// ─── channels tab ───────────────────────────────────────────────────────
const selectedForPack = new Set();
let lastChannels = [];

async function loadChannels() {
  if (!getToken()) {
    document.getElementById('channel-list').innerHTML = '<div class="empty">set ADMIN_TOKEN in Settings to load channels.</div>';
    return;
  }
  try {
    const r = await api('/admin/channels');
    lastChannels = r.channels || [];
    renderChannels();
  } catch (e) {
    document.getElementById('channel-list').innerHTML = '<div class="empty">failed to load: ' + e.message + '</div>';
  }
}

function renderChannels() {
  const root = document.getElementById('channel-list');
  root.innerHTML = '';
  if (lastChannels.length === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'no channels yet — add one above.'));
    return;
  }
  const tbl = el('table');
  tbl.appendChild(el('thead', {},
    el('tr', {},
      el('th', {}, ''),
      el('th', {}, 'Channel'),
      el('th', {}, 'npub'),
      el('th', { title: 'Long-form videos already published as Nostr events for this channel' }, 'Long'),
      el('th', { title: 'Shorts already published as Nostr events for this channel' }, 'Shorts'),
      el('th', {}, 'Last publish'),
      el('th', {}, 'Actions'),
    )));
  const tbody = el('tbody');
  for (const c of lastChannels) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = selectedForPack.has(c.channelId);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedForPack.add(c.channelId);
      else selectedForPack.delete(c.channelId);
      document.getElementById('btn-to-pack').disabled = selectedForPack.size === 0;
    });
    const titleNode = el('a', {
      href: c.url || ('https://www.youtube.com/channel/' + c.channelId), target: '_blank',
    }, c.title || c.channelId);
    const idLine = el('div', { class: 'npub' }, c.channelId);
    tbody.appendChild(el('tr', {},
      el('td', {}, cb),
      el('td', {}, titleNode, idLine),
      el('td', {}, npubCell(c.npub)),
      el('td', {}, String(c.counts?.long ?? 0)),
      el('td', {}, String(c.counts?.short ?? 0)),
      el('td', {}, fmtTs(c.counts?.lastPublishedAt)),
      el('td', {},
        el('button', {
          class: 'btn secondary', on: { click: () => { jumpToOverview(c.channelId); } },
        }, 'Overview'),
        ' ',
        (() => {
          const b = el('button', { class: 'btn secondary' }, 'Publish now');
          b.addEventListener('click', () => publishNow(c.channelId, b));
          return b;
        })(),
        ' ',
        (() => {
          const b = el('button', {
            class: 'btn secondary',
            title: 'Walk every video in this channel via YouTube\'s internal API. Backfilled events have empty descriptions and approximate timestamps.',
          }, 'Backfill all');
          b.addEventListener('click', () => backfillAll(c.channelId, b));
          return b;
        })(),
        ' ',
        el('button', {
          class: 'btn danger', on: { click: () => deleteChannel(c.channelId) },
        }, 'Delete'),
      ),
    ));
  }
  tbl.appendChild(tbody);
  root.appendChild(tbl);
  document.getElementById('btn-to-pack').disabled = selectedForPack.size === 0;
}

async function publishNow(channelId, btn) {
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
  toast('publishing ' + channelId + ' — this can take 30–90s while we wait for relays…', '', { sticky: true });
  try {
    const r = await api('/admin/publish', {
      method: 'POST',
      body: JSON.stringify({
        channelId,
        relayUrls: getRelays(),
      }),
    });
    toast('done: +' + r.published.longPublished + ' long, +' + r.published.shortPublished + ' short', 'ok');
    loadChannels();
  } catch (e) { toast(e.message, 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

function fmtBackfillProgress(run) {
  const phaseLabel = {
    'starting': 'starting',
    'innertube-videos': 'fetching videos tab',
    'innertube-shorts': 'fetching shorts tab',
    'publishing-videos': 'publishing videos',
    'publishing-shorts': 'publishing shorts',
    'done': 'done',
  }[run.phase] || run.phase;
  const totalSeen = (run.longSeen || 0) + (run.shortSeen || 0);
  const totalPublished = (run.longPublished || 0) + (run.shortPublished || 0);
  const denom = totalSeen > 0 ? totalSeen : '?';
  const lines = [
    'Backfilling ' + run.channelId + ' — ' + phaseLabel,
    'Published: ' + totalPublished + ' / ' + denom + ' (' +
      (run.longPublished || 0) + ' long, ' +
      (run.shortPublished || 0) + ' short, ' +
      (run.alreadyPublished || 0) + ' skipped, ' +
      (run.errors || 0) + ' errors)',
  ];
  if (run.lastVideoTitle) lines.push('Last: ' + run.lastVideoTitle.slice(0, 60));
  return lines.join('\n');
}

async function backfillAll(channelId, btn) {
  const ok = confirm(
    'Backfill all videos for ' + channelId + '?\\n\\n' +
    'This walks the YouTube internal API to enumerate every video on the channel and ' +
    'publishes a Nostr event for each one not already published.\\n\\n' +
    'Caveats:\\n' +
    '  • Descriptions will be empty (RSS gives descriptions only for the most recent ~15).\\n' +
    '  • Timestamps are approximate (parsed from "3 weeks ago"). Shorts have no upload date at all and will be ordered by their position in the Shorts tab.\\n' +
    '  • Large channels (1000+ videos) may take several minutes; relay publishing is the bottleneck.\\n\\n' +
    'You can re-click later to resume — already-published videos are skipped.'
  );
  if (!ok) return;
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Backfilling…'; }

  let runId;
  try {
    const kickoff = await api('/admin/channels/' + channelId + '/backfill', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!kickoff.ok || !kickoff.runId) {
      toast('backfill failed to start: ' + (kickoff.error || 'unknown'), 'error');
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
      return;
    }
    runId = kickoff.runId;
  } catch (e) {
    toast('backfill failed to start: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    return;
  }

  toast('Backfilling ' + channelId + ' — starting…', '', { sticky: true });

  // Poll the run until status is terminal. Bail out after 60 minutes of
  // polling as a defensive safety net.
  const pollStart = Date.now();
  const maxPollMs = 60 * 60 * 1000;
  let lastStatus = 'running';
  while (Date.now() - pollStart < maxPollMs) {
    await new Promise((r) => setTimeout(r, 2000));
    let s;
    try {
      s = await api('/admin/backfill/' + runId);
    } catch (e) {
      // Transient errors shouldn't kill polling; keep going.
      continue;
    }
    if (!s.ok || !s.run) continue;
    const run = s.run;
    toast(fmtBackfillProgress(run), run.status === 'aborted' ? 'error' : '', { sticky: true });
    if (run.status === 'done' || run.status === 'aborted') {
      lastStatus = run.status;
      if (run.status === 'done') {
        toast(
          'Backfill done: +' + run.longPublished + ' long / +' + run.shortPublished + ' short / ' +
          run.alreadyPublished + ' skipped / ' + run.errors + ' errors',
          'ok',
        );
      } else {
        toast('Backfill aborted in ' + run.phase + ': ' + (run.abortReason || 'unknown'), 'error');
      }
      break;
    }
  }
  if (lastStatus === 'running') {
    toast('Backfill still running after 60 min — check archive stats', 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  loadChannels();
}

async function deleteChannel(channelId) {
  if (!confirm('Remove ' + channelId + ' from cron rotation? Already-published events on relays are NOT deleted.')) return;
  try {
    await api('/admin/channels/' + channelId, { method: 'DELETE' });
    selectedForPack.delete(channelId);
    toast('removed', 'ok');
    loadChannels();
  } catch (e) { toast(e.message, 'error'); }
}

document.getElementById('btn-refresh').addEventListener('click', loadChannels);

// ─── add-channel flow ───────────────────────────────────────────────────
let resolvedChannel = null;
document.getElementById('btn-resolve').addEventListener('click', async () => {
  const url = document.getElementById('add-input').value.trim();
  if (!url) return;
  document.getElementById('resolve-result').textContent = 'resolving…';
  try {
    const r = await api('/admin/resolve', { method: 'POST', body: JSON.stringify({ url }) });
    if (!r.ok) {
      document.getElementById('resolve-result').textContent = 'could not resolve';
      document.getElementById('btn-add').disabled = true;
      resolvedChannel = null;
      return;
    }
    resolvedChannel = r;
    document.getElementById('resolve-result').textContent =
      '✓ ' + (r.title || '') + ' — ' + r.channelId;
    document.getElementById('btn-add').disabled = false;
  } catch (e) {
    document.getElementById('resolve-result').textContent = 'error: ' + e.message;
  }
});
document.getElementById('btn-add').addEventListener('click', async () => {
  if (!resolvedChannel) return;
  document.getElementById('btn-add').disabled = true;
  try {
    await api('/admin/channels', {
      method: 'POST',
      body: JSON.stringify({ channelId: resolvedChannel.channelId }),
    });
    toast('added ' + resolvedChannel.channelId, 'ok');
    document.getElementById('add-input').value = '';
    document.getElementById('resolve-result').textContent = '';
    resolvedChannel = null;
    loadChannels();
  } catch (e) { toast(e.message, 'error'); }
});

// ─── overview tab ───────────────────────────────────────────────────────
function jumpToOverview(channelId) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'overview'));
  document.querySelectorAll('section.tab').forEach((x) => x.classList.toggle('active', x.id === 'tab-overview'));
  document.getElementById('overview-input').value = channelId;
  doOverview();
}

async function doOverview() {
  const input = document.getElementById('overview-input').value.trim();
  if (!input) return;
  const root = document.getElementById('overview-result');
  root.innerHTML = '<div class="empty">resolving…</div>';
  let channelId;
  if (/^UC[\w-]{22}$/.test(input)) channelId = input;
  else {
    try {
      const r = await api('/admin/resolve', { method: 'POST', body: JSON.stringify({ url: input }) });
      if (!r.ok) { root.innerHTML = '<div class="empty">could not resolve URL</div>'; return; }
      channelId = r.channelId;
    } catch (e) { root.innerHTML = '<div class="empty">error: ' + e.message + '</div>'; return; }
  }
  root.innerHTML = '<div class="empty">loading published events…</div>';
  try {
    const r = await api('/admin/overview', {
      method: 'POST',
      body: JSON.stringify({ channelId }),
    });
    renderOverview(r);
  } catch (e) { root.innerHTML = '<div class="empty">error: ' + e.message + '</div>'; }
}
document.getElementById('btn-overview').addEventListener('click', doOverview);

function renderOverview(p) {
  const root = document.getElementById('overview-result');
  root.innerHTML = '';
  const card = el('div', { class: 'card' });
  const header = el('div', { class: 'row' });
  header.appendChild(el('div', { class: 'grow' },
    el('strong', {}, p.channelTitle || p.channelId),
    el('div', { class: 'npub' }, p.channelId),
  ));
  const entries = (p.entries || []).slice().sort((a, b) => b.publishedAtUnix - a.publishedAtUnix);
  const longCount = entries.filter((e) => e.classification === 'long').length;
  const shortCount = entries.length - longCount;
  header.appendChild(el('div', {},
    el('div', {}, entries.length + ' published'),
    el('div', { class: 'npub' }, longCount + ' long, ' + shortCount + ' shorts'),
  ));
  card.appendChild(header);

  if (entries.length === 0) {
    card.appendChild(el('div', { class: 'empty' }, 'no published events for this channel yet — try Backfill or Publish now from the Channels tab.'));
    root.appendChild(card);
    return;
  }
  const tbl = el('table');
  tbl.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'Thumb'),
    el('th', {}, 'Title'),
    el('th', {}, 'Kind'),
    el('th', {}, 'Published'),
  )));
  const tbody = el('tbody');
  for (const e of entries) {
    tbody.appendChild(el('tr', {},
      el('td', {}, el('img', { class: 'thumb', src: e.thumbnailUrl, loading: 'lazy' })),
      el('td', {}, el('a', { href: e.watchUrl, target: '_blank' }, e.title)),
      el('td', { class: 'kind-' + e.kind }, 'kind ' + e.kind + ' (' + e.classification + ')'),
      el('td', {}, fmtTs(e.publishedAtUnix)),
    ));
  }
  tbl.appendChild(tbody);
  card.appendChild(tbl);
  root.appendChild(card);
}

// ─── relay list ─────────────────────────────────────────────────────────
function renderRelayList() {
  const root = document.getElementById('relay-list');
  const relays = getRelays();
  root.innerHTML = '';
  if (relays.length === 0) {
    root.appendChild(el('div', { class: 'empty' }, '(no relays — add one below)'));
    return;
  }
  for (const r of relays) {
    const remove = el('button', {
      class: 'btn secondary', on: { click: () => { setRelays(relays.filter((x) => x !== r)); renderRelayList(); } },
    }, '×');
    root.appendChild(el('label', {},
      el('span', { class: 'grow' }, r),
      remove,
    ));
  }
}
document.getElementById('btn-add-relay').addEventListener('click', () => {
  const v = document.getElementById('relay-add').value.trim();
  if (!v.startsWith('wss://') && !v.startsWith('ws://')) { toast('relay must start with wss://'); return; }
  const cur = getRelays();
  if (!cur.includes(v)) cur.push(v);
  setRelays(cur);
  document.getElementById('relay-add').value = '';
  renderRelayList();
});

// ─── follow pack tab ────────────────────────────────────────────────────
let lastSignedPack = null;
document.getElementById('btn-to-pack').addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'follow-pack'));
  document.querySelectorAll('section.tab').forEach((x) => x.classList.toggle('active', x.id === 'tab-follow-pack'));
  renderPackChannels();
});

// Inline picker open-state + search query, persisted across re-renders so
// typing/searching doesn't get reset by every selection.
let packPickerOpen = false;
let packPickerQuery = '';

function renderPackChannels() {
  const root = document.getElementById('pack-channels');
  root.innerHTML = '';

  // Selected list (or empty hint).
  if (selectedForPack.size === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'no channels yet — click "+ Add channels" below or tick boxes in the Channels tab.'));
  } else {
    const ul = el('table');
    ul.appendChild(el('thead', {}, el('tr', {}, el('th', {}, 'Channel'), el('th', {}, 'npub'), el('th', {}))));
    const tbody = el('tbody');
    for (const id of selectedForPack) {
      const c = lastChannels.find((x) => x.channelId === id);
      const remove = el('button', {
        class: 'btn secondary', on: { click: () => { selectedForPack.delete(id); renderPackChannels(); renderChannels(); } },
      }, 'remove');
      const title = c?.title || id;
      tbody.appendChild(el('tr', {},
        el('td', {}, title, el('div', { class: 'npub' }, id)),
        el('td', {}, npubCell(c?.npub)),
        el('td', {}, remove),
      ));
    }
    ul.appendChild(tbody);
    root.appendChild(ul);
  }

  // Add-channels affordance. Hidden when every bridged channel is already in.
  const addable = lastChannels.filter((c) => !selectedForPack.has(c.channelId));
  if (addable.length === 0 && lastChannels.length > 0) {
    root.appendChild(el('div', { class: 'empty', style: 'margin-top:8px' }, 'all bridged channels are in this pack.'));
    return;
  }

  const toggleBtn = el('button', {
    class: 'btn secondary', style: 'margin-top:8px',
    on: { click: () => { packPickerOpen = !packPickerOpen; renderPackChannels(); } },
  }, packPickerOpen ? 'Close picker' : '+ Add channels');
  root.appendChild(toggleBtn);

  if (!packPickerOpen) return;

  // Picker panel.
  const panel = el('div', {
    style: 'border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:8px;background:var(--panel-2)',
  });
  const search = el('input', {
    type: 'text', placeholder: 'Search by channel name or UC… id', class: 'grow',
    style: 'margin-bottom:8px',
  });
  search.value = packPickerQuery;
  search.addEventListener('input', () => {
    packPickerQuery = search.value;
    renderList();
  });
  panel.appendChild(search);

  const listRoot = el('div', { style: 'max-height:300px;overflow-y:auto' });
  panel.appendChild(listRoot);

  function renderList() {
    listRoot.innerHTML = '';
    const q = packPickerQuery.trim().toLowerCase();
    const matches = addable.filter((c) => {
      if (!q) return true;
      return (c.title || '').toLowerCase().includes(q)
        || c.channelId.toLowerCase().includes(q);
    });
    if (matches.length === 0) {
      listRoot.appendChild(el('div', { class: 'empty', style: 'text-align:left;padding:8px 0' },
        q ? 'no matches.' : 'no addable channels.'));
      return;
    }
    const tbl = el('table');
    const tbody = el('tbody');
    for (const c of matches) {
      const addBtn = el('button', {
        class: 'btn secondary',
        on: { click: () => {
          selectedForPack.add(c.channelId);
          renderPackChannels();
          renderChannels();
        } },
      }, 'add');
      tbody.appendChild(el('tr', {},
        el('td', {}, c.title || c.channelId, el('div', { class: 'npub' }, c.channelId)),
        el('td', {}, npubCell(c.npub)),
        el('td', { style: 'text-align:right' }, addBtn),
      ));
    }
    tbl.appendChild(tbody);
    listRoot.appendChild(tbl);
  }
  renderList();

  // Add-all-matching helper — useful when filtering down to a topical subset.
  const addAll = el('button', {
    class: 'btn secondary', style: 'margin-top:8px',
    on: { click: () => {
      const q = packPickerQuery.trim().toLowerCase();
      for (const c of addable) {
        if (!q || (c.title || '').toLowerCase().includes(q) || c.channelId.toLowerCase().includes(q)) {
          selectedForPack.add(c.channelId);
        }
      }
      renderPackChannels();
      renderChannels();
    } },
  }, 'Add all visible');
  panel.appendChild(addAll);

  root.appendChild(panel);
}

document.getElementById('bunker-url').value = getBunker();
document.getElementById('btn-save-bunker').addEventListener('click', () => {
  setBunker(document.getElementById('bunker-url').value.trim());
  toast('bunker URL saved', 'ok');
});

function getSignerMethod() {
  const checked = document.querySelector('input[name="signer-method"]:checked');
  return checked ? checked.value : 'nip07';
}
for (const r of document.querySelectorAll('input[name="signer-method"]')) {
  r.addEventListener('change', () => {
    const m = getSignerMethod();
    document.getElementById('signer-nip07').style.display = m === 'nip07' ? '' : 'none';
    document.getElementById('signer-nip46').style.display = m === 'nip46' ? '' : 'none';
  });
}

document.getElementById('btn-pack-build').addEventListener('click', async () => {
  const name = document.getElementById('pack-name').value.trim();
  const dTag = document.getElementById('pack-dtag').value.trim();
  const description = document.getElementById('pack-description').value.trim();
  const channelIds = Array.from(selectedForPack);
  const method = getSignerMethod();
  const bunker = document.getElementById('bunker-url').value.trim();
  if (!name) return toast('name required');
  if (!dTag) return toast('d-tag required');
  if (channelIds.length === 0) return toast('select at least one channel');
  if (method === 'nip07' && !window.nostr) {
    return toast('no NIP-07 extension found — install Alby/nos2x or use NIP-46', 'error');
  }
  if (method === 'nip46' && !bunker) return toast('bunker URL required');
  const relays = getRelays();
  document.getElementById('pack-event').textContent = 'building template…';
  try {
    const built = await api('/admin/follow-pack/build', {
      method: 'POST',
      body: JSON.stringify({
        channelIds, name, description, dTag,
        defaultRelay: relays[0],
      }),
    });
    if (!built.ok) { document.getElementById('pack-event').textContent = 'build failed'; return; }

    let signedEvent;
    if (method === 'nip07') {
      document.getElementById('pack-event').textContent = 'requesting signature from extension…';
      signedEvent = await window.nostr.signEvent(built.event);
    } else {
      document.getElementById('pack-event').textContent = 'connecting bunker…';
      const parsed = await parseBunkerInput(bunker);
      if (!parsed) { document.getElementById('pack-event').textContent = 'invalid bunker URL'; return; }
      const localSk = generateSecretKey();
      const pool = new SimplePool();
      const signer = new BunkerSigner(localSk, parsed, { pool });
      await signer.connect();
      document.getElementById('pack-event').textContent = 'requesting signature…';
      const pubkey = await signer.getPublicKey();
      const tmpl = { ...built.event, pubkey };
      signedEvent = await signer.signEvent(tmpl);
    }

    lastSignedPack = signedEvent;
    document.getElementById('pack-event').textContent = JSON.stringify(signedEvent, null, 2);
    document.getElementById('btn-pack-publish').disabled = false;
    toast('signed ✓', 'ok');
  } catch (e) {
    document.getElementById('pack-event').textContent = 'error: ' + e.message;
    toast(e.message, 'error');
  }
});

document.getElementById('btn-pack-publish').addEventListener('click', async () => {
  if (!lastSignedPack) return;
  const btn = document.getElementById('btn-pack-publish');
  const statusEl = document.getElementById('pack-publish-status');
  const relays = getRelays();
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = 'publishing…';
  statusEl.innerHTML = relays.length
    ? 'publishing to ' + relays.length + ' relay(s):<br/>' + relays.map(u => '• ' + u + ' — pending…').join('<br/>')
    : 'publishing to default relays (configured on the worker)…';
  try {
    const r = await api('/admin/follow-pack/publish', {
      method: 'POST',
      body: JSON.stringify({ event: lastSignedPack, relayUrls: relays }),
    });
    const lines = (r.results || []).map(res => {
      const icon = res.ok ? '✓' : '✗';
      const color = res.ok ? 'var(--ok)' : 'var(--bad)';
      const detail = res.ok ? 'accepted' : (res.error || 'rejected');
      return '<span style="color:' + color + '">' + icon + '</span> ' + res.url + ' — ' + detail;
    });
    statusEl.innerHTML =
      '<div style="margin-bottom:8px">accepted by <b>' + r.accepted + '/' + r.relays.length + '</b> relay(s) at ' + new Date().toLocaleTimeString() + '</div>' +
      lines.join('<br/>');
    toast('accepted by ' + r.accepted + '/' + r.relays.length + ' relays', r.accepted > 0 ? 'ok' : 'error');
  } catch (e) {
    statusEl.innerHTML = '<span style="color:var(--bad)">error: ' + e.message + '</span>';
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
});

// ─── published packs list ───────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

async function loadPacksList() {
  const root = document.getElementById('packs-list');
  root.innerHTML = '<div class="empty" style="text-align:left;padding:0">loading…</div>';
  try {
    const r = await api('/admin/follow-pack/list');
    if (!r.ok) { root.innerHTML = '<div class="empty" style="text-align:left;padding:0;color:var(--bad)">load failed</div>'; return; }
    if (!r.packs || r.packs.length === 0) {
      root.innerHTML = '<div class="empty" style="text-align:left;padding:0">no packs archived yet — publish one above.</div>';
      return;
    }
    root.innerHTML = '';
    for (const pack of r.packs) {
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:8px;background:var(--panel-2)';
      const dateStr = new Date(pack.created_at * 1000).toLocaleString();
      const knownChannels = pack.channels.filter(c => c.channelId);
      const unknownCount = pack.channels.length - knownChannels.length;
      const channelLines = pack.channels.map(c => {
        if (c.channelId) {
          return '• ' + escapeHtml(c.channelTitle || c.channelId) + ' <span style="color:var(--muted);font-size:11px">(' + escapeHtml(c.channelId) + ')</span>';
        }
        return '• <span style="color:var(--muted)">' + escapeHtml(c.pubkey.slice(0, 16)) + '… (not in this bridge\'s channel store)</span>';
      }).join('<br/>');
      card.innerHTML =
        '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-weight:600;font-size:14px">' + escapeHtml(pack.title || '(untitled)') + '</div>' +
            '<div style="color:var(--muted);font-size:12px;margin-top:2px">' +
              'd-tag: <code>' + escapeHtml(pack.dTag) + '</code> · ' +
              pack.channels.length + ' channel(s)' +
              (unknownCount > 0 ? ' · <span style="color:var(--accent-2)">' + unknownCount + ' unknown</span>' : '') +
              ' · published ' + escapeHtml(dateStr) +
            '</div>' +
            (pack.description ? '<div style="font-size:12px;margin-top:4px">' + escapeHtml(pack.description) + '</div>' : '') +
          '</div>' +
          '<button class="btn secondary" data-pack-edit="' + escapeHtml(pack.id) + '">Edit</button>' +
        '</div>' +
        '<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--muted);font-size:12px">Channels</summary>' +
          '<div style="margin-top:6px;font-size:13px;line-height:1.6">' + channelLines + '</div>' +
        '</details>';
      root.appendChild(card);
      const editBtn = card.querySelector('[data-pack-edit]');
      editBtn.addEventListener('click', () => editPack(pack));
    }
  } catch (e) {
    root.innerHTML = '<div class="empty" style="text-align:left;padding:0;color:var(--bad)">error: ' + escapeHtml(e.message) + '</div>';
  }
}

function editPack(pack) {
  document.getElementById('pack-name').value = pack.title || '';
  document.getElementById('pack-dtag').value = pack.dTag || '';
  document.getElementById('pack-description').value = pack.description || '';
  selectedForPack.clear();
  let unknown = 0;
  for (const c of pack.channels) {
    if (c.channelId) selectedForPack.add(c.channelId);
    else unknown++;
  }
  renderPackChannels();
  renderChannels();
  document.getElementById('pack-event').textContent = '(no event yet)';
  document.getElementById('pack-publish-status').textContent = '(not published yet)';
  document.getElementById('btn-pack-publish').disabled = true;
  lastSignedPack = null;
  document.getElementById('pack-name').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (unknown > 0) {
    toast(unknown + ' channel(s) in this pack aren\'t in the bridge — they will be dropped on re-publish', 'error');
  } else {
    toast('loaded into form — edit and click Build & sign', 'ok');
  }
}

document.getElementById('btn-packs-refresh').addEventListener('click', loadPacksList);

// ─── archive / republish ────────────────────────────────────────────────
async function loadArchiveStats() {
  const out = document.getElementById('archive-stats');
  out.textContent = 'loading…';
  try {
    const r = await api('/admin/archive/stats');
    if (!r.ok) { out.textContent = 'failed'; return; }
    const lines = ['Total archived: ' + r.total];
    const kinds = Object.keys(r.byKind || {}).sort((a, b) => Number(a) - Number(b));
    for (const k of kinds) lines.push('  kind ' + k + ': ' + r.byKind[k]);
    out.textContent = lines.join('\\n');
  } catch (e) { out.textContent = 'error: ' + e.message; }
}
document.getElementById('btn-archive-stats').addEventListener('click', loadArchiveStats);

document.getElementById('btn-republish').addEventListener('click', async () => {
  const out = document.getElementById('republish-result');
  const raw = document.getElementById('republish-relays').value;
  const relayUrls = raw.split(/[\\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (relayUrls.length === 0) { out.textContent = 'no relays specified'; return; }
  const channelId = document.getElementById('republish-channel').value.trim() || undefined;
  const kindsRaw = document.getElementById('republish-kinds').value;
  const kinds = kindsRaw ? kindsRaw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : undefined;
  const limitRaw = document.getElementById('republish-limit').value.trim();
  const limit = limitRaw ? Number(limitRaw) : undefined;
  out.textContent = 'streaming events to ' + relayUrls.length + ' relay(s)…';
  try {
    const r = await api('/admin/archive/republish', {
      method: 'POST',
      body: JSON.stringify({ relayUrls, channelId, kinds, limit }),
    });
    const lines = [
      'Scanned:        ' + r.scanned,
      'Attempted:      ' + r.attempted,
      'Accepted by ≥1: ' + r.acceptedAtLeastOnce,
      'Truncated:      ' + (r.truncated ? 'yes (use sinceUnix=' + r.lastCreatedAt + ' to continue)' : 'no'),
      '',
      'Per relay:',
    ];
    for (const url of Object.keys(r.perRelay || {})) {
      lines.push('  ' + url + ': ' + r.perRelay[url] + ' / ' + r.attempted);
    }
    out.textContent = lines.join('\\n');
    toast('republish complete: ' + r.acceptedAtLeastOnce + '/' + r.attempted + ' events', r.acceptedAtLeastOnce > 0 ? 'ok' : 'error');
  } catch (e) {
    out.textContent = 'error: ' + e.message;
    toast(e.message, 'error');
  }
});

// Pre-fill the republish relays box with the configured Kubo relay so a
// click-and-go is the default UX.
(function prefillRepublishRelays() {
  const box = document.getElementById('republish-relays');
  if (box && !box.value) box.value = 'wss://relay.kubo.watch';
})();

// ─── boot ───────────────────────────────────────────────────────────────
refreshAuthBadge();
loadConfig();
loadChannels();
</script>
</body>
</html>`;
