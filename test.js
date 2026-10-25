// Unit tests for the pure parts of the spelling keys:  node test.js
// (e2e.mjs checks the real keys and the real spellchecker inside Obsidian.)
const assert = require("assert");
const { tokens, nextBad, wordAt, distance, neighbours, edits1, accents, candidates, parseList, listName, sameLang, makeLists, buildModel, decodeModel, workerSource, nearWords, detectLang, rankFixes, around, matchCase, cleanSettings } = require("./main.js").core;

const at = (line, ch) => ({ line, ch });
const L = s => s.split("\n");
const words = s => tokens(L(s)).map(t => t.text);
let n = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split("\n").join("\n      ")}`); }
};

// ─── what gets spellchecked ───
t("plain words, accents, elision, hyphen", () => assert.deepStrictEqual(words("L'ensemble des réels, peut-être aujourd’hui."), ["L'ensemble", "des", "réels", "peut-être", "aujourd’hui"]));
t("positions are UTF-16 columns", () => assert.deepStrictEqual(tokens(L("éa xy😀 mot")).map(t => [t.line, t.from, t.to]), [[0, 0, 2], [0, 3, 5], [0, 8, 11]]));
t("inline maths is skipped", () => assert.deepStrictEqual(words("soit $f(x) = dx$ une fonction"), ["soit", "une", "fonction"]));
t("escaped \\$ is text", () => assert.deepStrictEqual(words("prix 5\\$ euros $x$ fin"), ["prix", "euros", "fin"]));
t("display maths over lines is skipped", () => assert.deepStrictEqual(words("avant\n$$\n\\frac{a}{b}\nssi\n$$\naprès"), ["avant", "après"]));
t("$$ on one line", () => assert.deepStrictEqual(words("avant $$\\sum x$$ après"), ["avant", "après"]));
t("code fence and inline code are skipped", () => assert.deepStrictEqual(words("mot\n```js\nconst foo\n```\nun `bar` deux"), ["mot", "un", "deux"]));
t("$ inside code is not maths", () => assert.deepStrictEqual(words("`$` mot $x$ fin"), ["mot", "fin"]));
t("frontmatter is skipped", () => assert.deepStrictEqual(words("---\ntype: exercice\n---\ntexte"), ["texte"]));
t("--- later in the note is not frontmatter", () => assert.deepStrictEqual(words("haut\n---\nbas"), ["haut", "bas"]));
t("wikilinks, embeds, markdown link targets, urls", () =>
  assert.deepStrictEqual(words("voir [[Anneaux intègres|anneau]] et ![[img.png]] ou [texte](https://x.org/abc) ici https://foo.bar/baz fin"), ["voir", "et", "ou", "texte", "ici", "fin"]));
t("tags, block ids, footnotes, callout type, comments, html", () =>
  assert.deepStrictEqual(words("> [!theoreme] Titre\nmot #algebre/groupes [^1] %%note perso%% <br> fin ^abc12"), ["Titre", "mot", "fin"]));
t("file names, paths, domains, snake_case, emails are skipped (a sentence's full stop is not)", () =>
  assert.deepStrictEqual(words("voir Erreurs.md et exoump.vercel.app ou ~/SUP/notes puis snake_case et moi@mail.fr fin. Suite"), ["voir", "et", "ou", "puis", "et", "fin", "Suite"]));
t("single letters and ALL-CAPS acronyms are not checked", () => assert.deepStrictEqual(words("a x TVI SSI Mot"), ["Mot"]));
t("latex command outside maths is skipped", () => assert.deepStrictEqual(words("le \\textbf est ici"), ["le", "est", "ici"]));

// ─── ]s / [s ───
const bad = new Set(["mond", "helo", "bonjuor"]);
const isBad = w => bad.has(w.toLowerCase());
const D = L("bonjour le mond\nhelo $mond$ x\nfin bonjuor");
const go = (pos, fwd, count = 1) => { const r = nextBad(D, pos, fwd, count, isBad); return r && [r.tok.line, r.tok.from, r.wrapped]; };
t("]s next misspelling", () => assert.deepStrictEqual(go(at(0, 0), true), [0, 11, false]));
t("]s skips maths", () => assert.deepStrictEqual(go(at(1, 0), true), [2, 4, false]));
t("2]s", () => assert.deepStrictEqual(go(at(0, 0), true, 2), [1, 0, false]));
t("]s from inside a bad word goes to the next one", () => assert.deepStrictEqual(go(at(0, 12), true), [1, 0, false]));
t("]s wraps to the top", () => assert.deepStrictEqual(go(at(2, 5), true), [0, 11, true]));
t("[s previous", () => assert.deepStrictEqual(go(at(2, 0), false), [1, 0, false]));
t("[s from inside a bad word goes to its start", () => assert.deepStrictEqual(go(at(2, 6), false), [2, 4, false]));
t("[s on the start of a bad word goes to the previous one", () => assert.deepStrictEqual(go(at(2, 4), false), [1, 0, false]));
t("[s wraps to the bottom", () => assert.deepStrictEqual(go(at(0, 3), false), [2, 4, true]));
t("no misspelling at all → null", () => assert.strictEqual(nextBad(L("tout va bien"), at(0, 0), true, 1, isBad), null));
t("count bigger than the number of misspellings wraps around", () => assert.deepStrictEqual(go(at(0, 0), true, 4), [0, 11, true]));

// ─── word under the cursor (z=, zg) ───
t("wordAt: on the word", () => assert.strictEqual(wordAt(D, at(0, 12)).text, "mond"));
t("wordAt: on the space before → the next word on the line", () => assert.strictEqual(wordAt(D, at(0, 7)).text, "le"));
t("wordAt: after the last word → null", () => assert.strictEqual(wordAt(L("mot  "), at(0, 4)), null));
t("wordAt: inside maths → null", () => assert.strictEqual(wordAt(L("$mond$"), at(0, 2)), null));

// ─── ranking ───
t("accent-only change is cheap", () => assert(distance("theoreme", "théorème") < 1));
t("case-only change is nearly free", () => assert(distance("Bonjour", "bonjour") < 0.2));
t("a missing letter (insertion) is cheaper than an extra one", () => assert(distance("mond", "monde") < distance("mond", "mon")));
t("transposition counts once", () => assert.strictEqual(distance("bonjuor", "bonjour"), 1));
t("splitting a word costs more than a normal edit", () => assert(distance("problemme", "problème") < distance("problemme", "prob lemme")));
t("edits1 covers insert, delete, swap, substitute", () => {
  const e = new Set(edits1("mond"));
  for (const w of ["monde", "mon", "mnod", "mont"]) assert(e.has(w), w);
});
t("edits1 uses plain letters only (accents have their own pass)", () => assert(!edits1("mond").some(w => /[^a-z]/.test(w))));
t("accents: every way to put accents on up to 2 letters", () => {
  const a = new Set(accents("theoreme"));
  for (const w of ["théorème", "thèoreme", "theorème", "théoreme"]) assert(a.has(w), w);
  assert(!a.has("theoreme"), "not the word itself");
  assert(a.size < 200, `small enough to check fast (${a.size})`);
});
t("accents: a word without accentable letters → none", () => assert.deepStrictEqual(accents("rst"), []));
t("candidates: one-edit and accent spellings, no duplicates", () => {
  const c = candidates("mond");
  assert(c.includes("monde") && c.includes("mönd"));
  assert.strictEqual(new Set(c).size, c.length);
});
// ─── word lists, language, ranking ───
const fr = { path: "w/fr_50k.txt", text: "de 900\nle 800\nmonde 300\nmont 40\nthéorème 20\nthéorie 30\nfonction 50\nest 700" };
const en = { path: "w/en_50k.txt", text: "the 900\nof 800\nis 700\nmind 200\nhello 300\nhole 50\ntheorem 20\nfunction 60\nmonde 1" };
const lists = makeLists([fr, en]);
const notes = [{ path: "a.md", mtime: 1, text: "surjective\n".repeat(12) + "Cauchy\n".repeat(9) }];
const model = decodeModel(buildModel({ lists: [fr, en], notes }));
const ctx = (lang, picks = {}, prev = -1, next = -1) => ({ model, lang, near: neighbours("qwerty"), picks, prev, next });
const fixesOf = (typo, lang, picks) => rankFixes(typo, [...nearWords(typo, model), "mound"], ctx(lang, picks));
t("parseList: counts, plain words count 1, comments skipped", () => {
  const l = parseList("monde 300\nMot\n# note\n\n");
  assert.deepStrictEqual([...l.freq], [["monde", 300], ["mot", 1]]);
  assert.strictEqual(l.total, 301);
});
t("listName / sameLang: the language from the file name", () => {
  assert.deepStrictEqual(["w/fr_50k.txt", "english.txt", "a/b/de-DE.dic"].map(listName), ["fr", "english", "de"]);
  assert(sameLang("fr", "french") && sameLang("en", "en-US") && !sameLang("fr", "en") && !sameLang(null, "fr"));
});
t("makeLists merges the files of one language", () => {
  const m = makeLists([fr, { path: "french.txt", text: "monde\nchose" }, en]);
  assert.deepStrictEqual(m.map(l => l.name), ["fr", "en"]);
  assert(m[0].freq.get("chose") === 1 && m[0].freq.get("monde") === 300);
});
t("nearWords: accents for free plus one edit, from the lists and the vault", () => {
  const n = nearWords("theoreme", model);
  assert(n.includes("théorème"), JSON.stringify(n));
  assert(nearWords("surjectve", model).includes("surjective"));
  assert(nearWords("cauhy", model).includes("Cauchy"), "keeps the vault spelling");
});
t("detectLang: the paragraph's language, null when unclear", () => {
  assert.strictEqual(detectLang(["the", "theorem", "is"], model), "en");
  assert.strictEqual(detectLang(["le", "théorème", "est", "de"], model), "fr");
  assert.strictEqual(detectLang(["the"], model), null, "one word is not enough");
  assert.strictEqual(detectLang(["the", "of", "le", "de"], model), null, "a tie");
  assert.strictEqual(detectLang(["x"], decodeModel(buildModel({ lists: [fr] }))), "fr", "one list: always it");
  assert.strictEqual(detectLang(["the", "of"], null), null, "no model yet");
});
t("distance: the key next door and a doubled letter cost less", () => {
  const near = neighbours("qwerty");
  assert(distance("bonjpur", "bonjour", near) < distance("bonjxur", "bonjour", near));
  assert(distance("problemme", "probleme") < 1);
  assert(neighbours("azerty").get("a").has("z") && neighbours("qwerty").get("a").has("q") && !neighbours("qwerty").get("a").has("p"));
});
t("rank: the common word first (mond → monde, not mont or mound)", () => assert.strictEqual(fixesOf("mond", "fr")[0], "monde"));
t("rank: the paragraph's language first (mond in English → mind)", () => assert.strictEqual(fixesOf("mond", "en")[0], "mind"));
t("rank: theorme → theorem in English, théorème / théorie in French", () => {
  assert.strictEqual(fixesOf("theorme", "en")[0], "theorem");
  assert(["théorème", "théorie"].includes(fixesOf("theorme", "fr")[0]));
});
t("rank: words of your notes count (surjectve → surjective)", () => assert.strictEqual(fixesOf("surjectve", "fr")[0], "surjective"));
t("rank: the fix you took before comes first", () => {
  assert.strictEqual(fixesOf("mond", "fr")[0], "monde", "before any pick");
  assert.strictEqual(fixesOf("mond", "fr", { mond: { mont: 2 } })[0], "mont");
});
t("rank: one spelling per word, never the typo itself", () => {
  const r = rankFixes("mond", ["monde", "Monde", "mond", "mind"], ctx("fr"));
  assert.deepStrictEqual(r, ["monde", "mind"]);
});
t("rank: no lists at all still ranks by closeness", () =>
  assert.strictEqual(rankFixes("helo", ["hole", "hello", "help"], { model: null, lang: null, near: null, picks: {} })[0], "hello"));

// ─── context: the words around the typo ───
{
  const lst = [{ path: "fr.txt", text: "monde 300\nmont 280\nle 900\ndu 800\nblanc 50" }];
  const m = decodeModel(buildModel({ lists: lst, notes: [{ path: "n.md", mtime: 1, text: "au sommet du mont blanc\n".repeat(4) + "le monde\n" } ] }));
  const c = (prev, next) => ({ model: m, lang: "fr", near: neighbours("qwerty"), picks: {}, prev: prev ? m.id(prev) : -1, next: next ? m.id(next) : -1 });
  t("context: alone, the common word (mond → monde)", () => assert.strictEqual(rankFixes("mond", ["monde", "mont"], c())[0], "monde"));
  t("context: after du, before blanc → mont", () => {
    assert.strictEqual(rankFixes("mond", ["monde", "mont"], c("du"))[0], "mont");
    assert.strictEqual(rankFixes("mond", ["monde", "mont"], c(null, "blanc"))[0], "mont");
  });
  t("context: around() takes the words on the same line only", () => {
    const toks = tokens(["le mond est", "beau"]);
    assert.deepStrictEqual(around(toks, 0, 3), { prev: "le", next: "est" });
    assert.deepStrictEqual(around(toks, 0, 8), { prev: "mond", next: undefined });
  });
}

// ─── the model file ───
const snapshot = m => {
  const words = new Set([...m.allWords()].filter(w => m.count(m.id(w)) || m.inLists(m.id(w))));
  const out = { files: [...m.files.keys()].sort(), counts: {}, pairs: {}, near: {}, freq: {} };
  for (const w of words) {
    const id = m.id(w);
    out.counts[w] = m.count(id);
    out.freq[w] = m.langs.map((l, i) => m.freq(i, id)).join(",");
    out.near[w] = m.near(w.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()).sort().join(",");
    for (const v of words) { const p = m.pair(id, m.id(v)); if (p) out.pairs[w + " " + v] = p; }
  }
  for (const k of Object.keys(out.counts)) if (!out.counts[k] && out.freq[k].split(",").every(x => x === "0")) delete out.counts[k];
  return out;
};
t("model: encode → decode gives the same model, also after edits", () => {
  const m = decodeModel(buildModel({ lists: [fr, en], notes: [{ path: "a.md", mtime: 1, text: "le monde est grand\nthe mind is" }] }));
  m.update("b.md", 2, "un mot tout neuf, le monde");
  const again = decodeModel(m.encode());
  assert.deepStrictEqual(snapshot(again), snapshot(m));
  assert.strictEqual(again.pair(again.id("le"), again.id("monde")), 2);
  assert(!m.dirty, "encode clears dirty");
});
t("model: no lists, no notes → an empty model that still works", () => {
  const m = decodeModel(buildModel({}));
  assert.strictEqual(m.size, 0);
  assert.deepStrictEqual(nearWords("mond", m), []);
  m.update("a.md", 1, "bonjour le monde");
  assert.strictEqual(m.count(m.id("monde")), 1);
});
t("model: a word shows in lower case if your notes ever write it so, else its commonest spelling", () => {
  const m = decodeModel(buildModel({ notes: [{ path: "a.md", mtime: 1, text: "Le monde. le monde\nCauchy Cauchy CAUCHY\nMONTAGNE" }] }));
  assert.strictEqual(m.form(m.id("le")), "le");
  assert.strictEqual(m.form(m.id("cauchy")), "Cauchy");
  assert.strictEqual(m.form(m.id("montagne")), "MONTAGNE");
  m.update("b.md", 2, "CAUCHY CAUCHY CAUCHY");
  assert.strictEqual(m.form(m.id("cauchy")), "CAUCHY", "the commonest wins");
  m.remove("b.md");
  assert.strictEqual(m.form(m.id("cauchy")), "Cauchy", "and goes back when the note goes");
});
t("model: a damaged or foreign file is refused", () => {
  assert.throws(() => decodeModel(new ArrayBuffer(4)));
  assert.throws(() => decodeModel(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer));
});
// The incremental path must land exactly where a full build would: random notes, random edits,
// deletes and renames, then the model compared with one built from scratch on the final notes.
t("model: incremental updates = a full rebuild (200 random runs)", () => {
  let seed = 42; // mulberry32: 32-bit integer maths, every bit random
  const rnd = n => { let x = (seed = (seed + 0x6d2b79f5) | 0); x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) % n; };
  const VOC = ["le", "Le", "monde", "Mont", "mont", "blanc", "du", "théorème", "the", "mind", "is", "Cauchy", "suite", "suites", "zorg", "x", "MONTAGNE", "Montagne", "montagne"];
  const text = () => Array.from({ length: 1 + rnd(4) }, () => Array.from({ length: rnd(8) }, () => VOC[rnd(VOC.length)]).join(" ")).join("\n");
  for (let run = 0; run < 200; run++) {
    const notes = new Map();
    for (let i = 0; i < 1 + rnd(5); i++) notes.set(`n${i}.md`, text());
    const m = decodeModel(buildModel({ lists: [fr, en], notes: [...notes].map(([path, t]) => ({ path, mtime: 1, text: t })) }));
    for (let op = 0; op < 1 + rnd(12); op++) {
      const paths = [...notes.keys()], kind = rnd(4);
      if (kind === 0 || !paths.length) { const p = `new${op}.md`; notes.set(p, text()); m.update(p, 2, notes.get(p)); }
      else if (kind === 1) { const p = paths[rnd(paths.length)]; notes.set(p, text()); m.update(p, 3, notes.get(p)); }
      else if (kind === 2) { const p = paths[rnd(paths.length)]; notes.delete(p); m.remove(p); }
      else { const p = paths[rnd(paths.length)], q = `moved${op}.md`; notes.set(q, notes.get(p)); notes.delete(p); m.rename(p, q); }
    }
    const fresh = decodeModel(buildModel({ lists: [fr, en], notes: [...notes].map(([path, t]) => ({ path, mtime: 1, text: t })) }));
    assert.deepStrictEqual(snapshot(m), snapshot(fresh), `run ${run}`);
    assert.deepStrictEqual(snapshot(decodeModel(m.encode())), snapshot(fresh), `run ${run}, saved and loaded`);
    assert([...m.extraPairs.values()].every(v => v > 0) && [...m.spelled.values()].every(v => v > 0), `run ${run}: no empty entries left behind`);
  }
});
t("worker: its source builds the very same bytes as buildModel", () => {
  const vm = require("vm"), input = { lists: [fr, en], notes, sig: "s" };
  let got = null;
  const box = { TextEncoder, TextDecoder, Map, Set, Uint32Array, Float64Array, Uint8Array, DataView, JSON, Math, Number, String, Object, Array, postMessage: b => (got = b), onmessage: null };
  vm.runInNewContext(workerSource(), box);
  box.onmessage({ data: input });
  assert(got && !got.error, got && got.error);
  assert.deepStrictEqual(Buffer.from(got), Buffer.from(buildModel(input)));
});
t("matchCase: Capitalised and ALL CAPS follow the typo", () => {
  assert.strictEqual(matchCase("Bonjuor", "bonjour"), "Bonjour");
  assert.strictEqual(matchCase("MOND", "monde"), "MONDE");
  assert.strictEqual(matchCase("mond", "Monde"), "Monde"); // a proper noun keeps its capital
});

// ─── settings ───
t("settings: defaults, unknown keys dropped, wrong types ignored", () =>
  assert.deepStrictEqual(cleanSettings({ spelling: false, rowNumbers: "yes", wordList: "w.txt", junk: 1 }),
    { spelling: false, underline: true, wordLists: "w.txt", learn: true, keyboard: "auto", rowNumbers: true, menuKeys: true }));
t("settings: an unknown keyboard falls back to auto", () => assert.strictEqual(cleanSettings({ keyboard: "dvorak" }).keyboard, "auto"));
t("settings: nothing saved yet → defaults", () => assert.strictEqual(cleanSettings(null).spelling, true));

if (failed) { console.log(`${failed} failed, ${n} passed`); process.exit(1); }
console.log(`ok — ${n} tests`);
