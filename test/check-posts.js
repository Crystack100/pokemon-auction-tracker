// Reads every sample post and checks it against test/expected.json (the answers Alden gave).
// Run: node test/check-posts.js   Add a post to test/posts/ and its expected title to expected.json.
const P = require('../parser.js'); const fs = require('fs');
const now = new Date('2026-10-26T04:00:00Z');
const expected = JSON.parse(fs.readFileSync(__dirname + '/expected.json', 'utf8'));
let bad = 0;
for (const f of fs.readdirSync(__dirname + '/posts').sort()) {
  const r = P.parse(fs.readFileSync(__dirname + '/posts/' + f, 'utf8'), now, { postOnly: true });
  const got = { card: r.cardName, set: r.setName, number: r.cardNumber, grade: r.grade, reserve: r.hasReserve === false ? 'none' : r.reserve, ends: r.endsAt };
  const want = expected[f] || {};
  const wrong = Object.keys(want).filter(k => want[k] !== got[k]);
  if (wrong.length) bad++;
  console.log(wrong.length ? '✗' : '✓', f, wrong.length ? wrong.map(k => `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(want[k])}`).join('; ') : got.card);
}
process.exitCode = bad ? 1 : 0;
