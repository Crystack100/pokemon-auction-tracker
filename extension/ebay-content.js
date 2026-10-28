/* Runs on eBay sold-listings pages opened from the tracker's "Get eBay average" link.
   It reads the sold prices on the page you're looking at and saves the average to that auction. */
(function () {
  const m = location.hash.match(/pat=([\w-]+)/);
  if (!m) return; // an ordinary eBay visit: do nothing
  const id = m[1];
  const query = new URLSearchParams(location.search).get('_nkw') || '';

  function badge(text) {
    let el = document.getElementById('pat-ebay-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pat-ebay-badge';
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#141a2b;color:#fff;padding:12px 16px;border-radius:10px;font:600 14px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:320px';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  async function run() {
    const key = 'auction:' + id;
    const a = (await chrome.storage.local.get(key))[key];
    if (!a) return badge('Pokémon Auction Tracker: that auction is no longer in your tracker.');
    const sales = EbaySold.parseSold(document.documentElement.outerHTML, query, a.grade);
    const s = EbaySold.summarise(sales);
    // Every matching sale with its date, so the tracker can work out the average itself (e.g. only recent sales).
    const list = sales.slice(0, 60).map(x => ({ price: x.price, soldDate: x.soldDate, title: x.title, url: x.url, currency: x.currency }));
    const result = s.count ? { status: 'ok', ...s, sales: list } : { status: 'none', sales: list };
    chrome.runtime.sendMessage({ type: 'ebay-result', id, result: { ...result, query, checkedAt: new Date().toISOString() } });
    badge(s.count
      ? `Saved ${list.length} sold listings to the tracker. It works out the average from the recent ones.`
      : 'Pokémon Auction Tracker: no matching sold listings on this page. Try other search words on the card.');
  }
  setTimeout(run, 1500); // let the results finish loading
})();
