// How often z= puts the right fix first (top 1) and in the first 3, for releases 1.0.0 and 1.1.0
// (read from git) and the working copy. No Obsidian: the spellchecker is played by the word
// lists plus the words of the vault (a word is "correct" when it is in a list or used 3 times),
// and Chromium's own list is left out, for every version alike.
//
//   node tools/eval.js <vault> <typos.json> fr_50k.txt en_50k.txt [french.txt …]
//   MISSES=10 …   prints some misses        TUNE=1 …   tries weights (tuned on half, scored on the other)
//
// Sets: real typos mined from the vault's git history (tools/mine-typos.py; {typo, fix, lang});
// synthetic ones (common words of the vault and of the English list, one realistic mistake each:
// accents dropped, the key next door, a letter dropped / doubled / swapped); and typos placed in
// real sentences of the vault, for the words around them (the sentence's own pairs are left out
// of the counts while it is ranked). Seeded: runs compare.
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
const core = require("../main.js").core;
const [vaultDir, typosFile, ...listFiles] = process.argv.slice(2);
const release = tag => {
  const f = path.join(os.tmpdir(), `vim-extras-${tag}.js`);
  fs.writeFileSync(f, execFileSync("git", ["-C", path.join(__dirname, ".."), "show", `${tag}:main.js`]));
  return require(f).core;
};
const v100 = release("1.0.0"), v110 = release("1.1.0");

// ─── the vault and the lists ───
const lists = listFiles.map(p => ({ path: p, text: fs.readFileSync(p, "utf8") })), notes = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "Library") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) notes.push({ path: p, mtime: 1, text: fs.readFileSync(p, "utf8") });
  }
})(vaultDir);
const model = core.decodeModel(core.buildModel({ lists, notes })), bare = core.decodeModel(core.buildModel({ lists }));
const inLists = w => model.inLists(model.id(w.toLowerCase()));
const isGood = w => inLists(w) || model.count(model.id(w.toLowerCase())) >= core.VAULT_MIN;
const L = model.langs, li = name => L.findIndex(l => core.sameLang(l.name, name));
const share = (name, w) => model.freq(li(name), model.id(w)) / L[li(name)].total;

// ─── test cases ───
let seed = 7; // mulberry32
const rnd = () => { let x = (seed = (seed + 0x6d2b79f5) | 0); x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
const pickN = (arr, n) => { const a = arr.slice(), out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return out; };
const near = core.neighbours("qwerty");
function corrupt(w) {
  const c = [...w], strip = s => s.normalize("NFD").replace(/\p{M}/gu, "");
  const kinds = strip(w) !== w ? ["accent", "accent", "accent", "key", "drop", "double", "swap"] : ["key", "drop", "double", "swap", "key"];
  const kind = kinds[Math.floor(rnd() * kinds.length)], i = 1 + Math.floor(rnd() * (c.length - 2));
  if (kind === "accent") return strip(w);
  if (kind === "key") { const n = [...(near.get(c[i]) || [])]; if (!n.length) return null; c[i] = n[Math.floor(rnd() * n.length)]; }
  if (kind === "drop") c.splice(i, 1);
  if (kind === "double") { if (c[i] === c[i + 1]) c.splice(i, 1); else c.splice(i, 0, c[i]); }
  if (kind === "swap") [c[i], c[i + 1]] = [c[i + 1], c[i]];
  return c.join("");
}
function synth(words, lang, n) {
  const out = [];
  for (const w of pickN(words, n * 2)) {
    const t = corrupt(w);
    if (t && t !== w && !isGood(t)) out.push({ typo: t, fix: w, lang });
    if (out.length >= n) break;
  }
  return out;
}
const all = [...model.allWords()];
const frWords = all.filter(w => model.count(model.id(w)) >= 5 && [...w].length >= 5 && /^\p{L}+$/u.test(w) && model.form(model.id(w)) === w && share("fr", w) > 0 && share("fr", w) >= 10 * share("en", w));
const enWords = all.filter(w => w.length >= 5 && /^[a-z]+$/.test(w) && share("en", w) >= 10 * share("fr", w) && model.freq(li("en"), model.id(w)) > 50);
const sentences = [];
for (const n of notes) {
  const byLine = new Map();
  for (const t of core.tokens(n.text.split("\n"))) { if (!byLine.has(t.line)) byLine.set(t.line, []); byLine.get(t.line).push(t.text.toLowerCase()); }
  for (const ws of byLine.values()) if (ws.length >= 3) sentences.push(ws);
}
const inSentences = [];
for (let tries = 0; inSentences.length < 1200 && tries < 200000; tries++) {
  const ws = sentences[Math.floor(rnd() * sentences.length)], i = 1 + Math.floor(rnd() * (ws.length - 2)), w = ws[i];
  if ([...w].length < 4 || !/^\p{L}+$/u.test(w) || !isGood(w)) continue;
  const t = corrupt(w);
  if (t && t !== w && !isGood(t)) inSentences.push({ typo: t, fix: w, prev: ws[i - 1], next: ws[i + 1], lang: core.detectLang(ws, model) });
}
const real = JSON.parse(fs.readFileSync(typosFile, "utf8")).filter(t => !isGood(t.typo));
const sets = { "real typos": real, "synthetic fr": synth(frWords, "fr", 400), "synthetic en": synth(enWords, "en", 250), "in sentences": inSentences };

// ─── the rankings ───
const vault110 = new Map();
for (const n of notes) for (const t of core.tokens(n.text.split("\n"))) {
  const k = t.text.toLowerCase(), v = vault110.get(k);
  if (!v) vault110.set(k, { count: 1, form: t.text }); else { v.count++; if (t.text === k) v.form = k; }
}
const lex110 = v110.lexicon(v110.makeLists(lists), vault110);
const fr100 = new Set(lists.filter(l => /fr/i.test(path.basename(l.path))).flatMap(l => l.text.split("\n").map(x => x.trim().split(/\s+/)[0].toLowerCase())));
const isFr100 = w => { const l = w.toLowerCase(); return fr100.has(l) || (/s$/.test(l) && fr100.has(l.slice(0, -1))); };
// the sentence's own pairs out of the counts while it is ranked (as if it were a new sentence)
const withoutOwnPairs = (m, t, f) => {
  const p = m.id(t.prev), x = m.id(t.fix), n = m.id(t.next), out = [];
  if (p >= 0 && x >= 0 && m.pair(p, x)) { m.bump(p, x, -1); out.push([p, x]); }
  if (x >= 0 && n >= 0 && m.pair(x, n)) { m.bump(x, n, -1); out.push([x, n]); }
  try { return f(); } finally { for (const [a, b] of out) m.bump(a, b, 1); }
};
const now = (m, useContext) => t => withoutOwnPairs(m, t, () => {
  const good = [...core.nearWords(t.typo, m), ...core.candidates(t.typo)].filter(isGood);
  const ctx = { model: m, lang: t.lang, near, picks: {}, prev: useContext && t.prev ? m.id(t.prev) : -1, next: useContext && t.next ? m.id(t.next) : -1 };
  return core.rankFixes(t.typo, good, ctx);
});
const runs = {
  "1.0.0": t => v100.rank(t.typo, v100.byLanguage(v100.candidates(t.typo).filter(isGood), isFr100)),
  "1.1.0": t => v110.rankFixes(t.typo, [...v110.nearWords(t.typo, lex110), ...v110.candidates(t.typo)].filter(isGood), { lex: lex110, lang: t.lang, near, picks: {} }),
  "now, no notes": now(bare, false),
  "now": now(model, true),
};

const hit = (f, t, n = 1) => f(t).slice(0, n).map(s => s.toLowerCase()).includes(t.fix.toLowerCase());
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "-").padStart(6);
console.log("set            cases   " + Object.keys(runs).map(r => r.padEnd(15)).join(" ") + "  (top 1 / top 3)");
for (const [name, cases] of Object.entries(sets)) {
  const cols = Object.values(runs).map(f => `${pct(cases.filter(t => hit(f, t)).length, cases.length)}/${pct(cases.filter(t => hit(f, t, 3)).length, cases.length).trim()}`.padEnd(15));
  console.log(`${name.padEnd(14)} ${String(cases.length).padStart(5)}   ${cols.join(" ")}`);
}
if (+process.env.MISSES) for (const [name, cases] of Object.entries(sets)) {
  const miss = cases.filter(t => !hit(runs.now, t)).slice(0, +process.env.MISSES).map(t => `${t.prev ? t.prev + " " : ""}[${t.typo}→${t.fix}]${t.next ? " " + t.next : ""} got ${runs.now(t).slice(0, 3).join(", ")}`);
  console.log(`\n${name} misses:\n  ${miss.join("\n  ")}`);
}

// TUNE=1: weights tried on the first half of the sentence cases, scored on the second half
if (process.env.TUNE) {
  const cases = sets["in sentences"], half = cases.length >> 1, a = cases.slice(0, half), b = cases.slice(half), keep = { ...core.WEIGHT }, f = now(model, true);
  const acc = set => set.filter(t => hit(f, t)).length / set.length;
  let best = [acc(a), { ...keep }];
  for (const context of [0.2, 0.4, 0.6, 0.8, 1, 1.3]) for (const freq of [0.08, 0.12, 0.16]) for (const vault of [0.1, 0.15, 0.25]) {
    Object.assign(core.WEIGHT, { context, freq, vault });
    const x = acc(a);
    if (x > best[0]) best = [x, { ...core.WEIGHT }];
  }
  Object.assign(core.WEIGHT, keep);
  const before = acc(b);
  Object.assign(core.WEIGHT, best[1]);
  console.log(`\ntuned on ${a.length}: ${JSON.stringify(best[1])}\nscored on the other ${b.length}: ${pct(before * b.length, b.length)} with the current weights → ${pct(acc(b) * b.length, b.length)}`);
  Object.assign(core.WEIGHT, keep);
}
