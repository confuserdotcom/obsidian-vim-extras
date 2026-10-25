// Unit tests for the pure parts of the spelling keys:  node test.js
// (e2e.mjs checks the real keys and the real spellchecker inside Obsidian.)
const assert = require("assert");
const { tokens, nextBad, wordAt, distance, neighbours, edits1, accents, candidates, parseList, listName, sameLang, makeLists, lexicon, nearWords, detectLang, rankFixes, matchCase, cleanSettings } = require("./main.js").core;

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
const lex = lexicon(lists, new Map([["surjective", { count: 12, form: "surjective" }], ["cauchy", { count: 9, form: "Cauchy" }]]));
const ctx = (lang, picks = {}) => ({ lex, lang, near: neighbours("qwerty"), picks });
const fixesOf = (typo, lang, picks) => rankFixes(typo, [...nearWords(typo, lex), "mound"], ctx(lang, picks));
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
  const n = nearWords("theoreme", lex);
  assert(n.includes("théorème"), JSON.stringify(n));
  assert(nearWords("surjectve", lex).includes("surjective"));
  assert(nearWords("cauhy", lex).includes("Cauchy"), "keeps the vault spelling");
});
t("detectLang: the paragraph's language, null when unclear", () => {
  assert.strictEqual(detectLang(["the", "theorem", "is"], lists), "en");
  assert.strictEqual(detectLang(["le", "théorème", "est", "de"], lists), "fr");
  assert.strictEqual(detectLang(["the"], lists), null, "one word is not enough");
  assert.strictEqual(detectLang(["the", "of", "le", "de"], lists), null, "a tie");
  assert.strictEqual(detectLang(["x"], lists.slice(0, 1)), "fr", "one list: always it");
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
  assert.strictEqual(rankFixes("helo", ["hole", "hello", "help"], { lex: lexicon(), lang: null, near: null, picks: {} })[0], "hello"));
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
