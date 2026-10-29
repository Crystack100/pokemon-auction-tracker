/* Runs only on the tracker website. Lets that page read and update what this extension saved
   (the auctions you track, settings) and pass on button presses like Update all. */
(function () {
  const reply = (id, result, error) => window.postMessage({ pat: 'res', id, result, error }, location.origin);
  window.addEventListener('message', async e => {
    const d = e.source === window && e.data;
    if (!d || d.pat !== 'req') return;
    try {
      let result;
      if (d.op === 'hello') result = { version: chrome.runtime.getManifest().version };
      else if (d.op === 'get') result = await chrome.storage.local.get(d.args);
      else if (d.op === 'set') result = await chrome.storage.local.set(d.args);
      else if (d.op === 'remove') result = await chrome.storage.local.remove(d.args);
      else if (d.op === 'fetch') result = await chrome.runtime.sendMessage({ type: 'pc-fetch', url: d.args });
      else if (d.op === 'send') { chrome.runtime.sendMessage(d.args).catch(() => {}); result = true; }
      reply(d.id, result === undefined ? true : result);
    } catch (err) { reply(d.id, null, err.message); }
  });
  chrome.storage.onChanged.addListener((changes, area) => window.postMessage({ pat: 'changed', changes, area }, location.origin));
})();
