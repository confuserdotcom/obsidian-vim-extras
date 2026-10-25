// Unit tests for the pure parts of the spelling keys:  node test.js
// (e2e.mjs checks the real keys and the real spellchecker inside Obsidian.)
const assert = require("assert");
const { tokens, nextBad, wordAt, distance, rank, edits1, accents, candidates, matchCase, wordListOf, byLanguage, cleanSettings } = require("./main.js").core;

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
t("rank: French list first on ties, closest first", () => {
  const r = rank("mond", [
    { src: "fr", list: ["pond", "mon", "monde", "monda", "mondé"] },
    { src: "both", list: ["mind", "pond", "mod", "mon", "monad"] },
    { src: "en", list: ["mind", "pond"] },
  ]);
  assert.strictEqual(r[0], "monde");
  assert.strictEqual(new Set(r).size, r.length, "no duplicates");
  assert(r.length <= 9);
});
t("rank: helo → hello first", () => {
  const r = rank("helo", [{ src: "fr", list: ["hello"] }, { src: "both", list: ["hole", "hello", "help"] }]);
  assert.strictEqual(r[0], "hello");
  assert(r.includes("hole"));
});
t("rank: théorème from an accentless typo", () => assert.strictEqual(rank("theoreme", [{ src: "fr", list: ["théorème", "théorèmes"] }])[0], "théorème"));
t("rank: on a tie the first spellcheck language wins", () =>
  assert.deepStrictEqual(rank("mond", [{ src: "other", list: ["mont"] }, { src: "primary", list: ["mind"] }]), ["mind", "mont"]));
t("preferred word list: plurals count, other words don't", () => {
  const fr = wordListOf(new Set(["monde", "théorème", "travail"]));
  assert(fr("monde") && fr("théorèmes") && fr("Monde"));
  assert(!fr("mound") && !fr("travaux"));
});
t("rank: on a tie the French spelling wins (mond → monde, not mound)", () =>
  assert.strictEqual(rank("mond", byLanguage(["mound", "mind", "monde"], w => w === "monde"))[0], "monde"));
t("rank: French only breaks ties, a closer English fix still wins", () =>
  assert.strictEqual(rank("helo", byLanguage(["hel", "hello"], w => w === "hel"))[0], "hello"));
t("rank: never suggests the word itself", () => assert(!rank("mond", [{ src: "fr", list: ["mond", "monde"] }]).includes("mond")));
t("matchCase: Capitalised and ALL CAPS follow the typo", () => {
  assert.strictEqual(matchCase("Bonjuor", "bonjour"), "Bonjour");
  assert.strictEqual(matchCase("MOND", "monde"), "MONDE");
  assert.strictEqual(matchCase("mond", "Monde"), "Monde"); // a proper noun keeps its capital
});

// ─── settings ───
t("settings: defaults, unknown keys dropped, wrong types ignored", () =>
  assert.deepStrictEqual(cleanSettings({ spelling: false, rowNumbers: "yes", wordList: "w.txt", junk: 1 }),
    { spelling: false, underline: true, wordList: "w.txt", rowNumbers: true, menuKeys: true }));
t("settings: nothing saved yet → defaults", () => assert.strictEqual(cleanSettings(null).spelling, true));

if (failed) { console.log(`${failed} failed, ${n} passed`); process.exit(1); }
console.log(`ok — ${n} tests`);
