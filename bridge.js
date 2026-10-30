// The UI speaks its existing API contract; every local request stays in this tab.
(() => {
  'use strict';
  const originalFetch = window.fetch.bind(window);
  const scriptUrl = document.currentScript?.src || new URL('./bridge.js', location.href).href;
  const worker = new Worker(new URL('./worker.js', scriptUrl), {type:'module'});
  const localPaths = new Set(['/api/state','/api/control','/api/config','/api/models','/api/check','/api/export','/api/import']);
  const pending = new Map();
  let sequence = 0, fatal = null, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve=resolve; readyReject=reject; });
  // The UI awaits individual requests too; keep an early initialization failure handled.
  ready.catch(() => {});
  function fail(message) {
    fatal = new Error(message || 'Не удалось запустить WebAssembly.');
    window.cellariumRuntimeError = fatal.message;
    readyReject(fatal);
    for (const request of pending.values()) request.reject(fatal);
    pending.clear();
    window.dispatchEvent(new CustomEvent('cellarium-runtime-error', {detail:fatal.message}));
  }
  worker.addEventListener('message', ({data}) => {
    if (data.type === 'ready') { readyResolve(data); return; }
    if (data.type === 'fatal') { fail(data.error); return; }
    if (data.type === 'persistence-warning') {
      window.dispatchEvent(new CustomEvent('cellarium-persistence-warning', {detail:data.error}));
      return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    request.resolve(new Response(JSON.stringify(data.body), {
      status:data.status || 200, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}
    }));
  });
  worker.addEventListener('error', event => fail(event.message || 'Ошибка загрузки WebAssembly worker.'));
  worker.addEventListener('messageerror', () => fail('Не удалось прочитать сообщение WebAssembly worker.'));
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (url.origin !== location.origin || !localPaths.has(url.pathname)) return originalFetch(input, init);
    if (fatal) throw fatal;
    let body = init.body;
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (body === undefined && input instanceof Request && method !== 'GET' && method !== 'HEAD') body = await input.clone().text();
    if (body && typeof body !== 'string') throw new Error('Локальный API ожидает JSON.');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      worker.postMessage({id, path:url.pathname, method, body:body || ''});
    });
  };
  window.cellariumWasm = {ready, worker, runtime:'WebAssembly'};
})();
