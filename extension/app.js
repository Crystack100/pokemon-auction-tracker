/* Pokémon Auction Tracker: auction list, storage and the eBay comparison. Parsing lives in parser.js. */
(function () {
  // On the website, the extension is reached through bridge.js; inside the extension, directly.
  const chrome = window.patBridge || window.chrome;
  const P = window.AuctionParser;
  // Bump with every change to the website, so you can see which version you have open.
  const SITE_VERSION = '0.15.1';
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
const photos = a => (a.images && a.images.length ? a.images : a.image ? [a.image] : []);

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
  const marketPrice = a => a.ebaySold ?? (a.ebayAuto && a.ebayAuto.currency !== 'USD' ? a.ebayAuto.price : null) ?? null;
  const endOf = a => a.extendedTo || a.endsAt;
  function verdict(a) {
    const bid = a.currentBid ?? a.startBid;
    if (bid == null) return { cls: 'none', text: 'No bids yet', ratio: null };
    const market = marketPrice(a);
    const st = a.ebayAuto && a.ebayAuto.status;
    if (!market) return { cls: 'none', text: st === 'checking' ? 'Checking eBay…' : inExtension ? 'No eBay average yet' : 'Add eBay last sold to compare', ratio: null };
    const total = bid;
    const ratio = total / market;
    const pct = Math.round(Math.abs(1 - ratio) * 100);
    if (ratio < 0.85) return { cls: 'good', text: `Under market by ${pct}%`, ratio, total };
    if (ratio <= 1.05) return { cls: 'warn', text: ratio < 1 ? `Near market (${pct}% under)` : `At market (${pct}% over)`, ratio, total };
    return { cls: 'bad', text: `Over market by ${pct}%`, ratio, total };
  }

  function ebayQuery(a) { return (a.ebayQuery || `${a.cardName || ''} ${a.grade || ''}`).trim(); }
  function marketLinks(a) {
    const q = encodeURIComponent(ebayQuery(a));
    return [
      [inExtension ? 'Get eBay average' : 'eBay AU sold', `https://www.ebay.com.au/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=60${inExtension ? '#pat=' + a.id : ''}`],
      ['eBay US sold', `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1&_sop=13`],
      ['PriceCharting', `https://www.pricecharting.com/search-products?type=prices&q=${q}`],
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
  function renderCard(a) {
    const cd = countdownText(endOf(a));
    const v = verdict(a);
    const reserve = a.reserve != null ? money(a.reserve) + (a.currentBid >= a.reserve ? ' (met)' : ' (not met)') : a.hasReserve ? 'Yes, amount unknown' : '$0 (no reserve)';
    const fill = v.ratio == null ? 0 : Math.min(v.ratio / 1.5, 1) * 100;
    const fillColor = v.cls === 'good' ? 'var(--good)' : v.cls === 'bad' ? 'var(--bad)' : 'var(--warn)';
    const market = marketPrice(a);
    const maxBid = market;
    const auto = a.ebayAuto || {};
    const autoText = auto.average ? `eBay average ${money(auto.average)} from the last ${auto.count} sold` : auto.price ? `${auto.currency === 'USD' ? 'No Australian sales. eBay US: US' : 'eBay'} ${money(auto.price)}${auto.soldDate ? ', sold ' + esc(auto.soldDate) : ''}${auto.count > 1 ? ` · median of last ${auto.count}: ${money(auto.median)}` : ''}${auto.title ? `<br>Latest match: ${auto.itemUrl ? `<a href="${esc(auto.itemUrl)}" target="_blank" rel="noopener">${esc(auto.title)}</a>` : esc(auto.title)}` : ''}` :
auto.status === 'none' ? 'No matching eBay sales found. Try other search words, then Get eBay average again.' : inExtension ? 'Tap "Get eBay average" to open eBay sold listings. The average is saved here once the page loads.' : '';
    const pics = photos(a);
    return `
    <article class="slab${cd.ended ? ' ended' : ''}" data-id="${a.id}">
      <div class="label">
        <span class="name">${esc(a.cardName || a.title || 'Untitled auction')}</span>
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
          <span class="v">${money(a.currentBid ?? a.startBid)}</span>
          <span class="who">${a.topBidder ? esc(a.topBidder) + ' · ' : ''}${a.bidCount || 0} bid${a.bidCount === 1 ? '' : 's'}${a.commentsRead != null ? ` · ${a.commentsRead} comment${a.commentsRead === 1 ? '' : 's'} read` : ''}${a.lastSeenAt ? ' · updated ' + esc(ago(a.lastSeenAt)) : ''}</span>
          <span class="pill ${v.cls}">${v.text}</span>
        </div>
      </div>
      <div class="body">
        <dl>
          <dt>Reserve</dt><dd>${reserve}</dd>
          ${a.antiSnipe ? '<dt>Anti-snipe</dt><dd>Extends in last 5 min</dd>' : ''}
        </dl>
        <div class="ends">
          <span class="countdown${cd.soon ? ' soon' : ''}" data-ends="${endOf(a) || ''}">${cd.text}</span>
          <span class="when">${endOf(a) ? (a.extendedTo ? 'Extended by anti-snipe<br>' : '') + esc(localTimeText(endOf(a))) : ''}</span>
        </div>
        <div class="market">
          <label>eBay search<input data-field="ebayQuery" value="${esc(ebayQuery(a))}"></label>
          ${v.ratio != null ? `<div class="bar" title="Line marks the eBay price"><i style="width:${fill}%;background:${fillColor}"></i><b></b></div>
          <span class="hint">eBay average ${money(market)}. Bid up to ${money(maxBid)} to stay at or under market.</span>` : ''}
          ${autoText ? `<span class="hint">${autoText}${auto.checkedAt ? ' · checked ' + esc(ago(auto.checkedAt)) : ''}</span>` : ''}
          <div class="links">${/\/posts\/\d+/.test(a.postUrl || '') ? `<a href="${esc(a.postUrl)}" target="_blank" rel="noopener">Facebook post ↗</a>` : ''}${inExtension && /\/posts\/\d+/.test(a.postUrl || '') ? '<button type="button" data-act="update-now">↻ Update bids</button>' : ''}${marketLinks(a).map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t} ↗</a>`).join('')}</div>
        </div>
        <details>
          <summary>Fix details</summary>
          ${inExtension ? '' : `<p class="hint">Copy the post again from Facebook with the newest comments and paste it here.</p>
          <textarea data-field="repaste" aria-label="Updated post"></textarea>`}
          <div class="fields" style="margin-top:8px">
            <label style="grid-column:1/-1">Title<input data-field="cardName" value="${esc(a.cardName || '')}"></label>
            <label>Grade<input data-field="grade" value="${esc(a.grade || '')}" placeholder="PSA 10"></label>
            <label>Current bid $<input data-field="currentBid" inputmode="decimal" value="${a.currentBid ?? ''}"></label>
            <label>Reserve $<input data-field="reserve" inputmode="decimal" value="${a.reserve ?? ''}" placeholder="${a.hasReserve === false ? 'No reserve' : ''}"></label>
            <label>Ends<input data-field="ends" type="datetime-local" value="${isoToWall(a.endsAt, a.zone || 'QLD')}"></label>
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
      <div class="thumb">${a.image ? `<img src="${esc(a.image)}" alt="">` : ''}</div>
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
  function renderUnder() {
    const now = Date.now();
    const live = auctions.filter(a => isTracked(a) && (!endOf(a) || new Date(endOf(a)) > now));
    const rows = live.map(a => {
      const bid = a.currentBid ?? a.startBid;
      const avg = marketPrice(a);
      return { a, bid, avg, diff: bid != null && avg ? avg - bid : null, pct: bid != null && avg ? (avg - bid) / avg : null };
    }).sort((x, y) => (y.pct ?? -9) - (x.pct ?? -9));
    $('underList').innerHTML = rows.length ? rows.map(({ a, bid, avg, diff, pct }) => {
      const cd = countdownText(endOf(a));
      const diffCell = diff == null ? (avg ? 'No bids yet' : `<a href="${esc(marketLinks(a)[0][1])}" target="_blank" rel="noopener">Get eBay average ↗</a>`)
        : `<span class="${diff >= 0 ? 'diff-good' : 'diff-bad'}">${diff >= 0 ? money(diff) + ' under' : money(-diff) + ' over'} (${Math.round(Math.abs(pct) * 100)}%)</span>`;
      return `<tr>
        <td><div class="under-item"><div class="thumb">${a.image ? `<img src="${esc(a.image)}" alt="">` : ''}</div>
          <span>${/\/posts\/\d+/.test(a.postUrl || '') ? `<a href="${esc(a.postUrl)}" target="_blank" rel="noopener">${esc(a.cardName || 'Untitled auction')}</a>` : esc(a.cardName || 'Untitled auction')}${a.grade ? ' · ' + esc(a.grade) : ''}</span></div></td>
        <td class="num">${money(bid)}</td>
        <td class="num">${avg ? money(avg) : '—'}</td>
        <td class="num">${diffCell}</td>
        <td class="num"><span class="countdown${cd.soon ? ' soon' : ''}" data-ends="${endOf(a) || ''}">${cd.text}</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="5" class="hint">No live tracked auctions yet.</td></tr>`;
  }

  // Facebook auctions are re-read from the saved post text and comments every time the page loads,
  // so improvements to the reader apply straight away, without updating the extension.
  // Anything you corrected in "Fix details" is kept.
  function derive(a) {
    if (a.source !== 'facebook' || !a.raw) return a;
    const out = { ...a };
    const edited = a.edited || {};
    const parsed = P.parse(a.raw, new Date(a.addedAt || a.lastSeenAt || Date.now()), { postOnly: true });
    if (!parsed.cardName) {
      const fromPhoto = (a.imageText || []).map(t => t.replace(/\s+/g, ' ').trim()).find(t => t.length >= 4 && t.length <= 80);
      parsed.cardName = fromPhoto ? fromPhoto.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : (a.seller ? 'Auction by ' + a.seller : '');
    }
    for (const f of ['title', 'cardName', 'grade', 'postage', 'startBid', 'buyNow', 'hasReserve', 'reserve', 'antiSnipe']) {
      if (edited[f] || edited[f === 'hasReserve' ? 'reserve' : f]) continue;
      if (parsed[f] != null && parsed[f] !== '') out[f] = parsed[f];
    }
    if (parsed.endsAt && !edited.endsAt) { out.endsAt = parsed.endsAt; out.zone = parsed.zone; }
    if (Array.isArray(a.allComments) && !a.manualBid) {
      const bids = a.allComments.map(c => ({ name: c.name, amount: P.bidAmount(c.text) })).filter(x => x.amount != null);
      const top = bids.reduce((m, x) => (!m || x.amount > m.amount ? x : m), null);
      if (top) Object.assign(out, { currentBid: top.amount, topBidder: top.name });
      out.bidCount = bids.length;
    }
    return out;
  }

  function render() {
    renderFound();
    renderUnder();
    const filter = $('filter').value, sort = $('sort').value;
    const now = Date.now();
    let list = auctions.filter(isTracked);
    if (filter === 'live') list = list.filter(a => !endOf(a) || new Date(endOf(a)) > now);
    if (filter === 'under') list = list.filter(a => verdict(a).cls === 'good');
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
    try { await store.save({ ...a, ...patch }); }
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
    const openLightbox = (pics, i, a) => { lb = { pics, i }; showLb(); $('lbNote').textContent = a ? photoNote(a) : ''; $('lightbox').hidden = false; };
    const step = d => { lb.i = (lb.i + d + lb.pics.length) % lb.pics.length; showLb(); };
    $('lbPrev').addEventListener('click', e => { e.stopPropagation(); step(-1); });
    $('lbNext').addEventListener('click', e => { e.stopPropagation(); step(1); });
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
        const patch = { currentBid: typedBid, manualBid: typedBid !== a.currentBid, cardName: val('cardName'), grade: val('grade'),
          reserve: numOrNull(val('reserve')), zone: val('zone') };
        if (patch.reserve != null) patch.hasReserve = true;
        const ends = wallToIso(val('ends'), patch.zone);
        if (ends) { patch.endsAt = ends; patch.extendedTo = null; }
        // Remember what you changed so later updates from Facebook don't overwrite it.
        const edited = { ...(a.edited || {}) };
        for (const f of ['cardName', 'grade', 'reserve']) if (patch[f] !== a[f] && !(patch[f] === '' && a[f] == null)) edited[f] = true;
        if (ends && ends !== a.endsAt) edited.endsAt = true;
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
      if (field !== 'ebaySold' && field !== 'ebayQuery') return;
      const a = auctions.find(x => x.id === e.target.closest('.slab').dataset.id);
      if (!a) return;
      updateField(a, { [field]: field === 'ebaySold' ? numOrNull(e.target.value) : e.target.value.trim() });
      if (field === 'ebayQuery' && inExtension) setTimeout(() => chrome.runtime.sendMessage({ type: 'ebay-check', id: a.id, force: true }), 300);
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
      $('updateAll').hidden = false;
      $('autoRow').hidden = false;
      $('updateAll').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'update-now' }); $('storeStatus').textContent = 'Updating your tracked auctions…'; });
      const saveSetting = async patch => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...(settings || {}), ...patch } }); };
      chrome.storage.local.get('settings').then(({ settings }) => {
        $('autoRefresh').checked = !settings || settings.autoUpdate !== false;
        // Opening or refreshing the tracker fetches fresh bids in the background (no tabs, no clicks).
        if (!settings || settings.autoUpdate !== false) chrome.runtime.sendMessage({ type: 'update-now' });
        $('sweepMinutes').value = String(settings && settings.sweepMinutes != null ? settings.sweepMinutes : 5);
      });
      $('sweepMinutes').addEventListener('change', e => saveSetting({ sweepMinutes: Number(e.target.value) }));
      const showScan = r => {
        const n = (k, w) => `${r[k]} ${w}${r[k] === 1 ? '' : 's'}`;
        $('storeStatus').textContent = !r ? 'Press "+ Track this auction" on Facebook to add auctions. Update them whenever you like.'
          : r.error === 'logged-out' ? 'Update failed: you seem to be logged out of Facebook in Chrome.'
          : r.error ? `Update ${ago(r.at)} failed (${r.error}).`
          : r.mode === 'silent' && !r.posts ? `Update ${ago(r.at)} couldn't read the post. Open it on Facebook and press "↻ Update bids" there instead.`
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
      $('autoRefresh').addEventListener('change', e => saveSetting({ autoUpdate: e.target.checked }));
    }
    const onSite = !(window.chrome && window.chrome.storage && window.chrome.runtime && window.chrome.runtime.id);
    $('verBadge').textContent = `${onSite ? 'Site v' + SITE_VERSION : 'Built-in page v' + SITE_VERSION} · Extension ${inExtension ? 'v' + chrome.runtime.getManifest().version : 'not connected'}`;
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
    }, err => { $('storeStatus').textContent = 'Could not load saved auctions: ' + (err.message || err.code); });
    setInterval(tick, 1000);
  }
  start();
})();
