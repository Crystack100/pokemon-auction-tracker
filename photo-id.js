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

  async function identify(dataUrls, fetchJson, title) {
    let text = '', pokemon = null, nums = [];
    for (const d of dataUrls) {
      text += await readText(d);
      pokemon = await pokemonIn(text); nums = numbersIn(text);
      if (nums.length) break;
    }
    const found = nums.length ? await lookup(pokemon, nums, fetchJson, title) : null;
    const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (found) return { ...found, distinct: nums.length, text: excerpt };
    return pokemon ? { status: 'partial', pokemon, distinct: nums.length, text: excerpt } : { status: 'none', text: excerpt };
  }
  return { identify, numbersIn, pokemonIn };
})();
