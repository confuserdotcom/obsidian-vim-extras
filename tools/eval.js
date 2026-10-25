// How often z= puts the right fix first (top 1) or in the first 3, before (release 1.0.0, read
// from git) and now. No Obsidian: the spellchecker is played by the word lists plus the words
// of the vault (a word is "correct" when it is in one of them), and Chromium's own list is left
// out, for both versions alike.
//
//   node tools/eval.js <vault> <typos.json> fr_50k.txt en_50k.txt [french.txt …]
//
// typos.json: real pairs from tools/mine-typos.py ({typo, fix, context}, or {typo, fix, lang}:
// the committed one keeps no text of the notes). On top of them, synthetic typos: common words
// of the vault (French) and of the English list, each with one realistic mistake (accents
// dropped, the key next door, a letter dropped / doubled / swapped). Seeded, so runs compare.
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
const core = require("../main.js").core;
const [vaultDir, typosFile, ...listFiles] = process.argv.slice(2);

// release 1.0.0, for the "before" column
const oldFile = path.join(os.tmpdir(), "vim-extras-1.0.0.js");
fs.writeFileSync(oldFile, execFileSync("git", ["-C", path.join(__dirname, ".."), "show", "1.0.0:main.js"]));
const old = require(oldFile).core;

// ─── what is known ───
const lists = core.makeLists(listFiles.map(p => ({ path: p, text: fs.readFileSync(p, "utf8") })));
const vault = new Map();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "Library") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) for (const t of core.tokens(fs.readFileSync(p, "utf8").split("\n"))) {
      const k = t.text.toLowerCase(), v = vault.get(k);
      if (!v) vault.set(k, { count: 1, form: t.text });
      else { v.count++; if (t.text === k) v.form = k; }
    }
  }
})(vaultDir);
const inLists = w => lists.some(l => l.freq.has(w.toLowerCase()));
const KNOWN_VAULT = 3;
const isGood = w => inLists(w) || (vault.get(w.toLowerCase())?.count || 0) >= KNOWN_VAULT;
const fr = lists.find(l => core.sameLang(l.name, "fr")), en = lists.find(l => core.sameLang(l.name, "en"));
const stems = listFiles.filter(p => !/_\d+k/.test(p)).map(p => new Set(fs.readFileSync(p, "utf8").split("\n").map(w => w.trim().split(/\s+/)[0]).filter(Boolean)));
const isFrenchOld = w => { const l = w.toLowerCase(); return fr.freq.has(l) || stems.some(s => s.has(l) || s.has(w)) || (/s$/.test(l) && fr.freq.has(l.slice(0, -1))); };

// ─── test cases ───
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pickN = (arr, n) => { const a = arr.slice(), out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return out; };
const near = core.neighbours("qwerty");
const share = (l, w) => (l.freq.get(w) || 0) / l.total;
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
const frWords = [...vault.values()].filter(v => v.count >= 5 && v.form === v.form.toLowerCase() && [...v.form].length >= 5 && /^\p{L}+$/u.test(v.form)
  && share(fr, v.form) > 0 && share(fr, v.form) >= 10 * share(en, v.form)).map(v => v.form);
const enWords = [...en.freq.keys()].slice(200, 20000).filter(w => w.length >= 5 && /^[a-z]+$/.test(w) && share(en, w) >= 10 * share(fr, w));
const real = JSON.parse(fs.readFileSync(typosFile, "utf8")).filter(t => !isGood(t.typo))
  .map(t => (t.context ? { ...t, lang: core.detectLang(core.tokens([t.context]).map(x => x.text), lists) } : t));
const sets = { real, "synthetic fr": synth(frWords, "fr", 400), "synthetic en": synth(enWords, "en", 250) };

// ─── the two rankings ───
const before = t => old.rank(t.typo, old.byLanguage(old.candidates(t.typo).filter(isGood), isFrenchOld));
const lexAll = core.lexicon(lists, vault), lexNoVault = core.lexicon(lists, new Map());
const now = (t, lex) => {
  const good = [...core.nearWords(t.typo, lex), ...core.candidates(t.typo)].filter(isGood);
  return core.rankFixes(t.typo, good, { lex, lang: t.lang, near, picks: {} });
};
const runs = { "1.0.0": before, "now, no vault": t => now(t, lexNoVault), now: t => now(t, lexAll) };

const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + "%" : "-").padStart(5);
const misses = {};
for (const [name, cases] of Object.entries(sets)) {
  const row = [name.padEnd(13), String(cases.length).padStart(4)];
  for (const [run, f] of Object.entries(runs)) {
    let top1 = 0, top3 = 0;
    for (const t of cases) {
      const r = f(t).map(s => s.toLowerCase()), k = t.fix.toLowerCase();
      if (r[0] === k) top1++; else if (run === "now") (misses[name] = misses[name] || []).push(`${t.typo}→${t.fix} got ${r.slice(0, 3).join(",")}`);
      if (r.slice(0, 3).includes(k)) top3++;
    }
    row.push(`${run}: ${pct(top1, cases.length)} ${pct(top3, cases.length)}`);
  }
  console.log(row.join("  "));
}
console.log("(each run: top 1, top 3)");
if (+process.env.MISSES) for (const [k, v] of Object.entries(misses)) console.log(`\n${k} misses:\n  ` + v.slice(0, +process.env.MISSES).join("\n  "));

// TUNE=1: try weight combinations on the synthetic sets (not the real ones, to keep them honest)
if (process.env.TUNE) {
  const syn = [...sets["synthetic fr"], ...sets["synthetic en"]], keep = { ...core.WEIGHT }, res = [];
  for (const freq of [0.06, 0.09, 0.12, 0.16, 0.2]) for (const otherLang of [0.3, 0.6, 1]) for (const unknown of [0.15, 0.3, 0.5]) for (const v of [0.05, 0.15, 0.25]) {
    Object.assign(core.WEIGHT, { freq, otherLang, unknown, vault: v });
    res.push([syn.filter(t => now(t, lexAll)[0]?.toLowerCase() === t.fix.toLowerCase()).length / syn.length, JSON.stringify(core.WEIGHT)]);
  }
  Object.assign(core.WEIGHT, keep);
  res.sort((a, b) => b[0] - a[0]);
  console.log("\nbest weights (synthetic top 1):\n" + res.slice(0, 6).map(([a, w]) => `  ${(100 * a).toFixed(1)}%  ${w}`).join("\n"));
  console.log("  current: " + JSON.stringify(keep));
}
