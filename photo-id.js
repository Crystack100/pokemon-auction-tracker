/* Reads the text printed on an auction's photo, in this browser and for free: the Pokémon's name and
   the card number ("125/197"). The number is then looked up in the Pokémon TCG card list
   (pokemontcg.io) for the card's full name and set. Used to search eBay and PriceCharting more
   exactly when the post doesn't name the card. */
window.PhotoId = (() => {
  const base = new URL('vendor/', document.baseURI).href;
  let workerP = null, namesP = null;
  const loadScript = src => new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('photo reader failed to load')); document.head.append(s);
  });
  const worker = () => workerP || (workerP = loadScript(base + 'tesseract/tesseract.min.js').then(() =>
    Tesseract.createWorker('eng', 1, { workerPath: base + 'tesseract/worker.min.js', corePath: base + 'tesseract/', langPath: base + 'tesseract/', gzip: true, workerBlobURL: false })));
  const names = () => namesP || (namesP = fetch(base + 'pokemon-names.json').then(r => r.json()).then(list =>
    list.map(n => ({ n, re: new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`, 'i') })).sort((a, b) => b.n.length - a.n.length)));

  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('photo could not be opened')); i.src = src; });
  // A grey, enlarged copy of part of the photo (the whole photo, the top where the name is, the bottom where the number is).
  function crop(img, y0, y1, width) {
    const sw = img.naturalWidth, sh = Math.round(img.naturalHeight * (y1 - y0));
    const scale = Math.min(3, width / sw);
    const c = document.createElement('canvas'); c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.4)';
    g.drawImage(img, 0, Math.round(img.naturalHeight * y0), sw, sh, 0, 0, c.width, c.height);
    return c;
  }
  async function readText(dataUrl) {
    const [w, img] = await Promise.all([worker(), loadImg(dataUrl)]);
    let text = '';
    for (const [y0, y1, width] of [[0, 1, 1600], [0, 0.3, 1800], [0.7, 1, 1800]]) text += '\n' + (await w.recognize(crop(img, y0, y1, width))).data.text;
    return text;
  }

  // "125/197", "TG30/TG30", "SV107/SV122", "GG44/GG70". Two numbers whose second part is a plausible set size.
  function numbersIn(text) {
    const out = [];
    for (const m of text.matchAll(/(?:^|[^A-Z0-9])([A-Z]{0,3})(\d{1,3}) ?\/ ?([A-Z]{0,3})(\d{2,3})(?!\d)/gi)) {
      const n = (m[1] + m[2]).toUpperCase(), total = (m[3] + m[4]).toUpperCase();
      if (+m[4] < 15 || out.some(x => x.n === n && x.total === total)) continue;
      out.push({ n: n.replace(/^0+(?=\d)/, ''), total });
    }
    return out;
  }
  async function pokemonIn(text) {
    const flat = text.replace(/[^A-Za-z.'\- ♀♂\n]/g, ' ');
    const hit = (await names()).find(x => x.n.length >= 4 && x.re.test(flat));
    return hit ? hit.n : null;
  }

  // Looks a number (and name, if read) up in the Pokémon TCG card list; fetchJson goes through the extension.
  async function lookup(pokemon, nums, fetchJson, title) {
    const sel = '&select=name,number,rarity,set&orderBy=-set.releaseDate&pageSize=20';
    for (const { n, total } of nums.slice(0, 3)) {
      const nameQ = pokemon ? (/\s/.test(pokemon) ? ` name:"${pokemon}*"` : ` name:${pokemon}*`) : '';
      const totalQ = /^\d+$/.test(total) ? ` set.printedTotal:${+total}` : '';
      for (const q of [`number:${n}${totalQ}${nameQ}`, nameQ ? `number:${n}${nameQ}` : null].filter(Boolean)) {
        const r = await fetchJson('https://api.pokemontcg.io/v2/cards?q=' + encodeURIComponent(q) + sel);
        let cards = (r && r.data) || [];
        if (!nameQ && cards.length > 1) cards = cards.filter(c => new RegExp(`\\b${c.name.split(' ')[0]}\\b`, 'i').test(title || ''));
        if (cards.length && (nameQ || cards.length === 1)) {
          const c = cards[0];
          return { status: 'ok', name: c.name, set: c.set.name, number: `${c.number}/${c.set.printedTotal}`, rarity: c.rarity || '', pokemon: pokemon || c.name.split(' ')[0], matches: cards.length };
        }
      }
    }
    return null;
  }

  // When the number can't be read: the Pokémon's name (from the post title or the photo) plus the rarity the
  // title gives ("Illustration", "SIR", "Gold"…). Picks the one card if there's only one, or the one whose
  // number shows anywhere in the photo text, otherwise the newest printing.
  const RARITIES = [[/special illustration|\bsir\b|\bsar\b/i, 'Special Illustration Rare'], [/illustration|\bir\b|\bar\b|\bchr\b/i, 'Illustration Rare'],
    [/hyper|gold|\bur\b/i, 'Hyper Rare'], [/full art|\bfa\b|ultra rare/i, 'Ultra Rare']];
  async function byName(pokemon, title, text, fetchJson) {
    const rarity = (RARITIES.find(([re]) => re.test(title || '')) || [])[1];
    if (!pokemon || !rarity) return null;
    const nameQ = /\s/.test(pokemon) ? `name:"${pokemon}*"` : `name:${pokemon}*`;
    const get = async q => { const r = await fetchJson('https://api.pokemontcg.io/v2/cards?q=' + encodeURIComponent(q) + '&select=name,number,rarity,set&orderBy=-set.releaseDate&pageSize=50'); return (r && r.data) || []; };
    let cards = await get(`${nameQ} rarity:"${rarity}"`);
    // The card list may word the rarity differently: all cards of this Pokémon, keeping the ones whose rarity fits.
    if (!cards.length) {
      const fit = rarity === 'Special Illustration Rare' ? /special illustration|special art/i : rarity === 'Illustration Rare' ? /illustration|art rare/i : rarity === 'Hyper Rare' ? /hyper|secret|gold/i : /ultra|full art/i;
      cards = (await get(nameQ)).filter(c => fit.test(c.rarity || '') && !(rarity === 'Illustration Rare' && /special/i.test(c.rarity || '')));
    }
    if (!cards.length) return { status: 'none', pokemon, rarity, note: `The card list has no ${pokemon} ${rarity}` };
    const digits = (text || '').replace(/\s+/g, '');
    const c = cards.find(c => digits.includes(`${c.number}/${c.set.printedTotal}`)) || cards.find(c => new RegExp(`(^|\\D)${c.number}(\\D|$)`).test(digits)) || cards[0];
    return { status: 'ok', name: c.name, set: c.set.name, number: `${c.number}/${c.set.printedTotal}`, rarity: c.rarity || '', pokemon, matches: cards.length, guessed: cards.length > 1 && c === cards[0] };
  }
  async function titlePokemon(title) { return pokemonIn(title || ''); }

  // From the titles of the eBay listings that look most like the photo (eBay image search): the card number
  // and Pokémon most of them agree on, then the exact card from the card list.
  async function fromTitles(titles, fetchJson, title) {
    const top = (list) => { const c = new Map(); list.filter(Boolean).forEach(k => c.set(k, (c.get(k) || 0) + 1)); return [...c.entries()].sort((a, b) => b[1] - a[1])[0] || null; };
    const nums = titles.map(t => numbersIn(t)[0]).filter(Boolean);
    const num = top(nums.map(n => n.n + '/' + n.total));
    const mons = []; for (const t of titles.slice(0, 15)) mons.push(await pokemonIn(t));
    const mon = top(mons);
    const rar = top(titles.map(t => (RARITIES.find(([re]) => re.test(t)) || [])[1]));
    const pokemon = (mon && mon[0]) || await titlePokemon(title);
    let found = null;
    if (num && (num[1] >= 2 || titles.length === 1)) { const [n, total] = num[0].split('/'); found = await lookup(pokemon, [{ n, total }], fetchJson, title) || await lookup(null, [{ n, total }], fetchJson, pokemon || title); }
    if (!found && pokemon && rar) { const b = await byName(pokemon, rar[0], titles.join(' '), fetchJson); if (b && b.status === 'ok') found = b; }
    const sample = titles.slice(0, 3);
    if (found) return { ...found, source: 'ebay', distinct: 1, titles: sample };
    return pokemon ? { status: 'partial', source: 'ebay', pokemon, titles: sample } : { status: 'none', source: 'ebay', titles: sample };
  }

  // Looking at the picture: the card in the photo (found by cutting away the plain background around it),
  // shrunk to a small grid of colours, compared with the card list's picture of every printing of that Pokémon.
  const GW = 16, GH = 22;
  function grid(img, box) {
    const c = document.createElement('canvas'); c.width = GW; c.height = GH;
    const g = c.getContext('2d'); g.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, GW, GH);
    const d = g.getImageData(0, 0, GW, GH).data, v = [];
    for (let i = 0; i < d.length; i += 4) v.push(d[i], d[i + 1], d[i + 2]);
    // Even out lighting: each colour channel to mean 0, spread 1.
    for (let ch = 0; ch < 3; ch++) {
      let m = 0, n = 0; for (let i = ch; i < v.length; i += 3) { m += v[i]; n++; } m /= n;
      let sd = 0; for (let i = ch; i < v.length; i += 3) sd += (v[i] - m) ** 2; sd = Math.sqrt(sd / n) || 1;
      for (let i = ch; i < v.length; i += 3) v[i] = (v[i] - m) / sd;
    }
    return v;
  }
  // Where the card is in the photo: everything that differs clearly from the colour of the photo's corners.
  function cardBox(img) {
    const W = 200, H = Math.round(img.naturalHeight * W / img.naturalWidth);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const px = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const corners = [px(2, 2), px(W - 3, 2), px(2, H - 3), px(W - 3, H - 3)];
    const bg = [0, 1, 2].map(k => corners.reduce((s, c) => s + c[k], 0) / 4);
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    const rows = new Array(H).fill(0), cols = new Array(W).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = px(x, y);
      if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 90) { rows[y]++; cols[x]++; }
    }
    for (let y = 0; y < H; y++) if (rows[y] > W * 0.15) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    for (let x = 0; x < W; x++) if (cols[x] > H * 0.15) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    const k = img.naturalWidth / W;
    if (x1 - x0 < W * 0.2 || y1 - y0 < H * 0.2) return { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    return { x: x0 * k, y: y0 * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
  }
  const dist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  async function byPicture(pokemon, dataUrl, fetchJson, fetchImg) {
    if (!pokemon || !fetchImg) return null;
    const nameQ = /\s/.test(pokemon) ? `name:"${pokemon}*"` : `name:${pokemon}*`;
    const r = await fetchJson('https://api.pokemontcg.io/v2/cards?q=' + encodeURIComponent(nameQ) + '&select=name,number,rarity,set,images&orderBy=-set.releaseDate&pageSize=60');
    const cards = ((r && r.data) || []).filter(c => c.images && c.images.small);
    if (!cards.length) return null;
    const photo = await loadImg(dataUrl);
    const mine = grid(photo, cardBox(photo));
    const scored = [];
    for (let i = 0; i < cards.length; i += 6) {
      await Promise.all(cards.slice(i, i + 6).map(async c => {
        try { const im = await loadImg(await fetchImg(c.images.small)); scored.push({ c, d: dist(mine, grid(im, { x: 0, y: 0, w: im.naturalWidth, h: im.naturalHeight })) }); } catch {}
      }));
    }
    scored.sort((a, b) => a.d - b.d);
    if (!scored.length) return null;
    const [best, next] = scored;
    const sure = !next || best.d < next.d * 0.9;
    const c = best.c;
    return { status: 'ok', name: c.name, set: c.set.name, number: `${c.number}/${c.set.printedTotal}`, rarity: c.rarity || '', pokemon, matches: scored.length,
      source: 'picture', guessed: !sure, score: Math.round(best.d * 100) / 100 };
  }

  async function identify(dataUrls, fetchJson, title, fetchImg) {
    let text = '', pokemon = null, nums = [];
    for (const d of dataUrls) {
      text += await readText(d);
      pokemon = await pokemonIn(text); nums = numbersIn(text);
      if (nums.length) break;
    }
    const named = (await titlePokemon(title)) || pokemon;
    let found = nums.length ? await lookup(named, nums, fetchJson, title) || await lookup(pokemon, nums, fetchJson, title) : null;
    let note = '';
    if (!found) { const b = await byName(named, title, text, fetchJson); if (b && b.status === 'ok') found = b; else if (b) note = b.note; }
    // No number, or only a guess between several printings: compare the photo with each printing's picture.
    if ((!found || found.guessed) && (named || pokemon)) {
      try { const p = await byPicture(named || pokemon, dataUrls[0], fetchJson, fetchImg); if (p && (!found || !p.guessed)) found = p; } catch (e) { note = note || 'picture compare failed'; }
    }
    const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (found) return { ...found, distinct: found.guessed !== undefined ? 1 : nums.length, text: excerpt };
    return pokemon || named ? { status: 'partial', pokemon: pokemon || named, distinct: nums.length, text: excerpt, note } : { status: 'none', text: excerpt, note };
  }
  return { identify, fromTitles, numbersIn, pokemonIn };
})();
