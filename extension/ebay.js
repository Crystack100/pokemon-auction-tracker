/* Reads eBay's sold-listings search page and works out the average sold price.
   Used by the eBay page script and by the tests. */
(function (root) {
  const strip = s => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const STOP = /^(the|and|of|holo|card|cards|pokemon|pokémon|tcg|x|1|a|with|in|for|new)$/;

  function searchUrl(query, site = 'au') {
    const host = site === 'us' ? 'www.ebay.com' : 'www.ebay.com.au';
    return `https://${host}/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=60${/\.com\.au$/.test(host) ? '&LH_PrefLoc=1' : ''}`;
  }

  // A listing counts as the same item when it has the grade (if any) and most of the search words.
  function matcher(query, grade) {
    const g = (grade || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const words = (query || '').toLowerCase().replace(g, ' ').split(/[^a-z0-9/#é]+/).filter(w => w.length > 1 && !STOP.test(w));
    return title => {
      const t = title.toLowerCase().replace(/\s+/g, ' ');
      if (g && !new RegExp(`\\b${g.replace('.', '\\.')}(?![\\d.])`).test(t)) return false;
      if (!words.length) return true;
      return words.filter(w => t.includes(w)).length / words.length >= 0.6;
    };
  }

  function parseSold(html, query, grade) {
    const ok = matcher(query, grade);
    const chunks = html.split(/<li\b[^>]*class="[^"]*\bs-(?:item|card)\b/).slice(1);
    const sales = [];
    for (const chunk of chunks) {
      const titleM = chunk.match(/class="[^"]*\bs-(?:item|card)__title\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|h3)>/);
      const priceM = chunk.match(/class="[^"]*\bs-(?:item|card)__price\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
      if (!titleM || !priceM) continue;
      const title = strip(titleM[1]).replace(/^New listing\s*/i, '');
      const priceText = strip(priceM[1]);
      if (/shop on ebay/i.test(title) || /\bto\b/i.test(priceText) || !ok(title)) continue;
      const price = parseFloat((priceText.match(/[\d,]+(?:\.\d{2})?/) || [''])[0].replace(/,/g, ''));
      if (!price) continue;
      const dateM = strip(chunk).match(/Sold\s+((?:\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})|(?:[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}))/);
      const linkM = chunk.match(/href="(https:\/\/www\.ebay\.com(?:\.au)?\/itm\/[^"?]+)/);
      sales.push({ title, price, currency: /US\s*\$/.test(priceText) ? 'USD' : 'AUD', soldDate: dateM ? dateM[1] : '', url: linkM ? linkM[1] : '' });
    }
    return sales;
  }

  // Average of the most recent sales (up to 10). With 5 or more, the highest and lowest are
  // left out so one odd sale doesn't skew it.
  function summarise(sales) {
    const recent = sales.slice(0, 10);
    if (!recent.length) return { count: 0 };
    let prices = recent.map(s => s.price).sort((a, b) => a - b);
    if (prices.length >= 5) prices = prices.slice(1, -1);
    const average = Math.round(prices.reduce((t, p) => t + p, 0) / prices.length);
    return { count: recent.length, average, price: average, latest: recent[0].price, soldDate: recent[0].soldDate, title: recent[0].title, itemUrl: recent[0].url, currency: recent[0].currency };
  }

  const api = { searchUrl, parseSold, summarise, matcher };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EbaySold = api;
})(typeof self !== 'undefined' ? self : globalThis);
