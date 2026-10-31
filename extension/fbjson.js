/* Reads Facebook posts out of the data embedded in a group or post page's HTML,
   so the extension can check the group without opening a tab. */
(function (root) {
  const POST_URL = /https:\/\/www\.facebook\.com\/groups\/[^/"?]+\/(?:posts|permalink)\/\d+\/?/;

  function blobs(html) {
    const out = [];
    const re = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) { try { out.push(JSON.parse(m[1])); } catch { /* not JSON we can read */ } }
    return out;
  }

  // Visit every object under `node` without deep recursion.
  function each(node, fn) {
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (fn(n) === false) continue;
      for (const k in n) { const v = n[k]; if (v && typeof v === 'object') stack.push(v); }
    }
  }

  // Not the post's own photos: video and reel thumbnails (t15), Instagram and stories (t51), ads (t45),
  // profile pictures, and previews of links to other sites (external…fbcdn, safe_image).
  const NOT_PHOTO = /\/\/external[.-]|safe_image|\/t15\.|\/t51\.|\/t45\.|\/t39\.30808-1\/|\/t1\.30497-1\//;
  const SKIP_TYPES = /Video|Reel|StoryBucket|StoriesBucket|StoryCard|ExternalUrl|ExternalShare/;
  function readStory(node) {
    const s = { key: node.post_id, text: '', postUrl: '', seller: '', image: null, imageWidth: 0, images: [], comments: [] };
    const seenComments = new Set();
    each(node, o => {
      if (o !== node && typeof o.post_id === 'string' && o.post_id !== node.post_id) return false; // a different (shared) post
      if (o !== node && typeof o.__typename === 'string' && SKIP_TYPES.test(o.__typename)) return false; // videos, reels, stories, link previews
      if (o.body && typeof o.body.text === 'string' && o.author && typeof o.author.name === 'string') {
        const id = o.author.name + '|' + o.body.text;
        if (!seenComments.has(id)) { seenComments.add(id); s.comments.push({ name: o.author.name, text: o.body.text.split('\n')[0].trim(), created: o.created_time || 0, at: o.created_time ? o.created_time * 1000 : null }); }
        return; // look inside for replies too
      }
      if (o.message && typeof o.message.text === 'string' && o.message.text.length > s.text.length) s.text = o.message.text;
      if (!s.seller && Array.isArray(o.actors) && o.actors[0] && o.actors[0].name) s.seller = o.actors[0].name;
      for (const k of ['url', 'wwwURL', 'permalink_url']) {
        if (!s.postUrl && typeof o[k] === 'string' && POST_URL.test(o[k])) s.postUrl = o[k].match(POST_URL)[0];
      }
      if (typeof o.uri === 'string' && /scontent|fbcdn/.test(o.uri) && !NOT_PHOTO.test(o.uri) && (o.width || 0) >= 300) {
        if (!s.images.includes(o.uri)) s.images.push(o.uri);
        if (o.width > s.imageWidth) { s.image = o.uri; s.imageWidth = o.width; }
      }
    });
    s.comments.sort((a, b) => (a.created || 0) - (b.created || 0));
    return s;
  }

  function extractPosts(html) {
    const found = new Map();
    for (const b of blobs(html)) {
      each(b, o => {
        if (typeof o.post_id === 'string' && /^\d+$/.test(o.post_id)) {
          const s = readStory(o);
          const old = found.get(s.key);
          if (!old) { found.set(s.key, s); return; }
          // The same post can appear several times with different pieces filled in.
          if (s.text.length > old.text.length) old.text = s.text;
          old.postUrl = old.postUrl || s.postUrl;
          old.seller = old.seller || s.seller;
          if (s.imageWidth > old.imageWidth) { old.image = s.image; old.imageWidth = s.imageWidth; }
          s.images.forEach(u => { if (!old.images.includes(u)) old.images.push(u); });
          const have = new Set(old.comments.map(c => c.name + '|' + c.text));
          s.comments.forEach(c => { if (!have.has(c.name + '|' + c.text)) old.comments.push(c); });
        }
      });
    }
    return [...found.values()].filter(p => p.text);
  }

  // Photos from a post's album page or a photo page: each Photo's biggest image, in order.
  function extractImages(html) {
    const out = [];
    const add = u => { const id = u.split('?')[0]; if (!out.some(x => x.split('?')[0] === id)) out.push(u); };
    // In document order (each() above walks in reverse), so photos keep the post's order.
    const inOrder = (node, fn) => {
      const stack = [node];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        if (fn(n) === false) continue;
        const kids = Object.values(n).filter(v => v && typeof v === 'object');
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
    };
    for (const b of blobs(html)) {
      inOrder(b, o => {
        if (typeof o.__typename === 'string' && SKIP_TYPES.test(o.__typename)) return false; // friends' stories, reels, videos on the page
        if (o.__typename !== 'Photo') return;
        let best = null;
        each(o, i => { if (typeof i.uri === 'string' && /fbcdn|scontent/.test(i.uri) && !NOT_PHOTO.test(i.uri) && (i.width || 0) >= 300 && (!best || i.width > best.width)) best = i; });
        if (best) add(best.uri);
        return false;
      });
    }
    return out;
  }

  function loggedOut(html) { return !/"USER_ID":"[1-9]\d*"/.test(html) && /id="login_form"|name="login"|\/login\/\?/.test(html); }

  const api = { extractPosts, extractImages, loggedOut };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FbJson = api;
})(typeof self !== 'undefined' ? self : globalThis);
