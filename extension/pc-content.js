/* Runs on PriceCharting pages you open from the tracker ("PriceCharting ↗" on a card). Saves the
   product name and price table to that auction, so the tracker can show its market value.
   PriceCharting blocks the extension from reading its pages in the background, so this reads the
   page you are looking at. Nothing is clicked. */
(function () {
  const m = location.hash.match(/pat=([\w-]+)/);
  try { if (m) sessionStorage.setItem('patId', m[1]); } catch {}
  let id = m ? m[1] : null;
  try { id = id || sessionStorage.getItem('patId'); } catch {}
  if (!id) return;
  const part = sel => { const el = document.querySelector(sel); return el ? el.outerHTML : ''; };
  const product = part('#product_name') && part('#price_data');
  const html = part('#product_name') + part('#price_data') + part('#games_table');
  if (!html) return;
  chrome.runtime.sendMessage({ type: 'pc-page', id, url: location.href.split('#')[0], html });
  const note = document.createElement('div');
  note.textContent = product ? 'Saved this price to your auction tracker ✓' : 'Pick the right product below and its price is saved to your auction tracker.';
  note.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#d62f3a;color:#fff;font:600 14px/1.3 system-ui,sans-serif;padding:10px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.3)';
  document.body.append(note);
  setTimeout(() => note.remove(), 6000);
})();
