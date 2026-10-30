/* Pokémon Auction Tracker: auction list, storage and the eBay comparison. Parsing lives in parser.js. */
(function () {
  // On the website, the extension is reached through bridge.js; inside the extension, directly.
  const chrome = window.patBridge || window.chrome;
  const P = window.AuctionParser;
  // Bump with every change to the website, so you can see which version you have open.
  const SITE_VERSION = '0.21.2';
  const $ = id => document.getElementById(id);
  const ZONE_CHOICES = [
    ['QLD', 'QLD (AEST, no daylight saving)'],
    ['NSW', 'NSW / ACT'],
    ['VIC', 'VIC'],
    ['TAS', 'TAS'],
    ['SA', 'SA'],
    ['NT', 'NT'],
    ['WA', 'WA'],
    ['NZ', 'New Zealand'],
  ];
  const EXAMPLE = `HUGE SAME DAY AUCTION! - ENDS 9:00pm TONIGHT QLD TIME 🔥
⭐️ MINT CONDITION PSA 10 GENGAR !!!! ⭐️
😮 NO RESERVE 😮
📦 POSTAGE - $15 TRACKED POSTAGE
📈 Bidding Rules:
➡️ Minimum $1 increments up to $50
➡️ Minimum $5 increments after $50
🕒 Auction ends:
📅 26/10/2026
QLD - 9:00pm
⚠️ Anti-snipe rule in place:
⏱️ +5 mins within the last 5 mins
Sidney Zabala
 ·
500
Reply
Brandon O'Connell
 ·
F
Reply`;

  let auctions = [];
  let store = null;
  let pendingImage = null;
  let parsed = null;

  /* ---------- storage: the artifact's shared database when available, else this browser ---------- */
  const LS_KEY = 'slabwatch.auctions.v1';
  function localStore() {
    const read = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
    const write = list => { try { localStorage.setItem(LS_KEY, JSON.stringify(list)); return true; } catch { return false; } };
    let listener = () => {};
    return {
      kind: 'local',
      subscribe(cb) { listener = cb; cb(read()); },
      async save(a) {
        const list = read().filter(x => x.id !== a.id); list.push(a);
        if (!write(list)) throw new Error('This browser would not save. The photo may be too large, or storage is blocked.');
        listener(list);
      },
      async remove(id) { const list = read().filter(x => x.id !== id); write(list); listener(list); },
    };
  }
  function dbStore(db) {
    const col = db.collection('auctions');
    return {
      kind: 'db',
      subscribe(cb, onErr) { col.onSnapshot(s => cb(s.docs.map(d => ({ ...d.data(), id: d.id }))), onErr); },
      save(a) { const { id, ...body } = a; return col.doc(id).set(JSON.parse(JSON.stringify(body))); },
      remove(id) { return col.doc(id).delete(); },
    };
  }
  // Chrome extension: one storage key per auction, so the dashboard and background never overwrite each other.
  function chromeStore() {
    const area = chrome.storage.local;
    const all = async () => Object.entries(await area.get(null)).filter(([k]) => k.startsWith('auction:')).map(([, v]) => v);
    return {
      kind: 'chrome',
      async subscribe(cb) {
        cb(await all());
        chrome.storage.onChanged.addListener(async (_c, name) => { if (name === 'local') cb(await all()); });
      },
      save(a) { return area.set({ ['auction:' + a.id]: a }); },
      // Change only these fields on the saved auction, so a change made meanwhile (an eBay or
      // PriceCharting result, new bids) isn't overwritten by this page's older copy.
      async patch(id, patch) { const k = 'auction:' + id; const cur = (await area.get(k))[k]; if (cur) await area.set({ [k]: { ...cur, ...patch } }); },
      remove(id) { return area.remove('auction:' + id); },
    };
  }
  const inExtension = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id;

  async function initStore() {
    if (inExtension) return chromeStore();
    if (window.claude && typeof window.claude.use === 'function') {
      try {
        const db = await Promise.race([window.claude.use('db'), new Promise(r => setTimeout(() => r(null), 8000))]);
        if (db) return dbStore(db);
      } catch { /* fall through to this browser */ }
    }
    return localStore();
  }

  /* ---------- helpers ---------- */
  const money = v => v == null || isNaN(v) ? '—' : '$' + Number(v).toLocaleString('en-AU', { maximumFractionDigits: 2 });
  const numOrNull = v => { const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return isNaN(n) ? null : n; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const zoneOf = label => P.ZONES[label] || P.ZONES.QLD;

  // datetime-local value (wall clock in the post's zone) <-> ISO instant
  function wallToIso(value, zoneLabel) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '');
    if (!m) return null;
    const off = P.zoneOffset(zoneOf(zoneLabel), +m[1], +m[2] - 1, +m[3]);
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - off * 60000).toISOString();
  }
  function isoToWall(iso, zoneLabel) {
    if (!iso) return '';
    const t = new Date(iso);
    const z = zoneOf(zoneLabel);
    let off = P.zoneOffset(z, t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    const w = new Date(t.getTime() + off * 60000);
    const pad = n => String(n).padStart(2, '0');
    return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
  }
  function zoneTimeText(iso, zoneLabel) {
    const wall = isoToWall(iso, zoneLabel);
    if (!wall) return '';
    const [d, t] = wall.split('T');
    const [y, mo, da] = d.split('-').map(Number);
    let [h, mi] = t.split(':').map(Number);
    const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    const day = new Date(Date.UTC(y, mo - 1, da)).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    return `${day}, ${h}:${String(mi).padStart(2, '0')}${ap} ${zoneLabel}`;
  }
  // The viewer's own region, named the way sellers write it (NSW, QLD...), from the computer's time zone.
  const REGION_BY_TZ = {
    'Australia/Sydney': 'NSW', 'Australia/Canberra': 'ACT', 'Australia/ACT': 'ACT', 'Australia/NSW': 'NSW', 'Australia/Melbourne': 'VIC', 'Australia/Victoria': 'VIC',
    'Australia/Hobart': 'TAS', 'Australia/Tasmania': 'TAS', 'Australia/Brisbane': 'QLD', 'Australia/Queensland': 'QLD', 'Australia/Lindeman': 'QLD',
    'Australia/Adelaide': 'SA', 'Australia/South': 'SA', 'Australia/Broken_Hill': 'NSW', 'Australia/Darwin': 'NT', 'Australia/North': 'NT',
    'Australia/Perth': 'WA', 'Australia/West': 'WA', 'Pacific/Auckland': 'NZ',
  };
  const viewerTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
  const viewerRegion = REGION_BY_TZ[viewerTz] || '';
  function localTimeText(iso) {
    const t = new Date(iso);
    const day = t.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    const time = t.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s/g, '').toLowerCase();
    const where = viewerRegion || t.toLocaleTimeString('en-AU', { timeZoneName: 'short' }).split(' ').pop();
    return `${day}, ${time} ${where}`;
  }
  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  }
// Photos you removed with "Not this post" in the photo viewer stay hidden.
const photoKey = u => String(u).split('?')[0].split('/').pop();
const photos = a => (a.images && a.images.length ? a.images : a.image ? [a.image] : []).filter(u => !(a.hiddenPhotos || []).includes(photoKey(u)));

function countdownText(iso) {
    if (!iso) return { text: 'No end time', soon: false, ended: false };
    let s = Math.floor((new Date(iso) - Date.now()) / 1000);
    if (s <= 0) return { text: 'Ended', soon: false, ended: true };
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); s %= 60;
    const text = d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s` : `${m}m ${String(s).padStart(2, '0')}s`;
    return { text, soon: !d && !h && m < 10, ended: false };
  }

  // Price you'd actually pay (bid + postage) against the last eBay sale.
  // A price typed in by hand wins over the automatic eBay lookup.
  // Market value: a value you typed in Fix details wins; then the eBay AU average of recent sales;
  // then PriceCharting (in AUD) when there's no eBay average. Times the quantity.
  const marketPrice = a => {
    if (a.ebaySold != null) return a.ebaySold;
    const m = ebayMarket(a); if (m) return m.average * qtyOf(a);
    const pc = pcPrice(a); return pc ? pc.aud * qtyOf(a) : null;
  };
  const qtyOf = a => (a.qty > 1 ? a.qty : 1);

  // eBay AU average, worked out from the sales the extension saved (with their sold dates):
  // the 10 most recent sales from the 90 days before the auction was posted (widened to 180 or
  // 365 days if there are fewer than 3), dropping the highest and lowest when there are 5 or more.
  const DAY = 86400e3;
  function ebayMarket(a) {
    const auto = a.ebayAuto || {};
    const all = (auto.sales || []).filter(s => s.currency !== 'USD' && s.price > 0).map(s => ({ ...s, t: Date.parse(s.soldDate) || null }));
    // Only sales of this exact card, when its number is known (eBay also lists near matches).
    let sales = a.cardNumber ? all.filter(s => sameNumber(s.title || '', a.cardNumber)) : all;
    // Raw card: leave out graded copies. Graded card: keep only the same grade (e.g. PSA 10).
    const gm = (a.grade || '').match(/^(\w+)\s*([\d.]+)$/);
    const before = sales.length;
    if (gm) sales = sales.filter(s => new RegExp(`\\b${gm[1]}\\s*${gm[2].replace('.', '\\.')}(?![\\d.])`, 'i').test(s.title || ''));
    else if (isSingleCard(a)) sales = sales.filter(s => !GRADED_TITLE.test(s.title || ''));
    const otherGrade = before - sales.length;
    // Searched as one item (a lot's price is one item's times the quantity): leave out lots and bundles ("3 ETBs total", "x2", "bundle"), which inflate the average.
    const beforeLots = sales.length;
    sales = sales.filter(s => !LOT_TITLE.test(s.title || '') && !lotQty(s.title || ''));
    const lots = beforeLots - sales.length;
    if (a.cardNumber && all.length && !sales.length) return null;
    if (!sales.length) return auto.average && auto.currency !== 'USD' ? { average: auto.average, count: auto.count, legacy: true } : null;
    const ref = new Date(a.addedAt || auto.checkedAt || Date.now()).getTime();
    let days = null, pool = [];
    for (const w of [90, 180, 365]) { pool = sales.filter(s => s.t && s.t >= ref - w * DAY); days = w; if (pool.length >= 3) break; }
    if (pool.length < 3) { pool = sales; days = null; }
    const used = [...pool].sort((x, y) => (y.t || 0) - (x.t || 0)).slice(0, 10);
    const byPrice = [...used].sort((x, y) => x.price - y.price);
    const dropped = byPrice.length >= 5 ? [byPrice[0], byPrice[byPrice.length - 1]] : [];
    const kept = byPrice.length >= 5 ? byPrice.slice(1, -1) : byPrice;
    const average = Math.round(kept.reduce((t, x) => t + x.price, 0) / kept.length);
    const times = used.map(x => x.t).filter(Boolean);
    return { average, used, kept, dropped, days, otherCards: all.length - sales.length - otherGrade - lots, otherGrade, lots, older: sales.length - pool.length, skipped: pool.length - used.length,
      from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) : null, count: used.length };
  }
  const shortDate = t => new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  function ebayExplain(a) {
    const m = ebayMarket(a);
    if (!m) return '';
    const q = qtyOf(a);
    const total = q > 1 ? ` × ${q} items = <strong>${money(m.average * q)}</strong>` : '';
    if (m.legacy) return `<span class="hint">eBay AU average <strong>${money(m.average)}</strong>${total} from the last ${m.count} sold. Open "eBay AU sold" again to recalculate it using sale dates.</span>`;
    const span = m.from ? `${shortDate(m.from)} – ${shortDate(m.to)}` : 'dates unknown';
    const how = [
      m.days ? `Used the ${m.count} most recent eBay AU sales from the ${m.days} days before this auction was posted (${span}).` : `Fewer than 3 sales in the last year, so used all ${m.count} found (${span}).`,
      m.otherGrade ? `Left out ${m.otherGrade} ${a.grade ? `sale${m.otherGrade === 1 ? '' : 's'} that weren't ${esc(a.grade)}` : `graded sale${m.otherGrade === 1 ? '' : 's'} (this card is ungraded)`}.` : '',
      m.lots ? `Left out ${m.lots} lot${m.lots === 1 ? '' : 's'} or bundle${m.lots === 1 ? '' : 's'} with more than one item.` : '',
      m.otherCards ? `Left out ${m.otherCards} sale${m.otherCards === 1 ? '' : 's'} of other cards (not number ${esc(a.cardNumber)}).` : '',
      m.older ? `Left out ${m.older} older sale${m.older === 1 ? '' : 's'}.` : '',
      m.skipped ? `Left out ${m.skipped} more from that period beyond the 10 most recent.` : '',
      m.dropped.length ? `Dropped the highest (${money(m.dropped[1].price)}) and lowest (${money(m.dropped[0].price)}) so one odd sale doesn't skew it.` : '',
      `Average of the remaining ${m.kept.length}: ${money(m.average)}.`,
      q > 1 ? `This lot has ${q} items, so the market value is ${money(m.average)} × ${q} = ${money(m.average * q)}.` : '',
    ].filter(Boolean).join(' ');
    const list = m.used.map(x => `<li${m.dropped.includes(x) ? ' class="dropped"' : ''}>${x.t ? shortDate(x.t) : '?'} · ${money(x.price)} · ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || 'listing')}</a>` : esc(x.title || '')}</li>`).join('');
    return `<span class="hint">eBay AU average <strong>${money(m.average)}</strong>${total} · ${m.count} sales, ${span}</span>
      <details class="how"><summary>How this was worked out</summary><p class="hint">${how}</p><ol class="sales">${list}</ol></details>`;
  }
  const endOf = a => a.extendedTo || a.endsAt;
  function verdict(a) {
    const market = marketPrice(a);
    // No bids yet counts as $0, so the card still compares against the eBay price.
    const bid = a.currentBid ?? a.startBid ?? (market ? 0 : null);
    if (bid == null) return { cls: 'none', text: 'No bids yet', ratio: null };
    const st = a.ebayAuto && a.ebayAuto.status;
    if (!market) return { cls: 'none', text: st === 'checking' ? 'Checking eBay…' : inExtension ? 'No market price yet' : 'Add a market value to compare', ratio: null };
    const total = bid;
    const ratio = total / market;
    const pct = Math.round(Math.abs(1 - ratio) * 100);
    const gap = money(Math.abs(market - total));
    if (ratio < 0.85) return { cls: 'good', text: `Under market by ${gap} (${pct}%)`, ratio, total };
    if (ratio <= 1.05) return { cls: 'warn', text: ratio < 1 ? `Near market: ${gap} under (${pct}%)` : `At market: ${gap} over (${pct}%)`, ratio, total };
    return { cls: 'bad', text: `Over market by ${gap} (${pct}%)`, ratio, total };
  }

  // The number as sellers write it in eBay titles: "RC22" for lettered numbers, "113/114" otherwise.
  // A single card (graded or with a card number), rather than sealed product like an ETB or booster box.
  const isSingleCard = a => !!(a.grade || a.cardNumber) && !/\b(etb|elite trainer|booster|box|bundle|tin|collection box|case|pack|sealed)\b/i.test(a.cardName || '');
  // eBay titles of graded copies: used to keep raw and graded sales apart.
  const GRADED_TITLE = /\b(PSA|BGS|CGC|TAG|ACE|SGC|Beckett|graded|slab(bed)?)\b/i;
  const LOT_TITLE = /\b(lot|bundle|bulk|joblot|job lot|set of \d+|\d+\s*(etbs|boxes|tins|packs|cards)|total|combo)\b|\b(and|&|\+)\s+\w+.*\b(etb|box)\b.*\b(etb|box)\b/i;
  const searchNo = n => !n ? '' : /[a-z]/i.test(n) ? n.split('/')[0] : n;
  // Card name plus its number; without a number, the set name narrows it down instead.
  // The name of one item: without the seller's lot label ("Lot 3") or the quantity ("3x", "x3", "Lot of 3"),
  // so eBay and PriceCharting are searched for a single one and the price is multiplied by the quantity.
  const LOT_LABEL = /^\s*(?:auction\s*)?lot\s*#?\s*\d{1,3}\b\s*[-–:.)]?\s*/i;
  const singleName = a => (a.cardName || '').replace(LOT_LABEL, '').replace(/\blot of \d{1,2}\b/i, '').replace(/(^|\s)\d{1,2}\s*[x×](?=\s)/i, ' ').replace(/\s[x×]\s?\d{1,2}\b/i, ' ').replace(/\s+/g, ' ').trim();
  function ebayQuery(a) { return (a.ebayQuery || `${singleName(a)} ${a.cardNumber ? searchNo(a.cardNumber) : a.setName || ''} ${a.grade || ''}`).replace(/\s+/g, ' ').trim(); }
  // Does an eBay listing title show this card's number? ("RC22/RC25" matches "RC22", "rc 22", "RC22/RC25")
  function sameNumber(title, n) {
    const [first, second] = n.split('/');
    const lm = first.match(/^([A-Z]*)0*(\d+)$/i);
    if (!lm) return true;
    const [, letters, digits] = lm;
    if (letters) return new RegExp(`(^|[^a-z])${letters}\\s?0*${digits}(?!\\d)`, 'i').test(title);
    const sm = second && second.match(/^([A-Z]*)0*(\d+)$/i);
    return new RegExp(`(^|[^\\d])0*${digits}\\s*\\/\\s*${sm ? sm[1] + '0*' + sm[2] : '\\d'}|#\\s*0*${digits}(?!\\d)`, 'i').test(title);
  }
  function marketLinks(a) {
    const q = encodeURIComponent(ebayQuery(a));
    return [
      // Opening eBay AU sold listings also saves their average to the card (read by the extension on that page).
      // Individual trading cards, filtered to graded (slabs) or ungraded (raw) sales to match this card.
      ['eBay AU sold', `https://www.ebay.com.au/sch/${isSingleCard(a) ? '183454/' : ''}i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=60${isSingleCard(a) ? '&Graded=' + (a.grade ? 'Yes' : 'No') : ''}${inExtension ? '#pat=' + a.id : ''}`],
      ['eBay US sold', `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1&_sop=13`],
      // Opening PriceCharting from here also saves its price to the card (read by the extension on that page).
      ['PriceCharting', (a.pc && a.pc.status === 'ok' && a.pc.url ? a.pc.url : pcSearchUrl(a)) + (inExtension ? '#pat=' + a.id : '')],
    ];
  }

  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, 420 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image this browser can read.')); };
      img.src = url;
    });
  }

  /* ---------- the add-auction bench ---------- */
  function fillZoneSelect(sel, value) {
    sel.innerHTML = ZONE_CHOICES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    const label = (zoneOf(value) || {}).label;
    sel.value = ZONE_CHOICES.some(([v]) => v === label) ? label : (label === 'ACT' ? 'NSW' : 'QLD');
  }

  function readBench() {
    parsed = $('raw').value.trim() ? P.parse($('raw').value) : null;
    const f = parsed || {};
    $('fCard').value = f.cardName || '';
    $('fGrade').value = f.grade || '';
    $('fBid').value = f.currentBid ?? '';
    $('fBidder').value = f.topBidder || '';
    $('fReserve').value = f.hasReserve === false ? 'No reserve' : f.reserve != null ? String(f.reserve) : f.hasReserve ? 'Yes, amount not stated' : '';
    $('fPost').value = f.postage ?? '';
    fillZoneSelect($('fZone'), f.zone || 'QLD');
    $('fEnds').value = isoToWall(f.endsAt, $('fZone').value);
    const notes = [];
    if (parsed) {
      notes.push(`${f.bidCount} bid${f.bidCount === 1 ? '' : 's'} found in ${f.commentCount} comment${f.commentCount === 1 ? '' : 's'}`);
      if (!f.endsAt) notes.push('no end time found');
      else if (f.assumedZone) notes.push('time zone not stated, assumed QLD');
    }
    $('parseNote').textContent = notes.join(' · ');
  }

  function setPendingImage(dataUrl) {
    pendingImage = dataUrl;
    $('drop').innerHTML = dataUrl ? `<img src="${dataUrl}" alt="Card photo"><span>Tap to change</span>` : `<span id="dropText">Card photo: paste a screenshot (Ctrl/Cmd+V), drop an image, or tap to choose</span>`;
  }

  function resetBench() {
    $('raw').value = ''; setPendingImage(null);
    ['fSeller', 'fSold'].forEach(id => { $(id).value = ''; });
    readBench();
  }

  async function addAuction() {
    const raw = $('raw').value.trim();
    if (!raw && !$('fCard').value.trim()) { $('parseNote').textContent = 'Paste a post first.'; return; }
    const f = parsed || {};
    const reserveText = $('fReserve').value.trim();
    const reserveNum = numOrNull(reserveText);
    const a = {
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      addedAt: new Date().toISOString(),
      raw,
      title: f.title || '',
      cardName: $('fCard').value.trim(),
      grade: $('fGrade').value.trim(),
      currentBid: numOrNull($('fBid').value),
      topBidder: $('fBidder').value.trim() || null,
      bidCount: f.bidCount || 0,
      startBid: f.startBid ?? null,
      buyNow: f.buyNow ?? null,
      hasReserve: !reserveText ? f.hasReserve ?? null : !/^no/i.test(reserveText),
      reserve: reserveNum,
      postage: numOrNull($('fPost').value),
      zone: $('fZone').value,
      endsAt: wallToIso($('fEnds').value, $('fZone').value),
      antiSnipe: !!f.antiSnipe,
      seller: $('fSeller').value.trim(),
      ebaySold: numOrNull($('fSold').value),
      image: pendingImage,
    };
    $('saveBtn').disabled = true;
    try { await store.save(a); resetBench(); $('parseNote').textContent = `Added ${a.cardName || 'auction'}.`; }
    catch (e) { $('parseNote').textContent = 'Not saved: ' + (e.message || e.code || 'try again.'); }
    finally { $('saveBtn').disabled = false; }
  }

  /* ---------- the list ---------- */
  /* ---------- PriceCharting ----------
     The extension reads PriceCharting's page for this item (the site blocks reading it from here
     directly), and this page picks the matching product and the price for its grade. Prices are in
     US dollars and converted to AUD. Results are saved on the auction and refreshed every 12 hours. */
  const PC_LABELS = { used_price: 'Ungraded', complete_price: 'Grade 7', new_price: 'Grade 8', graded_price: 'Grade 9', box_only_price: 'Grade 9.5', manual_only_price: 'PSA 10' };
  let audPerUsd = null, audRateNote = '';
  async function loadRate() {
    for (const [url, get] of [['https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD', j => j.rates.AUD], ['https://open.er-api.com/v6/latest/USD', j => j.rates.AUD]]) {
      try { const r = await get(await (await fetch(url)).json()); if (r > 0.5 && r < 5) { audPerUsd = r; audRateNote = `US$1 = A$${r.toFixed(2)} today`; return; } } catch {}
    }
    audPerUsd = 1.52; audRateNote = 'US$1 ≈ A$1.52 (rate service unavailable)';
  }
  function pcQuery(a) {
    if (a.pcQuery) return a.pcQuery;
    const name = singleName(a).replace(/\b(PSA|BGS|CGC|TAG|ACE|SGC)\s*[\d.]+\b/gi, '').replace(/\bETB\b/i, 'Elite Trainer Box').replace(/\b(factory sealed|sealed|brand new|english)\b/gi, '');
    // PriceCharting writes card numbers as "#RC22" or "#113", so only the first part is searched.
    return `${name} ${a.cardNumber ? a.cardNumber.split('/')[0] : ''}`.replace(/\s+/g, ' ').trim();
  }
  const pcSearchUrl = a => `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(pcQuery(a))}`;
  const usd = t => { const n = parseFloat(String(t || '').replace(/[^\d.]/g, '')); return n > 0 ? n : null; };
  // One product page: its name, set, and the price under each column (Ungraded, Grade 9, PSA 10…).
  function pcReadProduct(doc, url) {
    const table = doc.querySelector('#price_data') || doc;
    if (doc.querySelector('#games_table') || !doc.querySelector('[id$="_price"]')) return null; // a search results page
    const heads = table === doc ? [] : [...table.querySelectorAll('thead th, tr:first-child th')].map(th => th.textContent.replace(/\s+/g, ' ').trim());
    const prices = {};
    const cells = [...table.querySelectorAll('td[id$="_price"]')].filter(td => PC_LABELS[td.id] || table !== doc);
    cells.forEach((td, i) => {
      const label = (heads.length === cells.length ? heads[i] : '') || PC_LABELS[td.id] || td.id;
      const v = usd((td.querySelector('.price, .js-price') || td).textContent);
      if (v && !(label in prices)) prices[label] = v;
    });
    const h1 = doc.querySelector('h1#product_name, #product_name, h1');
    const set = h1 && h1.querySelector('a') ? h1.querySelector('a').textContent.trim() : '';
    const name = h1 ? h1.childNodes[0].textContent.replace(/\s+/g, ' ').trim() : '';
    return { name, set, url, prices };
  }
  // Search results: pick the row that matches the card number, then the most words of the title and set.
  function pcPickRow(doc, a) {
    const rows = [...doc.querySelectorAll('#games_table tbody tr, table.hoverable-rows tbody tr')].map(tr => {
      const link = tr.querySelector('td.title a, a[href*="/game/"]');
      return link && { href: new URL(link.getAttribute('href'), 'https://www.pricecharting.com').href, title: link.textContent.trim(), set: (tr.querySelector('td.console') || {}).textContent || '' };
    }).filter(Boolean).filter(r => /pokemon/i.test(r.href + r.set));
    const words = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || [];
    const want = new Set(words(pcQuery(a)).concat(words(a.setName)));
    let best = null;
    for (const r of rows) {
      if (a.cardNumber && !sameNumber(r.title, a.cardNumber)) continue;
      const have = new Set(words(r.title + ' ' + r.set));
      let score = 0; want.forEach(w => { if (have.has(w)) score++; });
      if (!isSingleCard(a) && /\b(etb|elite trainer)\b/i.test(a.cardName || '') !== /elite trainer/i.test(r.title)) score -= 3;
      if (/japanese|chinese|korean/i.test(r.set) && !/japanese|chinese|korean/i.test(a.cardName + ' ' + a.setName)) score -= 2;
      if (!best || score > best.score) best = { ...r, score };
    }
    return best;
  }
  function pcGradeLabel(a, prices) {
    const labels = Object.keys(prices);
    const find = re => labels.find(l => re.test(l));
    const gm = (a.grade || '').match(/^(\w+)\s*([\d.]+)$/);
    if (gm) {
      const [, co, n] = gm;
      return find(new RegExp(`^${co}\\s*${n.replace('.', '\\.')}$`, 'i')) || (n === '10' ? null : find(new RegExp(`^grade\\s*${n.replace('.', '\\.')}$`, 'i'))) || null;
    }
    if (!isSingleCard(a)) return find(/sealed|^new/i) || find(/ungraded|loose/i) || labels[0] || null;
    return find(/ungraded|loose/i) || null;
  }
  // The PriceCharting price for this auction (one item), or null.
  function pcPrice(a) {
    const pc = a.pc;
    if (!pc || pc.status !== 'ok' || !pc.prices) return null;
    const label = pcGradeLabel(a, pc.prices);
    if (!label || !audPerUsd && !pc.rate) return null;
    const rate = audPerUsd || pc.rate;
    return { label, usd: pc.prices[label], aud: Math.round(pc.prices[label] * rate), rate };
  }
  const fetchPage = url => window.patBridge && window.patBridge.fetchPage ? window.patBridge.fetchPage(url) : chrome.runtime.sendMessage({ type: 'pc-fetch', url });
  const pcBusy = new Set();
  async function pcLookup(a) {
    if (!inExtension || pcBusy.has(a.id)) return;
    pcBusy.add(a.id);
    const save = async pc => { const r = await chrome.storage.local.get('auction:' + a.id); const cur = r['auction:' + a.id]; if (cur) await chrome.storage.local.set({ ['auction:' + a.id]: { ...cur, pc } }); };
    const query = pcQuery(a);
    try {
      const get = async url => { const r = await fetchPage(url); if (!r || typeof r !== 'object') throw new Error('old-extension'); if (r.error || r.status >= 400) throw new Error(r.error || 'PriceCharting answered ' + r.status); return { doc: new DOMParser().parseFromString(r.text, 'text/html'), url: r.url || url }; };
      let { doc, url } = await get(pcSearchUrl(a));
      let product = pcReadProduct(doc, url);
      if (!product) {
        const row = pcPickRow(doc, a);
        if (!row) { await save({ status: 'none', query, checkedAt: new Date().toISOString() }); return; }
        ({ doc, url } = await get(row.href));
        product = pcReadProduct(doc, url);
      }
      if (!product || !Object.keys(product.prices).length) { await save({ status: 'none', query, url, checkedAt: new Date().toISOString() }); return; }
      await save({ status: 'ok', query, ...product, rate: audPerUsd, checkedAt: new Date().toISOString() });
    } catch (e) {
      if (e.message === 'old-extension') { a.pcOld = true; return; }
      await save({ status: / 403$/.test(e.message) ? 'blocked' : 'error', query, error: e.message, checkedAt: new Date().toISOString() });
    } finally { pcBusy.delete(a.id); }
  }
  // A PriceCharting page you opened from a card: the extension saved its price table, read it here.
  async function pcFromPage(a) {
    const pg = a.pcPage;
    if (!pg || (a.pc && a.pc.pageAt === pg.at)) return;
    const doc = new DOMParser().parseFromString(pg.html || '', 'text/html');
    const product = pcReadProduct(doc, pg.url);
    const base = { source: 'page', pageAt: pg.at, query: pcQuery(a), checkedAt: pg.at };
    const pc = product && Object.keys(product.prices).length ? { status: 'ok', ...base, ...product, rate: audPerUsd }
      : { status: 'pick', ...base, url: pg.url };
    const r = await chrome.storage.local.get('auction:' + a.id); const cur = r['auction:' + a.id];
    if (cur) await chrome.storage.local.set({ ['auction:' + a.id]: { ...cur, pc } });
  }
  // Look up tracked auctions that have no PriceCharting price yet, or one older than 12 hours, one at a time.
  let pcRunning = false;
  async function pcQueue() {
    if (!inExtension || pcRunning) return;
    if (!audPerUsd) await loadRate();
    for (const a of auctions) if (a.pcPage) await pcFromPage(a);
    const extVer = (chrome.runtime.getManifest().version || '0').split('.').map(Number);
    if (extVer[0] === 0 && extVer[1] < 16) return; // needs extension 0.16.0
    pcRunning = true;
    try {
      if (!audPerUsd) await loadRate();
      // Prices read from a page you opened, or checks PriceCharting refused, wait until the search words change.
      const due = auctions.filter(a => isTracked(a) && !a.example && (!a.pc || a.pc.query !== pcQuery(a) ||
        (a.pc.source !== 'page' && a.pc.status !== 'blocked' && !/ 403$/.test(a.pc.error || '') && Date.now() - Date.parse(a.pc.checkedAt) > 12 * 3600e3)));
      for (const a of due) { await pcLookup(a); await new Promise(r => setTimeout(r, 1500)); }
    } finally { pcRunning = false; }
  }
  function pcExplain(a) {
    const pc = a.pc;
    if (!pc) return inExtension ? '<span class="hint">Checking PriceCharting…</span>' : '';
    if (pc.status !== 'ok' && ebayMarket(a)) return '';
    if (pc.status === 'blocked' || / 403$/.test(pc.error || '')) return `<span class="hint">PriceCharting doesn't allow automatic checks. Press "PriceCharting ↗" below once and its price is saved here.</span>`;
    if (pc.status === 'pick') return `<span class="hint">On the PriceCharting page, click the product that matches this auction and its price is saved here. If PriceCharting doesn't have it, the eBay AU average is used.</span>`;
    if (pc.status === 'error') return `<span class="hint">PriceCharting couldn't be read (${esc(pc.error)}). Open it with the link below.</span>`;
    if (pc.status === 'none') return `<span class="hint">No PriceCharting match for "${esc(pc.query)}". Change the search words in Fix details.</span>`;
    const p = pcPrice(a);
    const q = qtyOf(a);
    const all = Object.entries(pc.prices).map(([l, v]) => `${esc(l)} US${money(v)}`).join(' · ');
    if (!p) return `<span class="hint">PriceCharting has no ${esc(a.grade || 'ungraded')} price for <a href="${esc(pc.url)}" target="_blank" rel="noopener">${esc(pc.name)}</a>. ${all}</span>`;
    return `<span class="hint">PriceCharting <strong>${money(p.aud)}</strong>${ebayMarket(a) ? ' (for comparison; the eBay AU average is used)' : ''}${q > 1 ? ` × ${q} = <strong>${money(p.aud * q)}</strong>` : ''} · ${esc(p.label)}</span>
      <details class="how"><summary>How this was worked out</summary><p class="hint">Matched <a href="${esc(pc.url)}" target="_blank" rel="noopener">${esc(pc.name)}${pc.set ? ' (' + esc(pc.set) + ')' : ''}</a> on PriceCharting, searched as "${esc(pc.query)}". Its ${esc(p.label)} price is US${money(p.usd)}, which is ${money(p.aud)} at ${esc(audRateNote || `US$1 = A$${p.rate.toFixed(2)}`)}.${q > 1 ? ` This lot has ${q} items, so ${money(p.aud)} × ${q} = ${money(p.aud * q)}.` : ''} PriceCharting's price is its average of recent sold listings for that exact product and grade. Checked ${esc(ago(pc.checkedAt))}.</p><p class="hint">All its prices: ${all}</p></details>`;
  }
  function renderCard(a) {
    const cd = countdownText(endOf(a));
    const v = verdict(a);
    // Reserve: just the amount, green once the bid reaches it and red until then.
    const reserveMet = a.reserve != null && a.reserve > 0 ? (a.currentBid ?? 0) >= a.reserve : null;
    const reserve = a.reserve != null && a.reserve > 0 ? money(a.reserve) : a.hasReserve ? 'Amount unknown' : '$0';
    const fill = v.ratio == null ? 0 : Math.min(v.ratio / 1.5, 1) * 100;
    const fillColor = v.cls === 'good' ? 'var(--good)' : v.cls === 'bad' ? 'var(--bad)' : 'var(--warn)';
    const market = marketPrice(a);
    const auto = a.ebayAuto || {};
    const autoText = auto.average ? `eBay AU average ${money(auto.average)} from the last ${auto.count} sold` : auto.price ? `${auto.currency === 'USD' ? 'No Australian sales. eBay US: US' : 'eBay'} ${money(auto.price)}${auto.soldDate ? ', sold ' + esc(auto.soldDate) : ''}${auto.count > 1 ? ` · median of last ${auto.count}: ${money(auto.median)}` : ''}${auto.title ? `<br>Latest match: ${auto.itemUrl ? `<a href="${esc(auto.itemUrl)}" target="_blank" rel="noopener">${esc(auto.title)}</a>` : esc(auto.title)}` : ''}` :
auto.status === 'none' ? 'No matching eBay AU sales found. Try other search words, then open eBay AU sold again.' : inExtension ? 'Open "eBay AU sold" below. The Australian sold average is saved here once that page loads.' : '';
    const pics = photos(a);
    return `
    <article class="slab${cd.ended ? ' ended' : ''}" data-id="${a.id}">
      <div class="label">
        <span class="name">${esc(a.cardName || a.title || 'Untitled auction')}${a.cardNumber ? ` <small class="cardno">${esc(a.cardNumber)}</small>` : ''}${a.setName ? `<small class="setname">${esc(a.setName)}</small>` : ''}</span>
        <span class="label-end"><span class="grade">${esc(a.grade || '')}</span><button type="button" class="x" data-act="remove-now" aria-label="Remove ${esc(a.cardName || 'auction')}" title="Remove">✕</button></span>
      </div>
      <div class="window">
        <div class="gallery">
          <div class="photo" data-act="${pics.length ? 'zoom' : 'photo'}" data-i="0" role="button" tabindex="0" aria-label="${pics.length ? 'View photos' : 'Add card photo'}">${pics.length ? `<img src="${esc(pics[0])}" alt="${esc(a.cardName)}">${pics.length > 1 ? `<span class="count">${pics.length} photos</span>` : ''}` : 'Add photo'}</div>
          ${pics.length > 1 ? `<div class="strip">${pics.slice(1, 6).map((u, i) => `<img src="${esc(u)}" alt="" data-act="zoom" data-i="${i + 1}" loading="lazy">`).join('')}</div>` : ''}
        </div>
        <div class="price">
          ${a.example ? '<span class="example-tag">Example</span>' : ''}
          <span class="k">${a.currentBid == null && a.startBid != null ? 'Starting bid' : cd.ended ? 'Final bid' : 'Current bid'}</span>
          <span class="v">${money(a.currentBid ?? a.startBid ?? 0)}</span>
          <span class="who">${a.lateComments ? `${a.lateComments} comment${a.lateComments === 1 ? '' : 's'} after the end not counted · ` : ''}${a.bidCount || 0} bid${a.bidCount === 1 ? '' : 's'}${a.brokenBids ? ` (${a.brokenBids} under the minimum step not counted)` : ''}${a.commentsRead != null ? ` · ${a.commentsRead} comment${a.commentsRead === 1 ? '' : 's'} read` : ''}${a.lastSeenAt ? ' · updated ' + esc(ago(a.lastSeenAt)) : ''}</span>
          <span class="pill ${v.cls}">${v.text}</span>
        </div>
      </div>
      <div class="body">
        <dl>
          <dt>Reserve</dt><dd${reserveMet == null ? '' : ` class="${reserveMet ? 'met' : 'unmet'}" title="${reserveMet ? 'Reserve met' : 'Reserve not met yet'}"`}>${reserve}</dd>
          ${a.antiSnipe ? `<dt>Anti-snipe</dt><dd>+${a.antiSnipeMins || 5} min for bids in the last ${a.antiSnipeWindow || a.antiSnipeMins || 5} min</dd>` : ''}
        </dl>
        <div class="ends">
          <span class="countdown${cd.soon ? ' soon' : ''}" data-ends="${endOf(a) || ''}">${cd.text}</span>
          <span class="when">${endOf(a) ? (a.extendedTo ? `Extended by anti-snipe (was ${esc(localTimeText(a.endsAt))})<br>` : '') + esc(localTimeText(endOf(a))) : ''}</span>
        </div>
        ${a.fromSaved && !a.endsAt ? '<p class="hint">Added from your Facebook Saved folder. Its details fill in automatically, or as soon as you open the post on Facebook.</p>' : ''}
        <div class="market">
          
          ${v.ratio != null ? `<div class="bar" title="Line marks the market price"><i style="width:${fill}%;background:${fillColor}"></i><b></b></div>
` : ''}
          ${a.ebaySold != null ? `<span class="hint">Market value <strong>${money(a.ebaySold)}</strong> (typed in Fix details)</span>` : ''}
          ${a.cardNumber && (a.ebayAuto?.sales || []).length && !ebayMarket(a) ? `<span class="hint">None of the ${(a.ebayAuto.sales || []).length} eBay AU sales were card ${esc(a.cardNumber)}. Open "eBay AU sold" again: the search now includes the number.</span>` : ''}
          ${ebayMarket(a) ? ebayExplain(a) : autoText && !pcPrice(a) ? `<span class="hint">${autoText}</span>` : ''}${auto.checkedAt ? `<span class="hint">eBay checked ${esc(ago(auto.checkedAt))}</span>` : ''}
          ${pcExplain(a)}
          <div class="links">${/\/posts\/\d+/.test(a.postUrl || '') ? `<a href="${esc(a.postUrl)}" target="_blank" rel="noopener">Facebook post ↗</a>` : ''}${marketLinks(a).map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t} ↗</a>`).join('')}</div>
        </div>
        <details>
          <summary>Fix details</summary>
          ${inExtension ? '' : `<p class="hint">Copy the post again from Facebook with the newest comments and paste it here.</p>
          <textarea data-field="repaste" aria-label="Updated post"></textarea>`}
          <div class="fields" style="margin-top:8px">
            <label style="grid-column:1/-1">Title<input data-field="cardName" value="${esc(a.cardName || '')}"></label>
            <label>Grade<input data-field="grade" value="${esc(a.grade || '')}" placeholder="PSA 10"></label>
            <label>Set<input data-field="setName" value="${esc(a.setName || '')}" placeholder="Legendary Treasures"></label>
            <label>Card number<input data-field="cardNumber" value="${esc(a.cardNumber || '')}" placeholder="RC22/RC25"></label>
            <label>Current bid $<input data-field="currentBid" inputmode="decimal" value="${a.currentBid ?? ''}"></label>
            <label>Reserve $<input data-field="reserve" inputmode="decimal" value="${a.reserve ?? ''}" placeholder="${a.hasReserve === false ? 'No reserve' : ''}"></label>
            <label>Ends<input data-field="ends" type="datetime-local" value="${isoToWall(a.endsAt, a.zone || 'QLD')}"></label>
            <label>Quantity in lot<input data-field="qty" inputmode="numeric" value="${a.qty > 1 ? a.qty : ''}" placeholder="1"></label>
            <label>Market value $<input data-field="marketValue" inputmode="decimal" value="${a.ebaySold ?? ''}" placeholder="PriceCharting / eBay"></label>
            <label style="grid-column:1/-1">eBay search words<input data-field="ebayQuery" value="${esc(ebayQuery(a))}"></label>
            <label style="grid-column:1/-1">PriceCharting search words<input data-field="pcQuery" value="${esc(pcQuery(a))}"></label>
            <label>Time zone<select data-field="zone">${ZONE_CHOICES.map(([z, t]) => `<option value="${z}"${(a.zone || 'QLD') === z ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
          </div>
          <div class="foot" style="margin-top:8px">
            <button type="button" class="primary" data-act="update">Save</button>
            <span class="row">
              ${a.source === 'facebook' ? '<button type="button" data-act="untrack">Stop tracking</button>' : ''}
              <button type="button" data-act="delete">Remove</button>
              <button type="button" data-act="confirm-delete" class="primary" hidden>Yes, remove</button>
            </span>
          </div>
        </details>
      </div>
    </article>`;
  }

  // Auctions picked up from Facebook wait in "Found" until you choose to track them.
  const isFound = a => a.tracked === false && !a.dismissed;
  const isTracked = a => a.tracked !== false && !a.dismissed;

  function renderFoundRow(a) {
    const cd = countdownText(endOf(a));
    const v = verdict(a);
    return `<div class="found-row" data-id="${a.id}">
      <div class="thumb">${photos(a)[0] ? `<img src="${esc(photos(a)[0])}" alt="">` : ''}</div>
      <div class="found-main">
        <strong>${esc(a.cardName || a.title || 'Untitled auction')}${a.grade ? ' · ' + esc(a.grade) : ''}</strong>
        <span class="hint">${money(a.currentBid ?? a.startBid)}${a.seller ? ' · ' + esc(a.seller) : ''} · <span class="countdown" data-ends="${endOf(a) || ''}">${cd.text}</span>${a.postUrl ? ` · <a href="${esc(a.postUrl)}" target="_blank" rel="noopener">post ↗</a>` : ''}</span>
        <span class="pill ${v.cls}">${v.text}</span>
      </div>
      <div class="row">
        <button type="button" class="primary" data-act="track">Track</button>
        <button type="button" data-act="hide">Hide</button>
      </div>
    </div>`;
  }

  function renderFound() {
    const now = Date.now();
    const found = auctions.filter(a => isFound(a) && (!endOf(a) || new Date(endOf(a)) > now))
      .sort((a, b) => new Date(endOf(a) || 8e15) - new Date(endOf(b) || 8e15));
    $('foundSection').hidden = !found.length;
    $('foundCount').textContent = `(${found.length})`;
    $('foundList').innerHTML = found.map(renderFoundRow).join('');
  }

  // Undervalued view: every live tracked auction, ranked by how far the bid sits under the eBay average.
  // Ended view: tracked auctions that have finished, with the final bid against the eBay AU average.
  // The last update after the end (the tracker keeps checking for 10 minutes) records the final bid.
  function renderEnded() {
    const now = Date.now();
    const done = auctions.filter(a => isTracked(a) && endOf(a) && new Date(endOf(a)) <= now)
      .sort((x, y) => new Date(endOf(y)) - new Date(endOf(x)));
    $('endedNote').textContent = done.length
      ? `${done.length} finished auction${done.length === 1 ? '' : 's'} you tracked, with what each went for. Newest first. Remove one with ✕ on its card in Tracking (show "All, including ended").`
      : 'Auctions you track show up here once they finish, with what they went for.';
    $('endedList').innerHTML = done.length ? done.map(a => {
      const bid = a.currentBid ?? null;
      const avg = marketPrice(a);
      const reserveMissed = a.reserve > 0 && bid != null && bid < a.reserve;
      const result = bid == null ? '<span class="hint">No bids</span>'
        : reserveMissed ? `<span class="diff-bad">Reserve ${money(a.reserve)} not met</span>`
        : !avg ? '<span class="hint">Sold · no market price</span>'
        : `<span class="${bid <= avg ? 'diff-good' : 'diff-bad'}">Sold ${money(Math.abs(avg - bid))} ${bid <= avg ? 'under' : 'over'} (${Math.round(Math.abs(avg - bid) / avg * 100)}%)</span>`;
      const pic = photos(a)[0];
      const title = esc(a.cardName || 'Untitled auction') + (a.cardNumber ? ` <small class="hint">${esc(a.cardNumber)}</small>` : '');
      return `<tr>
        <td><div class="under-item" data-id="${a.id}"><div class="thumb">${pic ? `<img src="${esc(pic)}" alt="View photos" data-act="zoom" data-i="0" role="button">` : ''}</div>
          <span>${/\/posts\/\d+/.test(a.postUrl || '') ? `<a href="${esc(a.postUrl)}" target="_blank" rel="noopener">${title}</a>` : title}${a.grade ? ' · ' + esc(a.grade) : ''}</span></div></td>
        <td class="num">${bid == null ? '—' : money(bid)}<br><small class="hint">${a.bidCount || 0} bid${a.bidCount === 1 ? '' : 's'}</small></td>
        <td class="num">${avg ? money(avg) : '—'}</td>
        <td class="num">${result}</td>
        <td class="num">${esc(localTimeText(endOf(a)))}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="5" class="hint">Nothing has ended yet.</td></tr>`;
  }

  function renderUnder() {
    const now = Date.now();
    const live = auctions.filter(a => isTracked(a) && (!endOf(a) || new Date(endOf(a)) > now));
    const rows = live.map(a => {
      const avg = marketPrice(a);
      const bid = a.currentBid ?? a.startBid ?? (avg ? 0 : null); // no bids yet counts as $0
      return { a, bid, avg, diff: bid != null && avg ? avg - bid : null, pct: bid != null && avg ? (avg - bid) / avg : null };
    }).filter(r => r.diff != null && r.diff > 0) // only auctions whose bid is under the market value
      .sort((x, y) => y.pct - x.pct);
    $('underList').innerHTML = rows.length ? rows.map(({ a, bid, avg, diff, pct }) => {
      const cd = countdownText(endOf(a));
      const diffCell = diff == null ? (avg ? '' : `<a href="${esc(marketLinks(a)[0][1])}" target="_blank" rel="noopener">eBay AU sold ↗</a>`)
        : `<span class="${diff >= 0 ? 'diff-good' : 'diff-bad'}">${diff >= 0 ? money(diff) + ' under' : money(-diff) + ' over'} (${Math.round(Math.abs(pct) * 100)}%)</span>`;
      return `<tr>
        <td><div class="under-item" data-id="${a.id}"><div class="thumb">${photos(a)[0] ? `<img src="${esc(photos(a)[0])}" alt="View photos" data-act="zoom" data-i="0" role="button">` : ''}</div>
          <span>${/\/posts\/\d+/.test(a.postUrl || '') ? `<a href="${esc(a.postUrl)}" target="_blank" rel="noopener">${esc(a.cardName || 'Untitled auction')}</a>` : esc(a.cardName || 'Untitled auction')}${a.grade ? ' · ' + esc(a.grade) : ''}</span></div></td>
        <td class="num">${money(bid)}${a.currentBid == null && a.startBid == null ? '<br><small class="hint">no bids yet</small>' : ''}</td>
        <td class="num">${avg ? money(avg) + (qtyOf(a) > 1 && a.ebaySold == null ? `<br><small class="hint">${qtyOf(a)} × ${money(avg / qtyOf(a))}</small>` : '') : '—'}</td>
        <td class="num">${diffCell}</td>
        <td class="num"><span class="countdown${cd.soon ? ' soon' : ''}" data-ends="${endOf(a) || ''}">${cd.text}</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="5" class="hint">No live auctions are under market value right now.</td></tr>`;
  }

  // Facebook auctions are re-read from the saved post text and comments every time the page loads,
  // so improvements to the reader apply straight away, without updating the extension.
  // Anything you corrected in "Fix details" is kept.
  // "2 x Prismatic ETB", "Prismatic ETB x3", "Lot of 4 ..." -> how many of the item are in the lot.
  function lotQty(title) {
    title = title.replace(LOT_LABEL, ''); // "Lot 3 3x Booster Box": the 3 after "Lot" is the seller's lot number
    const m = title.match(/(?:^|\s)(\d{1,2})\s*[x×]\s+\S/i) || title.match(/\S\s+[x×]\s?(\d{1,2})\b/i) || title.match(/\blot of (\d{1,2})\b/i);
    const n = m ? +m[1] : 1;
    return n >= 2 && n <= 50 ? n : null;
  }
  function derive(a) {
    if (a.source !== 'facebook' || !a.raw) return a;
    const out = { ...a };
    const edited = a.edited || {};
    const parsed = P.parse(a.raw, new Date(a.addedAt || a.lastSeenAt || Date.now()), { postOnly: true });
    if (!parsed.cardName) {
      const fromPhoto = (a.imageText || []).map(t => t.replace(/\s+/g, ' ').trim()).find(t => t.length >= 4 && t.length <= 80);
      parsed.cardName = fromPhoto ? fromPhoto.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : (a.seller ? 'Auction by ' + a.seller : '');
    }
    // Graded only when the post itself says so: clear a grade an older reader saved.
    if (!edited.grade) out.grade = parsed.grade || '';
    for (const f of ['title', 'cardName', 'postage', 'startBid', 'buyNow', 'hasReserve', 'reserve', 'antiSnipe', 'antiSnipeMins', 'antiSnipeWindow', 'incLow', 'incHigh', 'incAt', 'wholeDollars']) {
      if (edited[f] || edited[f === 'hasReserve' ? 'reserve' : f]) continue;
      if (parsed[f] != null && parsed[f] !== '') out[f] = parsed[f];
    }
    if (parsed.endsAt && !edited.endsAt) { out.endsAt = parsed.endsAt; out.zone = parsed.zone; }
    if (!edited.qty) out.qty = lotQty(out.cardName || '');
    if (!edited.cardNumber && parsed.cardNumber) out.cardNumber = parsed.cardNumber;
    if (!edited.setName && parsed.setName) out.setName = parsed.setName;
    // End time and anti-snipe (rule read from the post, e.g. "+5 mins within the last 5 mins").
    // Only comment times from Facebook count (not when the tracker happened to read them), and
    // anything posted after the end is left out of the bids.
    const endsMs = out.endsAt && !a.extendedByHand ? new Date(out.endsAt).getTime() : null;
    let endMs = endsMs;
    out.extendedTo = null;
    const comments = Array.isArray(a.allComments) ? a.allComments : null;
    // Bidding rules from the post ("Minimum $1 increments up to $50, $5 after, whole dollars"):
    // going through the bids in the order they were placed, a bid only counts if it beats the
    // highest so far by the minimum step (and is whole dollars). Others are left out.
    const rules = out.incLow != null;
    const stepAt = high => (out.incAt != null && high >= out.incAt ? out.incHigh : out.incLow);
    const minNext = high => high == null ? (out.startBid || (rules ? 1 : 0)) : high + (rules ? stepAt(high) : 0.01);
    let valid = [], broke = 0;
    if (comments) {
      let high = null;
      const order = comments.map((c, i) => ({ c, i, amount: P.bidAmount(c.text) })).filter(x => x.amount != null)
        .sort((x, y) => (x.c.at && y.c.at ? x.c.at - y.c.at : x.i - y.i));
      for (const x of order) {
        const ok = x.amount >= minNext(high) && !(rules && out.wholeDollars && x.amount % 1);
        if (!ok) { if (rules && (high == null || x.amount > high)) broke++; continue; }
        high = x.amount; valid.push(x);
      }
    }
    // Anti-snipe: a counted bid placed within the last few minutes before the current end moves the
    // end to that bid's time plus the stated minutes; later bids are checked against the new end.
    if (endMs && out.antiSnipe) {
      const add = (out.antiSnipeMins || 5) * 60e3, win = (out.antiSnipeWindow || out.antiSnipeMins || 5) * 60e3;
      for (const { c } of valid.filter(x => x.c.at)) {
        if (c.at > endMs) break;
        if (c.at >= endMs - win) endMs = Math.max(endMs, c.at + add);
      }
      if (endMs > endsMs) out.extendedTo = new Date(endMs).toISOString();
    }
    const inTime = c => !(endMs && c.at && c.at > endMs);
    out.lateComments = comments && endMs ? comments.filter(c => !inTime(c)).length : 0;
    if (comments && !a.manualBid) {
      const bids = valid.filter(x => inTime(x.c));
      const top = bids[bids.length - 1];
      if (top) Object.assign(out, { currentBid: top.amount, topBidder: top.c.name });
      out.bidCount = bids.length;
      out.brokenBids = broke;
    }
    out.nextBid = rules ? minNext(out.currentBid ?? null) : null;
    return out;
  }

  function render() {
    renderFound();
    renderUnder();
    renderEnded();
    const filter = $('filter').value, sort = $('sort').value;
    const now = Date.now();
    let list = auctions.filter(isTracked);
    if (filter === 'live') list = list.filter(a => !endOf(a) || new Date(endOf(a)) > now);
    if (filter === 'under') list = list.filter(a => { const m = marketPrice(a), b = a.currentBid ?? a.startBid ?? 0; return m && b < m; });
    const endKey = a => endOf(a) ? (new Date(endOf(a)) < now ? 9e15 + +new Date(endOf(a)) : +new Date(endOf(a))) : 8e15;
    if (sort === 'ends') list.sort((a, b) => endKey(a) - endKey(b));
    if (sort === 'deal') list.sort((a, b) => (verdict(a).ratio ?? 9) - (verdict(b).ratio ?? 9));
    if (sort === 'added') list.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
    $('count').textContent = `(${list.length})`;
    $('grid').innerHTML = list.length ? list.map(renderCard).join('') :
      `<div class="empty">${auctions.some(isTracked) ? 'Nothing matches this filter.' : inExtension ? 'Nothing tracked yet. Open your auction group on Facebook and press "+ Track this auction" on any auction post.' : 'No auctions yet. Paste a post above and press Add to tracker.'}</div>`;
  }

  function tick() {
    document.querySelectorAll('.countdown[data-ends]').forEach(el => {
      const cd = countdownText(el.dataset.ends || null);
      el.textContent = cd.text;
      el.classList.toggle('soon', cd.soon);
      el.closest('.slab')?.classList.toggle('ended', cd.ended);
    });
  }

  // Remove straight away, with a few seconds to undo.
  let undoTimer = null;
  function removeWithUndo(a) {
    if (a.source === 'facebook') updateField(a, { dismissed: true, tracked: false }); else store.remove(a.id);
    const toast = $('toast');
    toast.innerHTML = `Removed ${esc(a.cardName || 'auction')}. <button type="button" id="undoBtn">Undo</button>`;
    toast.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { toast.hidden = true; }, 6000);
    $('undoBtn').addEventListener('click', () => { store.save({ ...a }); toast.hidden = true; });
  }

  async function updateField(a, patch) {
    try { await (store.patch ? store.patch(a.id, patch) : store.save({ ...a, ...patch })); }
    catch (e) { $('storeStatus').textContent = 'Not saved: ' + (e.message || e.code); }
  }

  /* ---------- wiring ---------- */
  let photoTarget = null; // the shared file picker serves both the bench and card photos
  function wire() {
    $('raw').addEventListener('input', readBench);
    $('fZone').addEventListener('change', () => { if (parsed && parsed.endsAt) $('fEnds').value = isoToWall(parsed.endsAt, $('fZone').value); });
    $('saveBtn').addEventListener('click', addAuction);
    $('clearBtn').addEventListener('click', resetBench);
    $('filter').addEventListener('change', render);
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      const view = t.dataset.view;
      document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-pressed', String(x === t)));
      $('underSection').hidden = view !== 'under';
      $('endedSection').hidden = view !== 'ended';
      $('trackingSection').hidden = view !== 'tracking';
    }));
    $('sort').addEventListener('change', render);

    const pick = () => $('file').click();
    $('drop').addEventListener('click', pick);
    $('drop').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    $('file').addEventListener('change', async e => {
      const file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      if (photoTarget) { const a = auctions.find(x => x.id === photoTarget); photoTarget = null; if (a) updateField(a, { image: await shrinkImage(file) }); return; }
      setPendingImage(await shrinkImage(file));
    });
    ['dragover', 'dragenter'].forEach(t => $('drop').addEventListener(t, e => { e.preventDefault(); $('drop').classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => $('drop').addEventListener(t, () => $('drop').classList.remove('over')));
    $('drop').addEventListener('drop', async e => {
      e.preventDefault();
      const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
      if (file) setPendingImage(await shrinkImage(file));
    });
    document.addEventListener('paste', async e => {
      const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      setPendingImage(await shrinkImage(file));
    });

    let lb = { pics: [], i: 0 };
    const showLb = () => { $('lbImg').src = lb.pics[lb.i]; $('lbCount').textContent = `${lb.i + 1} of ${lb.pics.length}`; $('lbPrev').hidden = $('lbNext').hidden = lb.pics.length < 2; };
    const photoNote = a => {
      const l = a.photoLog || {}, n = x => x ? (x.error ? 'error' : x.found) : '–';
      return `v${chrome.runtime.getManifest().version} · Photos found · Facebook page: ${n(l.facebook)} · background: ${n(l.background)} · album: ${n(l.album)}${l.album && l.album.status ? ` (${l.album.status}, ${Math.round((l.album.size || 0) / 1024)}KB)` : ''}`;
    };
    const openLightbox = (pics, i, a) => { lb = { pics, i, a }; showLb(); $('lbRemove').hidden = !a || pics.length < 2; $('lbNote').textContent = a ? photoNote(a) : ''; $('lightbox').hidden = false; };
    const step = d => { lb.i = (lb.i + d + lb.pics.length) % lb.pics.length; showLb(); };
    $('lbPrev').addEventListener('click', e => { e.stopPropagation(); step(-1); });
    $('lbNext').addEventListener('click', e => { e.stopPropagation(); step(1); });
    $('endedList').addEventListener('click', e => {
      if (e.target.dataset.act !== 'zoom') return;
      const a = auctions.find(x => x.id === e.target.closest('[data-id]').dataset.id);
      if (a) openLightbox(photos(a), 0, a);
    });
    $('underList').addEventListener('click', e => {
      if (e.target.dataset.act !== 'zoom') return;
      const a = auctions.find(x => x.id === e.target.closest('[data-id]').dataset.id);
      if (a) openLightbox(photos(a), 0, a);
    });
    $('lbRemove').addEventListener('click', e => {
      e.stopPropagation();
      const a = lb.a && auctions.find(x => x.id === lb.a.id);
      if (!a) return;
      const hidden = [...(a.hiddenPhotos || []), photoKey(lb.pics[lb.i])];
      updateField(a, { hiddenPhotos: hidden });
      lb.pics = lb.pics.filter((_, j) => j !== lb.i); lb.a = { ...a, hiddenPhotos: hidden };
      if (!lb.pics.length) { $('lightbox').hidden = true; return; }
      lb.i = Math.min(lb.i, lb.pics.length - 1); showLb(); $('lbRemove').hidden = lb.pics.length < 2;
    });
    $('lightbox').addEventListener('click', e => { if (e.target.id !== 'lbImg') $('lightbox').hidden = true; });
    document.addEventListener('keydown', e => {
      if ($('lightbox').hidden) return;
      if (e.key === 'Escape') $('lightbox').hidden = true; else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1);
    });

    $('grid').addEventListener('click', async e => {
      const card = e.target.closest('.slab'); if (!card) return;
      const a = auctions.find(x => x.id === card.dataset.id); if (!a) return;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'photo') { photoTarget = a.id; $('file').click(); }
      if (act === 'zoom') openLightbox(photos(a), Number(e.target.closest('[data-i]').dataset.i) || 0, a);
      if (act === 'delete') { card.querySelector('[data-act="confirm-delete"]').hidden = false; e.target.textContent = 'Keep it'; e.target.dataset.act = 'keep'; }
      else if (act === 'keep') { card.querySelector('[data-act="confirm-delete"]').hidden = true; e.target.textContent = 'Remove'; e.target.dataset.act = 'delete'; }
      if (act === 'confirm-delete') { if (a.source === 'facebook') updateField(a, { dismissed: true }); else store.remove(a.id); }
      if (act === 'remove-now') removeWithUndo(a);
      if (act === 'untrack') updateField(a, { tracked: false });
      if (act === 'update-now') { chrome.runtime.sendMessage({ type: 'update-now', id: a.id }); e.target.textContent = 'Updating…'; }
      if (act === 'recheck') chrome.runtime.sendMessage({ type: 'ebay-check', id: a.id, force: true });
      if (act === 'update') {
        const text = (card.querySelector('[data-field="repaste"]')?.value || '').trim();
        const typedBid = numOrNull(card.querySelector('[data-field="currentBid"]').value);
        const val = f => card.querySelector(`[data-field="${f}"]`).value.trim();
        const patch = { currentBid: typedBid, manualBid: typedBid !== a.currentBid, cardName: val('cardName'), grade: val('grade'), cardNumber: val('cardNumber').toUpperCase(), setName: val('setName'),
          reserve: numOrNull(val('reserve')), zone: val('zone'), qty: numOrNull(val('qty')), ebaySold: numOrNull(val('marketValue')) };
        if (patch.reserve != null) patch.hasReserve = true;
        const ends = wallToIso(val('ends'), patch.zone);
        if (ends) { patch.endsAt = ends; patch.extendedTo = null; }
        // Remember what you changed so later updates from Facebook don't overwrite it.
        const edited = { ...(a.edited || {}) };
        for (const f of ['cardName', 'grade', 'reserve', 'cardNumber', 'setName']) if (patch[f] !== a[f] && !(patch[f] === '' && a[f] == null)) edited[f] = true;
        if (ends && ends !== a.endsAt) edited.endsAt = true;
        if (patch.qty !== (a.qty > 1 ? a.qty : null)) edited.qty = true;
        patch.edited = edited;
        if (text) {
          const p = P.parse(text);
          if (p.currentBid != null) Object.assign(patch, { currentBid: p.currentBid, topBidder: p.topBidder, bidCount: p.bidCount });
          if (p.endsAt) Object.assign(patch, { endsAt: p.endsAt, zone: p.zone });
          patch.raw = text;
        }
        updateField(a, patch);
      }
    });
    $('foundList').addEventListener('click', e => {
      const row = e.target.closest('.found-row'); const act = e.target.closest('[data-act]')?.dataset.act;
      const a = row && auctions.find(x => x.id === row.dataset.id);
      if (!a || !act) return;
      if (act === 'track') updateField(a, { tracked: true });
      if (act === 'hide') updateField(a, { dismissed: true });
    });
    $('hideAll').addEventListener('click', () => auctions.filter(isFound).forEach(a => updateField(a, { dismissed: true })));
    $('grid').addEventListener('change', e => {
      const field = e.target.dataset.field;
      if (field !== 'ebaySold' && field !== 'ebayQuery' && field !== 'pcQuery') return;
      const a = auctions.find(x => x.id === e.target.closest('.slab').dataset.id);
      if (!a) return;
      updateField(a, { [field]: field === 'ebaySold' ? numOrNull(e.target.value) : e.target.value.trim() });
      if (field === 'ebayQuery' && inExtension) setTimeout(() => chrome.runtime.sendMessage({ type: 'ebay-check', id: a.id, force: true }), 300);
      if (field === 'pcQuery') setTimeout(pcQueue, 300);
    });
  }

  async function start() {
    fillZoneSelect($('fZone'), 'QLD');
    if (inExtension) { // auctions arrive from Facebook, so hand entry starts tucked away
      $('bench').hidden = true;
      $('sub').textContent = 'The auctions you picked on Facebook, with live bids next to what each card last sold for on eBay.';
      $('benchToggle').hidden = false;
      $('benchToggle').addEventListener('click', () => { $('bench').hidden = !$('bench').hidden; });
      const showDump = d => {
        $('debugBox').hidden = !d;
        if (d) $('debugText').value = JSON.stringify(d, null, 1);
      };
      chrome.storage.local.get('debugDump').then(r => showDump(r.debugDump));
      chrome.storage.onChanged.addListener(ch => { if (ch.debugDump) showDump(ch.debugDump.newValue); });
      $('debugCopy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText($('debugText').value); $('debugCopy').textContent = 'Copied ✓'; }
        catch { $('debugText').select(); $('debugCopy').textContent = 'Press Ctrl/Cmd+C'; }
      });
      $('debugClear').addEventListener('click', () => chrome.storage.local.remove('debugDump'));
      const saveSetting = async patch => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...(settings || {}), ...patch } }); };
      chrome.storage.local.get('settings').then(({ settings }) => {
        // Bids always update by themselves: in the background while Chrome is open, and right away
        // when the tracker opens (no buttons). Turns auto-update back on if it was switched off before.
        if (settings && settings.autoUpdate === false) saveSetting({ autoUpdate: true });
        chrome.runtime.sendMessage({ type: 'update-now' });
        $('sweepMinutes').value = String(settings && settings.sweepMinutes != null ? settings.sweepMinutes : 5);
      });
      $('sweepMinutes').addEventListener('change', e => saveSetting({ sweepMinutes: Number(e.target.value) }));
      const showScan = r => {
        const n = (k, w) => `${r[k]} ${w}${r[k] === 1 ? '' : 's'}`;
        $('storeStatus').textContent = !r ? 'Press "+ Track this auction" on Facebook to add auctions. Update them whenever you like.'
          : r.error === 'logged-out' ? 'Update failed: you seem to be logged out of Facebook in Chrome.'
          : r.error ? `Update ${ago(r.at)} failed (${r.error}).`
          : r.mode === 'silent' && !r.posts ? `Update ${ago(r.at)} couldn't read the post. It updates again on its own, or straight away when you open the post on Facebook.`
          : `Last update ${ago(r.at)}${r.comments != null ? ` · read ${r.comments} comment${r.comments === 1 ? '' : 's'}` : ''}`;
      };
      chrome.storage.local.get('lastScan').then(r => showScan(r.lastScan));
      const showGroups = groups => {
        const list = Object.values(groups || {});
        $('watch').hidden = true; // auctions are now picked with the Track button on Facebook
        if (!list.length) return;
        $('watchTitle').textContent = 'Watching ' + list.map(g => g.name || g.id).join(', ');
        const last = list.map(g => g.lastSweep).filter(Boolean).sort().pop();
        $('watchNote').textContent = `Checked quietly in the background while Chrome is open, no tabs opened${last ? `. Last check ${ago(last)}.` : '. First check starting soon.'}`;
      };
      chrome.storage.local.get('groups').then(r => showGroups(r.groups));
      chrome.storage.onChanged.addListener(c => { if (c.groups) showGroups(c.groups.newValue); });
      $('groupForm').addEventListener('submit', e => {
        e.preventDefault();
        const url = $('groupUrl').value.trim();
        if (!/facebook\.com\/groups\/[^/?#]+/.test(url)) { $('watchNote').textContent = 'That doesn\'t look like a Facebook group link. It should contain facebook.com/groups/.'; return; }
        chrome.runtime.sendMessage({ type: 'add-group', url: url.startsWith('http') ? url : 'https://' + url });
        $('groupUrl').value = '';
        $('watchNote').textContent = 'Added. Checking it now…';
      });
      $('checkNow').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'check-now' }); $('watchNote').textContent = 'Checking now…'; });
      chrome.storage.onChanged.addListener(c => { if (c.lastScan) showScan(c.lastScan.newValue); });
    }
    // The paste-a-post form starts hidden so it doesn't flash on load; without the extension it's the way in.
    if (!inExtension) $('bench').hidden = false;
    const onSite = !(window.chrome && window.chrome.storage && window.chrome.runtime && window.chrome.runtime.id);
    $('verBadge').textContent = `${onSite ? 'Site v' + SITE_VERSION : 'Built-in page v' + SITE_VERSION} · Extension ${inExtension ? 'v' + chrome.runtime.getManifest().version : 'not connected'}`;
    if (onSite && !inExtension) $('noExt').hidden = false;
    wire();
    render();
    store = await initStore();
    $('storeStatus').textContent = store.kind === 'db' ? 'Saved to this page, on every device' : store.kind === 'chrome' ? $('storeStatus').textContent : 'Saved in this browser';
    let first = true;
    store.subscribe(list => {
      auctions = list.map(derive);
      if (first && !list.length && !$('raw').value && !inExtension) {
        $('raw').value = EXAMPLE; readBench();
        $('parseNote').textContent = 'Example post loaded. Press Add to tracker to try it, or Clear and paste your own.';
      }
      first = false;
      render();
      pcQueue();
    }, err => { $('storeStatus').textContent = 'Could not load saved auctions: ' + (err.message || err.code); });
    setInterval(tick, 1000);
  }
  start();
})();
