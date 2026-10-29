// The tracker page lives on the website, so it updates without reinstalling the extension.
const TRACKER_URL = 'https://crystack100.github.io/pokemon-auction-tracker/';
/* Background worker: saves the auctions you track, looks up eBay sold prices, and updates
   a tracked post when you ask it to. Nothing runs on a timer. */
importScripts('parser.js', 'ebay.js', 'fbjson.js');
const P = self.AuctionParser;
const E = self.EbaySold;

const EBAY_STALE_MS = 6 * 3600e3;
const KEY = id => 'auction:' + id;

async function getAuction(id) { return (await chrome.storage.local.get(KEY(id)))[KEY(id)] || null; }
async function putAuction(a) { await chrome.storage.local.set({ [KEY(a.id)]: a }); }
async function allAuctions() {
  return Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith('auction:')).map(([, v]) => v);
}
async function settings() {
  const { settings: s } = await chrome.storage.local.get('settings');
  return { ...(s || {}) };
}

/* ---------- posts seen on Facebook ---------- */
async function onAuctionSeen(p, fromTabId, track) {
  if (!p.postUrl) p = { ...p, postUrl: null };
  // Read the post on its own, and the bids straight from the comments, so nothing in the post
  // (like a "·" in the header) can be mistaken for where the comments start.
  const raw = p.text;
  const parsed = P.parse(raw, new Date(), { postOnly: true });
  const bids = (p.comments || []).map(c => ({ name: c.name, amount: P.bidAmount(c.text) })).filter(x => x.amount != null);
  const top = bids.reduce((m, x) => (!m || x.amount > m.amount ? x : m), null);
  // A post whose item is only named in its photos: use the words Facebook read off the photo, or the seller.
  if (!parsed.cardName) {
    const fromPhoto = (p.imageText || []).map(t => t.replace(/\s+/g, ' ').trim()).find(t => t.length >= 4 && t.length <= 80);
    parsed.cardName = fromPhoto ? fromPhoto.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : (p.seller ? 'Auction by ' + p.seller : '');
  }
  Object.assign(parsed, { currentBid: top ? top.amount : null, topBidder: top ? top.name : null, bidCount: bids.length });
  // The same post can arrive under a temporary id (before its link was known) and later under its
  // real one; match them by the start of the post and the seller so they stay one auction.
  const fp = fingerprint(p.text, p.seller);
  let old = await getAuction(p.key);
  if (!old) {
    // Two different real post ids are always two different posts, even from the same seller with a similar title.
    const realId = id => /^\d+$/.test(id);
    const twin = (await allAuctions()).find(x => !(realId(x.id) && realId(p.key)) && (x.fingerprint === fp || (x.raw && fingerprint(x.raw, x.seller) === fp)));
    if (twin) {
      old = twin;
      if (twin.id !== p.key && /^\d+$/.test(p.key)) { await chrome.storage.local.remove(KEY(twin.id)); old = { ...twin, id: p.key }; }
      else p = { ...p, key: twin.id };
    }
  }
  // Only posts you pressed Track on are kept.
  if (track === false) { if (old) await putAuction({ ...old, tracked: false, dismissed: true }); return; }
  if (!track && !(old && old.tracked !== false && !old.dismissed)) return;
  const a = old ? { ...old } : { id: p.key, addedAt: p.seenAt, source: 'facebook' };
  if (track) { a.tracked = true; a.dismissed = false; }
  a.fingerprint = fp;

  // Card details: take the newest reading, except for anything you corrected by hand.
  const edited = a.edited || {};
  for (const f of ['title', 'cardName', 'grade', 'postage', 'startBid', 'buyNow', 'hasReserve', 'reserve', 'antiSnipe']) {
    if (edited[f] || edited[f === 'hasReserve' ? 'reserve' : f]) continue;
    if (parsed[f] != null && parsed[f] !== '') a[f] = parsed[f];
    else if (a[f] === undefined) a[f] = parsed[f];
  }
  if (parsed.endsAt && !edited.endsAt) { a.endsAt = parsed.endsAt; a.zone = parsed.zone; }
  // Anti-snipe: a late bid can push the end out, so keep the latest end we know of.
  if (false) { // anti-snipe extensions are now worked out on the website from comment times
    const endMs = new Date(a.endsAt).getTime();
    const ext = new Date(a.lastBidAt).getTime() + 5 * 60e3;
    if (new Date(a.lastBidAt).getTime() > endMs - 5 * 60e3 && ext > endMs) a.extendedTo = new Date(ext).toISOString();
  }
  if (!a.seller && p.seller) a.seller = p.seller;
  // Photos: keep every photo seen from any reading (Facebook only shows some at a time), one copy each.
  // How many photos each kind of reading found, so a missing photo can be traced to its source.
  a.photoLog = { ...(a.photoLog || {}), [p.source || 'facebook']: { found: (p.images || []).length, at: p.seenAt } };
  if (p.images && p.images.length) {
    const photoId = u => (u.split('?')[0].split('/').pop() || u);
    const fresh = [...(a.images || []), ...p.images]; // photos already on the card keep their place, new ones go after
    const ids = new Set();
    a.images = fresh.filter(u => !ids.has(photoId(u)) && ids.add(photoId(u))).slice(0, 20);
  }
  if (p.image) a.image = p.image;
  if (p.postUrl) a.postUrl = p.postUrl;
  if (p.photoSet) a.photoSet = p.photoSet;
  a.raw = raw;
  a.lastSeenAt = p.seenAt;
  a.extendedTo = null;

  // Bids: the highest dollar comment we've ever seen wins (comments can scroll out of view).
  if (parsed.currentBid != null && (a.currentBid == null || parsed.currentBid > a.currentBid || a.manualBid)) {
    if (a.currentBid == null || parsed.currentBid > a.currentBid) a.lastBidAt = p.seenAt;
    a.currentBid = parsed.currentBid;
    a.topBidder = parsed.topBidder;
    a.manualBid = false;
  }
  a.bidCount = Math.max(a.bidCount || 0, parsed.bidCount);
  a.commentsRead = (p.comments || []).length;
  // Every comment ever read, and the words Facebook read off the photos, so the tracker website can
  // re-read the post with its newest rules.
  // Each comment keeps when it was posted (from Facebook) and when it was first read, so the
  // tracker website can leave out comments made after the auction ended.
  const known = new Map((a.allComments || []).map(c => [c.name + '|' + c.text, c]));
  for (const c of p.comments || []) {
    const k = c.name + '|' + c.text, old = known.get(k);
    if (!old) known.set(k, { name: c.name, text: c.text, at: c.at || null, seen: p.seenAt });
    else if (!old.at && c.at) known.set(k, { ...old, at: c.at });
  }
  a.allComments = [...known.values()].slice(-500);
  if (p.imageText && p.imageText.length) a.imageText = p.imageText;

  if (!a.photoSet && /^\d+$/.test(a.id)) a.photoSet = 'pcb.' + a.id;
  await putAuction(a);
  // Fill in the rest of the post's photos when you press Track/Update, or if they're missing or stale.
  if (track || !a.photosFetchedAt || Date.now() - new Date(a.photosFetchedAt) > 6 * 3600e3) fetchPhotos(a.id);
}

// Same seller and same item title means the same auction, even if one copy was read before
// "See more" was opened.
function fingerprint(text, seller) {
  const title = (P.parse(String(text || ''), new Date(), { postOnly: true }).cardName || '').toLowerCase();
  const who = (seller || '').toLowerCase().trim();
  return who + '|' + (title.length >= 6 ? title : String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase());
}

// Merge auctions that were saved twice by older versions (one with an end time, one without).
async function mergeDuplicates() {
  const groups = new Map();
  for (const a of await allAuctions()) {
    if (a.source !== 'facebook' || !a.raw) continue;
    const fp = fingerprint(a.raw, a.seller);
    groups.set(fp, [...(groups.get(fp) || []), a]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // Keep the most complete copy: a real post id first, then one with an end time, then the newest.
    list.sort((x, y) => (/^\d+$/.test(y.id) - /^\d+$/.test(x.id)) || (!!y.endsAt - !!x.endsAt) || String(y.lastSeenAt).localeCompare(String(x.lastSeenAt)));
    const [keep, ...others] = list;
    const rest = others.filter(r => !(/^\d+$/.test(r.id) && /^\d+$/.test(keep.id))); // never merge two real posts
    const merged = { ...keep };
    for (const r of rest) {
      for (const f of ['endsAt', 'zone', 'reserve', 'hasReserve', 'postage', 'image', 'postUrl', 'antiSnipe']) if (merged[f] == null && r[f] != null) merged[f] = r[f];
      if ((r.currentBid ?? -1) > (merged.currentBid ?? -1)) Object.assign(merged, { currentBid: r.currentBid, topBidder: r.topBidder });
      if (r.tracked !== false && !r.dismissed) { merged.tracked = true; merged.dismissed = false; }
      await chrome.storage.local.remove(KEY(r.id));
    }
    await putAuction(merged);
  }
}
chrome.runtime.onInstalled.addListener(mergeDuplicates);
chrome.runtime.onStartup.addListener(mergeDuplicates);

/* ---------- eBay sold prices ---------- */
const ebayQueue = [];
let ebayBusy = false;
function queueEbay(id) { if (!ebayQueue.includes(id)) ebayQueue.push(id); runEbay(); }
async function runEbay() {
  if (ebayBusy) return;
  ebayBusy = true;
  while (ebayQueue.length) {
    const id = ebayQueue.shift();
    await checkEbay(id);
    await new Promise(r => setTimeout(r, 4000)); // be gentle with eBay
  }
  ebayBusy = false;
}
async function checkEbay(id) {
  let a = await getAuction(id);
  if (!a) return;
  const query = (a.ebayQuery || `${a.cardName || ''} ${a.grade || ''}`).trim();
  if (!query) return;
  await putAuction({ ...a, ebayAuto: { ...(a.ebayAuto || {}), status: 'checking' } });
  let result;
  try {
    let sales = [];
    for (const site of ['au', 'us']) {
      const res = await fetch(E.searchUrl(query, site), { credentials: 'omit' });
      if (res.status === 403) throw new Error('eBay blocked the automatic lookup. Use the eBay AU sold link below.');
      if (!res.ok) throw new Error('eBay answered ' + res.status);
      sales = E.parseSold(await res.text(), a.cardName, a.grade);
      if (sales.length) break; // fall back to eBay US only when Australia has no sales
    }
    const s = E.summarise(sales);
    result = s.count ? { status: 'ok', ...s } : { status: 'none' };
  } catch (e) {
    result = { status: 'error', error: e.message };
  }
  a = await getAuction(id); // it may have changed while we were fetching
  if (a) await putAuction({ ...a, ebayAuto: { ...result, query, checkedAt: new Date().toISOString() } });
}

/* ---------- updating on request ---------- */

// Update a tracked post when you press Update in the tracker: fetch the post's page with your
// Facebook login, without opening a tab, and read the post and comments from the data in it.
const AUCTION_RE = /auction|\bbids?\b|reserve|\bSB\b|starting\s*bid/i;
// All the photos in a post's album, read from Facebook's album page in the background (no tab).
async function fetchPhotos(id) {
  const a = await getAuction(id);
  if (!a || !a.photoSet) return;
  try {
    const res = await fetch(`https://www.facebook.com/media/set/?set=${a.photoSet}&type=1`, { credentials: 'include', headers: { accept: 'text/html' } });
    const html = await res.text();
    const found = FbJson.extractImages(html);
    const now = await getAuction(id);
    const log = { ...(now.photoLog || {}), album: { found: found.length, status: res.status, size: html.length, at: new Date().toISOString() } };
    if (!found.length) { await putAuction({ ...now, photoLog: log, photosFetchedAt: new Date().toISOString() }); return; }
    const ids = new Set();
    const images = [...found, ...(now.images || [])].filter(u => { const k = u.split('?')[0].split('/').pop(); return !ids.has(k) && ids.add(k); }).slice(0, 20);
    await putAuction({ ...now, images, photoLog: log, photosFetchedAt: new Date().toISOString() });
  } catch (e) {
    const now = await getAuction(id);
    if (now) await putAuction({ ...now, photoLog: { ...(now.photoLog || {}), album: { error: e.message, at: new Date().toISOString() } } });
  }
}

async function silentCheck(url, groupId, targetId) {
  const report = { at: new Date().toISOString(), url: url.split('?')[0], posts: 0, auctions: 0, mode: 'silent' };
  try {
    const res = await fetch(url, { credentials: 'include', headers: { accept: 'text/html' } });
    const html = await res.text();
    if (FbJson.loggedOut(html)) { report.error = 'logged-out'; return; }
    const posts = FbJson.extractPosts(html);
    report.posts = posts.length;
    // When checking one tracked auction, make sure the reading lands on that card even if Facebook's ids differ.
    const target = targetId && (posts.find(p => p.key === targetId) || posts.find(p => AUCTION_RE.test(p.text)));
    if (target) target.key = targetId;
    report.comments = 0;
    for (const p of target ? [target] : posts) { // checking one auction: ignore the other posts on that page
      if (!target && !AUCTION_RE.test(p.text)) continue;
      report.comments = (report.comments || 0) + p.comments.length;
      report.auctions++;
      await onAuctionSeen({
        key: p.key,
        postUrl: p.postUrl || (groupId ? `https://www.facebook.com/groups/${groupId}/posts/${p.key}/` : url),
        seller: p.seller, image: p.image, images: p.images, text: p.text, comments: p.comments, seenAt: report.at, source: 'background',
      }, null);
    }
  } catch (e) {
    report.error = e.message;
  } finally {
    await chrome.storage.local.set({ lastScan: report });
  }
}

/* ---------- wiring ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // The tracker page reads PriceCharting prices through here (that site doesn't let other pages read it).
  // Only PriceCharting pages, read as a normal visit without your cookies.
  if (msg.type === 'pc-fetch') {
    let u = null; try { u = new URL(msg.url); } catch {}
    if (!u || u.protocol !== 'https:' || u.hostname !== 'www.pricecharting.com') { sendResponse({ error: 'not allowed' }); return; }
    fetch(u.href, { credentials: 'omit' })
      .then(async r => sendResponse({ status: r.status, url: r.url, text: await r.text() }))
      .catch(e => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg.type === 'auction-seen') onAuctionSeen(msg.payload, sender.tab && sender.tab.id, msg.track);
  if (msg.type === 'debug-dump') {
    chrome.storage.local.set({ debugDump: msg.dump });
    const url = TRACKER_URL;
    chrome.tabs.query({ url: TRACKER_URL + '*' }).then(([t]) => t ? chrome.tabs.update(t.id, { active: true }) : chrome.tabs.create({ url }));
  }
  if (msg.type === 'pc-page') getAuction(msg.id).then(a => a && putAuction({ ...a, pcPage: { url: msg.url, html: String(msg.html).slice(0, 400000), at: new Date().toISOString() } }));
  if (msg.type === 'ebay-result') getAuction(msg.id).then(a => a && putAuction({ ...a, ebayAuto: msg.result }));
  if (msg.type === 'update-now') {
    (async () => {
      const list = msg.id ? [await getAuction(msg.id)] : (await allAuctions()).filter(a => a.tracked !== false && !a.dismissed);
      // Facebook tabs you already have open re-read the tracked posts showing there, exactly like
      // pressing each post's own Update button (no tabs are opened).
      const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/*' });
      for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'update-tracked', id: msg.id || null }).catch(() => {});
      for (const a of list) if (a && /\/posts\/\d+/.test(a.postUrl || '')) await checkAuction(a);
    })();
  }
});

// Right-click menu on Facebook group pages, for posts where the buttons don't show.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'pat-track', title: 'Track this auction', contexts: ['all'], documentUrlPatterns: ['https://www.facebook.com/groups/*'] });
    chrome.contextMenus.create({ id: 'pat-debug', title: 'Send this post to the tracker for fixing', contexts: ['all'], documentUrlPatterns: ['https://www.facebook.com/groups/*'] });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'pat-debug' && tab) chrome.tabs.sendMessage(tab.id, { type: 'context-debug' }, { frameId: info.frameId || 0 }).catch(() => {});
  if (info.menuItemId === 'pat-track' && tab) chrome.tabs.sendMessage(tab.id, { type: 'context-track' }, { frameId: info.frameId || 0 }).catch(() => {});
});
// Automatic bid updates: re-read tracked live auctions in the background, more often near the end.
// This only fetches the post's page; it never opens a tab or clicks anything on your screen.
function dueEvery(a, now) {
  const end = new Date(a.extendedTo || a.endsAt || 0).getTime();
  if (!a.endsAt) return 15 * 60e3;
  const left = end - now;
  if (left < -10 * 60e3) return null; // ended a while ago: the final bid is in
  if (left < 15 * 60e3) return 60e3;
  if (left < 60 * 60e3) return 3 * 60e3;
  return 5 * 60e3;
}
let autoBusy = false;
async function checkAuction(a) {
  await silentCheck(a.postUrl, (a.postUrl.match(/groups\/([^/]+)/) || [])[1], a.id);
  const now = await getAuction(a.id);
  if (now) await putAuction({ ...now, lastAutoAt: new Date().toISOString() });
}
async function autoUpdate() {
  if (autoBusy || (await settings()).autoUpdate === false) return;
  autoBusy = true;
  try {
    const now = Date.now();
    const due = (await allAuctions())
      .filter(a => a.tracked !== false && !a.dismissed && /\/posts\/\d+/.test(a.postUrl || ''))
      .filter(a => { const every = dueEvery(a, now); return every != null && now - new Date(a.lastAutoAt || 0) >= every; })
      .slice(0, 5);
    for (const a of due) await checkAuction(a);
  } finally { autoBusy = false; }
}
// Create the timer once; re-creating it every time the extension wakes up would keep pushing it back.
chrome.alarms.get('auto-update', al => { if (!al) chrome.alarms.create('auto-update', { periodInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener(al => { if (al.name === 'auto-update') autoUpdate(); });
chrome.action.onClicked.addListener(async () => {
  const url = TRACKER_URL;
  const [tab] = await chrome.tabs.query({ url: TRACKER_URL + '*' });
  if (tab) chrome.tabs.update(tab.id, { active: true }); else chrome.tabs.create({ url });
});
