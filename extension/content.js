/* Runs on Facebook group pages. Adds Track / Update buttons to auction posts and, only when
   you press one, reads the post as it is on screen and hands it to the background worker.
   It never clicks, scrolls or reloads anything by itself; the only click it makes is the
   post's own "See more", right after you press Track or Update on that post. */
(function () {

  const textOf = el => (el && (el.innerText || el.textContent) || '').trim();

  // Posts: Facebook marks feed posts in different ways over time (feed rows, aria-posinset,
  // role="article"), so gather all of them and keep only the outermost, skipping comments.
  function posts() {
    const cands = new Set([
      ...document.querySelectorAll('[role="feed"] > div, div[aria-posinset], [role="article"]'),
    ]);
    if (/\/(posts|permalink)\/|multi_permalinks/.test(location.href)) {
      document.querySelectorAll('[role="dialog"], [role="main"]').forEach(d => cands.add(d));
    }
    const list = [...cands].filter(el => !isComment(el) && !el.closest('[aria-label^="Comment by"], [aria-label^="Reply by"]'));
    return list.filter(el => !list.some(o => o !== el && o.contains(el) && !o.matches('[role="main"], [role="dialog"]') ));
  }

  function isComment(el) { return /^(Comment|Reply) by /i.test(el.getAttribute('aria-label') || ''); }

  function postText(post) {
    const msg = post.querySelector('[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"], [data-ad-preview="message"]');
    if (msg) return textOf(msg);
    const copy = post.cloneNode(true);
    copy.querySelectorAll('[role="article"], [role="button"], form, .pat-bar, [aria-label^="Comment by"], [aria-label^="Reply by"]').forEach(n => n.remove());
    return textOf(copy);
  }

  const COMMENT_SEL = '[aria-label^="Comment by"], [aria-label^="Reply by"]';
  function comments(post) {
    return [...post.querySelectorAll(COMMENT_SEL)].map(c => {
      const label = c.getAttribute('aria-label');
      const name = (label.match(/^(?:Comment|Reply) by (.+?)\s+(?:\d+\s*\w+|a|an|about|just)\b/i) || label.match(/^(?:Comment|Reply) by (.+)$/i) || [])[1] || '';
      // The comment body is the first text block that belongs to this comment (not a reply inside
      // it) and isn't the commenter's name or a Like/Reply control.
      const own = [...c.querySelectorAll('div[dir="auto"], span[dir="auto"]')].filter(n => n.closest(COMMENT_SEL) === c);
      const body = own.map(textOf).find(t => t && t !== name.trim() && !/^(Like|Reply|Share|Edited|Author|Top contributor|Top fan|Admin|Moderator)$/i.test(t)) || '';
      return { name: name.trim(), text: body.split('\n')[0].trim() };
    }).filter(c => c.name && c.text);
  }

  // Backup for when Facebook's comment labels aren't there: any short text block outside the
  // post's own message that reads as a bid, paired with the nearest person link above it.
  function looseComments(root) {
    const msg = root.querySelector('[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"], [data-ad-preview="message"]');
    const out = [];
    const seen = new Set();
    for (const n of root.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      if ((msg && msg.contains(n)) || n.closest('.pat-bar') || n.querySelector('div[dir="auto"], span[dir="auto"]')) continue;
      const t = textOf(n);
      if (!t || t.length > 40 || P_bid(t) == null || seen.has(n)) continue;
      let name = '';
      for (let up = n.parentElement, i = 0; up && up !== root && i < 6 && !name; up = up.parentElement, i++) {
        const link = [...up.querySelectorAll('a[href*="facebook.com/"], a[href^="/"]')].find(l => {
          const lt = textOf(l);
          return lt && lt.length < 40 && !/^\d/.test(lt) && (l.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        if (link) name = textOf(link).split('\n')[0];
      }
      if (name) { seen.add(n); out.push({ name, text: t }); }
    }
    return out;
  }
  // Same rule as the tracker's reader: a comment that is basically just a dollar amount.
  function P_bid(t) {
    const c = t.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu, ' ').replace(/^\s*(?:(?:new\s+)?bid(?:ding)?|i'?ll\s+(?:go|bid)|go|offer)\s*[:\-]?\s*/i, '').replace(/\s+/g, ' ').trim();
    const m = c.match(/^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s*k?\s*\$?(?:\s*(?:aud|bid|please|pls|plz|thanks|thank you|ty|thx|for me|here))*\s*[!.]*$/i);
    return m ? m[1] : null;
  }

  // Facebook sometimes opens a post's comments in a pop-up instead of under the post; read both.
  function allComments(post, text) {
    const list = comments(post);
    if (!list.some(x => P_bid(x.text) != null)) list.push(...looseComments(post));
    const start = text.replace(/\s+/g, ' ').slice(0, 40);
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (d.contains(post) || !textOf(d).replace(/\s+/g, ' ').includes(start)) continue;
      const seen = new Set(list.map(c => c.name + '|' + c.text));
      const found = comments(d);
      if (!found.some(x => P_bid(x.text) != null)) found.push(...looseComments(d));
      for (const c of found) if (!seen.has(c.name + '|' + c.text)) list.push(c);
    }
    return list;
  }

  // Comment threads only show a few comments until "View more comments" is opened. This runs
  // only right after you press Track or Update on that post.
  async function openComments(post) {
    const re = /^(View|See) (more|all|previous|\d+ more|\d+ previous) (comments|replies)|^View \d+ repl|^View all \d+ repl|^\d+ (more )?repl(y|ies)$/i;
    for (let round = 0; round < 6; round++) {
      const btns = [...post.querySelectorAll('[role="button"]')].filter(b => re.test(textOf(b)) && textOf(b).length < 50);
      if (!btns.length) break;
      btns.forEach(b => b.click());
      await new Promise(r => setTimeout(r, 900));
    }
  }

  // The post's own id, from any link inside it that carries one (timestamp, photos, comment links).
  const ID_PATTERNS = [/\/groups\/[^/?#]+\/(?:posts|permalink)\/(\d+)/, /[?&]multi_permalinks=(\d+)/, /[?&]story_fbid=(\d+)/, /[?&]set=(?:gm|pcb)\.(\d+)/, /\/posts\/(\d+)/];
  function postLink(post) {
    const group = (location.pathname.match(/^\/groups\/([^/?#]+)/) || [])[1];
    const hrefs = [location.href];
    for (const a of post.querySelectorAll('a[href]')) {
      const c = a.closest('[role="article"]');
      if (c && isComment(c) && !/comment_id/.test(a.href)) continue;
      hrefs.unshift(a.href);
    }
    for (const re of ID_PATTERNS) {
      for (const h of hrefs) {
        if (h === location.href && !/\/(posts|permalink)\/|multi_permalinks/.test(h)) continue;
        const m = h.match(re);
        const g = (h.match(/\/groups\/([^/?#]+)/) || [])[1] || group;
        if (m && g) return { url: `https://www.facebook.com/groups/${g}/posts/${m[1]}/`, id: m[1] };
      }
    }
    return null;
  }

  // Facebook only fills in a post's timestamp link when the pointer passes over it. When you press
  // Track on a post without a link yet, let those links know the pointer is there so they fill in.
  function wakeLinks(post) {
    for (const a of post.querySelectorAll('a[href="#"], a[role="link"]:not([href])')) {
      a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      a.dispatchEvent(new FocusEvent('focus'));
    }
  }

  // A fallback id from the start of the post, which stays the same when "See more" opens it.
  function textKey(text) { return 'h' + hash(text.replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase()); }

  // Every photo in the post itself (not in comments or profile pictures), in the post's order.
  const PHOTO_LINK = /\/photo(\.php)?\/?\?|\/photos\/|[?&]set=(pcb|gm|a)\./;
  function postImages(post) {
    const seen = new Set();
    const list = [];
    for (const img of post.querySelectorAll('img, image')) {
      if (img.closest('[aria-label^="Comment by"], [aria-label^="Reply by"], .pat-bar')) continue;
      const src = img.tagName === 'IMG' ? (img.currentSrc || img.src) : (img.getAttribute('href') || img.getAttribute('xlink:href') || '');
      if (!src || !/fbcdn|scontent/.test(src) || /emoji|static\.xx|rsrc\.php/.test(src)) continue;
      const r = img.getBoundingClientRect();
      const w = Math.max(img.naturalWidth || 0, r.width), h = Math.max(img.naturalHeight || 0, r.height);
      const inPhotoLink = PHOTO_LINK.test((img.closest('a[href]') || {}).href || '');
      if (!inPhotoLink && (w < 100 || h < 100)) continue; // profile pictures and icons
      const id = src.split('?')[0];
      if (seen.has(id)) continue;
      seen.add(id);
      list.push(src);
    }
    return list.slice(0, 20);
  }
  // The post's photo album (Facebook only shows up to 5 photos with a "+3" tile for the rest).
  function photoSet(post) {
    for (const a of post.querySelectorAll('a[href]')) {
      if (a.closest('[aria-label^="Comment by"], [aria-label^="Reply by"]')) continue;
      const m = a.href.match(/[?&]set=((?:pcb|gm)\.\d+)/);
      if (m) return m[1];
    }
    return null;
  }
  function photoInfo(post) {
    return [...post.querySelectorAll('img, image')].filter(i => !i.closest('[aria-label^="Comment by"], [aria-label^="Reply by"]')).slice(0, 30).map(i => {
      const src = i.tagName === 'IMG' ? (i.currentSrc || i.src) : (i.getAttribute('href') || i.getAttribute('xlink:href') || '');
      const r = i.getBoundingClientRect();
      return `${i.tagName.toLowerCase()} ${(src.match(/^https?:\/\/([^/]+)/) || [, src.slice(0, 20)])[1]} natural ${i.naturalWidth || 0}x${i.naturalHeight || 0} shown ${Math.round(r.width)}x${Math.round(r.height)}${PHOTO_LINK.test((i.closest('a[href]') || {}).href || '') ? ' in photo link' : ''}`;
    });
  }

  function author(post) {
    const h = post.querySelector('h2 a, h3 a, h4 a, strong a');
    return h ? textOf(h).split('\n')[0] : '';
  }

  function snapshot(post) {
    const images = postImages(post);
    const text = postText(post);
    const link = postLink(post);
    return {
      key: link ? link.id : textKey(text),
      postUrl: link ? link.url : null,
      seller: author(post),
      images,
      text,
      image: images[0] || null,
      photoSet: photoSet(post),
      // Facebook describes each photo, e.g. "May be an image of trading card and text that says 'Charizard ex'".
      imageText: [...post.querySelectorAll('img[alt]')].filter(i => !i.closest('[aria-label^="Comment by"], [aria-label^="Reply by"]'))
        .map(i => (i.alt.match(/text that says ['"“‘](.+?)['"”’]\s*$/i) || [])[1]).filter(Boolean),
      comments: allComments(post, text),
      seenAt: new Date().toISOString(),
    };
  }

  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

  function send(post, track) {
    const payload = snapshot(post);
    try { chrome.runtime.sendMessage({ type: 'auction-seen', payload, track }); } catch { /* extension was reloaded: refresh the page */ }
    return payload.key;
  }

  // Which posts are tracked, kept in step with the tracker's storage.
  const tracked = new Set();
  function loadTracked(all) {
    tracked.clear();
    for (const [k, v] of Object.entries(all)) if (k.startsWith('auction:') && v && v.tracked !== false && !v.dismissed) tracked.add(v.id);
    document.querySelectorAll('.pat-bar').forEach(paintBar);
  }
  try {
    chrome.storage.local.get(null).then(loadTracked);
    chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') chrome.storage.local.get(null).then(loadTracked); });
  } catch { /* extension was reloaded */ }

  const BTN = 'padding:6px 12px;border:0;border-radius:999px;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;';
  function paintBar(bar) {
    const on = tracked.has(bar.dataset.key);
    bar.innerHTML = on
      ? `<button type="button" data-act="update" style="${BTN}background:#11804a">✓ Tracking · ↻ Update bids</button><button type="button" data-act="stop" style="${BTN}background:#5b647a">Stop</button>`
      : `<button type="button" data-act="track" style="${BTN}background:#c8202f">+ Track this auction</button>`;
  }

  // A small bar of buttons above the post's text. Facebook can redraw posts, so it's re-added when missing.
  function ensureBar(post) {
    const key = snapshotKey(post);
    let bar = post.querySelector('.pat-bar');
    if (bar && bar.dataset.key === key) return;
    if (bar) bar.remove();
    bar = document.createElement('div');
    bar.className = 'pat-bar';
    bar.dataset.key = key;
    bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:8px 16px;position:relative;z-index:2';
    bar.addEventListener('click', e => {
      const act = e.target.closest('button') && e.target.closest('button').dataset.act;
      if (!act) return;
      e.preventDefault(); e.stopPropagation();
      const btn = e.target.closest('button');
      if (act === 'debug') { chrome.runtime.sendMessage({ type: 'debug-dump', dump: dump(post) }); btn.textContent = 'Sent ✓'; return; }
      if (act === 'stop') { tracked.delete(key); send(post, false); paintBar(bar); return; }
      // Only after you press Track or Update: open this one post's "See more" so the end time,
      // reserve and postage further down the post can be read, then save it.
      tracked.add(key);
      btn.textContent = 'Reading post…';
      readPost(post).then(() => { send(post, true); paintBar(bar); flash(bar.querySelector('button')); });
    });
    paintBar(bar);
    const msg = post.querySelector('[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"], [data-ad-preview="message"]');
    if (msg && msg.parentElement) msg.parentElement.insertBefore(bar, msg); else post.prepend(bar);
  }
  // Only right after you press Track or Update (or Update all in the tracker): open this post's
  // "See more" and its comments, wait for the comments to show, then it can be read.
  async function readPost(post) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const more = seeMore(post);
    if (more) { more.click(); await sleep(500); }
    if (!postLink(post)) wakeLinks(post);
    // A post whose comments are folded away shows only "12 comments"; open them first.
    if (!comments(post).length) {
      const toggle = [...post.querySelectorAll('[role="button"]')].find(b => /^\d+\s+comments?$/i.test(textOf(b)) && !b.closest('[aria-label^="Comment by"]'));
      if (toggle) toggle.click();
      for (let i = 0; i < 10 && !comments(post).length; i++) await sleep(300);
    }
    await openComments(post);
    await sleep(500);
  }
  function seeMore(post) {
    return [...post.querySelectorAll('[role="button"]')].find(b => /^See more$/i.test(textOf(b)) && !b.closest('[aria-label^="Comment by"], [aria-label^="Reply by"]')) || null;
  }
  function snapshotKey(post) { const l = postLink(post); return l ? l.id : textKey(postText(post)); }
  function flash(btn) { if (!btn) return; const t = btn.textContent; btn.textContent = 'Saved ✓'; setTimeout(() => { if (btn.isConnected) btn.textContent = t; }, 1200); }

  const LOOKS_LIKE_AUCTION = /auction|#auction|\bbids?\b|\bbidding\b|reserve|\bSB\b|starting\s*bid|anti\s*-?\s*snipe/i;

  function scan() {
    if (!location.pathname.startsWith('/groups/')) return; // Facebook changes pages without reloading
    // Only posts that look like auctions in the part you can see, plus any you already track.
    // Anything else can still be tracked with right-click → "Track this auction".
    for (const post of posts()) {
      const text = postText(post);
      const key = text && snapshotKey(post);
      if (text && (LOOKS_LIKE_AUCTION.test(text) || tracked.has(key))) ensureBar(post);
      else post.querySelector('.pat-bar')?.remove();
      if (key && tracked.has(key) && postLink(post)) passiveUpdate(post, key); // only posts we can be sure are that auction
    }
  }

  // A tracked post you scroll past is re-read as it is on screen (nothing is clicked), so new
  // bids you can already see reach the tracker without pressing anything.
  const lastSent = new Map();
  function passiveUpdate(post, key) {
    const p = snapshot(post);
    const sig = JSON.stringify([p.comments, p.images.length, p.text.length]);
    if (lastSent.get(key) === sig) return;
    lastSent.set(key, sig);
    try { chrome.runtime.sendMessage({ type: 'auction-seen', payload: p }); } catch { /* extension was reloaded */ }
  }

  // Right-click → "Track this auction" works even if the buttons don't show on a post.
  let lastRightClick = null;
  document.addEventListener('contextmenu', e => { lastRightClick = e.target; }, true);
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'context-debug' && lastRightClick) {
      const post = posts().find(p => p.contains(lastRightClick));
      if (post) chrome.runtime.sendMessage({ type: 'debug-dump', dump: dump(post) });
      return;
    }
    if (msg.type === 'update-tracked') {
      (async () => {
        for (const post of posts()) {
          const key = postText(post) && snapshotKey(post);
          if (!key || !tracked.has(key) || (msg.id && msg.id !== key)) continue;
          await readPost(post);
          send(post, true);
        }
      })();
      return;
    }
    if (msg.type !== 'context-track' || !lastRightClick) return;
    const post = posts().find(p => p.contains(lastRightClick)) || lastRightClick.closest('[role="article"]:not([aria-label^="Comment by"])');
    if (!post) return;
    const more = seeMore(post);
    if (more) more.click();
    setTimeout(() => { tracked.add(send(post, true)); document.querySelectorAll('.pat-bar').forEach(paintBar); }, more ? 700 : 0);
  });

  // A plain outline of how Facebook built a post (tags, roles, labels and short bits of text, with
  // links reduced to their kind), so a post that reads wrongly can be looked at and fixed.
  function dump(post) {
    const out = [];
    const walk = (el, depth) => {
      if (out.length > 600 || depth > 40) return;
      for (const n of el.childNodes) {
        if (n.nodeType === 3) {
          const t = n.textContent.replace(/\s+/g, ' ').trim();
          if (t) out.push('  '.repeat(depth) + JSON.stringify(t.slice(0, 80)));
          continue;
        }
        if (n.nodeType !== 1 || /^(SCRIPT|STYLE|SVG|PATH|svg|path)$/.test(n.tagName) || n.classList.contains('pat-bar')) continue;
        const attrs = ['role', 'aria-label', 'dir', 'data-ad-rendering-role', 'data-ad-comet-preview', 'aria-posinset']
          .filter(k => n.hasAttribute(k)).map(k => `${k}="${n.getAttribute(k).slice(0, 60)}"`);
        if (n.tagName === 'A') {
          const h = n.getAttribute('href') || '';
          attrs.push('href=' + (/\/(posts|permalink)\/\d+/.test(h) ? 'post-link' : /comment_id/.test(h) ? 'comment-link' : /set=(gm|pcb)\./.test(h) ? 'photo-link' : h === '#' ? '#' : /^https?:|^\//.test(h) ? 'other-link' : 'none'));
        }
        const useful = attrs.length || n.tagName === 'A' || n.tagName === 'IMG';
        if (useful) out.push('  '.repeat(depth) + '<' + n.tagName.toLowerCase() + (attrs.length ? ' ' + attrs.join(' ') : '') + '>');
        walk(n, useful ? depth + 1 : depth);
      }
    };
    walk(post, 0);
    return { at: new Date().toISOString(), version: chrome.runtime.getManifest().version, comments: allComments(post, postText(post)), images: postImages(post).length, photoSet: photoSet(post), photos: photoInfo(post), outline: out.join('\n') };
  }

  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(scan, 800); };
  new MutationObserver(muts => { if (muts.some(m => [...m.addedNodes].some(n => !(n.classList && n.classList.contains('pat-bar'))))) soon(); })
    .observe(document.body, { childList: true, subtree: true });
  soon();
})();
