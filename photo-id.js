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

  // The card list: pokemontcg.io (tried 3 times, it's sometimes down), then TCGdex as a second source.
  // Both give cards as { name, number, rarity, set: { name, printedTotal }, images: { small } }.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let tcgdexSets = null;
  async function getJson(url, fetchJson) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {} // straight from this page when the site allows it
    return fetchJson(url);
  }
  async function tcgdex(q, fetchJson) {
    const name = (q.match(/name:"?([^"*]+)\*?"?/) || [])[1];
    const number = (q.match(/number:(\S+)/) || [])[1];
    const total = (q.match(/set\.printedTotal:(\d+)/) || [])[1];
    const rarity = (q.match(/rarity:"([^"]+)"/) || [])[1];
    if (!name && !number) return [];
    const base = 'https://api.tcgdex.net/v2/en';
    if (!tcgdexSets) {
      const sets = await getJson(base + '/sets', fetchJson);
      tcgdexSets = new Map((sets || []).map((x, i) => [x.id, { name: x.name, official: x.cardCount && x.cardCount.official, order: i }]));
    }
    const params = [name ? 'name=' + encodeURIComponent(name.trim()) : '', number ? 'localId=' + encodeURIComponent(number) : ''].filter(Boolean).join('&');
    let list = (await getJson(`${base}/cards?${params}`, fetchJson)) || [];
    const setOf = c => tcgdexSets.get(c.id.slice(0, c.id.lastIndexOf('-'))) || { name: '', official: null, order: -1 };
    list = list.filter(c => c.id && (!total || +setOf(c).official === +total) && (!name || c.name.toLowerCase().startsWith(name.trim().toLowerCase())));
    list.sort((a, b) => setOf(b).order - setOf(a).order);
    list = list.slice(0, 40);
    const out = list.map(c => ({ name: c.name, number: c.localId, rarity: '', set: { name: setOf(c).name, printedTotal: setOf(c).official || '?' }, images: c.image ? { small: c.image + '/low.png' } : null, _id: c.id }));
    if (rarity) { // rarity is only on each card's own page
      for (let i = 0; i < out.length; i += 5) await Promise.all(out.slice(i, i + 5).map(async c => { try { const d = await getJson(`${base}/cards/${c._id}`, fetchJson); c.rarity = (d && d.rarity) || ''; } catch {} }));
      return out.filter(c => c.rarity.toLowerCase() === rarity.toLowerCase());
    }
    return out;
  }
  let ptcgDownAt = 0; // pokemontcg.io is often down for hours: after a failure, go straight to TCGdex for 10 minutes
  async function cardsQuery(q, extra, fetchJson) {
    let lastErr = null;
    for (const wait of Date.now() - ptcgDownAt < 10 * 60e3 ? [] : [0, 1500]) {
      if (wait) await sleep(wait);
      try { const r = await fetchJson('https://api.pokemontcg.io/v2/cards?q=' + encodeURIComponent(q) + extra); return (r && r.data) || []; }
      catch (e) { lastErr = e; if (!/answered 5\d\d|timeout|failed/i.test(String(e.message || e))) break; }
    }
    if (lastErr) ptcgDownAt = Date.now();
    try { return await tcgdex(q, fetchJson); }
    catch (e) { throw new Error(`card lists unavailable (${(lastErr && lastErr.message) || e.message})`); }
  }

  // Looks a number (and name, if read) up in the Pokémon TCG card list; fetchJson goes through the extension.
  async function lookup(pokemon, nums, fetchJson, title) {
    const sel = '&select=name,number,rarity,set&orderBy=-set.releaseDate&pageSize=20';
    for (const { n, total } of nums.slice(0, 3)) {
      const nameQ = pokemon ? (/\s/.test(pokemon) ? ` name:"${pokemon}*"` : ` name:${pokemon}*`) : '';
      const totalQ = /^\d+$/.test(total) ? ` set.printedTotal:${+total}` : '';
      for (const q of [`number:${n}${totalQ}${nameQ}`, nameQ ? `number:${n}${nameQ}` : null].filter(Boolean)) {
        let cards = await cardsQuery(q, sel, fetchJson);
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
    const get = q => cardsQuery(q, '&select=name,number,rarity,set&orderBy=-set.releaseDate&pageSize=50', fetchJson);
    let cards = await get(`${nameQ} rarity:"${rarity}"`);
    // The card list may word the rarity differently: all cards of this Pokémon, keeping the ones whose rarity fits.
    if (!cards.length) {
      const fit = rarity === 'Special Illustration Rare' ? /special illustration|special art/i : rarity === 'Illustration Rare' ? /illustration|art rare/i : rarity === 'Hyper Rare' ? /hyper|secret|gold/i : /ultra|full art/i;
      cards = (await get(nameQ)).filter(c => fit.test(c.rarity || '') && !(rarity === 'Illustration Rare' && /special/i.test(c.rarity || '')));
    }
    cards = inHint(cards);
    if (!cards.length) return { status: 'none', pokemon, rarity, note: `The card list has no ${pokemon} ${rarity}${hint ? ' in ' + hint.label : ''}` };
    const digits = (text || '').replace(/\s+/g, '');
    const c = cards.find(c => digits.includes(`${c.number}/${c.set.printedTotal}`)) || cards.find(c => new RegExp(`(^|\\D)${c.number}(\\D|$)`).test(digits)) || cards[0];
    return { status: 'ok', name: c.name, set: c.set.name, number: `${c.number}/${c.set.printedTotal}`, rarity: c.rarity || '', pokemon, matches: cards.length, guessed: cards.length > 1 && c === cards[0] };
  }
  async function titlePokemon(title) { return pokemonIn(title || ''); }

  // The card's name as most eBay titles write it: the Pokémon with the word before it when that's part of the
  // name ("Team Aqua's", "Dark", "Radiant"…) and the word after it when it's a card type ("ex", "GX", "V"…).
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function cardNameFrom(titles, pokemon) {
    const count = new Map();
    const re = new RegExp(`(?:\\b([A-Z][a-z]+'s|Team \\w+'s|Dark|Light|Radiant|Shining|Mega|M|Alolan|Galarian|Hisuian|Paldean|Rocket's|Erika's|Misty's|Brock's|Lt\\. Surge's|Sabrina's|Blaine's|Giovanni's|Koga's)\\s+)?${esc(pokemon)}(?:[\\s-]+(ex|EX|GX|V|VMAX|VSTAR|LV\\.X|BREAK|Prime|Star|δ|&\\s+\\w+(?:[\\s-]+GX)?))?(?![a-z])`, 'i');
    for (const t of titles) {
      const m = t.match(re); if (!m) continue;
      const pre = m[1] && !/^(pokemon|pokémon|the|holo|rare|card|psa|cgc|bgs|mint|nm|tcg|japanese|english)'?s?$/i.test(m[1]) ? m[1] + ' ' : '';
      const x = m[2] || '';
      const suffix = !x ? '' : x.startsWith('&') ? ' ' + x.replace(/\s+/g, ' ').replace(/[\s-]+gx$/i, '-GX') : x === 'ex' ? ' ex' : /^(gx|ex)$/i.test(x) ? '-' + x.toUpperCase() : /^(v|vmax|vstar|lv\.x|break)$/i.test(x) ? ' ' + x.toUpperCase() : ' ' + x;
      const k = pre + pokemon + suffix;
      count.set(k, (count.get(k) || 0) + 1);
    }
    const best = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
    return best ? best[0] : pokemon;
  }
  // The set most titles name, when they do.
  const SETS = ['Base Set', 'Jungle', 'Fossil', 'Team Rocket', 'Gym Heroes', 'Gym Challenge', 'Neo Genesis', 'Neo Discovery', 'Neo Revelation', 'Neo Destiny', 'Expedition', 'Aquapolis', 'Skyridge',
    'Ruby & Sapphire', 'Sandstorm', 'Dragon', 'Team Magma vs Team Aqua', 'Hidden Legends', 'FireRed & LeafGreen', 'Team Rocket Returns', 'Deoxys', 'Emerald', 'Unseen Forces', 'Delta Species', 'Legend Maker',
    'Holon Phantoms', 'Crystal Guardians', 'Dragon Frontiers', 'Power Keepers', 'Diamond & Pearl', 'Mysterious Treasures', 'Secret Wonders', 'Great Encounters', 'Majestic Dawn', 'Legends Awakened', 'Stormfront',
    'Platinum', 'Rising Rivals', 'Supreme Victors', 'Arceus', 'HeartGold SoulSilver', 'Unleashed', 'Undaunted', 'Triumphant', 'Call of Legends', 'Black & White', 'Emerging Powers', 'Noble Victories',
    'Next Destinies', 'Dark Explorers', 'Dragons Exalted', 'Boundaries Crossed', 'Plasma Storm', 'Plasma Freeze', 'Plasma Blast', 'Legendary Treasures', 'Flashfire', 'Furious Fists', 'Phantom Forces',
    'Primal Clash', 'Roaring Skies', 'Ancient Origins', 'BREAKthrough', 'BREAKpoint', 'Generations', 'Fates Collide', 'Steam Siege', 'Evolutions', 'Sun & Moon', 'Guardians Rising', 'Burning Shadows',
    'Shining Legends', 'Crimson Invasion', 'Ultra Prism', 'Forbidden Light', 'Celestial Storm', 'Dragon Majesty', 'Lost Thunder', 'Team Up', 'Detective Pikachu', 'Unbroken Bonds', 'Unified Minds',
    'Hidden Fates', 'Cosmic Eclipse', 'Sword & Shield', 'Rebel Clash', 'Darkness Ablaze', "Champion's Path", 'Vivid Voltage', 'Shining Fates', 'Battle Styles', 'Chilling Reign', 'Evolving Skies',
    'Celebrations', 'Fusion Strike', 'Brilliant Stars', 'Astral Radiance', 'Pokemon GO', 'Lost Origin', 'Silver Tempest', 'Crown Zenith', 'Scarlet & Violet', 'Paldea Evolved', 'Obsidian Flames', '151',
    'Paradox Rift', 'Paldean Fates', 'Temporal Forces', 'Twilight Masquerade', 'Shrouded Fable', 'Stellar Crown', 'Surging Sparks', 'Prismatic Evolutions', 'Journey Together', 'Destined Rivals',
    'Black Bolt', 'White Flare', 'Mega Evolution', 'Phantasmal Flames']
    .sort((a, b) => b.length - a.length).map(n => ({ n, re: new RegExp(`(^|[^a-z])${esc(n).replace(/ & /g, ' (?:&|and)? ?').replace(/ vs /g, ' (?:vs\\.?|versus) ')}(?![a-z])`, 'i') }));
  const THIRTIETH = { label: '30th Celebration', re: /\b30\s?th\b|30th anniv|celebration/i };
  function setFrom(titles) {
    const c = new Map();
    for (const t of titles) { const s = /\b30\s?th\b/i.test(t) ? { n: THIRTIETH.label } : SETS.find(x => x.re.test(t)); if (s) c.set(s.n, (c.get(s.n) || 0) + 1); }
    const best = [...c.entries()].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] >= 2 ? best[0] : '';
  }

  // The set the post itself names ("30th Classic coll", "Hidden Fates"…): picture and name matches must come from
  // it, so a look-alike printing from another set isn't picked. Set per auction with setPostText().
  let hint = null;
  function setPostText(text) {
    text = text || '';
    if (THIRTIETH.re.test(text) && /\b30\s?th\b/i.test(text)) { hint = THIRTIETH; return hint; }
    const s = SETS.find(x => x.re.test(text) && x.n !== '151' && x.n !== 'Dragon' && x.n !== 'Platinum' && x.n !== 'Arceus' && x.n !== 'Generations' && x.n !== 'Evolutions');
    hint = s ? { label: s.n, re: new RegExp('^' + esc(s.n) + '$', 'i') } : null;
    return hint;
  }
  const inHint = cards => hint ? cards.filter(c => hint.re.test((c.set && c.set.name) || '')) : cards;

  // From the titles of the eBay listings that look most like the photo (eBay image search): the card number
  // and Pokémon most of them agree on, then the exact card from the card list.
  async function fromTitles(titles, fetchJson, title) {
    const top = (list) => { const c = new Map(); list.filter(Boolean).forEach(k => c.set(k, (c.get(k) || 0) + 1)); return [...c.entries()].sort((a, b) => b[1] - a[1])[0] || null; };
    const nums = titles.map(t => numbersIn(t)[0]).filter(Boolean);
    const num = top(nums.map(n => n.n + '/' + n.total.replace(/^0+(?=\d)/, '')));
    const mons = []; for (const t of titles.slice(0, 15)) mons.push(await pokemonIn(t));
    const mon = top(mons);
    const rar = top(titles.map(t => (RARITIES.find(([re]) => re.test(t)) || [])[1]));
    const pokemon = (mon && mon[0]) || await titlePokemon(title);
    let found = null, listErr = null;
    const sure = num && (num[1] >= 2 || titles.length === 1);
    try {
      if (sure) { const [n, total] = num[0].split('/'); found = await lookup(pokemon, [{ n, total }], fetchJson, title) || await lookup(null, [{ n, total }], fetchJson, pokemon || title); }
      if (!found && pokemon && rar) { const b = await byName(pokemon, rar[0], titles.join(' '), fetchJson); if (b && b.status === 'ok') found = b; }
    } catch (e) { listErr = e; }
    const sample = titles.slice(0, 3);
    if (found) return { ...found, source: 'ebay', distinct: 1, titles: sample };
    const named0 = setFrom(titles);
    // The card lists couldn't confirm it (down, or the card isn't in them): the eBay titles alone are enough
    // when most of them agree on the Pokémon and the number.
    if (sure && pokemon) {
      const named = cardNameFrom(titles, pokemon);
      return { status: 'ok', source: 'ebay', name: named, set: named0 || (hint ? hint.label : ''), number: num[0], rarity: rar ? rar[0] : '', pokemon, distinct: 1, titles: sample, fromTitlesOnly: true, listError: listErr ? String(listErr.message || listErr) : null };
    }
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
    const cards = inHint(await cardsQuery(nameQ, '&select=name,number,rarity,set,images&orderBy=-set.releaseDate&pageSize=100', fetchJson)).filter(c => c.images && c.images.small);
    if (!cards.length) return null; // (also when the post's set isn't in the card list yet: no look-alike from another set)
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

  // Every Pokémon named in a title, in order ("Mew & Mewtwo" → Mew, Mewtwo).
  async function pokemonAll(text) {
    const flat = (text || '').replace(/[^A-Za-z.'\- ♀♂]/g, ' ');
    const hits = [];
    for (const x of await names()) {
      if (x.n.length < 3) continue;
      const m = flat.match(x.re);
      if (!m) continue;
      const at = m.index + m[1].length, end = at + x.n.length; // the same words can't be two Pokémon
      if (!hits.some(h => at < h.end && end > h.at || h.n === x.n)) hits.push({ n: x.n, at, end });
    }
    return hits.sort((a, b) => a.at - b.at).map(h => h.n);
  }
  // Several cards in one auction: the first photo is cut into side-by-side (or stacked) parts, and every
  // other photo counts as a part too. Each named Pokémon gets the part and printing that look most alike.
  async function identifyMany(dataUrls, pokemonList, fetchJson, fetchImg, ebayTitles) {
    const imgs = []; for (const d of dataUrls.slice(0, 4)) { try { imgs.push(await loadImg(d)); } catch {} }
    if (!imgs.length) return null;
    const regions = [];
    const box = cardBox(imgs[0]), n = pokemonList.length;
    const across = box.w >= box.h * 0.9;
    for (let i = 0; i < n; i++) regions.push(grid(imgs[0], across ? { x: box.x + box.w * i / n, y: box.y, w: box.w / n, h: box.h } : { x: box.x, y: box.y + box.h * i / n, w: box.w, h: box.h / n }));
    for (const im of imgs.slice(1)) regions.push(grid(im, cardBox(im)));
    // For each Pokémon: its printings' pictures, and the best printing for each part of the photos.
    const best = [];
    for (const mon of pokemonList) {
      const nameQ = /\s/.test(mon) ? `name:"${mon}*"` : `name:${mon}*`;
      let cards = [];
      try { cards = await cardsQuery(nameQ, '&select=name,number,rarity,set,images&orderBy=-set.releaseDate&pageSize=100', fetchJson); } catch {}
      cards = inHint(cards).filter(c => c.images && c.images.small && new RegExp(`(^|[^a-z])${mon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`, 'i').test(c.name));
      const sigs = [];
      for (let i = 0; i < cards.length; i += 6) await Promise.all(cards.slice(i, i + 6).map(async c => { try { const im = await loadImg(await fetchImg(c.images.small)); sigs.push({ c, g: grid(im, { x: 0, y: 0, w: im.naturalWidth, h: im.naturalHeight }) }); } catch {} }));
      best.push(regions.map(r => { const sc = sigs.map(x => ({ c: x.c, d: dist(r, x.g) })).sort((a, b) => a.d - b.d); return sc.length ? { c: sc[0].c, d: sc[0].d, sure: !sc[1] || sc[0].d < sc[1].d * 0.9, count: sc.length } : null; }));
    }
    // Give each Pokémon its own part of the photos (the arrangement with the closest matches overall).
    const perms = (arr, k) => k === 0 ? [[]] : arr.flatMap((x, i) => perms(arr.filter((_, j) => j !== i), k - 1).map(p => [x, ...p]));
    let pick = null, total = Infinity;
    for (const p of perms([...regions.keys()], n)) {
      const t = p.reduce((s, r, i) => s + (best[i][r] ? best[i][r].d : 9), 0);
      if (t < total) { total = t; pick = p; }
    }
    const items = [];
    for (const [i, mon] of pokemonList.entries()) {
      // eBay image search of the photos: the listings that name this Pokémon (and not just as part of a longer name).
      const re = new RegExp(`(^|[^a-z])${esc(mon)}(?![a-z])`, 'i');
      const mine = (ebayTitles || []).filter(t => re.test(t));
      if (mine.length >= 2) {
        try { const e = await fromTitles(mine, fetchJson, mon); if (e.status === 'ok' && e.pokemon === mon) { items.push({ name: e.name, set: e.set, number: e.number, rarity: e.rarity || '', pokemon: mon, guessed: false, matches: mine.length, source: 'ebay' }); continue; } } catch {}
      }
      const b = pick && best[i][pick[i]];
      // An uncertain picture match only gives the card's name: its set and number could be a look-alike printing.
      items.push(b ? { name: b.c.name, set: b.sure ? b.c.set.name : (hint ? hint.label : ''), number: b.sure ? `${b.c.number}/${b.c.set.printedTotal}` : '', rarity: b.c.rarity || '', pokemon: mon, guessed: !b.sure, matches: b.count } : { name: mon, set: hint ? hint.label : '', number: '', pokemon: mon, guessed: true, matches: 0 });
    }
    return { status: items.some(x => x.number) ? 'ok' : 'partial', multi: true, items, source: items.some(x => x.source === 'ebay') ? 'ebay' : 'picture', distinct: 1, name: items.map(x => x.name).join(' & ') };
  }

  async function identify(dataUrls, fetchJson, title, fetchImg) {
    let text = '', pokemon = null, nums = [];
    for (const d of dataUrls) {
      text += await readText(d);
      pokemon = await pokemonIn(text); nums = numbersIn(text);
      if (nums.length) break;
    }
    // The photo first; the post's title only if the photo didn't show a Pokémon's name.
    const named = pokemon || (await titlePokemon(title));
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
  return { identify, identifyMany, pokemonAll, fromTitles, numbersIn, pokemonIn, setPostText };
})();
