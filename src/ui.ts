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
  .toast { position: fixed; bottom: 16px; right: 16px; background: var(--panel); border: 1px solid var(--border); padding: 12px 16px; border-radius: 8px; max-width: 360px; }
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
  <button data-tab="preview">Preview / Publish</button>
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

<section class="tab" id="tab-preview">
  <h2>Preview / Publish</h2>
  <div class="card">
    <div class="row">
      <div class="grow">
        <label>Channel URL or UC… id</label>
        <input type="text" id="preview-input" placeholder="https://www.youtube.com/@veritasium" />
      </div>
      <div>
        <label>Shorts kind</label>
        <select id="preview-shorts-kind">
          <option value="22">22 (default)</option>
          <option value="34236">34236 (addressable)</option>
        </select>
      </div>
      <div>
        <label>Limit per feed</label>
        <input type="text" id="preview-limit" placeholder="(all)" style="width:80px" />
      </div>
      <div>
        <label>&nbsp;</label>
        <button class="btn secondary" id="btn-preview">Preview</button>
      </div>
    </div>
    <h3 style="margin-top:16px">Relays</h3>
    <div class="relay-list" id="relay-list"></div>
    <div class="row" style="margin-top:8px">
      <input type="text" id="relay-add" placeholder="wss://example.relay" />
      <button class="btn secondary" id="btn-add-relay">Add relay</button>
    </div>
  </div>
  <div id="preview-result"></div>
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
        <input type="text" id="pack-dtag" placeholder="favorites-v1" />
      </div>
    </div>
    <label style="margin-top:8px">Description</label>
    <textarea id="pack-description" placeholder="A pack of bridged YouTube channels."></textarea>
    <h3 style="margin-top:16px">Selected channels</h3>
    <div id="pack-channels"><div class="empty">go to Channels tab and tick some boxes…</div></div>
    <h3 style="margin-top:16px">Bunker URL (NIP-46)</h3>
    <div class="row">
      <input type="text" id="bunker-url" class="grow" placeholder="bunker://npub…?relay=wss://…&secret=…" />
      <button class="btn secondary" id="btn-save-bunker">Save</button>
    </div>
    <div class="row" style="margin-top:16px">
      <button class="btn" id="btn-pack-build">Build &amp; sign</button>
      <button class="btn" id="btn-pack-publish" disabled>Publish to relays</button>
    </div>
    <h3 style="margin-top:16px">Event</h3>
    <pre id="pack-event">(no event yet)</pre>
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
function toast(msg, kind) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + (kind || '');
  el.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
}
function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
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
    if (b.dataset.tab === 'follow-pack') renderPackChannels();
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

// ─── public config (default relays etc.) ────────────────────────────────
async function loadConfig() {
  try {
    const c = await fetch('/admin/config').then((r) => r.json());
    document.getElementById('settings-relays').textContent = (c.defaultRelays || []).join('\\n');
    if (getRelays().length === 0) setRelays(c.defaultRelays || []);
    document.getElementById('preview-shorts-kind').value = String(c.defaultShortsKind || 22);
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
      el('th', {}, 'Long'),
      el('th', {}, 'Shorts'),
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
    const link = el('a', { href: 'https://www.youtube.com/channel/' + c.channelId, target: '_blank' }, c.channelId);
    tbody.appendChild(el('tr', {},
      el('td', {}, cb),
      el('td', {}, link),
      el('td', {}, el('span', { class: 'npub' }, c.npub.slice(0, 16) + '…')),
      el('td', {}, String(c.counts?.long ?? 0)),
      el('td', {}, String(c.counts?.short ?? 0)),
      el('td', {}, fmtTs(c.counts?.lastPublishedAt)),
      el('td', {},
        el('button', {
          class: 'btn secondary', on: { click: () => { jumpToPreview(c.channelId); } },
        }, 'Preview'),
        ' ',
        el('button', {
          class: 'btn secondary', on: { click: () => publishNow(c.channelId) },
        }, 'Publish now'),
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

async function publishNow(channelId) {
  toast('publishing ' + channelId + '…');
  try {
    const r = await api('/admin/publish', {
      method: 'POST',
      body: JSON.stringify({
        channelId,
        relayUrls: getRelays(),
        shortsKind: parseInt(document.getElementById('preview-shorts-kind').value, 10),
      }),
    });
    toast('+' + r.published.longPublished + ' long, +' + r.published.shortPublished + ' short', 'ok');
    loadChannels();
  } catch (e) { toast(e.message, 'error'); }
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

// ─── preview tab ────────────────────────────────────────────────────────
function jumpToPreview(channelId) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'preview'));
  document.querySelectorAll('section.tab').forEach((x) => x.classList.toggle('active', x.id === 'tab-preview'));
  document.getElementById('preview-input').value = channelId;
  doPreview();
}

async function doPreview() {
  const input = document.getElementById('preview-input').value.trim();
  if (!input) return;
  const root = document.getElementById('preview-result');
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
  root.innerHTML = '<div class="empty">fetching feeds…</div>';
  const limit = parseInt(document.getElementById('preview-limit').value, 10);
  const shortsKind = parseInt(document.getElementById('preview-shorts-kind').value, 10);
  try {
    const r = await api('/admin/preview', {
      method: 'POST',
      body: JSON.stringify({
        channelId,
        shortsKind,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    });
    renderPreview(r);
  } catch (e) { root.innerHTML = '<div class="empty">error: ' + e.message + '</div>'; }
}
document.getElementById('btn-preview').addEventListener('click', doPreview);

function renderPreview(p) {
  const root = document.getElementById('preview-result');
  root.innerHTML = '';
  const card = el('div', { class: 'card' });
  const header = el('div', { class: 'row' });
  header.appendChild(el('div', { class: 'grow' },
    el('strong', {}, p.channelTitle || p.channelId),
    el('div', { class: 'npub' }, p.channelId),
  ));
  const allEntries = [
    ...p.longEntries.map((e) => ({ ...e, classification: 'long' })),
    ...p.shortEntries.map((e) => ({ ...e, classification: 'short' })),
  ].sort((a, b) => b.publishedAtUnix - a.publishedAtUnix);
  const fresh = allEntries.filter((e) => !e.alreadyPublished);
  header.appendChild(el('div', {},
    el('div', {}, fresh.length + ' would publish'),
    el('div', { class: 'npub' }, allEntries.length + ' total in feed'),
  ));
  const btn = el('button', {
    class: 'btn',
    on: { click: () => publishSelected(p.channelId, getCheckedIds()) },
  }, 'Publish selected');
  header.appendChild(btn);
  card.appendChild(header);

  if (allEntries.length === 0) {
    card.appendChild(el('div', { class: 'empty' }, 'no entries in feeds (channel may be empty or blocked).'));
    root.appendChild(card);
    return;
  }
  const tbl = el('table');
  tbl.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, ''),
    el('th', {}, 'Thumb'),
    el('th', {}, 'Title'),
    el('th', {}, 'Kind'),
    el('th', {}, 'Published'),
    el('th', {}, 'Status'),
  )));
  const tbody = el('tbody');
  for (const e of allEntries) {
    const cb = el('input', { type: 'checkbox', 'data-vid': e.videoId });
    cb.checked = !e.alreadyPublished;
    cb.disabled = e.alreadyPublished;
    const status = e.alreadyPublished
      ? el('span', { class: 'pill dup' }, 'already published')
      : el('span', { class: 'pill ' + e.classification }, 'will publish');
    tbody.appendChild(el('tr', {},
      el('td', {}, cb),
      el('td', {}, el('img', { class: 'thumb', src: e.thumbnailUrl, loading: 'lazy' })),
      el('td', {}, el('a', { href: e.watchUrl, target: '_blank' }, e.title)),
      el('td', { class: 'kind-' + e.kind }, 'kind ' + e.kind + ' (' + e.classification + ')'),
      el('td', {}, fmtTs(e.publishedAtUnix)),
      el('td', {}, status),
    ));
  }
  tbl.appendChild(tbody);
  card.appendChild(tbl);
  root.appendChild(card);

  function getCheckedIds() {
    return Array.from(tbl.querySelectorAll('input[type=checkbox]:checked')).map((c) => c.dataset.vid);
  }
}

async function publishSelected(channelId, videoIds) {
  if (videoIds.length === 0) { toast('nothing selected'); return; }
  toast('publishing ' + videoIds.length + ' video(s)…');
  try {
    const shortsKind = parseInt(document.getElementById('preview-shorts-kind').value, 10);
    const r = await api('/admin/publish', {
      method: 'POST',
      body: JSON.stringify({
        channelId,
        videoIds,
        shortsKind,
        relayUrls: getRelays(),
      }),
    });
    toast('+' + r.published.longPublished + ' long, +' + r.published.shortPublished + ' short', 'ok');
    doPreview();
    loadChannels();
  } catch (e) { toast(e.message, 'error'); }
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

function renderPackChannels() {
  const root = document.getElementById('pack-channels');
  root.innerHTML = '';
  if (selectedForPack.size === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'go to Channels tab and tick some boxes.'));
    return;
  }
  const ul = el('table');
  ul.appendChild(el('thead', {}, el('tr', {}, el('th', {}, 'Channel id'), el('th', {}, 'npub'), el('th', {}))));
  const tbody = el('tbody');
  for (const id of selectedForPack) {
    const c = lastChannels.find((x) => x.channelId === id);
    const remove = el('button', {
      class: 'btn secondary', on: { click: () => { selectedForPack.delete(id); renderPackChannels(); renderChannels(); } },
    }, 'remove');
    tbody.appendChild(el('tr', {},
      el('td', {}, id),
      el('td', {}, el('span', { class: 'npub' }, c ? c.npub.slice(0, 16) + '…' : '(unknown)')),
      el('td', {}, remove),
    ));
  }
  ul.appendChild(tbody);
  root.appendChild(ul);
}

document.getElementById('bunker-url').value = getBunker();
document.getElementById('btn-save-bunker').addEventListener('click', () => {
  setBunker(document.getElementById('bunker-url').value.trim());
  toast('bunker URL saved', 'ok');
});

document.getElementById('btn-pack-build').addEventListener('click', async () => {
  const name = document.getElementById('pack-name').value.trim();
  const dTag = document.getElementById('pack-dtag').value.trim();
  const description = document.getElementById('pack-description').value.trim();
  const channelIds = Array.from(selectedForPack);
  const bunker = document.getElementById('bunker-url').value.trim();
  if (!name) return toast('name required');
  if (!dTag) return toast('d-tag required');
  if (channelIds.length === 0) return toast('select at least one channel');
  if (!bunker) return toast('bunker URL required');
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
    const sig = await signer.signEvent(tmpl);
    lastSignedPack = sig;
    document.getElementById('pack-event').textContent = JSON.stringify(sig, null, 2);
    document.getElementById('btn-pack-publish').disabled = false;
    toast('signed ✓', 'ok');
  } catch (e) {
    document.getElementById('pack-event').textContent = 'error: ' + e.message;
    toast(e.message, 'error');
  }
});

document.getElementById('btn-pack-publish').addEventListener('click', async () => {
  if (!lastSignedPack) return;
  try {
    const r = await api('/admin/follow-pack/publish', {
      method: 'POST',
      body: JSON.stringify({ event: lastSignedPack, relayUrls: getRelays() }),
    });
    toast('accepted by ' + r.accepted + '/' + r.relays.length + ' relays', r.accepted > 0 ? 'ok' : 'error');
  } catch (e) { toast(e.message, 'error'); }
});

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
