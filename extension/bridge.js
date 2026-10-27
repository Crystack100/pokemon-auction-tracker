/* Connects the tracker website to the Chrome extension. The extension's small helper on this site
   passes storage reads/writes and messages through, so the website can show the auctions the
   extension saved. Inside the extension itself (dashboard.html) the real chrome APIs are used. */
(function () {
  // Always fetch the newest reader and page code (no stale copies from the browser cache).
  const add = src => new Promise(res => { const s = document.createElement('script'); s.src = src + '?v=' + Date.now(); s.onload = s.onerror = res; document.body.append(s); });
  const load = () => add('parser.js').then(() => add('app.js'));
  if (window.chrome && chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id) return load();
  let n = 0;
  const pending = new Map();
  const changeFns = [];
  const call = (op, args) => new Promise((res, rej) => {
    const id = ++n;
    pending.set(id, { res, rej });
    window.postMessage({ pat: 'req', id, op, args }, location.origin);
  });
  window.addEventListener('message', e => {
    const d = e.source === window && e.data;
    if (!d) return;
    if (d.pat === 'res' && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error)) : p.res(d.result); }
    if (d.pat === 'changed') changeFns.forEach(f => f(d.changes, d.area));
  });
  const hello = async () => {
    for (let i = 0; i < 15; i++) {
      const r = await Promise.race([call('hello'), new Promise(r => setTimeout(() => r(null), 200))]);
      if (r) return r;
    }
    return null;
  };
  hello().then(info => {
    if (info) {
      window.patBridge = {
        storage: {
          local: { get: k => call('get', k === undefined ? null : k), set: o => call('set', o), remove: k => call('remove', k) },
          onChanged: { addListener: f => changeFns.push(f) },
        },
        runtime: { id: 'pat-bridge', sendMessage: m => call('send', m).catch(() => {}), getManifest: () => ({ version: info.version }) },
      };
    } else {
      document.documentElement.dataset.noExtension = '1';
    }
    load();
  });
})();
