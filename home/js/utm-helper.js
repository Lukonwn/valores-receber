/**
 * Utmify & UTM Preservation Helper (v2.0)
 *
 * Regra de ouro: NUNCA alterar o caminho (pathname) de um link.
 * Um href relativo continua relativo; um href absoluto continua absoluto.
 * A versao anterior removia a barra inicial do pathname e transformava
 * "/home/consulta.html" em "home/consulta.html", que o browser resolvia
 * como "/home/home/consulta.html" -> 404 -> pixel/lead perdido no funil.
 *
 * O que este arquivo faz:
 *  1. Captura UTMs/xcod da URL e do storage (Utmify + este helper).
 *  2. Anexa os parametros de rastreamento aos links sem mexer no caminho.
 *  3. Expoe window.getMergedTrackingParams() para os redirecionamentos JS.
 *  4. Cobre links criados dinamicamente (MutationObserver).
 *  5. Cobre window.open() e location.assign()/location.replace().
 */
(function () {
  'use strict';

  var STORAGE_KEY = '__utm_tracking_data__';
  var TRACKING_KEYS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'src', 'sck', 'subid', 'subid2', 'subid3', 'subid4', 'subid5',
    'fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'kwai_click_id', 'xcod'
  ];
  var SKIP_PREFIXES = ['javascript:', 'mailto:', 'tel:', 'sms:', 'data:', 'blob:'];
  var HAS_TRACKING_RE = /[?&](utm_source|xcod|sck)=/i;

  /* ------------------------------------------------------------------ */
  /* Storage                                                              */
  /* ------------------------------------------------------------------ */

  function readStore(store, key) {
    try {
      var raw = store.getItem(key);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function writeStore(store, key, obj) {
    try { store.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  function getStoredParams() {
    var out = {};
    var stores = [];
    try { stores.push(window.localStorage); } catch (e) {}
    try { stores.push(window.sessionStorage); } catch (e) {}

    stores.forEach(function (store) {
      var obj = readStore(store, STORAGE_KEY);
      Object.keys(obj).forEach(function (k) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
      });
    });

    // A Utmify grava utm_source, utm_campaign, xcod... soltos no localStorage.
    TRACKING_KEYS.forEach(function (k) {
      try {
        var v = window.localStorage.getItem(k);
        if (v && !out[k]) out[k] = v;
      } catch (e) {}
    });

    return out;
  }

  var currentParams = new URLSearchParams(window.location.search);

  function mergeAll() {
    var merged = getStoredParams();
    currentParams.forEach(function (v, k) {
      if (v !== undefined && v !== null && v !== '') merged[k] = v;
    });
    return merged;
  }

  var stored = mergeAll();
  try { writeStore(window.localStorage, STORAGE_KEY, stored); } catch (e) {}
  try { writeStore(window.sessionStorage, STORAGE_KEY, stored); } catch (e) {}

  /**
   * Todos os parametros de rastreamento (URL atual + storage), ja prontos
   * para serem anexados a um redirect. Use nas trocas de pagina do funil:
   *   window.location.href = 'vsl.html?' + window.getMergedTrackingParams().toString();
   */
  window.getMergedTrackingParams = function () {
    var p = new URLSearchParams();
    var all = mergeAll();
    Object.keys(all).forEach(function (k) {
      if (all[k] !== undefined && all[k] !== null && all[k] !== '') p.set(k, all[k]);
    });
    return p;
  };

  /* ------------------------------------------------------------------ */
  /* Link rewriting (pathname intocavel)                                  */
  /* ------------------------------------------------------------------ */

  function isSkippable(href) {
    if (!href) return true;
    var h = String(href).trim();
    if (!h) return true;
    if (h.charAt(0) === '#') return true;
    var lower = h.toLowerCase();
    for (var i = 0; i < SKIP_PREFIXES.length; i++) {
      if (lower.indexOf(SKIP_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  function hasTracking(href) {
    return HAS_TRACKING_RE.test(href);
  }

  /**
   * Devolve o href com os parametros de rastreamento anexados.
   * O caminho original e preservado byte a byte; a query original tambem
   * (o xcod da Utmify tem caracteres especiais e nao pode ser re-encodado).
   */
  function buildTrackedHref(href) {
    var raw = String(href);

    var hashIndex = raw.indexOf('#');
    var hash = hashIndex === -1 ? '' : raw.slice(hashIndex);
    var withoutHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);

    var qIndex = withoutHash.indexOf('?');
    var path = qIndex === -1 ? withoutHash : withoutHash.slice(0, qIndex);
    var query = qIndex === -1 ? '' : withoutHash.slice(qIndex + 1);

    var existing = new URLSearchParams(query);
    var missing = new URLSearchParams();

    var tracking = window.getMergedTrackingParams();
    tracking.forEach(function (val, key) {
      if (val === undefined || val === null || val === '') return;
      if (!existing.has(key)) missing.set(key, val);
    });

    var extra = missing.toString();
    if (!extra) return raw;

    var sep = query ? '&' : '?';
    return path + sep + (query ? query + '&' : '') + extra + hash;
  }

  function processLink(link) {
    if (!link || link.tagName !== 'A') return;
    var href = link.getAttribute('href');
    if (isSkippable(href)) return;
    if (hasTracking(href)) return; // a Utmify ja enriqueceu esse link
    var tracked = buildTrackedHref(href);
    if (tracked !== href) link.setAttribute('href', tracked);
  }

  function processAll() {
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) processLink(links[i]);
  }

  /* ------------------------------------------------------------------ */
  /* Links dinamicos                                                      */
  /* ------------------------------------------------------------------ */

  function processNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'A') processLink(node);
    if (node.querySelectorAll) {
      var nested = node.querySelectorAll('a[href]');
      for (var i = 0; i < nested.length; i++) processLink(nested[i]);
    }
  }

  function startObserver() {
    if (!window.MutationObserver || !document.body) return;
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) processNode(added[j]);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ */
  /* Navegacoes programaticas                                              */
  /* ------------------------------------------------------------------ */

  var nativeOpen = window.open;
  window.open = function (url) {
    var target = arguments[1];
    var features = arguments[2];
    var finalUrl = url;
    if (typeof url === 'string' && !isSkippable(url) && !hasTracking(url)) {
      try { finalUrl = buildTrackedHref(url); } catch (e) { finalUrl = url; }
    }
    return nativeOpen.call(window, finalUrl, target, features);
  };

  if (window.Location && window.Location.prototype) {
    ['assign', 'replace'].forEach(function (method) {
      var original = window.Location.prototype[method];
      if (typeof original !== 'function') return;
      window.Location.prototype[method] = function (url) {
        var finalUrl = url;
        if (typeof url === 'string' && !isSkippable(url) && !hasTracking(url)) {
          try { finalUrl = buildTrackedHref(url); } catch (e) { finalUrl = url; }
        }
        return original.call(this, finalUrl);
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                 */
  /* ------------------------------------------------------------------ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      processAll();
      startObserver();
    });
  } else {
    processAll();
    startObserver();
  }
})();
