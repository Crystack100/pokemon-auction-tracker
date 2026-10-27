/* Reads a pasted Facebook auction post (with its comments) into a plain object.
   Works in the browser (window.AuctionParser) and in Node (module.exports). */
(function (root) {
  // Australian time zones by the label sellers write in posts.
  // dst: which daylight-saving rule applies, if any.
  const ZONES = {
    QLD: { label: 'QLD', std: 600, dst: null },
    AEST: { label: 'AEST', std: 600, dst: null },
    NSW: { label: 'NSW', std: 600, dst: 'south' },
    SYD: { label: 'NSW', std: 600, dst: 'south' },
    ACT: { label: 'ACT', std: 600, dst: 'south' },
    VIC: { label: 'VIC', std: 600, dst: 'south' },
    MEL: { label: 'VIC', std: 600, dst: 'south' },
    TAS: { label: 'TAS', std: 600, dst: 'south' },
    AEDT: { label: 'AEDT', std: 660, dst: null },
    SA: { label: 'SA', std: 570, dst: 'south' },
    ACST: { label: 'ACST', std: 570, dst: null },
    ACDT: { label: 'ACDT', std: 630, dst: null },
    NT: { label: 'NT', std: 570, dst: null },
    WA: { label: 'WA', std: 480, dst: null },
    PERTH: { label: 'WA', std: 480, dst: null },
    AWST: { label: 'WA', std: 480, dst: null },
    NZ: { label: 'NZ', std: 720, dst: 'nz' },
    NZT: { label: 'NZ', std: 720, dst: 'nz' },
  };

  function nthSunday(year, month, n) { // month 0-based
    const d = new Date(Date.UTC(year, month, 1));
    const first = (7 - d.getUTCDay()) % 7 + 1;
    return first + (n - 1) * 7;
  }
  function lastSunday(year, month) {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const dow = new Date(Date.UTC(year, month, last)).getUTCDay();
    return last - dow;
  }
  // Offset in minutes east of UTC for a wall-clock date in a zone.
  function zoneOffset(zone, y, m, d) {
    if (!zone.dst) return zone.std;
    const key = m * 100 + d;
    let start, end;
    if (zone.dst === 'south') { // first Sun Oct → first Sun Apr
      start = 9 * 100 + nthSunday(y, 9, 1);
      end = 3 * 100 + nthSunday(y, 3, 1);
    } else { // NZ: last Sun Sep → first Sun Apr
      start = 8 * 100 + lastSunday(y, 8);
      end = 3 * 100 + nthSunday(y, 3, 1);
    }
    const inDst = key >= start || key < end;
    return zone.std + (inDst ? 60 : 0);
  }

  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const num = s => parseFloat(String(s).replace(/,/g, ''));

  function findZone(text) {
    const m = text.toUpperCase().match(/\b(QLD|AEST|AEDT|NSW|SYD|ACT|VIC|MEL|TAS|SA|ACST|ACDT|NT|WA|PERTH|AWST|NZT|NZ)\b/);
    return m ? ZONES[m[1]] : null;
  }

  function findTime(text) {
    // 9:00pm, 9pm, 9.30 pm, 21:00
    let m = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
    if (m) {
      let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12;
      return { h, min: m[2] ? +m[2] : 0 };
    }
    m = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (m) return { h: +m[1], min: +m[2] };
    return null;
  }

  // Every date written in the text, as {y, m, d}. Prices and grades like "$9.60" or "9.5" are skipped.
  function dateCandidates(text, now) {
    const out = [];
    const re = /(^|[^\d$.,])(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?(?![\d.,]*\d)/g;
    let m;
    while ((m = re.exec(text))) {
      const sep = text.slice(m.index).match(/\d([\/.-])/)[1];
      if (sep === '.' && !m[4]) continue; // "9.5" is a grade or price, not a date
      let y = m[4] ? +m[4] : now.getFullYear(); if (y < 100) y += 2000;
      const d = +m[2], mo = +m[3] - 1;
      if (mo >= 0 && mo < 12 && d >= 1 && d <= 31) out.push({ y, m: mo, d, explicitYear: !!m[4] });
    }
    const re2 = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/gi;
    while ((m = re2.exec(text))) out.push({ y: m[3] ? +m[3] : now.getFullYear(), m: MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)), d: +m[1], explicitYear: !!m[3] });
    const re3 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/gi;
    while ((m = re3.exec(text))) out.push({ y: m[3] ? +m[3] : now.getFullYear(), m: MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)), d: +m[2], explicitYear: !!m[3] });
    return out;
  }
  // The date an auction ends: the first one written that falls between a week ago and two months ahead.
  // Day-only posts ("ends Wednesday", "ends 28th") resolve to the next such day.
  function findDate(text, now, loose) {
    const day = 86400e3;
    const near = c => { const t = Date.UTC(c.y, c.m, c.d); return t > now.getTime() - 7 * day && t < now.getTime() + 62 * day; };
    for (const c of dateCandidates(text, now)) {
      if (near(c)) return c;
      if (!c.explicitYear) { const n = { ...c, y: c.y + 1 }; if (near(n)) return n; } // "3/1" written in late December
    }
    if (!loose) return null; // weekday / "28th" only from the ends line ("Sun & Moon" is a set, not a day)
    const wd = text.match(/\b(sun|mon|tue|wed|thu|fri|sat)(?:day|s|nes|nesday|rs|rsday|urday|sday)?\b/i);
    if (wd) {
      const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(wd[1].toLowerCase());
      const t = new Date(now.getTime() + 10 * 3600e3); // Australian date, near enough to pick the day
      const ahead = (want - t.getUTCDay() + 7) % 7;
      const d = new Date(t.getTime() + ahead * day);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
    }
    const th = text.match(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i);
    if (th) {
      const t = new Date(now.getTime() + 10 * 3600e3);
      let c = { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: +th[1] };
      if (Date.UTC(c.y, c.m, c.d) < Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())) c = { ...c, m: (c.m + 1) % 12, y: c.m === 11 ? c.y + 1 : c.y };
      return c;
    }
    return null;
  }

  // Ending time: prefer the "Auction ends" section, then any line mentioning "end".
  function parseEnd(postLines, now) {
    const text = postLines.join('\n');
    let block = '';
    const idx = postLines.findIndex(l => /auction\s*end|ends?\b|closing|finish/i.test(l));
    if (idx >= 0) block = postLines.slice(idx, idx + 4).join(' ');
    const zone = findZone(block) || findZone(text) || ZONES.QLD;
    const time = findTime(block) || findTime(text);
    let date = findDate(block, now, true) || findDate(text, now);
    if (!date && /tonight|today|same\s*day/i.test(text)) {
      const local = new Date(now.getTime() + zoneOffset(zone, now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) * 60000);
      date = { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate() };
    }
    if (!date || !time) return { endsAt: null, zone: zone.label, assumedZone: !findZone(text) };
    const off = zoneOffset(zone, date.y, date.m, date.d);
    const utc = Date.UTC(date.y, date.m, date.d, time.h, time.min) - off * 60000;
    return { endsAt: new Date(utc).toISOString(), zone: zone.label, offsetMin: off, assumedZone: !findZone(text) };
  }

  // A comment counts as a bid when it is basically just a dollar amount.
  // A comment counts as a bid when it is basically just a dollar amount, give or take a few
  // friendly words and emoji ("$520", "550 pls", "Bid 600 🔥", "1.2k").
  function bidAmount(comment) {
    const c = String(comment)
      .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu, ' ')
      .replace(/^\s*(?:@\S+\s+)?(?:(?:new\s+)?bid(?:ding)?|i'?ll\s+(?:go|bid)|go|offer)\s*[:\-]?\s*/i, '')
      .replace(/\s+/g, ' ').trim();
    const m = c.match(/^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(k)?\s*\$?(?:\s*(?:aud|bid|please|pls|plz|thanks|thank you|ty|thx|for me|here))*\s*[!.]*$/i);
    if (!m) return null;
    let v = num(m[1] + (m[2] ? '.' + m[2] : ''));
    if (m[3]) v *= 1000;
    return v > 0 ? v : null;
  }

  function parseComments(lines) {
    const comments = [];
    for (let i = 1; i < lines.length - 1; i++) {
      if (lines[i] === '·') {
        comments.push({ name: lines[i - 1], text: lines[i + 1] });
      }
    }
    if (!comments.length) { // fallback: "Name: 500" or "Name - 500"
      for (const l of lines) {
        const m = l.match(/^(.{2,40}?)\s*[:\-–]\s*(.+)$/);
        if (m && bidAmount(m[2]) != null) comments.push({ name: m[1], text: m[2] });
      }
    }
    return comments;
  }

  const NOISE = /\b(mint|condition|huge|same\s*day|auction|ends?|tonight|today|qld|nsw|vic|time|starting|start|bid|no\s*reserve|reserve|graded|slab|gem|pristine|beautiful|stunning|rare|!+)\b/gi;
  const clean = s => s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu, ' ').replace(/\s+/g, ' ').trim();

  // Lines that are auction housekeeping rather than what's being sold.
  const BOILER = /auction|\bends?\b|\bhours?\b|tonight|finish|anti\s*-?\s*snipe|beware|scam|enjoy|reserve|approved|admin|trusted|\bvip\b|member|condition|postage|\bpost\b|payment|paypal|pay\s*id|\bgns\b|g\s*&\s*s|increment|\bbids?\b|^#|insurance|tracked|mailer|envelope|messaging|confidence|legend|read all|posting out|to pay|failing|failure|removal|\bqld\b|\bnsw\b|\bvic\b|\bwa\b|\bsa\b|\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}|\d\s*(am|pm)\b|see (more|less|pictures)|as shown|^\s*(standard|express|registered|regular|parcel|signature)\b|\bexpress\b.*\d|\bstandard\b.*\d|shipping|pick\s*-?\s*up|\bcollect(ion)?\b|\$\s*\d|please see|see (the )?(photos?|pics?|pictures?|images?)|photos? (for|of)\b|pics? (for|of)\b|·|^\d+\s*(m|h|d|w|mins?|hrs?)$/i;
  const SEPARATOR = /^[\s_\-.=*~•·]*$/;
  const PUBLISHER = /^(wizards of the coast|wotc|the pok[eé]mon company|pok[eé]mon tcg|pok[eé]mon)$/i;

  // Sellers usually put the item in its own block between separator lines; take the first block
  // that isn't housekeeping, up to the first line that lists contents ("20 X RAWS").
  function titleFromBlocks(postLines) {
    const lines = postLines.map(l => ({ raw: l, text: clean(l) }));
    const picked = [];
    for (const l of lines) {
      if (SEPARATOR.test(l.text) || BOILER.test(l.text)) { if (picked.length) break; continue; }
      if (PUBLISHER.test(l.text)) continue;
      if (picked.length && /^\d+\s*x\b/i.test(l.text)) break;
      picked.push(l.text);
      if (picked.length >= 4) break;
    }
    return picked.join(' ');
  }

  function parseCard(postLines) {
    const text = postLines.join('\n');
    const g = text.match(/\b(PSA|BGS|CGC|TAG|ACE|SGC|BECKETT)\s*(\d{1,2}(?:\.\d)?)\b/i);
    const grade = g ? `${g[1].toUpperCase()} ${g[2]}` : '';
    let source = '';
    if (g) {
      // Use just the stretch of the line around the grade, in case the post came through as one long line.
      const line = postLines.find(l => l.includes(g[0])) || '';
      const parts = line.split(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|!{2,}|\s[-–|]\s/u);
      source = clean(parts.find(p => p.includes(g[0])) || line);
    }
    else source = titleFromBlocks(postLines);
    let name = source.replace(g ? g[0] : '', ' ').replace(/[:–\-|]+/g, ' ').replace(NOISE, ' ').replace(/[^\w\s'.#/&é-]/g, ' ').replace(/\s+/g, ' ').trim();
    name = name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    return { grade, cardName: name };
  }

  // Postage: the cheapest price listed in the postage section, skipping insurance amounts.
  function parsePostage(postLines) {
    const start = postLines.findIndex(l => /postage|shipping|delivery/i.test(l));
    if (start < 0) return null;
    const prices = [];
    for (const l of postLines.slice(start, start + 8)) {
      if (prices.length && /payment|paypal|pay\s*id|bidding|increment/i.test(l)) break;
      if (/insur|STC|combined/i.test(l)) continue;
      for (const m of l.matchAll(/\$\s*(\d[\d,]*(?:\.\d{2})?)/g)) prices.push(num(m[1]));
    }
    if (/free\s*(post|shipping)/i.test(postLines.slice(start, start + 3).join(' ')) && !prices.length) return 0;
    return prices.length ? Math.min(...prices) : null;
  }

  function parseMoney(text, re) {
    const m = text.match(re);
    return m ? num(m[1]) : null;
  }

  // opts.postOnly: the text is just the post (comments are read separately), so a stray "·"
  // line is not where the comments start, and Facebook's "·" separators are dropped.
  function parse(raw, now = new Date(), opts = {}) {
    let lines = raw.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    if (opts.postOnly) lines = lines.filter(l => l !== '·');
    const firstDot = opts.postOnly ? -1 : lines.indexOf('·');
    const splitAt = firstDot > 0 ? firstDot - 1 : lines.length;
    const postLines = lines.slice(0, splitAt);
    const commentLines = lines.slice(splitAt);
    const postText = postLines.join('\n');

    const comments = parseComments(firstDot > 0 ? commentLines : lines.slice(Math.min(lines.length, postLines.length)));
    const bids = comments.map(c => ({ name: c.name, amount: bidAmount(c.text) })).filter(b => b.amount != null);
    const top = bids.reduce((a, b) => (!a || b.amount > a.amount ? b : a), null);

    let reserve = null, hasReserve = null;
    if (/no\s*reserve|nr\b|\$1\s*nr/i.test(postText)) hasReserve = false;
    else {
      const r = parseMoney(postText, /reserve[^\d\n$]{0,20}\$?\s*(\d[\d,]*)/i);
      if (r != null) { reserve = r; hasReserve = true; }
      else if (/reserve/i.test(postText)) hasReserve = true;
    }

    return {
      title: clean(postLines[0] || ''),
      ...parseCard(postLines),
      postage: parsePostage(postLines),
      startBid: parseMoney(postText, /(?:start(?:ing)?(?:\s*bid)?|\bsb)\s*[:\-@]?\s*\$\s*(\d[\d,]*)/i),
      buyNow: parseMoney(postText, /(?:buy\s*now|\bbin)\s*[:\-@]?\s*\$\s*(\d[\d,]*)/i),
      hasReserve, reserve,
      antiSnipe: /anti[\s-]*snipe/i.test(postText),
      ...parseEnd(postLines, now),
      currentBid: top ? top.amount : null,
      topBidder: top ? top.name : null,
      bidCount: bids.length,
      bids,
      commentCount: comments.length,
    };
  }

  const api = { parse, bidAmount, zoneOffset, ZONES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AuctionParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
