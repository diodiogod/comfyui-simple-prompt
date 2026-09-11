/**
 * PG-Lazy-Prompt.js — v3.14
 * Build for in‑node "Lazy Prompt" (ComfyUI extension)
 *
 * What it does
 * - Adds an in‑node "History" button and a minimal searchable panel to re‑insert past prompts.
 * - Auto‑refreshes UI after writes to /simple_prompt/history/* endpoints (list/preview stays in sync).
 * - Optional auto‑layout from current node.size; manual CFG overrides still available.
 *
 * Key switches
 * - CFG.AUTO_FROM_NODE_SIZE = true → button positions/sizes derive from the node’s current size
 * - CFG.AUTO_RATIOS → tweak ratios without rebuilding the file
 * - Anchor mode: CFG.ANCHOR = 'between' | 'port' | 'fixed'
 *
 * How to override config at runtime (before this script runs):
 *   window.__SIMPLE_PROMPT_HISTORY_CFG = { DEBUG: true, ANCHOR: 'port' };
 *
 * Author: Piotr Gredka & GPT. License: MIT.
 */

import { app } from "../../scripts/app.js";

const PG_HISTORY_SYNC_EVENT = 'simple-prompt-history-changed';
const PG_HISTORY_SYNC_KEY = 'simple_prompt_history_changed_at';
const pgHistoryChannel = (() => {
  try { return new BroadcastChannel('simple-prompt-history'); } catch (_) { return null; }
})();
function dispatchHistoryChanged(detail){
  try { window.dispatchEvent(new CustomEvent(PG_HISTORY_SYNC_EVENT, { detail: detail || {} })); } catch (_) {}
}
function publishHistoryChanged(detail){
  dispatchHistoryChanged(detail);
  try { pgHistoryChannel?.postMessage(detail || {}); } catch (_) {}
  try { localStorage.setItem(PG_HISTORY_SYNC_KEY, String(Date.now())); } catch (_) {}
}
try { pgHistoryChannel?.addEventListener('message', function(ev){ dispatchHistoryChanged(ev.data); }); } catch (_) {}
window.addEventListener('storage', function(ev){
  if (ev.key === PG_HISTORY_SYNC_KEY) dispatchHistoryChanged({ source: 'storage' });
});

(function(){
  if (window.__SIMPLE_PROMPT_HISTORY_V314__) return; window.__SIMPLE_PROMPT_HISTORY_V314__ = true;
  
  // Auto‑refresh after saving to history (writing endpoints /simple_prompt/history/*)
  (function installPgHistoryAutoRefresh(){
    if (window.__SIMPLE_PROMPT_HISTORY_AUTOREFRESH__) return; window.__SIMPLE_PROMPT_HISTORY_AUTOREFRESH__ = true;
    var origFetch = window.fetch.bind(window);
    function isWrite(url, init){
      try{
        if (typeof url !== 'string') return false;
        if (url.indexOf('/simple_prompt/history/') !== 0) return false;
        var m = (init && (init.method||'GET')).toUpperCase();
        if (m !== 'POST' && m !== 'PUT' && m !== 'DELETE') return false;
        return /\/pg\/history\/rename(?:\?|$)/.test(url);
      }catch(_){ return false; }
    }
    function pickNode(){
      try{
        var g = app && app.graph; var c = app && app.canvas;
        var sel = (c && c.selected_nodes && c.selected_nodes[0]) || null;
        if (sel) return sel;
        var nodes = (g && g._nodes) || [];
        for (var i=0;i<nodes.length;i++){
          var n = nodes[i];
          if (n && n.widgets && findWidget(n,'history_select')) return n;
        }
      }catch(_){ }
      return null;
    }
    window.fetch = function(url, init){
      var p = origFetch(url, init);
      try{
        if (isWrite(url, init)){
          p.then(function(res){
            try{
              if (res && res.ok){
                publishHistoryChanged({ source: 'write' });
                var node = pickNode(); if (node) runRefresh(node);
              }
            }catch(_){ }
          }).catch(function(){});
        }
      }catch(_){ }
      return p;
    };
  })();

  // ---------------- CONFIG (you can override via window.__SIMPLE_PROMPT_HISTORY_CFG = {...}) ----------------
  var CFG = window.__SIMPLE_PROMPT_HISTORY_CFG = Object.assign({
    // Visibility filters (from v3.13)
    LIMIT_TO_NODE_WITH_SLOT: true,
    ONLY_FOR_NODE_ID: null,
    ONLY_FOR_TITLE_RX: null,

    // Anchor mode: 'between' | 'port' | 'fixed'
    ANCHOR: 'port',

    // Manual constants (when AUTO_FROM_NODE_SIZE = false)
    X_LEFT: 30,
    Y_OFFSET: 10,
    GAP: 0,
    FIXED_X: 20,
    FIXED_Y: 120,
    BTN_W: 42,
    BTN_H: 24,
    PAD: 8,
    R: 6,
    FONT: '12px sans-serif',
    LABEL_HISTORY: 'History…',

    // Auto from node.size
    AUTO_FROM_NODE_SIZE: true,        // enable auto‑scaling
    AUTO_RATIOS: {                    // ratios relative to node.size
      X_LEFT: 0.33,                   // % of node width
      GAP: 0,                         // % of node height
      BTN_W: 0.32,                    // % of width
      BTN_H: 0.39,                    // % of height
      PAD:   0.50                     // % of width
    },
    AUTO_CLAMP: {                     // safe clamps
      X_LEFT: [25, 500],
      GAP:    [0, 0],
      BTN_W:  [22, 500],
      BTN_H:  [10, 24],
      PAD:    [6, 16]
    },

    DEBUG: false
  }, window.__SIMPLE_PROMPT_HISTORY_CFG || {});

  var DBG = !!CFG.DEBUG; function dbg(){ if (!DBG) return; try{ console.log.apply(console, ['[pg-history v3.14]'].concat(Array.prototype.slice.call(arguments))); }catch(_){ } }

  // ---------------- Helpers ----------------
  function app(){ return (window.app || null); }
  function graph(){ var a = app(); return a && a.graph ? a.graph : null; }
  function findWidget(node, name){ if (!node || !node.widgets) return null; for (var i=0;i<node.widgets.length;i++){ var w=node.widgets[i]; if (w && w.name===name) return w; } return null; }
  function get(node, key, def){ var w=findWidget(node,key); return (w&&typeof w.value!=='undefined')?w.value:def; }
  const PG_LAZY_NAMES = new Set([
    'SimplePromptStandalone', 'Simple Prompt (Standalone)',
  ]);
  function _norm(x){
    return (x == null ? '' : String(x));
  }
  function _collectNames(x){
    if (!x) return [];
    const out = [];
    out.push(_norm(x.comfyClass), _norm(x.type), _norm(x.name), _norm(x.title));
    const c = x.constructor || {};
    out.push(_norm(c.comfyClass), _norm(c.type), _norm(c.name), _norm(c.title));
    return out.filter(Boolean);
  }
  function _matchesAnyLazyName(x){
    return _collectNames(x).some(n => PG_LAZY_NAMES.has(n));
  }
  function isPgLazyPromptClass(x){
    return _matchesAnyLazyName(x);
  }
  const __isMaybeOurs = (nodeType, nodeData) => (
    _matchesAnyLazyName(nodeType) || _matchesAnyLazyName(nodeData)
  );
  
  function _isCollapsed(n){ try { return !!(n && (n.flags?.collapsed || n.collapsed)); } catch(_) { return false; } }
  function setPreview(node, txt, opts){
    try{
      var s = String(txt == null ? '' : txt);
      var force = !!(opts && (opts.force || opts.clear));
      var singleLine = !/\n/.test(s);
      var shortish   = s.trim().length <= 160;
      var hasCue     = /(^\s*[✓✔✗✘]|\b(history|reloaded|loaded|saved|cleared|error|failed|ok|done|success)\b)/i.test(s);
      if (((singleLine && shortish && hasCue) || s.trim() === '') && !force){
        try{ console.debug('[PG history] status ignored for text fields:', s); }catch(_){ }
        return;
      }

      // Normal preview → split into POS / NEG by a line with "---"
      var parts = s.split(/\r?\n?-{3,}\r?\n?/);
      var pos = (parts[0] || '').trim();
      var neg = (parts.length > 1 ? parts.slice(1).join('\n---\n') : '').trim();

      function _findWidget(node, name){
        if (!node || !node.widgets) return null;
        for (var i=0; i<node.widgets.length; i++){
          var w = node.widgets[i];
          if (w && w.name === name) return w;
        }
        return null;
      }
      function _findByRegex(node, rx){
        if (!node || !node.widgets) return null;
        for (var i=0; i<node.widgets.length; i++){
          var w = node.widgets[i];
          if (w && typeof w.value === 'string' && rx.test(w.name)) return w;
        }
        return null;
      }

      var wPos = _findWidget(node, 'positive')
              || _findWidget(node, 'positive_text')
              || _findWidget(node, 'positive_prompt')
              || _findByRegex(node, /(^|[_-])pos(itive)?($|[_-])/i);

      var wNeg = _findWidget(node, 'negative')
              || _findWidget(node, 'negative_text')
              || _findWidget(node, 'negative_prompt')
              || _findByRegex(node, /(^|[_-])neg(ative)?($|[_-])/i);

      function _apply(w, val){
        try { w.value = String(val || ''); } catch(_){ }
        try { w.callback && w.callback(w.value, (window.app && window.app.canvas) || null, node, 0, 0); } catch(_){ }
        try { node && node.onWidgetChanged && node.onWidgetChanged(w, w.value); } catch(_){ }
      }

      if (wPos) _apply(wPos, pos);
      if (wNeg) _apply(wNeg, neg);

      try {
        var g = (window.app && window.app.graph) || null;
        g && g.setDirtyCanvas && g.setDirtyCanvas(true, true);
      } catch(_){ }
    }catch(_){ /* silent */ }
  }
  function pgNotifyStatus(msg){
    try { console.debug('[PG history]', msg); } catch(_){ }
  }
  function redraw(){ try{ graph()&&graph().setDirtyCanvas&&graph().setDirtyCanvas(true,true);}catch(_){} }
  function dedupe(a){ var m=Object.create(null),o=[]; for (var i=0;i<a.length;i++){ var v=String(a[i]); if(!m[v]){m[v]=1;o.push(v);} } return o; }
  function getHistoryPath(node){
    // The server preference is authoritative so every browser tab reads one shared file.
    return undefined;
  }
  function widgetInfo(node, name) {
    if (!node || !node.widgets) return null;
    var y = (typeof node.widgets_start_y === 'number') ? node.widgets_start_y : 0;
    for (var i = 0; i < node.widgets.length; i++) {
      var w = node.widgets[i];
      if (!w) continue;
      var sz = null;
      try {
        sz = w.computeSize ? w.computeSize(node.size ? node.size[0] : 220) : null;
      } catch (_) {}
      var h = (sz && sz[1]) ? sz[1] : 20;
      if (w.name === name) return { y: y, h: h };
      y += h + 4;
    }
    return null;
  }
  function clamp(v, a, b){ v = Math.round(v); if (a!=null && v<a) v=a; if (b!=null && v>b) v=b; return v; }
  function autoFromSize(node){
    var s = node && node.size ? node.size : [220,150];
    var W = Math.max(100, s[0]|0), H = Math.max(80, s[1]|0);
    var rx = CFG.AUTO_RATIOS, cl = CFG.AUTO_CLAMP;
    return {
      X_LEFT: clamp(W * (rx.X_LEFT||0.07), cl.X_LEFT[0], cl.X_LEFT[1]),
      GAP:    clamp(H * (rx.GAP||0.08),    cl.GAP[0],    cl.GAP[1]),
      BTN_W:  clamp(W * (rx.BTN_W||0.34),  cl.BTN_W[0],  cl.BTN_W[1]),
      BTN_H:  clamp(H * (rx.BTN_H||0.09),  cl.BTN_H[0],  cl.BTN_H[1]),
      PAD:    clamp(W * (rx.PAD||0.04),    cl.PAD[0],    cl.PAD[1])
    };
  }

  // ---------------- Candidate filter ----------------
  function titleMatches(node) {
    var rx = CFG.ONLY_FOR_TITLE_RX;
    if (!rx) return true;
    try {
      if (typeof rx === 'string') rx = new RegExp(rx, 'i');
      var t = (node && (node.title || node.type) || '') + '';
      return !!(rx && rx.test && rx.test(t));
    } catch (_) {
      return false;
    }
  }
  function hasHistorySignature(node){
    try{
      if (!node) return false;

      // 1) Fast path: class/type match
      var cls = (node.comfyClass || node.type || '').toString();
      if (PG_LAZY_NAMES.has(cls)) return true;

      // 2) Heuristic by widget names (works even if some optional widgets are gone)
      var W = Array.isArray(node.widgets) ? node.widgets : [];
      if (!W.length) return false;

      // Build a quick name lookup
      var names = new Set();
      for (var i=0;i<W.length;i++){ var w=W[i]; if (w && w.name) names.add(String(w.name)); }

      // Core fields that are stable in your node
      var hasPos = names.has('positive') || /(^|[_-])pos(itive)?($|[_-])/i.test(Array.from(names).join(','));
      var hasNeg = names.has('negative') || /(^|[_-])neg(ative)?($|[_-])/i.test(Array.from(names).join(','));
      var hasLens = names.has('lens');
      var hasAll  = names.has('all_parameters_on');

      // Do NOT require: history_path, max_entries, history_select (they may be removed)
      return (hasPos && hasNeg && hasLens && hasAll);
    }catch(_){ return false; }
  }
  function isTargetNode(node) {
    if (!node) return false;
    if (CFG.ONLY_FOR_NODE_ID != null) return node.id === CFG.ONLY_FOR_NODE_ID;
    if (!titleMatches(node)) return false;
    if (CFG.LIMIT_TO_NODE_WITH_SLOT) return hasHistorySignature(node);
    return true;
  }

  // ---------------- API ----------------
  function dedupeByKeyHash(items){
    try{
      const seen = new Set();
      const out = [];
      for (const it of (items||[])){
        const kh = (it && it.key_hash) || '';
        const key = kh ? 'kh:'+kh : 'lbl:' + ((it && it.label_short) || '');
        if (seen.has(key)) continue;
        seen.add(key); out.push(it);
      }
      return out;
    }catch(_){ return Array.isArray(items) ? items : []; }
  }
  // --- 1) apiList: your async style, with `objects:true`
  async function apiList(node, searchQuery, searchScope){
    const body = {
      history_path: getHistoryPath(node),
      objects: true,
    };
    if (searchQuery) {
      body.search_query = String(searchQuery).trim();
      body.search_scope = searchScope || 'all';
    }
    const r = await fetch('/simple_prompt/history/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(function(){ return null; });
    if (!(r.ok && j && j.ok && Array.isArray(j.items)))
      throw new Error((j && (j.message||j.error)) || ('HTTP '+r.status));
    return dedupeByKeyHash(j.items);
  }
  async function apiRevision(){
    const r = await fetch('/simple_prompt/history/revision', { method: 'POST' });
    const j = await r.json().catch(function(){ return null; });
    if (!(r.ok && j && j.ok)) throw new Error((j && j.message) || ('HTTP ' + r.status));
    return String(j.revision || 'missing');
  }
  async function apiHistoryStatus(){
    const r = await fetch('/simple_prompt/history/status', { method: 'POST' });
    const j = await r.json().catch(function(){ return null; });
    if (!(r.ok && j && j.ok)) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }
  async function apiExportHistory(){
    const r = await fetch('/simple_prompt/history/export', { method: 'POST' });
    const j = await r.json().catch(function(){ return null; });
    if (!(r.ok && j && j.ok && Array.isArray(j.items))) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }
  async function apiImportHistory(payload){
    const r = await fetch('/simple_prompt/history/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(function(){ return null; });
    if (!(r.ok && j && j.ok)) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }
  async function apiPreview(node, sel) {
    var body = { history_path: getHistoryPath(node), history_select: sel };
    var r = await fetch('/simple_prompt/history/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var j = await r.json().catch(function () { return null; });
    if (!(r.ok && j && j.ok)) throw new Error((j && j.message) || ('HTTP ' + r.status));
    return (j.preview_text || '');
  }
  async function apiRename(node, sel, customName) {
    var body = {
      history_path: getHistoryPath(node),
      history_select: sel,
      custom_name: String(customName || '').trim()
    };
    var r = await fetch('/simple_prompt/history/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var j = await r.json().catch(function () { return null; });
    if (!(r.ok && j && j.ok)) throw new Error((j && j.message) || ('HTTP ' + r.status));
    return (j.custom_name || '');
  }
  async function apiUngroup(keyHash) {
    var r = await fetch('/simple_prompt/history/ungroup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key_hash: keyHash })
    });
    var j = await r.json().catch(function () { return null; });
    if (!(r.ok && j && j.ok)) throw new Error((j && (j.message || j.error)) || ('HTTP ' + r.status));
  }
  function setLineage(node, item) {
    var values = {
      history_group_id: item ? (item.group_id || item.key_hash || '') : '',
      history_base_key: item ? (item.key_hash || '') : '',
      history_base_positive: item ? (item.positive || '') : '',
      history_lineage_nonce: (globalThis.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : (Date.now() + '-' + Math.random()),
    };
    Object.keys(values).forEach(function(name) {
      var widget = findWidget(node, name);
      if (widget) widget.value = values[name];
    });
  }
  // Helper: refresh list and preview
  function runRefresh(node){
    try{
      if (typeof apiList === 'function') {
        apiList(node).then(function(items){
          try{
            const hs = findWidget(node,'history_select');
            if(hs){
              if (Array.isArray(hs.options)) hs.options = items;
              if (Array.isArray(hs.values))  hs.values  = items;
              if (Array.isArray(items) && !items.includes(hs.value)) hs.value = (items[0] || 'none');
            }
          }catch(_){ }
          try{
            const hs = findWidget(node,'history_select');
            if(hs && hs.value && typeof apiPreview === 'function'){
              apiPreview(node, hs.value);
            }
          }catch(_){ }
        }).catch(function(){});
      }
    }catch(_){ }
  }
  // ---------------- Panel (new themable CSS for openPanelUI) ----------------
  ;(function css(){
    var ID = 'pg-history-panel-css-vNext';
    if (document.getElementById(ID)) return;
    var s = document.createElement('style'); s.id = ID;
    s.textContent = [
      // ===== Theme tokens you can override from outside =====
      ':root{',
      '  --pg-hist-width: 560px;',
      '  --pg-hist-radius: 12px;',
      '  --pg-hist-gap: 10px;',
      '  --pg-hist-overlay-bg: rgba(0,0,0,.28);',
      '  --pg-hist-card-bg: var(--comfy-menu-bg,#222);',
      '  --pg-hist-text: var(--comfy-text,#ddd);',
      '  --pg-hist-border: var(--comfy-input-border,#444);',
      '  --pg-hist-input-bg: var(--comfy-input-bg,#2a2a2a);',
      '  --pg-hist-hover: #333;',
      '  --pg-hist-shadow: 0 10px 30px rgba(0,0,0,.35);',
      '  --pg-hist-body-maxh: 42vh;',
      '}',

      // ===== Overlay & Card =====
      '.pg-hist-overlay{position:fixed;inset:0;z-index:9999;font-size:14px;background:var(--pg-hist-overlay-bg);}',
      '.pg-hist-card{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
      '  width:min(var(--pg-hist-width),calc(100vw - 32px));',
      '  color:var(--pg-hist-text);background:var(--pg-hist-card-bg);border:1px solid var(--pg-hist-border);',
      '  border-radius:var(--pg-hist-radius);box-shadow:var(--pg-hist-shadow);display:flex;flex-direction:column;overflow:hidden;}',

      // ===== Header =====
      '.pg-hist-header{display:flex;align-items:center;gap:var(--pg-hist-gap);padding:10px 12px;',
      '  border-bottom:1px solid var(--pg-hist-border);}',
      '.pg-hist-title{font-weight:500;opacity:.95;flex:1;}',
      '.pg-hist-filter{flex:1;min-width:120px;padding:6px 8px;border:1px solid var(--pg-hist-border);',
      '  background:var(--pg-hist-input-bg);color:var(--pg-hist-text);border-radius:8px;outline:none;}',
      '.pg-hist-filter::placeholder{opacity:.6;}',
      '.pg-hist-filter:focus{box-shadow:0 0 0 2px rgba(255,255,255,.08) inset;border-color:#666;}',
      '.pg-hist-view-toggle{flex:0 0 auto;padding:6px 9px;border:1px solid var(--pg-hist-border);background:var(--pg-hist-input-bg);color:var(--pg-hist-text);border-radius:8px;cursor:pointer;font-size:12px;white-space:nowrap;}',
      '.pg-hist-view-toggle:hover{filter:brightness(1.08);}',
      '.pg-hist-view-toggle[aria-pressed="true"]{border-color:#4db8ff;color:#8fd2ff;}',
      '.pg-hist-search-tools{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--pg-hist-border);min-height:30px;flex-wrap:wrap;}',
      '.pg-hist-search-label{font-size:11px;opacity:.65;white-space:nowrap;}',
      '.pg-hist-scopes{display:flex;gap:2px;padding:2px;background:rgba(0,0,0,.2);border-radius:7px;}',
      '.pg-hist-scope{border:0;background:transparent;color:var(--pg-hist-text);opacity:.65;padding:4px 7px;border-radius:5px;cursor:pointer;font-size:11px;}',
      '.pg-hist-scope.active{background:#315f78;color:#fff;opacity:1;}',
      '.pg-hist-chips{display:flex;gap:5px;flex-wrap:wrap;flex:0 0 100%;min-height:0;}',
      '.pg-hist-chips:empty{display:none;}',
      '.pg-hist-chip{border:1px solid rgba(77,184,255,.35);background:rgba(77,184,255,.1);color:#b9e4ff;border-radius:999px;padding:3px 7px;cursor:pointer;font-size:11px;}',
      '.pg-hist-chip.exclude{border-color:rgba(217,139,139,.45);background:rgba(217,139,139,.1);color:#e7aaaa;}',
      '.pg-hist-library-bar{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--pg-hist-border);font-size:11px;}',
      '.pg-hist-library-status{flex:1;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.pg-hist-library-action{border:0;background:transparent;color:#8fd2ff;cursor:pointer;padding:3px 5px;font-size:11px;}',
      '.pg-hist-library-action:hover{text-decoration:underline;}',
      '.pg-hist-suggestion{display:flex;justify-content:space-between;gap:8px;padding:6px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);font-size:13px;}',
      '.pg-hist-suggestion:hover{background:var(--pg-hist-hover);}',
      '.pg-hist-suggestion-source{opacity:.5;font-size:10px;text-transform:uppercase;}',

      // ===== Body / List =====
      '.pg-hist-body{height:var(--pg-hist-body-maxh);overflow:auto;}',
      '.pg-hist-list{display:block;}',
      '.pg-hist-row{padding:8px 10px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:8px;border-bottom:1px solid rgba(255,255,255,0.05);}',
      '.pg-hist-row-text{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.pg-hist-row-meta{flex-shrink:0;display:flex;gap:8px;align-items:center;font-size:11px;opacity:0.7;}',
      '.pg-hist-row-hits{color:#4db8ff;font-weight:500;}',
      '.pg-hist-row-score{flex-shrink:0;font-weight:500;color:#4db8ff;min-width:50px;text-align:right;font-size:12px;}',
      '.pg-hist-row:hover{background:var(--pg-hist-hover);}',
      '.pg-hist-row.selected{background:var(--pg-hist-hover);outline:2px solid #4db8ff;}',
      '.pg-hist-row-group{font-weight:600;background:rgba(77,184,255,.075);border-left:3px solid #4db8ff;padding-left:7px;}',
      '.pg-hist-row-group:hover{background:rgba(77,184,255,.13);}',
      '.pg-hist-row-child{position:relative;padding-left:34px;background:rgba(255,255,255,.018);}',
      '.pg-hist-row-child::before{content:"";position:absolute;left:17px;top:0;width:9px;height:50%;border-left:1px solid rgba(77,184,255,.45);border-bottom:1px solid rgba(77,184,255,.45);}',
      '.pg-hist-row-child.selected::before{border-color:#4db8ff;}',
      '.pg-hist-row-versions{padding:2px 6px;border-radius:999px;background:rgba(77,184,255,.16);color:#8fd2ff;font-weight:600;white-space:nowrap;}',
      '.pg-hist-row-note{padding:2px 6px;border-radius:999px;background:rgba(241,211,107,.13);color:#f1d36b;font-weight:600;white-space:nowrap;}',
      '.pg-hist-row-reveal{margin:4px 12px 7px 34px;padding:5px 8px;border:1px dashed rgba(77,184,255,.4);border-radius:6px;color:#8fd2ff;cursor:pointer;font-size:11px;text-align:center;}',
      '.pg-hist-diff{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.pg-hist-diff-added{color:#f1d36b;font-weight:600;}',
      '.pg-hist-diff-removed{color:#d98b8b;text-decoration:line-through;text-decoration-thickness:1px;}',
      '.pg-hist-diff-arrow{color:#888;padding:0 4px;}',
      '.pg-hist-diff-label{color:#999;font-size:11px;margin-right:5px;}',
      '.pg-hist-diff-base{color:#9ab6c7;font-style:italic;}',
      '.pg-hist-diff-muted{color:#999;font-style:italic;}',
      '.pg-hist-highlight{background-color:#4db8ff;color:#000;font-weight:500;padding:1px 2px;border-radius:2px;}',
      '.pg-hist-empty,.pg-hist-status{padding:10px 12px;opacity:.8;}',
      '.pg-hist-empty-help{padding:10px 12px;opacity:.6;font-size:12px;line-height:1.6;}',

      // ===== Preview Pane =====
      '.pg-hist-preview{border-top:1px solid var(--pg-hist-border);padding:10px 12px;max-height:150px;overflow:auto;background:rgba(0,0,0,0.2);}',
      '.pg-hist-preview-label{font-size:11px;opacity:0.7;margin-bottom:4px;font-weight:500;}',
      '.pg-hist-preview-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;}',
      '.pg-hist-match-nav{display:flex;align-items:center;gap:4px;font-size:11px;}',
      '.pg-hist-match-nav button{border:1px solid var(--pg-hist-border);background:var(--pg-hist-input-bg);color:var(--pg-hist-text);border-radius:5px;cursor:pointer;padding:1px 6px;}',
      '.pg-hist-highlight.active{outline:2px solid #f1d36b;outline-offset:1px;}',
      '.pg-hist-preview-text{font-size:13px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;}',

      // ===== Footer / Button =====
      '.pg-hist-footer{padding:10px 12px;border-top:1px solid var(--pg-hist-border);}',
      '.pg-hist-btn-row{display:flex;gap:8px;margin-bottom:8px;}',
      '.pg-hist-btn-row .pg-hist-btn{flex:1;width:auto;}',
      '.pg-hist-btn{display:block;width:100%;padding:6px 10px;border:1px solid var(--pg-hist-border);',
      '  background:var(--pg-hist-input-bg);color:var(--pg-hist-text);border-radius:8px;cursor:pointer;}',
      '.pg-hist-btn:hover{filter:brightness(1.06);}',
    ].join('\n');
    document.head.appendChild(s);
  })();

  // Helper function to highlight search terms in text
  function highlightTerms(text, query) {
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, function(ch) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
      });
    }
    var safeText = escapeHtml(text || '');
    if (!query || !text) return safeText;

    var matches = String(query).matchAll(/([+-]?)"([^"]+)"|([+-]?\S+)/g);
    var terms = [];
    for (var match of matches) {
      var raw = match[2] || match[3] || '';
      var operator = match[2] ? match[1] : (/^[+-]/.test(raw) ? raw[0] : '');
      var term = match[2] ? raw : (operator ? raw.slice(1) : raw);
      if (term && operator !== '-') terms.push(escapeHtml(term));
    }
    if (!terms.length) return safeText;

    var escaped = terms.map(function(term) {
      return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    var pattern = new RegExp('(' + escaped.join('|') + ')', 'gi');
    return safeText.replace(pattern, '<span class="pg-hist-highlight">$1</span>');
  }

  function _parseSearchQuery(query) {
    var tokens = [];
    var rx = /([+-]?)("[^"]+"|\S+)/g;
    var match;
    while ((match = rx.exec(String(query || '')))) {
      var raw = match[0];
      var operator = match[1] || '';
      var value = (match[2] || '').replace(/^"|"$/g, '').trim();
      if (value) tokens.push({ raw: raw, value: value, exclude: operator === '-', required: operator === '+' });
    }
    return tokens;
  }

  function _bestMatchSnippet(source, query) {
    source = String(source || '');
    var terms = _parseSearchQuery(query).filter(function(token){ return !token.exclude; });
    if (!source || !terms.length) return '';
    var folded = source.toLocaleLowerCase();
    var candidates = [];
    terms.forEach(function(token) {
      var needle = token.value.toLocaleLowerCase();
      var from = 0;
      while (needle && candidates.length < 100) {
        var index = folded.indexOf(needle, from);
        if (index < 0) break;
        candidates.push(index);
        from = index + Math.max(1, needle.length);
      }
    });
    if (!candidates.length) return '';
    var best = candidates[0];
    var bestCount = -1;
    candidates.forEach(function(index) {
      var start = Math.max(0, index - 55);
      var end = Math.min(source.length, index + 95);
      var windowText = folded.slice(start, end);
      var count = terms.reduce(function(total, token){
        return total + (windowText.includes(token.value.toLocaleLowerCase()) ? 1 : 0);
      }, 0);
      if (count > bestCount) { bestCount = count; best = index; }
    });
    var start = Math.max(0, best - 45);
    var end = Math.min(source.length, best + 105);
    return (start ? '…' : '') + source.slice(start, end).replace(/\s+/g, ' ') + (end < source.length ? '…' : '');
  }

  function _diffTokens(text) {
    return String(text || '').match(/\s+|[^\s]+/g) || [];
  }

  function _escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, function(ch) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch];
    });
  }

  function _compactDiffPart(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function _renderDiffText(text, query) {
    return query ? highlightTerms(text, query) : _escapeHtml(text);
  }

  // Compare adjacent versions and keep only changed phrases in the row.
  function _diffHtml(newerText, olderText, query) {
    var newer = _diffTokens(newerText);
    var older = _diffTokens(olderText);
    if (!newer.length && !older.length) return '';
    if (newer.join('') === older.join('')) return '';

    // Keep the UI responsive if an unusually large prompt is compared.
    if (newer.length > 600 || older.length > 600) {
      return '<span class="pg-hist-diff-added">' + _renderDiffText(_compactDiffPart(newerText), query) + '</span>';
    }

    var rows = Array.from({ length: older.length + 1 }, function(){
      return new Array(newer.length + 1).fill(0);
    });
    for (var i = older.length - 1; i >= 0; i--) {
      for (var j = newer.length - 1; j >= 0; j--) {
        rows[i][j] = older[i] === newer[j]
          ? rows[i + 1][j + 1] + 1
          : Math.max(rows[i + 1][j], rows[i][j + 1]);
      }
    }

    var removed = [];
    var added = [];
    var oi = 0;
    var ni = 0;
    while (oi < older.length && ni < newer.length) {
      if (older[oi] === newer[ni]) {
        oi++; ni++;
      } else if (rows[oi + 1][ni] >= rows[oi][ni + 1]) {
        removed.push(older[oi++]);
      } else {
        added.push(newer[ni++]);
      }
    }
    while (oi < older.length) removed.push(older[oi++]);
    while (ni < newer.length) added.push(newer[ni++]);

    var removedText = _compactDiffPart(removed.join(' '));
    var addedText = _compactDiffPart(added.join(' '));
    if (!removedText && !addedText) return '';
    var html = '';
    if (addedText) html += '<span class="pg-hist-diff-added">' + _renderDiffText(addedText, query) + '</span>';
    if (removedText && addedText) html += '<span class="pg-hist-diff-arrow">→</span>';
    if (removedText) html += '<span class="pg-hist-diff-removed">' + _renderDiffText(removedText, query) + '</span>';
    return html;
  }

  function _variationDiffHtml(item, older, query) {
    if (!older) return '<span class="pg-hist-diff-base">Base prompt</span>';
    var positive = _diffHtml(item.positive, older.positive, query);
    var negative = _diffHtml(item.negative, older.negative, query);
    if (!positive && !negative) return '<span class="pg-hist-diff-muted">No visible text change</span>';
    var html = '';
    if (positive) html += '<span class="pg-hist-diff-label">Positive</span>' + positive;
    if (negative) {
      if (html) html += '<span class="pg-hist-diff-arrow">·</span>';
      html += '<span class="pg-hist-diff-label">Negative</span>' + negative;
    }
    return html;
  }

  function _variationDate(label) {
    var value = String(label || '');
    var separator = value.indexOf(' — ');
    return separator >= 0 ? value.slice(0, separator) : '';
  }

  function _variationBody(label) {
    var value = String(label || '');
    var separator = value.indexOf(' — ');
    return separator >= 0 ? value.slice(separator + 3) : value;
  }

  function _searchMatchSnippetHtml(item, query) {
    if (!query) return '';
    var source = item.matched_text || [item.positive || '', item.negative || ''].filter(Boolean).join(' --- ');
    var snippet = _bestMatchSnippet(source, query);
    if (!snippet) return '';
    return '<span class="pg-hist-diff-arrow">·</span><span class="pg-hist-diff-label">Match</span>'
      + highlightTerms(snippet, query);
  }

  function _inlineDiffHtml(newerText, olderText, query) {
    var newer = _diffTokens(newerText);
    var older = _diffTokens(olderText);
    if (newer.length > 600 || older.length > 600) return _renderDiffText(newerText, query);

    var rows = Array.from({ length: older.length + 1 }, function(){
      return new Array(newer.length + 1).fill(0);
    });
    for (var i = older.length - 1; i >= 0; i--) {
      for (var j = newer.length - 1; j >= 0; j--) {
        rows[i][j] = older[i] === newer[j]
          ? rows[i + 1][j + 1] + 1
          : Math.max(rows[i + 1][j], rows[i][j + 1]);
      }
    }

    var runs = [];
    function appendRun(type, text) {
      var last = runs[runs.length - 1];
      if (last && last.type === type) last.text += text;
      else runs.push({ type: type, text: text });
    }
    var oi = 0;
    var ni = 0;
    while (oi < older.length && ni < newer.length) {
      if (older[oi] === newer[ni]) {
        appendRun('same', newer[ni]);
        oi++; ni++;
      } else if (rows[oi + 1][ni] >= rows[oi][ni + 1]) {
        appendRun('removed', older[oi++]);
      } else {
        appendRun('added', newer[ni++]);
      }
    }
    while (oi < older.length) {
      appendRun('removed', older[oi++]);
    }
    while (ni < newer.length) {
      appendRun('added', newer[ni++]);
    }
    var html = runs.map(function(run) {
      var content = _renderDiffText(run.text, query);
      if (run.type === 'added') return '<span class="pg-hist-diff-added">' + content + '</span>';
      if (run.type === 'removed') return '<span class="pg-hist-diff-removed">' + content + '</span>';
      return content;
    }).join('');
    return html || '<span class="pg-hist-diff-muted">(empty)</span>';
  }

  function _inlineReviewHtml(item, older, query) {
    var html = '<span class="pg-hist-diff-label">Positive</span><br>'
      + _inlineDiffHtml(item.positive || '', older.positive || '', query);
    if (item.negative || older.negative) {
      html += '<br><span class="pg-hist-diff-label">Negative</span><br>'
        + _inlineDiffHtml(item.negative || '', older.negative || '', query);
    }
    return html;
  }

  function openPanelUI(node){
    // overlay & chrome
    var overlay = document.createElement('div'); overlay.className = 'pg-hist-overlay';
    var card    = document.createElement('div'); card.className    = 'pg-hist-card';
    var header  = document.createElement('div'); header.className  = 'pg-hist-header';
    var body    = document.createElement('div'); body.className    = 'pg-hist-body';
    var preview = document.createElement('div'); preview.className = 'pg-hist-preview'; preview.style.display = 'none';
    var footer  = document.createElement('div'); footer.className  = 'pg-hist-footer';
    var status  = document.createElement('div'); status.className  = 'pg-hist-status'; status.textContent = 'Loading…';

    // Preview pane structure
    var previewHead = document.createElement('div'); previewHead.className = 'pg-hist-preview-head';
    var previewLabel = document.createElement('div'); previewLabel.className = 'pg-hist-preview-label'; previewLabel.textContent = 'Preview:';
    var matchNav = document.createElement('div'); matchNav.className = 'pg-hist-match-nav'; matchNav.style.display = 'none';
    var matchPrev = document.createElement('button'); matchPrev.type = 'button'; matchPrev.textContent = '‹';
    var matchCount = document.createElement('span');
    var matchNext = document.createElement('button'); matchNext.type = 'button'; matchNext.textContent = '›';
    matchNav.appendChild(matchPrev); matchNav.appendChild(matchCount); matchNav.appendChild(matchNext);
    previewHead.appendChild(previewLabel); previewHead.appendChild(matchNav);
    var previewText = document.createElement('div'); previewText.className = 'pg-hist-preview-text';
    preview.appendChild(previewHead);
    preview.appendChild(previewText);

    // Header and search controls are separate so scopes clearly apply to the input.
    var title = document.createElement('div'); title.className = 'pg-hist-title'; title.textContent = 'History';

    // Wrapper for filter input + dropdown
    var filterWrapper = document.createElement('div');
    filterWrapper.style.position = 'relative';
    filterWrapper.style.flex = '1';
    filterWrapper.style.display = 'flex';

    var filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'pg-hist-filter';
    filter.placeholder = 'Search prompt history…';
    filter.autocapitalize = 'off'; filter.autocomplete = 'off'; filter.spellcheck = false;

    // Search history dropdown
    var searchHistoryDropdown = document.createElement('div');
    searchHistoryDropdown.style.position = 'absolute';
    searchHistoryDropdown.style.top = '100%';
    searchHistoryDropdown.style.left = '0';
    searchHistoryDropdown.style.right = '0';
    searchHistoryDropdown.style.background = 'var(--pg-hist-card-bg)';
    searchHistoryDropdown.style.border = '1px solid var(--pg-hist-border)';
    searchHistoryDropdown.style.borderTop = 'none';
    searchHistoryDropdown.style.borderRadius = '0 0 8px 8px';
    searchHistoryDropdown.style.maxHeight = '200px';
    searchHistoryDropdown.style.overflowY = 'auto';
    searchHistoryDropdown.style.display = 'none';
    searchHistoryDropdown.style.zIndex = '10000';

    filterWrapper.appendChild(filter);
    filterWrapper.appendChild(searchHistoryDropdown);

    var showDiff = true;
    try { showDiff = sessionStorage.getItem('simple_prompt_history_view') !== 'prompt'; } catch(_){ }
    var viewToggle = document.createElement('button');
    viewToggle.type = 'button';
    viewToggle.className = 'pg-hist-view-toggle';
    viewToggle.setAttribute('aria-pressed', String(showDiff));
    viewToggle.title = 'Switch between variation changes and prompt text';
    function updateViewToggle(){
      viewToggle.textContent = showDiff ? 'Changes' : 'Prompt';
      viewToggle.setAttribute('aria-pressed', String(showDiff));
    }
    updateViewToggle();
    viewToggle.onclick = function(){
      showDiff = !showDiff;
      try { sessionStorage.setItem('simple_prompt_history_view', showDiff ? 'changes' : 'prompt'); } catch(_){ }
      updateViewToggle();
      renderList();
    };

    // destroy helper
    function destroy(){
      // Save search history when closing popup
      var q = filter.value.trim();
      if (q) {
        saveSearchHistory(q);
      }
      try { document.removeEventListener('keydown', escHandler); } catch(_){ }
      try { document.removeEventListener('selectionchange', selectionChangeHandler); } catch(_){ }
      try { window.removeEventListener(PG_HISTORY_SYNC_EVENT, historySyncHandler); } catch(_){ }
      try { clearInterval(panelPoll); } catch(_){ }
      try { overlay.parentNode && overlay.parentNode.removeChild(overlay); } catch(_){ }
    }

    overlay.addEventListener('click', destroy);
    card.addEventListener('click', function(ev){ ev.stopPropagation(); });
    header.appendChild(title);
    header.appendChild(viewToggle);

    var searchTools = document.createElement('div'); searchTools.className = 'pg-hist-search-tools';
    var searchLabel = document.createElement('span'); searchLabel.className = 'pg-hist-search-label'; searchLabel.textContent = 'Search in:';
    var scopes = document.createElement('div'); scopes.className = 'pg-hist-scopes';
    var chips = document.createElement('div'); chips.className = 'pg-hist-chips';
    var searchScope = 'all';
    try { searchScope = sessionStorage.getItem('simple_prompt_search_scope') || 'all'; } catch(_){ }
    // "current" was the old normal-search scope; migrate it to the clearer "all" label.
    if (searchScope === 'current') searchScope = 'all';
    ['all', 'added', 'removed'].forEach(function(scopeName) {
      var button = document.createElement('button');
      button.type = 'button'; button.className = 'pg-hist-scope';
      button.textContent = scopeName[0].toUpperCase() + scopeName.slice(1);
      button.title = scopeName === 'all'
        ? 'Search names and text that exist in each saved prompt'
        : (scopeName === 'added'
          ? 'Search text introduced since the previous version'
          : 'Search text deleted since the previous version');
      button.dataset.scope = scopeName;
      button.onclick = function() {
        searchScope = scopeName;
        try { sessionStorage.setItem('simple_prompt_search_scope', scopeName); } catch(_){ }
        Array.from(scopes.children).forEach(function(child){ child.classList.toggle('active', child.dataset.scope === scopeName); });
        reloadPanel();
      };
      button.classList.toggle('active', scopeName === searchScope);
      scopes.appendChild(button);
    });
    searchTools.appendChild(searchLabel);
    searchTools.appendChild(scopes);
    searchTools.appendChild(filterWrapper);
    searchTools.appendChild(chips);

    var libraryBar = document.createElement('div'); libraryBar.className = 'pg-hist-library-bar';
    var libraryStatus = document.createElement('div'); libraryStatus.className = 'pg-hist-library-status';
    libraryStatus.textContent = 'Checking library…';
    var exportBtn = document.createElement('button'); exportBtn.type = 'button'; exportBtn.className = 'pg-hist-library-action'; exportBtn.textContent = 'Export';
    var importBtn = document.createElement('button'); importBtn.type = 'button'; importBtn.className = 'pg-hist-library-action'; importBtn.textContent = 'Import';
    var importInput = document.createElement('input'); importInput.type = 'file'; importInput.accept = '.json,application/json'; importInput.style.display = 'none';
    libraryBar.appendChild(libraryStatus); libraryBar.appendChild(exportBtn); libraryBar.appendChild(importBtn); libraryBar.appendChild(importInput);

    function refreshLibraryStatus() {
      apiHistoryStatus().then(function(info) {
        var saved = info.last_saved_at
          ? new Date(info.last_saved_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : 'not saved yet';
        libraryStatus.textContent = info.total + ' prompts · saved ' + saved + ' · backup ' + (info.backup_healthy ? 'healthy' : 'unavailable');
      }).catch(function(error) {
        libraryStatus.textContent = 'Library status unavailable: ' + ((error && error.message) || String(error));
      });
    }

    exportBtn.onclick = function() {
      exportBtn.disabled = true;
      exportBtn.textContent = 'Exporting…';
      apiExportHistory().then(function(payload) {
        var date = new Date();
        var stamp = date.toISOString().replace(/[:.]/g, '-');
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url; link.download = 'simple-prompt-history-' + stamp + '.json';
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(function(){ URL.revokeObjectURL(url); }, 0);
      }).catch(function(error) {
        status.textContent = 'Export failed: ' + ((error && error.message) || String(error));
        status.style.display = 'block';
      }).finally(function() {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Export';
      });
    };

    importBtn.onclick = function() { importInput.click(); };
    importInput.onchange = function() {
      var file = importInput.files && importInput.files[0];
      if (!file) return;
      if (!confirm('Import merges prompts into the current library and never deletes existing entries. Continue?')) {
        importInput.value = '';
        return;
      }
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      file.text().then(function(text) {
        return apiImportHistory(JSON.parse(text));
      }).then(function(result) {
        libraryStatus.textContent = 'Imported ' + result.added + ' new · updated ' + result.updated + ' · ' + result.total + ' total';
        publishHistoryChanged({ source: 'import' });
        return reloadPanel();
      }).catch(function(error) {
        status.textContent = 'Import failed: ' + ((error && error.message) || String(error));
        status.style.display = 'block';
      }).finally(function() {
        importInput.value = '';
        importBtn.disabled = false;
        importBtn.textContent = 'Import';
      });
    };

    // Search history management
    var SEARCH_HISTORY_KEY = 'simple_prompt_search_history';
    var MAX_SEARCH_HISTORY = 20;

    function getSearchHistory() {
      try {
        var stored = localStorage.getItem(SEARCH_HISTORY_KEY);
        if (stored) {
          var arr = JSON.parse(stored);
          return Array.isArray(arr) ? arr : [];
        }
      } catch(_) {}
      return [];
    }

    function saveSearchHistory(query) {
      if (!query || !query.trim()) return;
      try {
        var history = getSearchHistory();
        // Remove duplicate if exists
        history = history.filter(function(q) { return q !== query; });
        // Add to front
        history.unshift(query);
        // Limit size
        if (history.length > MAX_SEARCH_HISTORY) {
          history = history.slice(0, MAX_SEARCH_HISTORY);
        }
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
      } catch(_) {}
    }

    var GENERIC_SUGGESTION_WORDS = new Set(('the a an and or of in on at to with for from by is are was were this that photo photograph image high quality detailed highly ultra realistic cinematic camera shot lens lighting portrait masterpiece best resolution 4k 8k').split(' '));

    function localSuggestions() {
      var typed = filter.value.trim().toLocaleLowerCase();
      var values = [];
      var seen = new Set();
      function add(value, source, score) {
        value = String(value || '').trim();
        var folded = value.toLocaleLowerCase();
        if (!value || seen.has(folded) || (typed && folded === typed)) return;
        if (typed && !folded.includes(typed) && !folded.split(/\s+/).some(function(part){ return part.startsWith(typed.split(/\s+/).pop()); })) return;
        seen.add(folded); values.push({ value: value, source: source, score: score || 0 });
      }
      getSearchHistory().forEach(function(value, index){ add(value, 'recent', 100 - index); });
      var recentCount = values.length;
      var counts = new Map();
      var typedTerms = _parseSearchQuery(typed).filter(function(token){ return !token.exclude; }).map(function(token){ return token.value; });
      (libraryItems || []).forEach(function(item) {
        if (item.custom_name) add(item.custom_name, 'name', 90);
        var text = ((item.positive || '') + ' ' + (item.negative || '')).toLocaleLowerCase();
        var hasContext = !typedTerms.length || typedTerms.every(function(term){ return text.includes(term); });
        if (!hasContext) return;
        var unique = new Set(text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]{3,}/gu) || []);
        unique.forEach(function(word) {
          if (!GENERIC_SUGGESTION_WORDS.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
        });
      });
      Array.from(counts.entries()).sort(function(a,b){ return b[1] - a[1]; }).slice(0, 30).forEach(function(pair){
        if (typedTerms.some(function(term){ return term.toLocaleLowerCase() === pair[0]; })) return;
        var suggestion = typedTerms.length ? filter.value.trim() + ' ' + pair[0] : pair[0];
        add(suggestion, typedTerms.length ? 'paired' : 'frequent', 40 + pair[1]);
      });
      var recentVisible = Math.min(recentCount, 4);
      var otherVisible = 8 - recentVisible;
      return values.slice(0, recentVisible).concat(
        values.slice(recentCount).sort(function(a,b){ return b.score - a.score; }).slice(0, otherVisible)
      );
    }

    function showSearchSuggestions() {
      var suggestions = localSuggestions();
      if (!suggestions.length) {
        searchHistoryDropdown.style.display = 'none';
        return;
      }

      searchHistoryDropdown.innerHTML = '';
      suggestions.forEach(function(suggestion) {
        var item = document.createElement('div');
        item.className = 'pg-hist-suggestion';
        var value = document.createElement('span'); value.textContent = suggestion.value;
        var source = document.createElement('span'); source.className = 'pg-hist-suggestion-source'; source.textContent = suggestion.source;
        item.appendChild(value); item.appendChild(source);
        item.onclick = function() {
          filter.value = suggestion.value;
          searchHistoryDropdown.style.display = 'none';
          filter.dispatchEvent(new Event('input'));
          filter.focus();
        };
        searchHistoryDropdown.appendChild(item);
      });

      searchHistoryDropdown.style.display = 'block';
    }

    function hideSearchHistoryDropdown() {
      searchHistoryDropdown.style.display = 'none';
    }

    // Show dropdown on click (not focus, to avoid auto-opening)
    filter.addEventListener('click', function() {
      showSearchSuggestions();
    });

    // Hide dropdown on blur (with delay to allow clicks)
    filter.addEventListener('blur', function() {
      setTimeout(hideSearchHistoryDropdown, 200);
    });

    filter.addEventListener('input', function() {
      showSearchSuggestions();
    });

    // footer: Use button + New Prompt button
    var useBtn = document.createElement('button');
    useBtn.className = 'pg-hist-btn';
    useBtn.textContent = 'Use This Prompt';
    useBtn.style.marginBottom = '8px';
    useBtn.disabled = true;
    useBtn.style.opacity = '0.5';
    var selectedItem = null;

    useBtn.onclick = function(){
      if (!selectedItem) return;
      var kh = (selectedItem && selectedItem.key_hash) || '';
      var lbl = (selectedItem && selectedItem.label_short) || '';
      status.textContent = 'Loading…';
      var sel = kh || String(lbl);
      apiPreview(node, sel).then(function(txt){
        setLineage(node, selectedItem);
        try { setPreview(node, txt); } catch(_){ }
        destroy();
      }).catch(function(e){
        status.textContent = 'Error: ' + ((e && e.message) || String(e));
      });
    };

    var copyBtn = document.createElement('button');
    copyBtn.className = 'pg-hist-btn';
    copyBtn.textContent = 'Copy Positive Prompt';
    copyBtn.disabled = true;
    copyBtn.style.opacity = '0.5';

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function(resolve, reject) {
        var field = document.createElement('textarea');
        field.value = text;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        try {
          if (!document.execCommand('copy')) throw new Error('Clipboard copy was rejected');
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          field.remove();
        }
      });
    }

    copyBtn.onclick = function(){
      if (!selectedItem) return;
      var positive = String(selectedItem.positive || '');
      copyText(positive).then(function(){
        copyBtn.textContent = 'Copied Positive Prompt';
        setTimeout(function(){
          if (copyBtn) copyBtn.textContent = 'Copy Positive Prompt';
        }, 1200);
      }).catch(function(error){
        status.textContent = 'Copy failed: ' + ((error && error.message) || String(error));
      });
    };

    var copySelectionBtn = document.createElement('button');
    copySelectionBtn.className = 'pg-hist-btn';
    copySelectionBtn.textContent = 'Copy Selected Text';
    copySelectionBtn.disabled = true;
    copySelectionBtn.style.opacity = '0.5';
    var lastCleanSelection = '';

    function cleanSelectedPreviewText() {
      var selection = window.getSelection && window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
      if (!previewText.contains(selection.anchorNode) || !previewText.contains(selection.focusNode)) return '';
      var container = document.createElement('div');
      container.appendChild(selection.getRangeAt(0).cloneContents());
      container.querySelectorAll('.pg-hist-diff-removed,.pg-hist-diff-label').forEach(function(element){ element.remove(); });
      container.querySelectorAll('br').forEach(function(br){ br.replaceWith(document.createTextNode('\n')); });
      return String(container.textContent || '').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    }

    function selectionChangeHandler() {
      lastCleanSelection = cleanSelectedPreviewText();
      copySelectionBtn.disabled = !lastCleanSelection;
      copySelectionBtn.style.opacity = lastCleanSelection ? '1' : '0.5';
    }
    document.addEventListener('selectionchange', selectionChangeHandler);
    copySelectionBtn.onmousedown = function(event){ event.preventDefault(); };
    copySelectionBtn.onclick = function(){
      if (!lastCleanSelection) return;
      copyText(lastCleanSelection).then(function(){
        copySelectionBtn.textContent = 'Copied Selected Text';
        setTimeout(function(){
          if (copySelectionBtn) copySelectionBtn.textContent = 'Copy Selected Text';
        }, 1200);
      }).catch(function(error){
        status.textContent = 'Copy failed: ' + ((error && error.message) || String(error));
      });
    };

    var noneBtn = document.createElement('button');
    noneBtn.className = 'pg-hist-btn';
    noneBtn.textContent = 'New Prompt';
    noneBtn.onclick = function(){
      setLineage(node, null);
      try { setPreview(node, '', { force: true }); } catch(_) { }
      destroy();
    };

    var copyActions = document.createElement('div'); copyActions.className = 'pg-hist-btn-row';
    copyActions.appendChild(copyBtn); copyActions.appendChild(copySelectionBtn);
    footer.appendChild(useBtn);
    footer.appendChild(copyActions);
    footer.appendChild(noneBtn);

    // assemble
    card.appendChild(header);
    card.appendChild(searchTools);
    card.appendChild(libraryBar);
    card.appendChild(body);
    card.appendChild(preview);
    card.appendChild(footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    body.appendChild(status);

    // data & rendering
    var allItems = [];
    var libraryItems = [];
    var listEl = null;
    var selectedRowIndex = -1;
    var allRows = [];
    var filtered = [];
    var expandedGroups = new Set();
    var revealAllGroups = new Set();
    var refreshSerial = 0;
    var lastListSignature = null;
    var lastServerRevision = null;
    var previewMatchIndex = 0;

    function updatePreviewMatchNav(nextIndex) {
      var matches = Array.from(previewText.querySelectorAll('.pg-hist-highlight'));
      matches.forEach(function(match){ match.classList.remove('active'); });
      if (!matches.length) {
        matchNav.style.display = 'none';
        previewMatchIndex = 0;
        return;
      }
      previewMatchIndex = ((typeof nextIndex === 'number' ? nextIndex : 0) + matches.length) % matches.length;
      matches[previewMatchIndex].classList.add('active');
      matchCount.textContent = (previewMatchIndex + 1) + ' of ' + matches.length + ' matches';
      matchNav.style.display = 'flex';
      matches[previewMatchIndex].scrollIntoView({ block: 'nearest' });
    }
    matchPrev.onclick = function(){ updatePreviewMatchNav(previewMatchIndex - 1); };
    matchNext.onclick = function(){ updatePreviewMatchNav(previewMatchIndex + 1); };

    function reloadPanel(){
      var serial = ++refreshSerial;
      var q = filter.value.trim();
      var requests = q
        ? Promise.all([apiList(node), apiList(node, q, searchScope)])
        : apiList(node).then(function(items){ return [items, items]; });
      return requests.then(function(results){
        if (serial !== refreshSerial) return;
        libraryItems = Array.isArray(results[0]) ? results[0] : [];
        var nextItems = Array.isArray(results[1]) ? results[1] : [];
        var signature = searchScope + '\u0000' + q + '\u0000' + JSON.stringify(nextItems.map(function(it){
          return [it.key_hash, it.last_used_at, it.hits, it.custom_name, it.group_id, it.lineage_note, it.search_score];
        }));
        refreshLibraryStatus();
        if (signature === lastListSignature) return;
        lastListSignature = signature;
        allItems = nextItems;
        renderQueryChips();
        renderList();
        try { status.style.display = 'none'; } catch(_){ }
      }).catch(function(e){
        if (serial === refreshSerial) status.textContent = 'Error: ' + ((e && e.message) || String(e));
      });
    }

    function renderQueryChips() {
      chips.innerHTML = '';
      _parseSearchQuery(filter.value).forEach(function(token) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'pg-hist-chip' + (token.exclude ? ' exclude' : '');
        chip.textContent = (token.exclude ? 'exclude: ' : '') + token.value + ' ×';
        chip.title = 'Remove this search term';
        chip.onclick = function() {
          var value = filter.value;
          var index = value.indexOf(token.raw);
          if (index >= 0) filter.value = (value.slice(0, index) + value.slice(index + token.raw.length)).replace(/\s{2,}/g, ' ').trim();
          filter.dispatchEvent(new Event('input', { bubbles: true }));
          filter.focus();
        };
        chips.appendChild(chip);
      });
    }
    function historySyncHandler(){ reloadPanel(); }
    window.addEventListener(PG_HISTORY_SYNC_EVENT, historySyncHandler);
    // Executions write on the server. Poll cheap file metadata, then reload only after a change.
    function checkServerRevision(){
      apiRevision().then(function(revision){
        if (lastServerRevision !== revision) {
          lastServerRevision = revision;
          reloadPanel();
        }
      }).catch(function(){});
    }
    var panelPoll = setInterval(checkServerRevision, 1500);

    function renderList(){
      if (!listEl){
        listEl = document.createElement('div'); listEl.className = 'pg-hist-list';
        try { body.removeChild(status); } catch(_){ }
        body.innerHTML = '';
        body.appendChild(listEl);
      } else {
        listEl.innerHTML = '';
      }
      selectedRowIndex = -1;
      selectedItem = null;
      useBtn.disabled = true;
      useBtn.style.opacity = '0.5';
      copyBtn.disabled = true;
      copyBtn.style.opacity = '0.5';
      lastCleanSelection = '';
      copySelectionBtn.disabled = true;
      copySelectionBtn.style.opacity = '0.5';
      preview.style.display = 'none';
      allRows = [];
      var q = filter.value.trim();

      var groups = new Map();
      libraryItems.forEach(function(item){
        if (!item.group_id) return;
        if (!groups.has(item.group_id)) groups.set(item.group_id, []);
        groups.get(item.group_id).push(item);
      });
      groups.forEach(function(members){ members.sort(function(a,b){ return (b.last_used_at || 0) - (a.last_used_at || 0); }); });
      var matchesByHash = new Map(allItems.map(function(item){ return [item.key_hash, item]; }));
      var seenGroups = new Set();
      filtered = [];
      allItems.forEach(function(item){
        var members = item.group_id ? (groups.get(item.group_id) || []) : [];
        if (members.length > 1) {
          if (seenGroups.has(item.group_id)) return;
          seenGroups.add(item.group_id);
          var matchingMembers = members.filter(function(member){ return matchesByHash.has(member.key_hash); }).map(function(member){
            return Object.assign({}, member, matchesByHash.get(member.key_hash));
          }).sort(function(a,b){ return (b.search_score || 0) - (a.search_score || 0) || (b.last_used_at || 0) - (a.last_used_at || 0); });
          var representative = q ? matchingMembers[0] : members[0];
          filtered.push({ kind: 'group', item: representative, members: members, matchingMembers: matchingMembers });
          if (expandedGroups.has(item.group_id)) {
            var visibleMembers = q && !revealAllGroups.has(item.group_id) ? matchingMembers : members;
            visibleMembers.forEach(function(member){
              filtered.push({ kind: 'child', item: member, members: members });
            });
            if (q && matchingMembers.length < members.length && !revealAllGroups.has(item.group_id)) {
              filtered.push({ kind: 'reveal', item: representative, members: members, hiddenCount: members.length - matchingMembers.length });
            }
          }
        } else {
          filtered.push({ kind: 'item', item: item, members: [item] });
        }
      });

      if (!filtered.length){
        var empty = document.createElement('div');
        empty.className = 'pg-hist-empty';
        empty.textContent = q ? 'No matches' : 'No history';
        listEl.appendChild(empty);
        var help = document.createElement('div');
        help.className = 'pg-hist-empty-help';
        help.innerHTML = q
          ? 'All words must match.<br>Use "quoted phrases" for exact text or -word to exclude a term.'
          : 'Prompts appear here after Simple Prompt runs in a workflow.';
        listEl.appendChild(help);
        return;
      }

      function selectRow(index) {
        var descriptor = filtered[index];
        if (!descriptor || descriptor.kind === 'group' || descriptor.kind === 'reveal') return;
        allRows.forEach(function(r) { r.classList.remove('selected'); });
        selectedRowIndex = index;
        var row = allRows[index];
        var item = descriptor.item;
        row.classList.add('selected');
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        selectedItem = item;
        useBtn.disabled = false;
        useBtn.style.opacity = '1';
        copyBtn.disabled = false;
        copyBtn.style.opacity = '1';
        lastCleanSelection = '';
        copySelectionBtn.disabled = true;
        copySelectionBtn.style.opacity = '0.5';
        var selectedMemberIndex = descriptor.members.findIndex(function(member){ return member.key_hash === item.key_hash; });
        var selectedOlder = descriptor.kind === 'child' && selectedMemberIndex >= 0
          ? descriptor.members[selectedMemberIndex + 1]
          : null;
        var previewContent = item.positive || '';
        if (item.negative) previewContent += '\n---\n' + item.negative;
        if (selectedOlder && showDiff) {
          previewText.innerHTML = _inlineReviewHtml(item, selectedOlder, q);
        } else if (q) {
          previewText.innerHTML = highlightTerms(previewContent || '(empty)', q);
        } else {
          previewText.textContent = previewContent || '(empty)';
        }
        preview.style.display = 'block';
        updatePreviewMatchNav(0);
      }

      filtered.forEach(function(descriptor, index){
        if (descriptor.kind === 'reveal') {
          var reveal = document.createElement('div'); reveal.className = 'pg-hist-row-reveal';
          reveal.textContent = 'Show ' + descriptor.hiddenCount + ' other ' + (descriptor.hiddenCount === 1 ? 'version' : 'versions');
          reveal.onclick = function(){ revealAllGroups.add(descriptor.item.group_id); renderList(); };
          allRows.push(reveal); listEl.appendChild(reveal); return;
        }
        var it = descriptor.item;
        var isGroup = descriptor.kind === 'group';
        var lbl = (it && (it.label_short || it)) || '';
        var kh = (it && it.key_hash) || '';
        var memberIndex = descriptor.members.findIndex(function(member){ return member.key_hash === it.key_hash; });
        var older = descriptor.kind === 'child' && memberIndex >= 0
          ? descriptor.members[memberIndex + 1]
          : null;
        var diffHtml = descriptor.kind === 'child' ? _variationDiffHtml(it, older, q) : '';
        if (descriptor.kind === 'child' && q && diffHtml.indexOf('pg-hist-highlight') < 0) {
          diffHtml += _searchMatchSnippetHtml(it, q);
        }
        var hits = isGroup
          ? descriptor.members.reduce(function(total, member){ return total + (member.hits || 0); }, 0)
          : ((it && it.hits) || 0);
        var row = document.createElement('div');
        row.className = 'pg-hist-row' + (isGroup ? ' pg-hist-row-group' : '') + (descriptor.kind === 'child' ? ' pg-hist-row-child' : '');
        row.title = isGroup
          ? (expandedGroups.has(it.group_id) ? 'Click to collapse group' : 'Click to expand group and select its newest version')
          : (descriptor.kind === 'child' ? String(lbl) + '\nRight-click to remove from this group' : String(lbl));

        var textSpan = document.createElement('div');
        textSpan.className = 'pg-hist-row-text' + (descriptor.kind === 'child' ? ' pg-hist-diff' : '');
        if (descriptor.kind === 'child') {
          var dateText = _variationDate(lbl);
          if (showDiff) {
            var date = _escapeHtml(dateText);
            textSpan.innerHTML = (date ? '<span class="pg-hist-diff-label">' + date + ' ·</span>' : '') + diffHtml;
          } else {
            textSpan.textContent = (dateText ? dateText + ' · ' : '') + _variationBody(lbl);
          }
        } else {
          textSpan.textContent = (isGroup ? (expandedGroups.has(it.group_id) ? '▾ ' : '▸ ') : '') + String(lbl);
        }
        row.appendChild(textSpan);

        var metaSpan = document.createElement('div');
        metaSpan.className = 'pg-hist-row-meta';
        var hasNewDirection = isGroup
          ? descriptor.members.some(function(member){ return member.lineage_note === 'new_direction'; })
          : it.lineage_note === 'new_direction';
        if (hasNewDirection) {
          var noteSpan = document.createElement('span');
          noteSpan.className = 'pg-hist-row-note';
          noteSpan.textContent = 'New direction';
          noteSpan.title = 'Started separately because the selected prompt was substantially rewritten';
          metaSpan.appendChild(noteSpan);
        }
        var hitsSpan = document.createElement('span');
        hitsSpan.className = 'pg-hist-row-hits';
        hitsSpan.textContent = hits + (hits === 1 ? ' use' : ' uses');
        metaSpan.appendChild(hitsSpan);
        if (isGroup) {
          var versionsSpan = document.createElement('span');
          versionsSpan.className = 'pg-hist-row-versions';
          versionsSpan.textContent = q
            ? ((descriptor.matchingMembers || []).length + ' matches · ' + descriptor.members.length + ' versions')
            : (descriptor.members.length + (descriptor.members.length === 1 ? ' version' : ' versions'));
          metaSpan.appendChild(versionsSpan);
        } else if (q && typeof it.search_score !== 'undefined') {
          var scoreSpan = document.createElement('div');
          scoreSpan.className = 'pg-hist-row-score';
          scoreSpan.textContent = Math.round(it.search_score) + '%';
          metaSpan.appendChild(scoreSpan);
        }
        row.appendChild(metaSpan);

        row.onclick = function(){
          if (isGroup) {
            var wasExpanded = expandedGroups.has(it.group_id);
            if (wasExpanded) expandedGroups.delete(it.group_id);
            else expandedGroups.add(it.group_id);
            renderList();
            if (!wasExpanded) {
              var firstChildIndex = filtered.findIndex(function(candidate){
                return candidate.kind === 'child'
                  && candidate.item
                  && candidate.item.group_id === it.group_id;
              });
              if (firstChildIndex >= 0) selectRow(firstChildIndex);
            }
            return;
          }
          selectRow(index);
        };
        if (!isGroup) {
          row.ondblclick = function(){
            status.textContent = 'Loading preview…';
            apiPreview(node, kh || String(lbl)).then(function(txt){
              setLineage(node, it);
              try { setPreview(node, txt); } catch(_){ }
              destroy();
            }).catch(function(e){
              status.textContent = 'Error: ' + ((e && e.message) || String(e));
            });
          };
          if (descriptor.kind === 'child') {
            row.oncontextmenu = function(ev){
              ev.preventDefault();
              ev.stopPropagation();
              if (!confirm('Remove this version from the group?')) return;
              apiUngroup(kh).then(function(){
                publishHistoryChanged({ source: 'ungroup' });
                reloadPanel();
              }).catch(function(e){
                status.textContent = 'Remove failed: ' + ((e && e.message) || String(e));
              });
            };
          }
        }
        allRows.push(row);
        listEl.appendChild(row);
      });

      if (q) {
        var firstSelectable = filtered.findIndex(function(item){ return item.kind !== 'group' && item.kind !== 'reveal'; });
        if (firstSelectable >= 0) selectRow(firstSelectable);
      }
    }

    // interactions
    var isDestroyed = false;
    function focusFilter(){
      if (isDestroyed || !overlay.parentNode) return;
      try { filter.focus({ preventScroll: true }); } catch(_){
        try { filter.focus(); } catch(__){ }
      }
    }
    function insertSearchCharacter(character){
      var start = typeof filter.selectionStart === 'number' ? filter.selectionStart : filter.value.length;
      var end = typeof filter.selectionEnd === 'number' ? filter.selectionEnd : start;
      filter.value = filter.value.slice(0, start) + character + filter.value.slice(end);
      var caret = start + character.length;
      try { filter.setSelectionRange(caret, caret); } catch(_){ }
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function moveSelection(direction){
      if (!allRows.length) return;
      var index = selectedRowIndex;
      for (var tries = 0; tries < allRows.length; tries++) {
        index = (index + direction + allRows.length) % allRows.length;
        if (filtered[index] && filtered[index].kind !== 'group' && filtered[index].kind !== 'reveal') {
          selectRow(index);
          return;
        }
      }
    }
    function keyHandler(ev){
      // Check if destroyed or if overlay no longer exists in DOM
      if (isDestroyed) return;
      if (!overlay.parentNode) {
        isDestroyed = true;
        try { document.removeEventListener('keydown', keyHandler); } catch(_){ }
        return;
      }

      if (
        ev.target !== filter
        && !ev.ctrlKey
        && !ev.metaKey
        && !ev.altKey
        && typeof ev.key === 'string'
        && ev.key.length === 1
      ) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        focusFilter();
        insertSearchCharacter(ev.key);
        return;
      }

      if (ev.key === 'Escape'){
        destroy();
      } else if (ev.key === 'ArrowDown'){
        ev.preventDefault();
        moveSelection(1);
      } else if (ev.key === 'ArrowUp'){
        ev.preventDefault();
        moveSelection(-1);
      } else if (ev.key === 'Enter'){
        ev.preventDefault();
        if (selectedRowIndex >= 0 && allRows[selectedRowIndex] && allRows[selectedRowIndex].ondblclick) {
          allRows[selectedRowIndex].ondblclick();
        } else {
          moveSelection(1);
        }
      }
    }
    document.addEventListener('keydown', keyHandler, true);

    // Update destroy to remove new handler
    var originalDestroy = destroy;
    destroy = function() {
      isDestroyed = true;
      try { document.removeEventListener('keydown', keyHandler, true); } catch(_){ }
      originalDestroy();
    };

    // Filter input: send search query to server and re-render
    var filterTimeout = null;
    filter.addEventListener('input', function(){
      clearTimeout(filterTimeout);
      filterTimeout = setTimeout(function(){
        var q = filter.value.trim();
        status.textContent = 'Searching…';
        if (q) saveSearchHistory(q);
        reloadPanel();
      }, 250);
    });

    filter.addEventListener('keydown', function(ev){
      // Allow Escape, Enter, and Arrow keys to bubble up to main handler
      if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === 'ArrowDown' || ev.key === 'ArrowUp'){
        // Don't stop propagation - let keyHandler handle it
        return;
      }
      ev.stopPropagation();
    });

    // load data
    checkServerRevision();
    focusFilter();
    requestAnimationFrame(focusFilter);
    setTimeout(focusFilter, 0);
    setTimeout(focusFilter, 80);
  }

  window.__SIMPLE_PROMPT_HISTORY_OPEN_PANEL = function(node){ try{ openPanelUI(node); }catch(e){ console.error('[PG history] open', e); } };

  // ---------------- Draw (auto‑size aware) ----------------
  function attachUI(node){
    if (!node || node.__pg_hist_ui_attached_v314) return;
    if (!isTargetNode(node)) { dbg('skip node', node && (node.title||node.type), 'id=', node && node.id); return; }

    ['history_group_id', 'history_base_key', 'history_base_positive', 'history_lineage_nonce'].forEach(function(name){
      var widget = findWidget(node, name);
      if (!widget) return;
      widget.hidden = true;
      widget.type = 'converted-widget';
      widget.computeSize = function(){ return [0, -4]; };
      widget.serializeValue = function(){ return widget.value; };
    });
    setLineage(node, null);

    function _isCollapsed(n){ try { return !!(n && (n.flags?.collapsed || n.collapsed)); } catch(_) { return false; } }

    function myDraw(ctx){
      try{
        const n = this || node;
        if (_isCollapsed(n)){
          try { n.__pg_hist_ui_hit = []; } catch(_) {}
          return;
        }

        var S = CFG.AUTO_FROM_NODE_SIZE ? autoFromSize(node) : null;
        var X_LEFT = (S?S.X_LEFT:CFG.X_LEFT),
            GAP    = (S?S.GAP:CFG.GAP),
            BTN_W  = (S?S.BTN_W:CFG.BTN_W),
            BTN_H  = (S?S.BTN_H:CFG.BTN_H),
            PAD    = (S?S.PAD:CFG.PAD),
            R      = CFG.R;

        var x, y;
        if (CFG.ANCHOR === 'fixed'){
          x = CFG.FIXED_X; y = CFG.FIXED_Y;
        } else if (CFG.ANCHOR === 'port'){
          if (typeof node.getSlotPos === 'function' && node.inputs){
            for (var i = 0; i < node.inputs.length; i++) {
              var p = node.inputs[i];
              if (p && p.name === 'positive') {
                var lp = node.getSlotPos(true, i);
                if (lp) { x = X_LEFT; y = Math.max(4, lp[1] - Math.floor(BTN_H / 2)); }
                break;
              }
            }
          }
        } else {
          var prev = widgetInfo(node,'positive');
          var pos  = widgetInfo(node,'negative');
          var yBelowPrev = prev ? (prev.y + prev.h) : null;
          var yAbovePos  = pos  ? (pos.y - BTN_H)  : null;
          if (yBelowPrev!=null && yAbovePos!=null) y = Math.min(Math.max(yBelowPrev, 4), yAbovePos);
          else if (yBelowPrev!=null) y = yBelowPrev; else y = yAbovePos;
          x = X_LEFT; y = (y==null? ((typeof node.widgets_start_y==='number')?node.widgets_start_y:0) + 8 : y);
        }
        y += (CFG.Y_OFFSET|0);
        if (typeof x !== 'number' || typeof y !== 'number'){
          x = X_LEFT; y = ((typeof node.widgets_start_y==='number')?node.widgets_start_y:0) + 8 + (CFG.Y_OFFSET|0);
        }

        function rrect(ctx, x, y, w, h, r) {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.quadraticCurveTo(x + w, y, x + w, y + r);
          ctx.lineTo(x + w, y + h - r);
          ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h);
          ctx.quadraticCurveTo(x, y + h, x, y + h - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        }

        var bx = x;
        ctx.save();
        ctx.font = CFG.FONT;
        rrect(ctx,bx,y,BTN_W,BTN_H,R);
        ctx.fillStyle='#2a2a2a'; ctx.fill();
        ctx.strokeStyle='#444'; ctx.stroke();
        ctx.fillStyle='#ddd';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.font=CFG.BTN_FONT||CFG.FONT;
        ctx.fillText(CFG.LABEL_HISTORY, bx+BTN_W/2, y+BTN_H/2);
        ctx.restore();

        node.__pg_hist_ui_hit = [ {x:bx,y:y,w:BTN_W,h:BTN_H,id:'panel'} ];
      }catch(e){ /* ignore */ }
    }

    // ---- Wrap draw (single wrapper) --------------------------------------
    var __prevFG = node.onDrawForeground;
    node.onDrawForeground = function(ctx){
      if (typeof __prevFG === 'function'){
        try { __prevFG.apply(this, arguments); } catch(_){ }
      }
      return myDraw.call(this, ctx);
    };

    // ---- Keepalive (single interval) -------------------------------------
    node.__pg_hist_ui_keepalive = setInterval(function(){
      try {
        const fn = node.onDrawForeground;
        if (!fn || fn.toString().indexOf('myDraw') === -1){
          const prev = fn;
          node.onDrawForeground = function(ctx){
            if (typeof prev === 'function'){
              try { prev.apply(this, arguments); } catch(_){ }
            }
            const n = this || node;
            if (_isCollapsed(n)){
              try { n.__pg_hist_ui_hit = []; } catch(_){ }
              return;
            }
            return myDraw.call(this, ctx);
          };
        }
      } catch(_){ }
    }, 1000);

    // ---- Hit‑test ---------------------------------------------------------
    var __prevMD = node.onMouseDown;
    node.onMouseDown = function (e, localPos, graphcanvas) {
      const n = this || node;
      if (_isCollapsed(n)){
        return (typeof __prevMD === 'function') ? __prevMD.apply(this, arguments) : undefined;
      }
      try {
        const hits = n.__pg_hist_ui_hit || [];
        if (Array.isArray(hits) && hits.length){
          const x = localPos[0], y = localPos[1];
          for (let i = 0; i < hits.length; i++){
            const b = hits[i];
            const inside = x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
            if (inside){
              if (b.id === 'refresh'){
                apiList(n).then(function(){ pgNotifyStatus(n, '✓ History reloaded'); redraw(); }).catch(function(){});
              } else if (b.id === 'panel'){
                (window.__SIMPLE_PROMPT_HISTORY_OPEN_PANEL || openPanelUI)(n);
              }
              return true;
            }
          }
        }
      } catch(_){ }
      return (typeof __prevMD === 'function') ? __prevMD.apply(this, arguments) : undefined;
    };
    node.__pg_hist_ui_attached_v314 = true;
  }

  function mount() {
    var g = graph();
    if (!g) return false;
    try {
      var nodes = Array.from(g._nodes || g.nodes || []);
      for (var i = 0; i < nodes.length; i++) attachUI(nodes[i]);
      if (!app().__simple_prompt_history_v314) {
        app().registerExtension({
          name: 'simple_prompt.history.v314',
          nodeCreated: function (n) {
            try { attachUI(n); } catch (_) {}
          }
        });
        app().__simple_prompt_history_v314 = true;
      }
      return true;
    } catch (e) {
      console.error('[PG history] mount', e);
      return false;
    }
  }

  var t0=Date.now(); (function wait(){ if (mount()) return; if (Date.now()-t0>20000){ console.warn('[pg-history] waiting for app.graph...'); } setTimeout(wait,150); })();
})();
