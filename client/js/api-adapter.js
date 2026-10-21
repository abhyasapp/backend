/* ═══════════════════════════════════════════════════════════════════════
   api-adapter.js — Supabase primary + GAS fallback with response normalization.

   Usage:
     const res = await ApiAdapter.call('login', { username, password });
     const res = await ApiAdapter.call('getfile', { fileId, username, token });

   Behaviour:
     1. Picks a primary backend per action.
        - Most actions → Supabase (primary backend for everything).
        - Reporting actions → GAS (the exception the product owner asked for;
          report.gs is the reporting system and it stays primary).
     2. On timeout / network error / non-2xx → falls back to the other backend.
     3. Normalizes response shapes so the caller never sees a difference:
        - getfile / getfiles: guarantees `content` (string) on every entry.
        - PDF endpoints: keeps both `url` and `base64` if either exists.
     4. Caches `?action=health` results for 60s so we don't spam.

   Known caveat (documented, not fixed by this file):
     Weekly-set JSON files and study PDFs physically live in Supabase Storage
     or Google Drive. Neither backend can read the other's files. A file
     uploaded via Supabase is readable only by Supabase; a file uploaded
     via GAS is readable only by GAS. When a content-management action
     (adminuploadweeklysetfile, adminuploadsubjectivefile, adminaddstudydoc)
     falls back to GAS, a `_fallbackUsed: 'gas'` flag is set on the response
     so the admin UI can warn the user.
   ═══════════════════════════════════════════════════════════════════════ */

window.ApiAdapter = (function () {
  'use strict';

  /* ── Config ────────────────────────────────────────────────────── */
  const CONFIG = {
    supabase: {
      baseUrl: 'https://kdysjiiefvxnkrykgykz.supabase.co/functions/v1/api', // FILL ME if different
    },
    gas: {
      baseUrl: 'https://script.google.com/macros/s/REPLACE_WITH_YOUR_DEPLOYMENT_ID/exec', // FILL ME
    },
    timeoutMs: 8000,
    healthCacheMs: 60 * 1000,
  };

  /* ── Routing table: which backend is primary per action ───────────
     Reporting actions are GAS-primary. Everything else is Supabase-primary.
     Any action not listed defaults to Supabase. */
  const GAS_PRIMARY_ACTIONS = new Set([
    // ── report.gs (the reporting system) ──
    'reportquestion',
    'getcorrections',
    'adminlistquestionreports',
    'listreports',                       // alias
    'adminupdatequestionreportstatus',
    'resolvereport',                     // alias
    'admindeletequestionreport',
    'admingetquestion',
    'adminupdatequestion',
    'adminmarkfilecorrected',
    'adminlistcorrections',
    'adminexportcorrections',
  ]);

  /* ── Content-management actions ───────────────────────────────────
     These create a file AND return a fileId that another action refers to.
     They must all hit the same backend so the fileId stays meaningful
     within that backend's storage. If a fallback happens, we attach a
     warning flag on the response. */
  const CONTENT_MANAGE_ACTIONS = new Set([
    'adminuploadweeklysetfile',
    'adminuploadsubjectivefile',
    'admincommitsubjectiveimport',
    'admincreateweeklyset',
    'adminupdateweeklyset',
    'admindeleteweeklyset',
    'adminaddstudydoc',
    'adminupdatestudydoc',
    'admindeletestudydoc',
    'adminreplacesubmissionpdf',
  ]);

  /* ── Low-level HTTP ─────────────────────────────────────────────── */
  function fetchWithTimeout(url, opts, ms) {
    return new Promise(function (resolve, reject) {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); reject(new Error('timeout')); }, ms);
      fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
        .then(function (resp) { clearTimeout(timer); resolve(resp); })
        .catch(function (err) { clearTimeout(timer); reject(err); });
    });
  }

  async function rawCall(backend, action, params) {
    const base = CONFIG[backend].baseUrl;
    const url = base + '?action=' + encodeURIComponent(action);
    const body = JSON.stringify(Object.assign({}, params, { action: action }));

    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    }, CONFIG.timeoutMs);

    if (!resp.ok && resp.status !== 200) {
      const err = new Error('HTTP ' + resp.status);
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json();
    if (!data || data.success === false) {
      const err = new Error((data && data.error) || 'backend error');
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ── Health cache ──────────────────────────────────────────────── */
  const healthCache = {
    supabase: { at: 0, ok: false },
    gas: { at: 0, ok: false },
  };

  async function isUp(backend) {
    const cache = healthCache[backend];
    const now = Date.now();
    if (now - cache.at < CONFIG.healthCacheMs) return cache.ok;
    try {
      const resp = await fetchWithTimeout(
        CONFIG[backend].baseUrl + '?action=health',
        { method: 'GET' },
        3000
      );
      const data = await resp.json();
      cache.ok = !!(data && data.success);
    } catch (e) {
      cache.ok = false;
    }
    cache.at = now;
    return cache.ok;
  }

  /* ── Response normalizers ──────────────────────────────────────── */

  function ensureContent(entry) {
    if (!entry || !entry.success) return entry;
    if (entry.content === undefined && entry.result !== undefined) {
      try { entry.content = JSON.stringify(entry.result); } catch (e) {}
    }
    return entry;
  }

  const NORMALIZERS = {
    getfile: function (data) {
      return ensureContent(data);
    },
    getfiles: function (data) {
      if (!data || !data.success || !data.files) return data;
      Object.keys(data.files).forEach(function (id) { ensureContent(data.files[id]); });
      return data;
    },
  };

  function passthrough(data) { return data; }

  /* ── Public call ───────────────────────────────────────────────── */
  async function call(action, params) {
    params = params || {};
    const primary = GAS_PRIMARY_ACTIONS.has(action) ? 'gas' : 'supabase';
    const fallback = primary === 'gas' ? 'supabase' : 'gas';

    let result = null;
    let primaryError = null;
    let usedFallback = false;

    try {
      result = await rawCall(primary, action, params);
    } catch (e) {
      primaryError = e;
      console.warn('[api] ' + primary + ' failed for "' + action + '": ' + (e.message || e));
    }

    if (!result) {
      try {
        result = await rawCall(fallback, action, params);
        usedFallback = true;
        console.warn('[api] fell back to ' + fallback + ' for "' + action + '"');
      } catch (e2) {
        console.error('[api] both backends failed for "' + action + '"', {
          primary: primaryError,
          fallback: e2,
        });
        throw e2;
      }
    }

    // Normalize shape so the caller never needs to know which backend answered.
    const normalizer = NORMALIZERS[action] || passthrough;
    result = normalizer(result);

    // Flag fallback usage on content-management actions so the admin UI
    // can warn about file-location implications (see header comment).
    if (usedFallback && CONTENT_MANAGE_ACTIONS.has(action)) {
      result._fallbackUsed = fallback;
    }

    return result;
  }

  return {
    call: call,
    isUp: isUp,
    // Expose internals so callers can pre-warm or test.
    _config: CONFIG,
    _gasPrimaryActions: GAS_PRIMARY_ACTIONS,
    _contentManageActions: CONTENT_MANAGE_ACTIONS,
  };
})();