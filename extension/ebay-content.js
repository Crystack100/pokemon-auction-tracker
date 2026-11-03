/* Runs on eBay sold-listings pages opened from the tracker's "Get eBay average" link.
   It reads the sold prices on the page you're looking at and saves the average to that auction. */
(function () {
  const m = location.hash.match(/pat=([\w-]+)/);
  if (!m) return; // an ordinary eBay visit: do nothing
  const id = m[1];
  const item = (location.hash.match(/[&#]pi=(\d+)/) || [])[1]; // one card of a several-card auction
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
    // eBay asking you to confirm you're a person: nothing to read. Tell the tracker (a "find all" run stops) and leave it to you.
    if (/pardon our interruption|captcha|verify (that )?you('| a)re (a )?human|security measure/i.test(document.title + ' ' + (document.body ? document.body.innerText.slice(0, 2000) : '')) && !document.querySelector('.srp-results, .s-item, .s-card')) {
      chrome.runtime.sendMessage({ type: 'ebay-blocked', id, item: item != null ? +item : null });
      return badge('Pokémon Auction Tracker: eBay wants to check you\'re a person. Do that here, then reload this page.');
    }
    const sales = EbaySold.parseSold(document.documentElement.outerHTML, query, a.grade);
    const s = EbaySold.summarise(sales);
    // Every matching sale with its date, so the tracker can work out the average itself (e.g. only recent sales).
    const list = sales.slice(0, 60).map(x => ({ price: x.price, soldDate: x.soldDate, title: x.title, url: x.url, currency: x.currency }));
    const result = s.count ? { status: 'ok', ...s, sales: list } : { status: 'none', sales: list };
    chrome.runtime.sendMessage({ type: 'ebay-result', id, item: item != null ? +item : null, result: { ...result, query, checkedAt: new Date().toISOString() } });
    badge(s.count
      ? `Saved ${list.length} sold listings to the tracker. It works out the average from the recent ones.`
      : 'Pokémon Auction Tracker: no matching sold listings on this page. Try other search words on the card.');
  }
  setTimeout(run, 1500); // let the results finish loading
})();
