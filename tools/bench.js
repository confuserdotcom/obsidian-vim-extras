// What the model costs: build, file size, load, an edit, a save, a z= and a language check.
//   node --expose-gc tools/bench.js <vault> fr_50k.txt en_50k.txt [french.txt …]
const fs = require("fs"), path = require("path");
const core = require("../main.js").core;
const [vaultDir, ...listFiles] = process.argv.slice(2);
const lists = listFiles.map(p => ({ path: p, text: fs.readFileSync(p, "utf8") })), notes = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "Library") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) notes.push({ path: p, mtime: 1, text: fs.readFileSync(p, "utf8") });
  }
})(vaultDir);
const ms = f => { const t = process.hrtime.bigint(); const r = f(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };
const best = (n, f) => { let m = Infinity, r; for (let i = 0; i < n; i++) { const [t, x] = ms(f); if (t < m) m = t; r = x; } return [m, r]; };
const heap = () => { global.gc && global.gc(); return process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers; };
const mb = b => (b / 1048576).toFixed(1) + " MB";

console.log(`input: ${notes.length} notes (${mb(notes.reduce((a, n) => a + n.text.length, 0))}), ${lists.length} word lists (${mb(lists.reduce((a, l) => a + l.text.length, 0))})`);
const [tBuild, buf] = best(3, () => core.buildModel({ lists, notes, sig: "bench" }));
console.log(`full build (the worker's job):        ${tBuild.toFixed(0)} ms`);
console.log(`model.bin:                             ${mb(buf.byteLength)}`);
const h0 = heap();
const [tLoad, model] = best(10, () => core.decodeModel(buf.slice(0)));
const keep = core.decodeModel(buf.slice(0)), h1 = heap();
console.log(`load (decode + views), at startup:     ${tLoad.toFixed(1)} ms   (memory ≈ ${mb(h1 - h0)})`);
console.log(`  words ${model.size}, candidate index ${model.baseIds.length}, pairs ${model.pairKeys.length}`);

const big = notes.slice().sort((a, b) => b.text.length - a.text.length)[0], mid = notes[notes.length >> 1];
const [tEdit] = best(20, () => model.update(mid.path, 2, mid.text + " un mot de plus"));
const [tEditBig] = best(20, () => model.update(big.path, 2, big.text + " un mot de plus"));
console.log(`edit a note (re-count it):             ${tEdit.toFixed(2)} ms typical (${(mid.text.length / 1024).toFixed(0)} KB), ${tEditBig.toFixed(2)} ms biggest (${(big.text.length / 1024).toFixed(0)} KB)`);
const [tSave, out] = best(5, () => model.encode());
console.log(`save (encode, before the disk write):  ${tSave.toFixed(1)} ms (${mb(out.byteLength)})`);

const near = core.neighbours("qwerty"), typos = ["theoreme", "necessairement", "fonctoin", "aparaitre", "continuos", "probleme", "definiton", "reciproque"];
const z = typo => { const c = [...core.nearWords(typo, model), ...core.candidates(typo)].filter(w => model.inLists(model.id(w.toLowerCase())) || model.count(model.id(w.toLowerCase())) >= 3);
  return core.rankFixes(typo, c, { model, lang: "fr", near, picks: {}, prev: model.id("le"), next: model.id("est") }); };
const [tZ] = best(20, () => typos.map(z));
console.log(`z= ranking (one word, no spellchecker): ${(tZ / typos.length).toFixed(2)} ms   e.g. ${typos.slice(0, 4).map(t => `${t} → ${z(t)[0]}`).join(", ")}`);
const [tNear] = best(50, () => typos.map(t => core.nearWords(t, model)));
console.log(`  of which near words (binary search):  ${(tNear / typos.length).toFixed(2)} ms`);
const para = core.tokens(mid.text.split("\n")).slice(0, 60).map(t => t.text);
const [tLang] = best(50, () => core.detectLang(para, model));
console.log(`language of a 60-word paragraph:       ${tLang.toFixed(3)} ms`);
void keep;
