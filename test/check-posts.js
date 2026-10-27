// Prints what the reader gets from each sample post, so changes can be checked against real posts.
const P = require('../parser.js'); const fs = require('fs');
const now = new Date('2026-10-26T04:00:00Z');
for (const f of fs.readdirSync(__dirname + '/posts').sort()) {
  const r = P.parse(fs.readFileSync(__dirname + '/posts/' + f, 'utf8'), now);
  console.log(f, JSON.stringify({ card: r.cardName, grade: r.grade, reserve: r.hasReserve === false ? 'none' : r.reserve, postage: r.postage, ends: r.endsAt, zone: r.zone, antiSnipe: r.antiSnipe }));
}
