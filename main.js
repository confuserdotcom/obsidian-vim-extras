// Vim Extras: three small additions to Obsidian's Vim mode, each with its own switch in the
// settings.
//
// Spelling keys, straight on Electron's spellchecker (the one that draws the red squiggles):
//   ]s  [s        next / previous misspelled word (counts, d]s …; wraps around like Vim)
//   z=            suggestions for the word under the cursor — 1-9 picks, Ctrl-n/p + Enter
//   3z=           take suggestion 3 without a menu (1z= = the best one)
//   zg            add the word to the dictionary       zw / zug   take it back out
// Only prose is checked: maths, code, frontmatter, links, URLs, tags, comments, HTML,
// LaTeX commands, one-letter words and short acronyms are skipped.
//
// Screen-row numbers: relative numbers per screen row, counted the way gj / gk move (so j / k
// when they are mapped to them), so a count lands on the row it names, also beside maths.
//
// Menu keys: Ctrl-N / Ctrl-P move the selection in Obsidian's menus, like they already do in
// the quick switcher and the other suggesters.
//
// Keys go straight into the CodeMirror Vim engine, re-added after every Vim Motions config
// reload and on every note switch. All positions are {line, ch} (0-based, UTF-16 — the same
// units CodeMirror and Obsidian use).

const obsidian = (() => { try { return require("obsidian"); } catch { return {}; } })(); // node tests
const { Plugin = class {}, PluginSettingTab = class {}, Setting = class {}, Notice = class { constructor(m) { console.log(m); } }, Menu, FuzzySuggestModal = class {}, requireApiVersion = () => false } = obsidian;
const cm6 = name => { try { return require(name); } catch { return null; } }; // null under node
const CMState = cm6("@codemirror/state"), CMView = cm6("@codemirror/view");

// ═══ Spelling ════════════════════════════════════════════════════════════════════

// ─── What gets checked ─────────────────────────────────────────────────────────
// Each line with the skipped parts overwritten by spaces (same length, so columns stay right).
function prose(lines) {
  const out = lines.slice();
  let fence = false, display = false, start = 0;
  if (lines[0] === "---") { // frontmatter
    const end = lines.findIndex((l, i) => i > 0 && (l === "---" || l === "..."));
    if (end > 0) { start = end + 1; for (let r = 0; r < start; r++) out[r] = " ".repeat(lines[r].length); }
  }
  const blank = (s, a, b) => s.slice(0, a) + " ".repeat(b - a) + s.slice(b);
  for (let r = start; r < lines.length; r++) {
    let line = lines[r];
    if (!display && /^\s*(?:>\s*)*(```|~~~)/.test(line)) { fence = !fence; out[r] = " ".repeat(line.length); continue; }
    if (fence) { out[r] = " ".repeat(line.length); continue; }
    let from = display ? 0 : -1; // start of an open $$ … $$ on this line
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "\\") { i++; continue; }
      if (display) {
        if (c === "$" && line[i + 1] === "$") { line = blank(line, from, i + 2); display = false; i++; }
        continue;
      }
      if (c === "`") { const e = line.indexOf("`", i + 1); if (e > 0) { line = blank(line, i, e + 1); i = e; } continue; }
      if (c !== "$") continue;
      if (line[i + 1] === "$") { display = true; from = i; i++; continue; }
      let e = i + 1;
      while (e < line.length && (line[e] !== "$" || line[e - 1] === "\\")) e++;
      if (e < line.length) { line = blank(line, i, e + 1); i = e; }
    }
    if (display) line = blank(line, Math.max(from, 0), line.length);
    for (const re of SKIP) line = line.replace(re, m => " ".repeat(m.length));
    out[r] = line;
  }
  return out;
}
const SKIP = [
  /%%.*?%%/g, // comments
  /!?\[\[[^\]]*\]\]/g, // [[wikilinks]] and ![[embeds]]
  /\]\([^)]*\)/g, // [text](target): the target
  /\b(?:https?:\/\/|www\.)\S+/g, // urls
  /\S*[\p{L}\p{N}~][._/@][\p{L}\p{N}]\S*/gu, // notes.md, a.vercel.app, ~/notes/x, snake_case, a@b.org
  /(?<![\p{L}\p{N}])#[^\s#]+/gu, // #tags (a heading's "# " has a space)
  /\[[!^][^\]]*\]/g, // > [!callout] and [^footnote]
  /<[^>\n]+>/g, // <html>
  /\s\^[\w-]+\s*$/g, // ^block-id
  /\\[a-zA-Z]+/g, // \latex commands outside maths
];
const WORD = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
const acronym = w => w === w.toUpperCase() && w !== w.toLowerCase() && [...w].length <= 5;

// Words to spellcheck: {line, from, to, text}, in document order.
function tokens(lines) {
  const out = [];
  prose(lines).forEach((line, r) => {
    for (const m of line.matchAll(WORD)) {
      const text = m[0];
      if ([...text].length < 2 || acronym(text)) continue;
      out.push({ line: r, from: m.index, to: m.index + text.length, text });
    }
  });
  return out;
}

const before = (t, pos) => t.line < pos.line || (t.line === pos.line && t.from < pos.ch);
const after = (t, pos) => t.line > pos.line || (t.line === pos.line && t.from > pos.ch);

// ]s / [s: the count-th misspelled word after / before the cursor, wrapping around the note
// (Vim's 'wrapscan'). {tok, wrapped} or null when the note has none.
function nextBad(lines, pos, forward, count, isBad, toks = tokens(lines)) {
  const bad = toks.filter(t => isBad(t.text));
  if (!bad.length) return null;
  const n = bad.length;
  if (forward) {
    let i = bad.findIndex(t => after(t, pos));
    if (i < 0) i = n;
    const k = i + count - 1;
    return { tok: bad[k % n], wrapped: k >= n };
  }
  let i = -1;
  for (let j = 0; j < n; j++) if (before(bad[j], pos)) i = j;
  const k = i - (count - 1);
  return { tok: bad[((k % n) + n) % n], wrapped: k < 0 };
}

// The word under the cursor, else the next one on the line (like Vim's z=).
function wordAt(lines, pos) {
  const onLine = tokens([lines[pos.line]]).map(t => ({ ...t, line: pos.line }));
  // a note's first line may be frontmatter or inside a block: check against the whole note
  const all = tokens(lines).filter(t => t.line === pos.line);
  const ok = t => all.some(a => a.from === t.from && a.to === t.to);
  return onLine.find(t => ok(t) && t.from <= pos.ch && pos.ch < t.to) || onLine.find(t => ok(t) && t.from > pos.ch) || null;
}

// ─── Ranking suggestions ───────────────────────────────────────────────────────
const base = c => c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const joiner = c => c === " " || c === "-" || c === "'" || c === "’";

// Keyboard neighbours: hitting the key next door is the commonest typo, so it costs less.
const ROWS = { qwerty: ["qwertyuiop", "asdfghjkl", "zxcvbnm"], azerty: ["azertyuiop", "qsdfghjklm", "wxcvbn"], qwertz: ["qwertzuiop", "asdfghjkl", "yxcvbnm"] };
function neighbours(layout) {
  const at = new Map(), out = new Map();
  (ROWS[layout] || ROWS.qwerty).forEach((row, y) => [...row].forEach((c, x) => at.set(c, [x + y * 0.5, y]))); // rows are staggered
  for (const [c, [x, y]] of at) out.set(c, new Set([...at].filter(([d, [u, v]]) => d !== c && Math.abs(v - y) <= 1 && Math.abs(u - x) <= 1).map(([d]) => d)));
  return out;
}

// Accent-aware Damerau-Levenshtein: case = 0.05, accent = 0.2, a doubled letter added or
// dropped = 0.5 (problemme, aparaitre), the key next door = 0.6, a missing letter = 0.9 (typos
// drop letters more than they add them), splitting a word = 1.5, anything else = 1.
function distance(a, b, near = null) {
  const x = [...a], y = [...b], bx = x.map(base), by = y.map(base);
  const d = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  const del = i => (joiner(x[i]) ? 1.5 : bx[i] === bx[i - 1] || bx[i] === bx[i + 1] ? 0.5 : 1);
  const ins = j => (joiner(y[j]) ? 1.5 : by[j] === by[j - 1] || by[j] === by[j + 1] ? 0.5 : 0.9);
  const sub = (i, j) => {
    const p = x[i], q = y[j];
    if (p === q) return 0;
    if (p.toLowerCase() === q.toLowerCase()) return 0.05;
    if (bx[i] === by[j]) return 0.2;
    return near && near.has(bx[i]) && near.get(bx[i]).has(by[j]) ? 0.6 : 1;
  };
  for (let i = 1; i <= x.length; i++) d[i][0] = d[i - 1][0] + del(i - 1);
  for (let j = 1; j <= y.length; j++) d[0][j] = d[0][j - 1] + ins(j - 1);
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + del(i - 1), d[i][j - 1] + ins(j - 1), d[i - 1][j - 1] + sub(i - 1, j - 1));
    if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return Math.round(d[x.length][y.length] * 1000) / 1000;
}

// Plain letters only: accents get their own, much smaller pass (accents), which cuts the
// spellings to check by ~40 % (each check costs 0.06–2 ms).
const LETTERS = [..."abcdefghijklmnopqrstuvwxyz"];
// Every word one edit away (the dictionary then keeps the real ones).
function edits1(word) {
  const w = [...word.toLowerCase()], out = new Set();
  for (let i = 0; i <= w.length; i++) {
    const [l, r] = [w.slice(0, i), w.slice(i)];
    if (r.length) out.add([...l, ...r.slice(1)].join(""));
    if (r.length > 1) out.add([...l, r[1], r[0], ...r.slice(2)].join(""));
    for (const c of LETTERS) {
      if (r.length) out.add([...l, c, ...r.slice(1)].join(""));
      out.add([...l, c, ...r].join(""));
    }
  }
  out.delete(w.join(""));
  return [...out];
}

const ACCENTS = { a: "àâä", c: "ç", e: "éèêë", i: "îï", o: "ôö", u: "ùûü", y: "ÿ" };
// Every spelling with the accents added or changed on up to 2 letters (theoreme → théorème,
// two edits away, so edits1 alone would miss it).
function accents(word) {
  const w = [...word.toLowerCase()], out = new Set();
  const opts = w.map(c => { const b = base(c); return ACCENTS[b] ? [b, ...ACCENTS[b]].filter(x => x !== c) : []; });
  for (let i = 0; i < w.length; i++) for (const x of opts[i]) {
    const v = w.slice();
    v[i] = x;
    out.add(v.join(""));
    for (let j = i + 1; j < w.length; j++) for (const y of opts[j]) { const u = v.slice(); u[j] = y; out.add(u.join("")); }
  }
  return [...out]; // never the word itself: every option differs from its letter
}
// Spellings worth asking the dictionary about.
const candidates = word => [...new Set([...edits1(word), ...accents(word)])];

// ─── Word lists and the vault's own words ──────────────────────────────────────
// A word list: one word per line, optionally followed by how common it is (a frequency list
// such as FrequencyWords' fr_50k.txt: "monde 277005"); a plain list counts 1 per word.
function parseList(text) {
  const freq = new Map();
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const [w, n] = line.trim().split(/\s+/);
    if (!w || w.startsWith("#")) continue;
    const k = w.toLowerCase(), c = Number(n) || 1;
    freq.set(k, Math.max(freq.get(k) || 0, c));
    total += c;
  }
  return { freq, total: total || 1 };
}
// The language a list is for, from its file name: fr_50k.txt → fr, english.txt → english.
const listName = path => (path.split("/").pop().match(/^[\p{L}]+/u) || ["words"])[0].toLowerCase();
// Same language: fr = french = fr-FR (the first two letters).
const sameLang = (a, b) => !!a && !!b && a.slice(0, 2).toLowerCase() === b.slice(0, 2).toLowerCase();

// One list per language: files of the same language (fr_50k.txt and french.txt) are merged.
// files: [{path, text}] → [{name, freq, total}]
function makeLists(files) {
  const out = [];
  for (const { path, text } of files) {
    const name = listName(path), l = parseList(text), same = out.find(o => sameLang(o.name, name));
    if (!same) { out.push({ name, ...l }); continue; }
    for (const [w, c] of l.freq) same.freq.set(w, Math.max(same.freq.get(w) || 0, c));
    same.total += l.total;
  }
  return out;
}

// ─── The model: what z= knows, compiled into one file ──────────────────────────
// Everything the ranking reads (the word lists, the words of your notes, which words follow
// which) is one binary file, model.bin in the plugin folder: sorted word tables and typed
// arrays. Loading it is one read plus views on the bytes: no list is parsed, no note re-read,
// no map of 100k entries built; lookups are binary searches. Notes changed since are re-read
// one by one, and an edit updates the counts in place (the note's old words out, the new ones
// in). Words and pairs met after the build go to a small delta beside the sorted tables; when
// it grows past DELTA_MAX of them, or the lists change, the whole file is rebuilt by
// buildModel in a worker, off the main thread. Building and loading are one path: the worker
// returns the very bytes that are saved.
//
// File: "VXM1", u32 header length, JSON header (version, signature, languages, sections),
// then the sections, each 8-byte aligned so typed arrays view them in place. The sorted words
// and the candidate index stay UTF-8 bytes with an offset table, searched as bytes: loading
// makes no strings at all, and memory is about the file.
const MODEL_VERSION = 1, MAGIC = 0x314d5856; // "VXM1"
const VAULT_MIN = 3; // a word used this often in your notes counts as one of yours
// A note is kept as its words, one u32 each: the word id in the low 21 bits, the spelling in
// the high 11 (0 = lower case, k = the word's k-th other spelling: Cauchy, MONT …), so taking a
// note out takes out exactly its spellings too.
const PAIR = 2097152; // 2^21: ids below it; pair key = a * PAIR + b, < 2^42, exact in a double
const ID = PAIR - 1; // id mask
const SEP = 0xffffffff; // a line break: no pair across it (id ID, never given)
const DELTA_MAX = 0.1; // delta / sorted tables: past it, the next save rebuilds instead

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
// Byte order of UTF-8 = code point order: the order of the tables.
function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
// A sorted table of strings as bytes: blob + offsets (entry i = blob[off[i] … off[i+1]]).
// The first entry ≥ q (q: UTF-8 bytes).
function lowerBoundBytes(blob, off, q) {
  let lo = 0, hi = off.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1, a = off[mid], n = Math.min(off[mid + 1] - a, q.length);
    let c = 0;
    for (let i = 0; i < n && !c; i++) c = blob[a + i] - q[i];
    if (!c) c = off[mid + 1] - a - q.length;
    if (c < 0) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function equalBytes(blob, off, i, q) {
  const a = off[i];
  if (off[i + 1] - a !== q.length) return false;
  for (let j = 0; j < q.length; j++) if (blob[a + j] !== q[j]) return false;
  return true;
}
// strings → blob + offsets, in the given order
function packStrings(list) {
  let size = 0;
  for (const b of list) size += b.length;
  const blob = new Uint8Array(size), off = new Uint32Array(list.length + 1);
  let at = 0;
  list.forEach((b, i) => { off[i] = at; blob.set(b, at); at += b.length; });
  off[list.length] = at;
  return { blob, off };
}

// sections: {name: string | Uint32Array | Float64Array} → ArrayBuffer
function encodeModel(header, sections) {
  const enc = new TextEncoder(), parts = [];
  for (const [name, v] of Object.entries(sections)) {
    const type = typeof v === "string" ? "str" : v instanceof Float64Array ? "f64" : v instanceof Uint8Array ? "u8" : "u32";
    parts.push([name, type, type === "str" ? enc.encode(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength)]);
  }
  let size = 0;
  const index = parts.map(([name, type, bytes]) => { const at = size; size += Math.ceil(bytes.byteLength / 8) * 8; return [name, type, at, bytes.byteLength]; });
  const head = enc.encode(JSON.stringify({ ...header, sections: index }));
  const dataAt = Math.ceil((8 + head.length) / 8) * 8, out = new Uint8Array(dataAt + size), dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, head.length, true);
  out.set(head, 8);
  parts.forEach(([, , bytes], i) => out.set(bytes, dataAt + index[i][2]));
  return out.buffer;
}

// Lists + notes → the bytes of model.bin. Pure: runs in the worker, in node, anywhere.
// lists: [{path, text}]; notes: [{path, mtime, text}]; sig: what the lists were.
function buildModel({ lists = [], notes = [], sig = "" }) {
  const langs = makeLists(lists), count = new Map(), spellings = new Map(), seqs = [];
  for (const note of notes) {
    const seq = [];
    let line = -1;
    for (const t of tokens(note.text.split("\n"))) {
      const k = t.text.toLowerCase();
      if (t.line !== line && seq.length) seq.push(null);
      line = t.line;
      let v = 0;
      if (t.text !== k) {
        if (!spellings.has(k)) spellings.set(k, []);
        const sp = spellings.get(k);
        v = sp.indexOf(t.text) + 1 || sp.push(t.text);
      }
      seq.push([k, v]);
      count.set(k, (count.get(k) || 0) + 1);
    }
    seqs.push(seq);
  }
  const all = new Set(count.keys());
  for (const l of langs) for (const w of l.freq.keys()) all.add(w);
  const enc = new TextEncoder(), byWord = [...all].map(w => [w, enc.encode(w)]).sort((a, b) => cmpBytes(a[1], b[1]));
  const words = byWord.map(x => x[0]), n = words.length, ids = new Map(words.map((w, i) => [w, i]));
  if (n >= ID) throw new Error("too many words for the model");
  const freqs = langs.map(l => { const a = new Uint32Array(n); for (const [w, c] of l.freq) a[ids.get(w)] = c; return a; });
  const counts = new Uint32Array(n);
  for (const [w, c] of count) counts[ids.get(w)] = c;
  // the candidate index: spelling without accents or capitals → word, for list words and yours
  const cand = [];
  for (let i = 0; i < n; i++) if (counts[i] >= VAULT_MIN || freqs.some(f => f[i])) cand.push([enc.encode(base(words[i])), i]);
  cand.sort((a, b) => cmpBytes(a[0], b[0]) || a[1] - b[1]);
  const pairs = new Map(), files = [], toks = [];
  notes.forEach((note, j) => {
    const start = toks.length;
    let prev = SEP;
    for (const w of seqs[j]) {
      const id = w === null ? SEP : ids.get(w[0]);
      toks.push(w === null ? SEP : w[1] * PAIR + id);
      if (id !== SEP && prev !== SEP) { const key = prev * PAIR + id; pairs.set(key, (pairs.get(key) || 0) + 1); }
      prev = id;
    }
    files.push([note.path, note.mtime || 0, start, toks.length - start]);
  });
  const pairKeys = Float64Array.from([...pairs.keys()].sort((a, b) => a - b));
  const W = packStrings(byWord.map(x => x[1])), B = packStrings(cand.map(c => c[0]));
  const sections = {
    wordBlob: W.blob, wordOff: W.off, baseBlob: B.blob, baseOff: B.off, baseIds: Uint32Array.from(cand, c => c[1]),
    counts, pairKeys, pairCounts: Uint32Array.from(pairKeys, k => pairs.get(k)), toks: Uint32Array.from(toks),
    extraWords: "", extraPairKeys: new Float64Array(0), extraPairCounts: new Uint32Array(0),
  };
  freqs.forEach((f, i) => (sections["freq" + i] = f));
  const variants = [...spellings].map(([w, sp]) => [ids.get(w), sp]);
  return encodeModel({ version: MODEL_VERSION, sig, nStatic: n, langs: langs.map(l => ({ name: l.name, total: l.total })), variants, files }, sections);
}

function decodeModel(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error("not a model file");
  const hl = dv.getUint32(4, true), header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
  if (header.version !== MODEL_VERSION) throw new Error("model from another version");
  const dataAt = Math.ceil((8 + hl) / 8) * 8, sec = {};
  for (const [name, type, at, len] of header.sections) {
    const o = dataAt + at;
    sec[name] = type === "str" ? (len ? new TextDecoder().decode(new Uint8Array(buf, o, len)).split("\n") : [])
      : type === "f64" ? new Float64Array(buf, o, len / 8) : type === "u8" ? new Uint8Array(buf, o, len) : new Uint32Array(buf, o, len / 4);
  }
  return new Model(header, sec);
}

const utf8 = new TextEncoder(), utf8d = new TextDecoder();
// Ids: 0 … nStatic-1 are the sorted words of the file; later words get the next ids (the delta).
class Model {
  constructor(h, s) {
    this.sig = h.sig;
    this.nStatic = h.nStatic;
    this.wordBlob = s.wordBlob;
    this.wordOff = s.wordOff;
    this.langs = h.langs.map((l, i) => ({ name: l.name, total: l.total, freq: s["freq" + i] }));
    this.baseBlob = s.baseBlob;
    this.baseOff = s.baseOff;
    this.baseIds = s.baseIds;
    this.variants = new Map(h.variants); // id → its other spellings
    this.pairKeys = s.pairKeys;
    this.pairCounts = s.pairCounts;
    this.extraWords = s.extraWords;
    this.extraIds = new Map(this.extraWords.map((w, i) => [w, this.nStatic + i]));
    this.size = this.nStatic + this.extraWords.length;
    this.counts = s.counts;
    this.extraPairs = new Map();
    s.extraPairKeys.forEach((k, i) => this.extraPairs.set(k, s.extraPairCounts[i]));
    this.files = new Map(h.files.map(([path, mtime, at, len]) => [path, { mtime, toks: s.toks.subarray(at, at + len) }]));
    this.loadToks = s.toks;
    this.dirty = false;
  }
  // What only the first z= or the first edit needs, worked out then (a pass over the words
  // and the notes, a few ms), so that loading stays views only.
  lazy() {
    if (this.indexed) return;
    this.indexed = new Uint8Array(this.nStatic);
    for (const id of this.baseIds) this.indexed[id] = 1;
    this.extraBases = new Map();
    for (let id = 0; id < this.size; id++) if (!this.indexed[id] && this.counts[id] >= VAULT_MIN) this.indexLate(id);
    this.spelled = new Map(); // id * 2048 + spelling → count
    this.capitals = new Map(); // id → count of its other spellings
    for (const tok of this.loadToks) if (tok !== SEP && tok >= PAIR) this.spell(tok & ID, tok >>> 21, 1);
    this.loadToks = null;
  }
  id(w) {
    const e = this.extraIds.get(w);
    if (e !== undefined) return e;
    const q = utf8.encode(w), i = lowerBoundBytes(this.wordBlob, this.wordOff, q);
    return i < this.nStatic && equalBytes(this.wordBlob, this.wordOff, i, q) ? i : -1;
  }
  word(id) { return id < this.nStatic ? utf8d.decode(this.wordBlob.subarray(this.wordOff[id], this.wordOff[id + 1])) : this.extraWords[id - this.nStatic]; }
  *allWords() { for (let id = 0; id < this.size; id++) yield this.word(id); }
  // How to show a word: lower case if your notes ever write it so, else their commonest other
  // spelling (Cauchy), ties to the first in code-point order.
  form(id) {
    this.lazy();
    const caps = this.capitals.get(id) || 0;
    if (!caps || this.counts[id] > caps) return this.word(id);
    let best = null, most = 0;
    (this.variants.get(id) || []).forEach((sp, i) => {
      const c = this.spelled.get(id * 2048 + i + 1) || 0;
      if (c > most || (c === most && c && sp < best)) { best = sp; most = c; }
    });
    return best || this.word(id);
  }
  spell(id, v, d) {
    const k = id * 2048 + v, c = (this.spelled.get(k) || 0) + d;
    if (c) this.spelled.set(k, c); else this.spelled.delete(k);
    const t = (this.capitals.get(id) || 0) + d;
    if (t) this.capitals.set(id, t); else this.capitals.delete(id);
  }
  freq(li, id) { return id >= 0 && id < this.nStatic ? this.langs[li].freq[id] : 0; }
  count(id) { return id >= 0 ? this.counts[id] : 0; }
  inLists(id) { for (let li = 0; li < this.langs.length; li++) if (this.freq(li, id)) return true; return false; }
  // the words spelt b without accents or capitals that may be offered: in a list, or yours
  near(b) {
    this.lazy();
    const out = [], ok = id => this.count(id) >= VAULT_MIN || this.inLists(id);
    const q = utf8.encode(b);
    for (let i = lowerBoundBytes(this.baseBlob, this.baseOff, q); i < this.baseIds.length && equalBytes(this.baseBlob, this.baseOff, i, q); i++) if (ok(this.baseIds[i])) out.push(this.form(this.baseIds[i]));
    for (const id of this.extraBases.get(b) || []) if (ok(id)) out.push(this.form(id));
    return out;
  }
  pair(a, b) {
    if (a < 0 || b < 0) return 0;
    const k = a * PAIR + b, i = lowerBound(this.pairKeys, k);
    return i < this.pairKeys.length && this.pairKeys[i] === k ? this.pairCounts[i] : this.extraPairs.get(k) || 0;
  }
  bump(a, b, d) {
    const k = a * PAIR + b, i = lowerBound(this.pairKeys, k);
    if (i < this.pairKeys.length && this.pairKeys[i] === k) { this.pairCounts[i] += d; return; }
    const v = (this.extraPairs.get(k) || 0) + d;
    if (v) this.extraPairs.set(k, v); else this.extraPairs.delete(k);
  }
  indexLate(id) {
    if (id < this.nStatic && this.indexed[id]) return;
    const b = base(this.word(id));
    if (!this.extraBases.has(b)) this.extraBases.set(b, new Set());
    this.extraBases.get(b).add(id);
  }
  intern(w) {
    let id = this.id(w);
    if (id < 0) {
      if (this.size >= ID) throw new Error("too many words for the model");
      id = this.size++;
      this.extraWords.push(w);
      this.extraIds.set(w, id);
      if (id >= this.counts.length) { const c = new Uint32Array(Math.max(1024, this.counts.length * 2)); c.set(this.counts); this.counts = c; }
    }
    return id;
  }
  // the spelling's number for this word (0 = lower case), adding it if new
  variant(id, spelling, w) {
    if (spelling === w) return 0;
    if (!this.variants.has(id)) this.variants.set(id, []);
    const sp = this.variants.get(id), i = sp.indexOf(spelling);
    if (i >= 0) return i + 1;
    if (sp.length >= 2047) return 0; // 11 bits: past that, shown in lower case
    return sp.push(spelling);
  }
  // a note's words and pairs in (d = 1) or out (d = -1)
  apply(toks, d) {
    this.lazy();
    let prev = SEP;
    for (const tok of toks) {
      const id = tok === SEP ? SEP : tok & ID;
      if (id !== SEP) {
        if (tok >= PAIR) this.spell(id, tok >>> 21, d);
        const was = this.counts[id];
        this.counts[id] = was + d;
        if (d > 0 && was < VAULT_MIN && was + d >= VAULT_MIN) this.indexLate(id);
        if (prev !== SEP) this.bump(prev, id, d);
      }
      prev = id;
    }
  }
  noteIds(text) {
    const ids = [];
    let line = -1;
    for (const t of tokens(text.split("\n"))) {
      if (t.line !== line && ids.length) ids.push(SEP);
      line = t.line;
      const w = t.text.toLowerCase(), id = this.intern(w);
      ids.push(this.variant(id, t.text, w) * PAIR + id);
    }
    return Uint32Array.from(ids);
  }
  update(path, mtime, text) {
    const old = this.files.get(path), toks = this.noteIds(text);
    if (old) this.apply(old.toks, -1);
    this.apply(toks, 1);
    this.files.set(path, { mtime, toks });
    this.dirty = true;
  }
  remove(path) {
    const old = this.files.get(path);
    if (!old) return;
    this.apply(old.toks, -1);
    this.files.delete(path);
    this.dirty = true;
  }
  rename(from, to) {
    const e = this.files.get(from);
    if (!e) return;
    this.files.delete(from);
    this.files.set(to, e);
    this.dirty = true;
  }
  // how big the delta is next to the sorted tables
  deltaShare() { return (this.extraWords.length + this.extraPairs.size) / Math.max(1, this.nStatic + this.pairKeys.length); }
  encode() {
    let total = 0;
    for (const f of this.files.values()) total += f.toks.length;
    const toks = new Uint32Array(total), files = [];
    let at = 0;
    for (const [path, f] of this.files) { toks.set(f.toks, at); files.push([path, f.mtime, at, f.toks.length]); at += f.toks.length; }
    const sections = {
      wordBlob: this.wordBlob, wordOff: this.wordOff, baseBlob: this.baseBlob, baseOff: this.baseOff, baseIds: this.baseIds,
      counts: this.counts.subarray(0, this.size), pairKeys: this.pairKeys, pairCounts: this.pairCounts, toks,
      extraWords: this.extraWords.join("\n"), extraPairKeys: Float64Array.from(this.extraPairs.keys()), extraPairCounts: Uint32Array.from(this.extraPairs.values()),
    };
    this.langs.forEach((l, i) => (sections["freq" + i] = l.freq));
    this.dirty = false;
    return encodeModel({ version: MODEL_VERSION, sig: this.sig, nStatic: this.nStatic, langs: this.langs.map(l => ({ name: l.name, total: l.total })), variants: [...this.variants], files }, sections);
  }
}

// The worker that runs buildModel: its source is the functions above, so there is one build.
function workerSource() {
  const fns = { base, acronym, listName, sameLang, prose, tokens, parseList, makeLists, cmpBytes, packStrings, encodeModel, buildModel };
  return `"use strict";
const SKIP = [${SKIP.map(String).join(", ")}], WORD = ${WORD};
const MODEL_VERSION = ${MODEL_VERSION}, MAGIC = ${MAGIC}, VAULT_MIN = ${VAULT_MIN}, SEP = ${SEP}, PAIR = ${PAIR}, ID = ${ID};
${Object.entries(fns).map(([name, fn]) => (String(fn).startsWith("function") ? String(fn) : `const ${name} = ${fn};`)).join("\n")}
onmessage = e => { try { const buf = buildModel(e.data); postMessage(buf, [buf]); } catch (err) { postMessage({ error: String((err && err.stack) || err) }); } };`;
}
// buildModel off the main thread; where workers can't start, right here.
function buildInWorker(input) {
  return new Promise((resolve, reject) => {
    let worker, url;
    try {
      url = URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" }));
      worker = new Worker(url);
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      try { resolve(buildModel(input)); } catch (err) { reject(err); }
      return;
    }
    const done = () => { worker.terminate(); URL.revokeObjectURL(url); };
    worker.onmessage = e => { done(); if (e.data && e.data.error) reject(new Error(e.data.error)); else resolve(e.data); };
    worker.onerror = e => { done(); e.preventDefault(); try { resolve(buildModel(input)); } catch (err) { reject(err); } };
    worker.postMessage(input);
  });
}

// The words of the lists and of your notes that the typo is one edit (plus any accents) away
// from: theoreme, aparaitre → théorème, apparaître, by binary search instead of spellchecker calls.
function nearWords(word, model) {
  if (!model) return [];
  const out = new Set(), b = base(word);
  for (const k of [b, ...edits1(b)]) for (const w of model.near(k)) out.add(w);
  out.delete(word);
  return [...out];
}

// The language of some words: every word votes for the list where it is at least 10 times
// more common (de, le, the …); null when too few votes or too close to tell.
function detectLang(words, model) {
  const L = model ? model.langs : [];
  if (L.length < 2) return L.length ? L[0].name : null;
  const votes = L.map(() => 0);
  for (const w of words) {
    const id = model.id(w.toLowerCase());
    if (id < 0 || id >= model.nStatic) continue;
    let best = -1, p1 = 0, p2 = 0;
    for (let i = 0; i < L.length; i++) {
      const p = L[i].freq[id] / L[i].total;
      if (p > p1) { p2 = p1; p1 = p; best = i; } else if (p > p2) p2 = p;
    }
    if (p1 > 0 && p1 >= 10 * p2) votes[best]++;
  }
  const order = votes.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  if (order[0][0] < 2 || order[0][0] < 2 * order[1][0]) return null;
  return L[order[0][1]].name;
}

// How good s is as the fix for the typo word (lower is better): closeness first, then how
// common s is in the text's language, how often you use it, how often your notes have it next
// to the words around the typo, and whether you picked it for this typo before. A word only in
// another language's list (a French fix in an English paragraph) or in no list is pushed down.
// ctx: {model, lang, near, picks, prev, next} (prev / next: ids of the words around, or -1).
const WEIGHT = { freq: 0.12, otherLang: 0.6, unknown: 0.3, vault: 0.15, pick: 1.5, context: 0.8 };
function score(word, s, ctx) {
  const { model } = ctx, k = s.toLowerCase(), id = model ? model.id(k) : -1;
  let v = distance(word, s, ctx.near);
  if (id >= 0) {
    let f = 0, any = false;
    model.langs.forEach((l, li) => { const x = model.freq(li, id); if (x) any = true; if (!ctx.lang || sameLang(l.name, ctx.lang)) f = Math.max(f, x); });
    const c = model.count(id);
    if (f) v -= WEIGHT.freq * Math.log10(1 + f);
    else if (any) v += WEIGHT.otherLang;
    else if (!c) v += WEIGHT.unknown;
    if (c) v -= WEIGHT.vault * Math.log10(1 + c);
    if (ctx.prev >= 0) v -= WEIGHT.context * Math.log10(1 + model.pair(ctx.prev, id));
    if (ctx.next >= 0) v -= WEIGHT.context * Math.log10(1 + model.pair(id, ctx.next));
  } else v += WEIGHT.unknown;
  const picked = ctx.picks && ctx.picks[word.toLowerCase()];
  if (picked && picked[k]) v -= WEIGHT.pick + 0.2 * Math.min(picked[k], 5); // taken once: first next time
  return v;
}
// Best first, one spelling per word (Monde / monde).
function rankFixes(word, cands, ctx, max = 9) {
  const seen = new Set(), out = [];
  for (const s of cands) {
    const k = s.toLowerCase();
    if (s === word || seen.has(k)) continue;
    seen.add(k);
    out.push([s, score(word, s, ctx)]);
  }
  return out.sort((p, q) => p[1] - q[1]).slice(0, max).map(p => p[0]);
}

// Bonjuor → Bonjour, MOND → MONDE; a suggestion with its own capitals (Cauchy) keeps them.
function matchCase(orig, sug) {
  if (sug !== sug.toLowerCase()) return sug;
  if ([...orig].length > 1 && orig === orig.toUpperCase() && orig !== orig.toLowerCase()) return sug.toUpperCase();
  if (orig[0] !== orig[0].toLowerCase()) return sug[0].toUpperCase() + sug.slice(1);
  return sug;
}

// ─── Electron spellchecker ─────────────────────────────────────────────────────
// Measured: isWordMisspelled ≈ 0.06–2 ms, getWordSuggestions ≈ 10–150 ms. So nothing slow
// happens on a key press: while you're idle, the open note's words are checked and the fixes
// for each misspelled one worked out in small slices (warm), and ]s / z= read the caches.
const electron = (() => { try { return require("electron"); } catch { return null; } })();
const webFrame = electron && electron.webFrame;
const session = () => { try { return electron && electron.remote && electron.remote.session.defaultSession; } catch { return null; } };

// isWordMisspelled only knows the language dictionaries, not the words added with zg (those
// only reach the squiggles, measured), so the added words are kept here too.
const cache = new Map(), fixCache = new Map(), added = new Set();
function isBad(word) {
  if (!webFrame || added.has(word) || added.has(word.toLowerCase())) return false;
  if (!cache.has(word)) cache.set(word, webFrame.isWordMisspelled(word));
  return cache.get(word);
}

// What the ranking knows, set by the plugin: the model, the keyboard, your past picks.
const know = { model: null, near: neighbours("qwerty"), picks: {} };
// around: {prev, next}, the words on either side of the typo (lower case), or undefined
const ctxFor = (lang, around = {}) => {
  const m = know.model, id = w => (m && w ? m.id(w) : -1);
  return { ...know, lang, prev: id(around.prev), next: id(around.next) };
};
const fixKey = (word, lang, around = {}) => [lang || "", around.prev || "", word, around.next || ""].join("|");

// The ranked fixes for a word, one step at a time (each yield = a chance to hand the thread
// back): the near words of the lists and your notes, every one-edit / accent spelling the
// dictionary accepts, plus Chromium's own list.
function* fixesJob(word, lang, around) {
  const good = [];
  for (const c of nearWords(word, know.model)) { if (!isBad(c)) good.push(c); yield "check"; }
  for (const c of candidates(word)) { if (!isBad(c)) good.push(c); yield "check"; }
  yield "suggest"; // the next step is one 10–250 ms call: the runner gives it a fresh idle slot
  good.push(...webFrame.getWordSuggestions(word));
  fixCache.set(fixKey(word, lang, around), rankFixes(word, good, ctxFor(lang, around)));
}
// Right now (z= on a word the background hasn't reached yet). A check costs 0.06 ms on one
// machine and 2 ms on another (macOS checking every language: ~700 spellings = 1.5 s), so the
// near words of the model come first (a few checks), then the other spellings get at most
// COLD_MS, accents first. When all of them were checked and they give 3 fixes, Chromium's slow
// list is skipped this once (where checks are slow, it is fast). Not cached: the background
// works out the full list, so a z= a moment later shows it.
const COLD_MS = 150;
function fixes(word, lang, around) {
  const key = fixKey(word, lang, around);
  if (fixCache.has(key)) return fixCache.get(key);
  const good = nearWords(word, know.model).filter(c => !isBad(c)), end = Date.now() + COLD_MS;
  let all = true;
  for (const c of new Set([...accents(word), ...edits1(word)])) {
    if (Date.now() > end) { all = false; break; }
    if (!isBad(c)) good.push(c);
  }
  if (!all || good.length < 3) good.push(...webFrame.getWordSuggestions(word));
  return rankFixes(word, good, ctxFor(lang, around));
}
// The words on either side of a word of the note, on its line.
function around(toks, line, from) {
  const i = toks.findIndex(t => t.line === line && t.from === from);
  if (i < 0) return {};
  const prev = toks[i - 1], next = toks[i + 1];
  return { prev: prev && prev.line === line ? prev.text.toLowerCase() : undefined, next: next && next.line === line ? next.text.toLowerCase() : undefined };
}

// ─── Underlines ────────────────────────────────────────────────────────────────
// Our own wavy underline (styles.css hides Chromium's): drawn from the same check as ]s, so it
// shows on the whole note as soon as the background pass is done — not word by word as you
// type past them — and never inside maths or code.
const paintEffect = CMState && CMState.StateEffect.define();
const paintField = CMState && CMView && CMState.StateField.define({
  create: () => CMView.Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(paintEffect)) deco = e.value;
    return deco;
  },
  provide: f => CMView.EditorView.decorations.from(f),
});
const BAD = CMView && CMView.Decoration.mark({ class: "vim-extras-bad" });
function paint(view, toks) {
  if (!paintField || !view.state.field(paintField, false)) return;
  const doc = view.state.doc, marks = [];
  for (const t of toks) if (isBad(t.text)) {
    const line = doc.line(t.line + 1);
    marks.push(BAD.range(line.from + t.from, line.from + t.to));
  }
  view.dispatch({ effects: paintEffect.of(CMView.Decoration.set(marks, true)) });
}

// ─── Vim wiring ────────────────────────────────────────────────────────────────
let plugin = null; // the loaded plugin, for the actions (they only get the Vim adapter)

// The note's words, re-split only when the text changed (a big note takes ~10 ms).
let memo = { text: null, toks: null };
function tokensOf(text) {
  if (memo.text !== text) memo = { text, toks: tokens(text.split("\n")) };
  return memo.toks;
}

function spellJump(cm, head, args) {
  const text = cm.getValue();
  const r = nextBad(null, { line: head.line, ch: head.ch }, args.forward, args.repeat || 1, isBad, tokensOf(text));
  if (!r) { new Notice("No misspelled word"); return null; }
  if (r.wrapped) new Notice(args.forward ? "Search hit BOTTOM, continuing at TOP" : "Search hit TOP, continuing at BOTTOM");
  return { line: r.tok.line, ch: r.tok.from };
}
const ACTIONS = {
  spellSuggest: (cm, args) => plugin && plugin.suggest(args.repeatIsExplicit ? args.repeat : 0),
  spellAdd: () => plugin && plugin.dictionary(true),
  spellRemove: () => plugin && plugin.dictionary(false),
};
const KEYS = [
  ["]s", "motion", "spellJump", { forward: true }],
  ["[s", "motion", "spellJump", { forward: false }],
  ["z=", "action", "spellSuggest", {}],
  ["zg", "action", "spellAdd", {}],
  ["zw", "action", "spellRemove", {}],
  ["zug", "action", "spellRemove", {}],
];

const vimApi = () => window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
function register() {
  const Vim = vimApi();
  if (!Vim) return;
  Vim.defineMotion("spellJump", spellJump);
  for (const [name, fn] of Object.entries(ACTIONS)) Vim.defineAction(name, fn);
  for (const [keys, type, name, args] of KEYS) {
    Vim.removeMapCommand && Vim.removeMapCommand(keys);
    if (type === "motion") Vim.mapCommand(keys, type, name, args);
    else Vim.mapCommand(keys, type, name, args, { context: "normal" });
  }
}
function unregister() {
  const Vim = vimApi();
  if (Vim && Vim.removeMapCommand) for (const [keys] of KEYS) Vim.removeMapCommand(keys);
}

// ═══ Screen-row numbers ══════════════════════════════════════════════════════════
// The label on a row is how many gj (or gk) presses land there. Labels come from running Vim's
// own findPosV ahead of the cursor, because the real motion is irregular: it skips rows
// beside rendered inline maths (those stay blank) and spends one press per source line of a
// rendered $$ block (the block shows the first count). The cursor row shows the real line
// number (hybrid, like nvim). The numbers sit in the margin left of the text.

const GAP = 14; // px between the numbers and the text
const rowViews = new Set(); // the live RowNumbers, redrawn when the setting is turned on

// Screen rows of one .cm-line: rects of its direct children, grouped by vertical centre.
// Direct children only, so a KaTeX/MathJax span counts as one box, not hundreds.
function lineRows(el, range) {
  const rects = [];
  for (const n of el.childNodes) {
    if (n.nodeType === 3) { range.selectNodeContents(n); rects.push(...range.getClientRects()); }
    else if (n.nodeType === 1) rects.push(...n.getClientRects());
  }
  const boxes = rects.filter(r => r.height > 0).sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));
  if (!boxes.length) { const r = el.getBoundingClientRect(); return r.height > 1 ? [{ top: r.top, bottom: r.bottom }] : []; }
  const rows = [];
  for (const r of boxes) {
    const last = rows[rows.length - 1];
    if (last && (r.top + r.bottom) / 2 <= last.bottom) { last.top = Math.min(last.top, r.top); last.bottom = Math.max(last.bottom, r.bottom); }
    else rows.push({ top: r.top, bottom: r.bottom });
  }
  return rows;
}

class RowNumbers {
  constructor(view) {
    this.view = view;
    this.dom = view.scrollDOM.appendChild(document.createElement("div"));
    this.dom.className = "vim-extras-rows";
    this.onScroll = () => { this.layout = null; this.schedule(); }; // rows scrolled into view need labels
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    rowViews.add(this);
    this.schedule();
  }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.geometryChanged) this.layout = null;
    if (u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || u.focusChanged) this.schedule();
  }
  // Off the keypress path: numbering runs when the browser is idle (≈ a frame after the
  // cursor paints) and a held j coalesces into one pass.
  schedule() {
    if (this.idle || !(plugin && plugin.settings.rowNumbers)) return;
    this.idle = window.requestIdleCallback(() => {
      this.idle = 0;
      this.view.requestMeasure({ key: this, read: v => this.measure(v), write: m => this.draw(m) });
    }, { timeout: 80 });
  }
  // Visible rows in scroll coordinates, kept until the text, layout or scroll changes.
  // Also memoises Vim steps: after one j the chain from the new cursor is already known,
  // so a keypress costs ~1-2 findPosV instead of one per visible row (~0.3ms each).
  measureLayout(view) {
    const s = view.scrollDOM.getBoundingClientRect(), oy = view.scrollDOM.scrollTop - s.top, range = document.createRange(), rows = [];
    for (const el of view.contentDOM.children) {
      if (el.classList.contains("cm-gap")) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < s.top || r.top > s.bottom || r.height <= 1) continue;
      const rs = el.classList.contains("cm-line") ? lineRows(el, range).filter(w => w.bottom >= s.top && w.top <= s.bottom) : [r];
      for (const w of rs) rows.push({ top: w.top + oy, bottom: w.bottom + oy });
    }
    return {
      rows, oy, steps: new Map(), rowOf: new Map(), x: null,
      right: view.contentDOM.getBoundingClientRect().left - s.left + view.scrollDOM.scrollLeft - GAP,
    };
  }
  measure(view) {
    // the note is being closed (another view took the leaf): its layout is gone
    if (!view.dom.isConnected || this.gone) return null;
    try { return this.measureRows(view); } catch (e) { return null; } // a stale layout mid-swap: next idle pass redraws
  }
  measureRows(view) {
    const L = this.layout || (this.layout = this.measureLayout(view)), { rows, oy } = L;
    const rowAt = (head, assoc = 1) => {
      const key = head * 2 + (assoc < 0 ? 1 : 0);
      if (L.rowOf.has(key)) return L.rowOf.get(key);
      const c = view.coordsAtPos(head, assoc || 1), y = c && (c.top + c.bottom) / 2 + oy;
      let at = -1;
      if (c && rows.length && y >= rows[0].top && y <= rows[rows.length - 1].bottom) { // else off the visible rows
        let best = Infinity;
        rows.forEach((r, i) => { const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0; if (d < best) { best = d; at = i; } });
      }
      L.rowOf.set(key, at);
      return at;
    };
    const sel = view.state.selection.main, labels = new Map();
    const cur = rowAt(sel.head, sel.assoc);
    const cm = view.cm; // Vim's CM5 adapter: its findPosV is exactly what gj/gk call
    if (cur >= 0 && cm && cm.findPosV) {
      // Same goal x Vim uses: kept across a run of vertical moves, else the cursor's own x.
      const vim = cm.state && cm.state.vim, vertical = /^moveBy(DisplayLines|Lines|Scroll)$|^moveTo(Column|Eol)$/;
      const x = vim && vertical.test((vim.lastMotion && vim.lastMotion.name) || "") ? vim.lastHSPos : cm.charCoords(cm.posFromIndex(sel.head), "div").left;
      if (L.x !== x) { L.x = x; L.steps.clear(); }
      const step = (head, dir) => {
        const key = head * 2 + (dir < 0 ? 1 : 0);
        if (!L.steps.has(key)) {
          const q = cm.findPosV(cm.posFromIndex(head), dir, "line", x);
          L.steps.set(key, q.hitSide || q.focusBefore ? -1 : cm.indexFromPos(q));
        }
        return L.steps.get(key);
      };
      for (const dir of [1, -1]) {
        let p = sel.head;
        for (let k = 1; k <= 300; k++) { // the cap only guards a pathological layout
          const head = step(p, dir);
          if (head < 0 || head === p) break;
          const i = rowAt(head);
          if (i < 0) break;
          if (i !== cur && !labels.has(i)) labels.set(i, [k, head]);
          p = head;
        }
      }
    }
    return { rows, cur, labels, line: view.state.doc.lineAt(sel.head).number, lh: view.defaultLineHeight, right: L.right };
  }
  draw(m) {
    if (!m) return;
    const { rows, cur, labels, line, lh, right } = m;
    const dom = this.dom;
    dom.style.width = Math.max(0, right) + "px";
    while (dom.childElementCount > rows.length) dom.lastChild.remove();
    while (dom.childElementCount < rows.length) dom.appendChild(document.createElement("div"));
    rows.forEach((r, i) => {
      const d = dom.children[i];
      d.style.top = r.top + "px";
      d.style.height = Math.min(r.bottom - r.top, lh) + "px";
      d.className = i === cur ? "vim-extras-row-cur" : "";
      const l = labels.get(i);
      d.textContent = i === cur ? line : l ? l[0] : "";
      d.dataset.head = l ? l[1] : ""; // where that many j lands; read by e2e.mjs
    });
  }
  destroy() { rowViews.delete(this); this.gone = true; window.cancelIdleCallback(this.idle); this.view.scrollDOM.removeEventListener("scroll", this.onScroll); this.dom.remove(); }
}

// ═══ Menu keys ═══════════════════════════════════════════════════════════════════
// Obsidian's suggesters (quick switcher, autocomplete) already bind Ctrl-N / Ctrl-P, but Menu
// only registers the arrow keys:
//     scope.register([], "ArrowUp",   onArrowUp)
//     scope.register([], "ArrowDown", onArrowDown)
// Menu.onload() is where the menu pushes its scope, so patching onload adds the two bindings
// to every menu (spelling corrections, editor menu, file menu...). Native menus are drawn by
// the OS and never see them.
function patchMenus() {
  const proto = Menu && Menu.prototype;
  // Guard: if a future Obsidian renames these, fail loudly instead of silently patching a
  // broken shape.
  for (const method of ["onload", "onArrowUp", "onArrowDown"]) {
    if (!proto || typeof proto[method] !== "function") {
      new Notice(`Vim Extras: Menu.${method} is gone, Ctrl-N / Ctrl-P in menus are off.`);
      return null;
    }
  }
  const original = proto.onload;
  proto.onload = function () {
    original.call(this);
    // onArrowUp/Down return false, which is how an Obsidian scope handler says "handled" —
    // that's what stops Ctrl-N falling through to "Create new note".
    this.scope.register(["Ctrl"], "N", this.onArrowDown.bind(this));
    this.scope.register(["Ctrl"], "P", this.onArrowUp.bind(this));
  };
  return () => { proto.onload = original; };
}

// ═══ Plugin ══════════════════════════════════════════════════════════════════════
const DEFAULTS = { spelling: true, underline: true, wordLists: "", learn: true, keyboard: "auto", rowNumbers: true, menuKeys: true };
const KEYBOARDS = ["auto", "qwerty", "azerty", "qwertz"];
const cleanSettings = s => {
  const out = { ...DEFAULTS };
  if (s && typeof s.wordList === "string" && typeof s.wordLists !== "string") s = { ...s, wordLists: s.wordList }; // 1.0: one list
  for (const k of Object.keys(DEFAULTS)) if (s && typeof s[k] === typeof DEFAULTS[k]) out[k] = s[k];
  if (!KEYBOARDS.includes(out.keyboard)) out.keyboard = "auto";
  return out;
};

class VimExtras extends Plugin {
  async onload() {
    const t0 = performance.now();
    plugin = this;
    this.patched = [];
    const data = await this.loadData();
    this.settings = cleanSettings(data);
    this.picks = know.picks = (data && data.picks && typeof data.picks === "object") ? data.picks : {};
    this.timings = {}; // ms, for the e2e test and the curious: load, catchUp, build, save
    if (paintField) this.registerEditorExtension(paintField);
    if (CMView) this.registerEditorExtension(CMView.EditorView.updateListener.of(u => { if (u.selectionSet) this.badgeSoon(); }));
    if (CMView) this.registerEditorExtension(CMView.ViewPlugin.fromClass(RowNumbers));
    this.app.workspace.onLayoutReady(() => { this.patchReloads(); this.applyKeys(); });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => { this.patchReloads(); this.applyKeys(); }));
    const s = session();
    if (s) s.listWordsInSpellCheckerDictionary().then(ws => { for (const w of ws) added.add(w); }).catch(() => {});
    // the model: loaded once Obsidian is idle after startup, then kept up to date with the notes
    this.app.workspace.onLayoutReady(() => window.requestIdleCallback(async () => { await this.detectKeyboard(); await this.loadModel(); }, { timeout: 3000 }));
    const changed = f => f && f.extension === "md" && this.noteChanged(f.path);
    this.registerEvent(this.app.vault.on("modify", changed));
    this.registerEvent(this.app.vault.on("create", changed));
    this.registerEvent(this.app.vault.on("delete", f => { if (this.model && f.extension === "md") { this.model.remove(f.path); this.saveSoon(); } }));
    this.registerEvent(this.app.vault.on("rename", (f, from) => { if (this.model && f.extension === "md") { this.model.rename(from, f.path); this.saveSoon(); } }));
    // the language badge in the status bar: click to choose the note's language
    this.badge = this.addStatusBarItem();
    this.badge.addClass("vim-extras-lang", "mod-clickable");
    this.badge.addEventListener("click", e => this.langMenu(e));
    let badgeTimer = null;
    this.badgeSoon = () => { window.clearTimeout(badgeTimer); badgeTimer = window.setTimeout(() => this.updateBadge(), 200); };
    this.register(() => window.clearTimeout(badgeTimer));
    this.registerEvent(this.app.workspace.on("active-leaf-change", this.badgeSoon));
    this.registerEvent(this.app.workspace.on("editor-change", this.badgeSoon));
    this.registerEvent(this.app.metadataCache.on("changed", this.badgeSoon));
    // background: check the note and prepare the fixes whenever you pause
    let timer = null;
    this.soon = () => { window.clearTimeout(timer); timer = window.setTimeout(() => this.warm(), 150); };
    this.register(() => window.clearTimeout(timer));
    this.registerEvent(this.app.workspace.on("editor-change", this.soon));
    this.registerEvent(this.app.workspace.on("file-open", this.soon));
    this.app.workspace.onLayoutReady(this.soon);
    this.addCommand({ id: "suggest", name: "Spelling suggestions (z=)", editorCheckCallback: c => this.settings.spelling && (c || this.suggest(0), true) });
    this.addCommand({ id: "add-word", name: "Add word to dictionary (zg)", editorCheckCallback: c => this.settings.spelling && (c || this.dictionary(true), true) });
    this.addCommand({ id: "remove-word", name: "Remove word from dictionary (zw)", editorCheckCallback: c => this.settings.spelling && (c || this.dictionary(false), true) });
    this.addCommand({ id: "note-language", name: "Set the spelling language of this note", checkCallback: c => !!(this.settings.spelling && this.langs().length && this.app.workspace.getActiveFile()) && (c || new LangModal(this.app, this).open(), true) });
    this.addCommand({ id: "rebuild-model", name: "Rebuild the spelling model (word lists and your notes)", callback: () => this.rebuildModel() });
    this.addCommand({ id: "toggle-row-numbers", name: "Toggle screen-row numbers", callback: () => { this.settings.rowNumbers = !this.settings.rowNumbers; this.saveSettings(); } });
    this.addSettingTab(new VimExtrasSettings(this.app, this));
    this.apply();
    this.timings.onload = performance.now() - t0;
  }

  onunload() {
    this.unloaded = true;
    window.clearTimeout(this.saveTimer);
    window.clearTimeout(this.changeTimer);
    if (this.model && this.model.dirty) this.writeModel(this.model.encode()); // best effort: Obsidian may close first
    know.model = null;
    unregister();
    if (this.unpatchMenus) this.unpatchMenus();
    if (this.idleId) window.cancelIdleCallback(this.idleId);
    this.job = null;
    for (const [obj, name, orig] of this.patched) obj[name] = orig;
    document.body.classList.remove("vim-extras-underline", "vim-extras-rows-off");
    if (plugin === this) plugin = null;
  }

  async saveSettings() {
    this.settings = cleanSettings(this.settings);
    this.apply(); // before the write, so a toggle shows at once
    await this.saveData({ ...this.settings, picks: this.picks });
  }
  // Puts every feature in the state the settings ask for; safe to call again.
  apply() {
    const s = this.settings;
    this.applyKeys();
    document.body.classList.toggle("vim-extras-underline", s.spelling && s.underline);
    document.body.classList.toggle("vim-extras-rows-off", !s.rowNumbers);
    if (s.rowNumbers) for (const r of rowViews) { r.layout = null; r.schedule(); }
    if (s.menuKeys && !this.unpatchMenus) this.unpatchMenus = patchMenus();
    if (!s.menuKeys && this.unpatchMenus) { this.unpatchMenus(); this.unpatchMenus = null; }
    if (s.spelling && s.underline) this.soon && this.soon();
    else this.clearUnderlines();
    if (this.badgeSoon) this.badgeSoon();
  }
  applyKeys() { if (this.settings.spelling) register(); else unregister(); }

  // ─── The model ───
  langs() { return this.model ? this.model.langs : []; }
  modelPath() { return `${this.manifest.dir}/model.bin`; }
  listPaths() { return this.settings.wordLists.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(p => (obsidian.normalizePath ? obsidian.normalizePath(p) : p)); }
  // What the model was built from: the lists (path, size, date), learning on or off, the format.
  async signature() {
    const lists = [];
    for (const path of this.listPaths()) { const st = await this.app.vault.adapter.stat(path).catch(() => null); lists.push([path, st && st.size, st && st.mtime]); }
    return JSON.stringify({ v: MODEL_VERSION, min: VAULT_MIN, learn: this.settings.learn, lists });
  }
  // Startup: model.bin as views (milliseconds), then only the notes changed since. A missing,
  // old or foreign file (other lists, learning switched) is rebuilt in the worker instead.
  async loadModel() {
    const t0 = performance.now(), sig = await this.signature();
    if (!this.listPaths().length && !this.settings.learn) return this.useModel(null);
    let m = null;
    try { m = decodeModel(await this.app.vault.adapter.readBinary(this.modelPath())); } catch (e) { /* none yet, or unreadable */ }
    this.timings.load = performance.now() - t0;
    if (!m || m.sig !== sig) return this.rebuildModel(sig);
    this.useModel(m);
    await this.catchUp();
  }
  useModel(m) {
    know.model = this.model = m;
    if (m) window.requestIdleCallback(() => m.lazy(), { timeout: 2000 }); // so the first z= doesn't pay for it
    fixCache.clear();
    this.badgeSoon();
    this.soon();
  }
  // The notes added, changed or deleted since the model was saved: by their dates, no reading
  // of the unchanged ones. Many of them (a sync, a big import) → one rebuild in the worker.
  async catchUp() {
    const m = this.model;
    if (!m || !this.settings.learn) return;
    const t0 = performance.now(), files = this.app.vault.getMarkdownFiles(), seen = new Set();
    const stale = files.filter(f => { seen.add(f.path); const e = m.files.get(f.path); return !e || e.mtime !== f.stat.mtime; });
    const gone = [...m.files.keys()].filter(p => !seen.has(p));
    if (stale.length + gone.length > Math.max(50, files.length / 4)) return this.rebuildModel(m.sig);
    for (const p of gone) m.remove(p);
    for (let i = 0; i < stale.length; i++) {
      m.update(stale[i].path, stale[i].stat.mtime, await this.app.vault.cachedRead(stale[i]));
      if (i % 8 === 7) await new Promise(r => window.requestIdleCallback(r, { timeout: 500 }));
      if (this.unloaded || this.model !== m) return;
    }
    this.timings.catchUp = performance.now() - t0;
    this.timings.caughtUp = stale.length + gone.length;
    if (m.dirty) { fixCache.clear(); this.saveSoon(); }
  }
  // Everything from scratch, in the worker: the lists and every note (read here, where the
  // vault is; Obsidian has most of them cached).
  rebuildModel(sig) {
    if (this.building) return this.building;
    this.building = (async () => {
      const t0 = performance.now();
      sig = sig || (await this.signature());
      const lists = [];
      for (const path of this.listPaths()) {
        try { lists.push({ path, text: await this.app.vault.adapter.read(path) }); } catch (e) { new Notice(`Vim Extras: couldn't read the word list “${path}”`); }
      }
      const notes = [];
      if (this.settings.learn) for (const f of this.app.vault.getMarkdownFiles()) notes.push({ path: f.path, mtime: f.stat.mtime, text: await this.app.vault.cachedRead(f) });
      if (this.unloaded) return;
      const buf = await buildInWorker({ lists, notes, sig });
      if (this.unloaded) return;
      this.useModel(decodeModel(buf.slice(0))); // a copy: buf goes to the disk as it is
      await this.writeModel(buf);
      this.timings.build = performance.now() - t0;
      await this.catchUp(); // notes edited while it was building
    })().catch(e => { console.error("Vim Extras: model build failed", e); new Notice("Vim Extras: couldn't build the spelling model (see the console)"); })
      .finally(() => { this.building = null; });
    return this.building;
  }
  async writeModel(buf) {
    try { await this.app.vault.adapter.writeBinary(this.modelPath(), buf); } catch (e) { console.error("Vim Extras: couldn't save model.bin", e); }
  }
  // A note was edited: re-count it a moment after the typing stops.
  noteChanged(path) {
    if (!this.model || !this.settings.learn) return;
    (this.changed = this.changed || new Set()).add(path);
    window.clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(async () => {
      const paths = [...this.changed];
      this.changed.clear();
      for (const p of paths) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f && f.stat && this.model) this.model.update(p, f.stat.mtime, await this.app.vault.cachedRead(f));
      }
      this.saveSoon();
    }, 1500);
  }
  // Save when idle, a while after the last change; a big delta is folded in by a rebuild.
  saveSoon() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => window.requestIdleCallback(async () => {
      const m = this.model;
      if (!m || !m.dirty || this.unloaded) return;
      if (m.deltaShare() > DELTA_MAX) return this.rebuildModel(m.sig);
      const t0 = performance.now(), buf = m.encode();
      await this.writeModel(buf);
      this.timings.save = performance.now() - t0;
    }, { timeout: 5000 }), 15000);
  }
  async detectKeyboard() {
    let layout = this.settings.keyboard;
    if (layout === "auto") {
      layout = "qwerty";
      try {
        const map = await navigator.keyboard.getLayoutMap();
        layout = map.get("KeyQ") === "a" ? "azerty" : map.get("KeyY") === "z" ? "qwertz" : "qwerty";
      } catch (e) { /* no Keyboard API: qwerty */ }
    }
    this.layout = layout;
    know.near = neighbours(layout);
    fixCache.clear();
  }
  // Remember the fix you took for a typo: next time it comes first.
  remember(typo, fix) {
    if (!this.settings.learn) return;
    const t = typo.toLowerCase(), f = fix.toLowerCase(), p = this.picks;
    (p[t] = p[t] || {})[f] = (p[t][f] || 0) + 1;
    const keys = Object.keys(p);
    if (keys.length > 5000) delete p[keys[0]];
    for (const k of [...fixCache.keys()]) if (k.split("|")[2] === typo) fixCache.delete(k);
    this.saveSettings();
  }

  // ─── Language ───
  // The note's language from its frontmatter (lang: en), when it names one of the lists.
  forcedLang(file = this.app.workspace.getActiveFile()) {
    const fm = file && this.app.metadataCache.getFileCache(file)?.frontmatter;
    const want = fm && (fm.lang || fm.language);
    const l = want && this.langs().find(l => sameLang(l.name, String(want)));
    return l ? l.name : null;
  }
  // The language at a line: the note's frontmatter, else the paragraph's words, else the note's.
  langAt(text, line) {
    if (!this.langs().length) return null;
    const forced = this.forcedLang();
    if (forced) return forced;
    const toks = tokensOf(text), lines = text.split("\n");
    let a = line, b = line;
    while (a > 0 && lines[a - 1].trim()) a--;
    while (b < lines.length - 1 && lines[b + 1].trim()) b++;
    return detectLang(toks.filter(t => t.line >= a && t.line <= b).map(t => t.text), this.model) || detectLang(toks.map(t => t.text), this.model);
  }
  updateBadge() {
    const editor = this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
    const show = !!(this.settings.spelling && this.langs().length > 1 && editor);
    this.badge.toggle(show);
    if (!show) return;
    const forced = this.forcedLang(), lang = forced || this.langAt(editor.getValue(), editor.getCursor().line);
    this.badge.setText(lang ? lang.slice(0, 2).toUpperCase() : "··");
    this.badge.setAttr("aria-label", `Spelling: ${lang || "language unclear"} (${forced ? "set by the note" : "detected"}). Click to choose.`);
    this.badge.toggleClass("is-forced", !!forced);
  }
  langMenu(e) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const forced = this.forcedLang(file), menu = new Menu();
    menu.addItem(i => i.setTitle("Detect per paragraph").setChecked(!forced).onClick(() => this.setNoteLang(file, null)));
    for (const l of this.langs()) menu.addItem(i => i.setTitle(l.name).setChecked(forced === l.name).onClick(() => this.setNoteLang(file, l.name)));
    menu.showAtMouseEvent(e);
  }
  async setNoteLang(file, name) {
    await this.app.fileManager.processFrontMatter(file, fm => { if (name) fm.lang = name; else { delete fm.lang; delete fm.language; } });
  }

  clearUnderlines() {
    if (!paintField || !CMView) return;
    this.app.workspace.iterateAllLeaves(l => {
      const view = l.view && l.view.editor && l.view.editor.cm;
      if (view && view.state.field(paintField, false)) view.dispatch({ effects: paintEffect.of(CMView.Decoration.none) });
    });
  }

  // Re-register once Vim Motions has (re)loaded its vimrc / init.lua. Without Vim Motions this
  // does nothing.
  patchReloads() {
    const vm = this.app.plugins && this.app.plugins.plugins["vim-motions"];
    if (!vm || vm.__vimExtras) return;
    vm.__vimExtras = true;
    for (const name of ["reloadAllConfigs", "softReloadVimrc", "softReloadLuaConfig"]) {
      const orig = vm[name];
      if (typeof orig !== "function") continue;
      const self = this;
      vm[name] = async function (...args) { try { return await orig.apply(this, args); } finally { self.applyKeys(); } };
      this.patched.push([vm, name, orig]);
    }
    this.patched.push([vm, "__vimExtras", undefined]);
  }

  target() {
    const editor = this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
    if (!editor) return null;
    const tok = wordAt(editor.getValue().split("\n"), editor.getCursor());
    if (!tok) { new Notice("No word under the cursor"); return null; }
    return { editor, tok };
  }

  // Idle-time work for the open note: check every word, then work out the fixes for the
  // misspelled ones — in slices that stop as soon as the browser needs the thread back.
  warm() {
    if (!this.settings.spelling) return;
    const editor = this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
    if (!editor || !webFrame) return;
    // nearest the cursor first: that's the word z= is about to be pressed on
    const row = editor.getCursor().line;
    const text = editor.getValue(), view = editor.cm, all = tokensOf(text);
    const toks = all.slice().sort((p, q) => Math.abs(p.line - row) - Math.abs(q.line - row));
    const words = [...new Set(toks.map(t => t.text))];
    const underline = this.settings.underline, self = this;
    const nearest = new Map(); // each word's occurrence nearest the cursor: its language, its neighbours
    for (const t of toks) if (!nearest.has(t.text)) nearest.set(t.text, t);
    this.job = (function* () {
      const bad = [];
      for (const w of words) { if (isBad(w)) bad.push(w); yield "check"; }
      // every word is checked: underline them (if the note is still the text we checked)
      if (underline && view && view.dom.isConnected && view.state.doc.toString() === text) paint(view, all);
      for (const w of bad) {
        const t = nearest.get(w), lang = self.langAt(text, t.line), ar = around(all, t.line, t.from);
        if (!fixCache.has(fixKey(w, lang, ar))) yield* fixesJob(w, lang, ar);
      }
    })();
    this.idle();
  }
  idle() {
    if (this.idleId || !this.job) return;
    this.idleId = window.requestIdleCallback(deadline => {
      this.idleId = null;
      let step = null;
      // a "suggest" step is one long call: only start it with a whole idle slot ahead
      while (this.job && deadline.timeRemaining() > (step === "suggest" ? 40 : 2)) {
        const r = this.job.next();
        if (r.done) this.job = null;
        else step = r.value;
      }
      this.idle();
    }, { timeout: 2000 });
  }

  // z= : menu of suggestions; n z= : take suggestion n directly.
  suggest(n) {
    if (!webFrame) return new Notice("Spellchecking needs the desktop app");
    const t = this.target();
    if (!t) return;
    const { editor, tok } = t;
    const text = editor.getValue(), ar = around(tokensOf(text), tok.line, tok.from);
    const sugs = fixes(tok.text, this.langAt(text, tok.line), ar).map(s => matchCase(tok.text, s));
    if (n) {
      if (!sugs[n - 1]) return new Notice(`No suggestion ${n} for “${tok.text}”`);
      return this.pick(editor, tok, sugs[n - 1]);
    }
    const menu = new Menu();
    if (menu.setUseNativeMenu) menu.setUseNativeMenu(false); // Ctrl-n/p and 1-9 need Obsidian's own menu
    sugs.forEach((s, i) => menu.addItem(item => item.setTitle(`${i + 1}   ${s}`).onClick(() => this.pick(editor, tok, s))));
    if (!sugs.length) menu.addItem(item => item.setTitle(`No suggestions for “${tok.text}”`).setDisabled(true));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(`Add “${tok.text}” to the dictionary   zg`).onClick(() => this.dictionary(true, tok.text)));
    const view = editor.cm, c = view.coordsAtPos(editor.posToOffset({ line: tok.line, ch: tok.from }));
    menu.showAtPosition({ x: c ? c.left : 0, y: c ? c.bottom : 0 });
    sugs.slice(0, 9).forEach((s, i) => menu.scope.register([], String(i + 1), () => { menu.hide(); this.pick(editor, tok, s); return false; }));
    if (sugs.length && menu.select) menu.select(0); // Enter takes the best one
  }

  pick(editor, tok, text) {
    this.replace(editor, tok, text);
    this.remember(tok.text, text);
  }
  replace(editor, tok, text) {
    editor.transaction({ changes: [{ from: { line: tok.line, ch: tok.from }, to: { line: tok.line, ch: tok.to }, text }] });
    editor.setCursor({ line: tok.line, ch: tok.from });
    editor.focus();
  }

  // zg / zw: Chromium's own custom dictionary, shared by every vault.
  dictionary(add, word) {
    const s = session();
    if (!s) return new Notice("Spellchecking needs the desktop app");
    if (!word) { const t = this.target(); if (!t) return; word = t.tok.text; }
    const ok = add ? s.addWordToSpellCheckerDictionary(word) : s.removeWordFromSpellCheckerDictionary(word);
    if (add && ok !== false) added.add(word);
    if (!add) { added.delete(word); added.delete(word.toLowerCase()); }
    // then re-read the real dictionary (it is shared: another window may have changed it)
    s.listWordsInSpellCheckerDictionary().then(ws => { added.clear(); for (const w of ws) added.add(w); this.warm(); }).catch(() => {});
    this.warm(); // redraw the underlines
    new Notice(ok === false ? `Couldn't ${add ? "add" : "remove"} “${word}”` : add ? `Added “${word}” to the dictionary` : `Removed “${word}” from the dictionary`);
  }
}

// The note-language command: detect per paragraph, or one of the lists.
class LangModal extends FuzzySuggestModal {
  constructor(app, plugin) { super(app); this.plugin = plugin; this.setPlaceholder("Spelling language of this note"); }
  getItems() { return [null, ...this.plugin.langs().map(l => l.name)]; }
  getItemText(name) { return name || "Detect per paragraph"; }
  onChooseItem(name) { const f = this.app.workspace.getActiveFile(); if (f) this.plugin.setNoteLang(f, name); }
}

// Obsidian 1.13+ draws the settings tab from getSettingDefinitions() and lists every row in its
// settings search; older versions call display(), which draws the same definitions here.
function drawSettings(tab, defs, nested) {
  const el = tab.containerEl;
  if (!nested) el.empty();
  for (const d of defs) {
    if ((typeof d.visible === "function" ? d.visible() : d.visible) === false) continue;
    if (d.type === "group") {
      if (d.heading) new Setting(el).setName(d.heading).setHeading();
      drawSettings(tab, d.items || [], true);
      continue;
    }
    const row = new Setting(el).setName(d.name), c = d.control;
    if (d.desc) row.setDesc(d.desc);
    if (d.render) d.render(row);
    if (!c) continue;
    const value = tab.getControlValue(c.key) ?? c.defaultValue, ph = c.placeholder || "";
    const commit = async (v, redraw) => {
      if (c.validate && c.validate(v)) return;
      await tab.setControlValue(c.key, v);
      if (redraw) tab.display(); // the rows that hang on this one show or hide
    };
    if (c.type === "toggle") row.addToggle(t => t.setValue(!!value).onChange(v => commit(v, true)));
    else if (c.type === "dropdown") row.addDropdown(t => t.addOptions(c.options).setValue(value).onChange(v => commit(v, true)));
    else if (c.type === "number") row.addText(t => t.setPlaceholder(ph).setValue(String(value ?? "")).onChange(v => {
      const n = Number(v);
      if (v.trim() && Number.isFinite(n) && !(n < c.min) && !(n > c.max)) commit(n);
    }));
    else row.addText(t => t.setPlaceholder(ph).setValue(value ?? "").onChange(v => commit(v)));
  }
}

class VimExtrasSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  getControlValue(key) { return this.plugin.settings[key]; }
  async setControlValue(key, value) { this.plugin.settings[key] = value; await this.plugin.saveSettings(); }
  display() { drawSettings(this, this.getSettingDefinitions()); }

  // After a change that alters the rows themselves (the keyboard layout's description)
  redraw() { if (requireApiVersion("1.13.0")) this.update(); else this.display(); }

  getSettingDefinitions() {
    const p = this.plugin, spelling = () => p.settings.spelling;
    return [
      { name: "Vim mode is off", desc: "The spelling keys and the screen-row numbers need Settings → Editor → Vim key bindings, or the Vim Motions plugin.",
        visible: () => !vimApi(), render: row => row.settingEl.addClass("mod-warning") },
      { type: "group", heading: "Spelling", items: [
        { name: "Spelling keys", desc: "]s [s jump to the next or previous misspelled word, z= lists fixes, zg adds a word to the dictionary and zw takes it out. Uses the languages in Settings → Editor → Spellcheck.",
          control: { type: "toggle", key: "spelling" } },
        { name: "Own underline", desc: "Underline the misspelled words the way ]s sees them: the whole note at once, never inside maths, code or links. Hides the built-in underline in the editor.",
          visible: spelling, control: { type: "toggle", key: "underline" } },
        { name: "Word lists", desc: "Optional, one file of the vault per line: one word per line, best followed by how common it is (a frequency list such as FrequencyWords' fr_50k.txt). Name each file after its language. z= then ranks common words first, and with two languages it detects each paragraph's language and ranks that language's words first; the status bar shows it. A note can set it in its frontmatter: lang: en.",
          visible: spelling, render: row => row.addTextArea(t => {
            t.setPlaceholder("words/fr_50k.txt\nwords/en_50k.txt").setValue(p.settings.wordLists).onChange(v => this.setControlValue("wordLists", v));
            t.inputEl.rows = 3;
            t.inputEl.addEventListener("blur", () => p.loadModel());
          }) },
        { name: "Learn from your notes", desc: "Words you use in your notes rank higher (so terms missing from the lists are known), and the fix you take for a typo comes first next time. Kept in this plugin's data.",
          visible: spelling, render: row => row
            .addToggle(t => t.setValue(p.settings.learn).onChange(async v => { await this.setControlValue("learn", v); p.loadModel(); }))
            .addExtraButton(b => b.setIcon("rotate-ccw").setTooltip("Forget the fixes you took").onClick(async () => { for (const k of Object.keys(p.picks)) delete p.picks[k]; fixCache.clear(); await p.saveSettings(); new Notice("Forgot the fixes you took"); })) },
        { name: "Keyboard layout", desc: `A typo on the key next door costs less. Auto reads the system layout${p.layout ? ` (now ${p.layout})` : ""}.`,
          visible: spelling, render: row => row.addDropdown(d => {
            for (const k of KEYBOARDS) d.addOption(k, k === "auto" ? "Auto" : k.toUpperCase());
            d.setValue(p.settings.keyboard).onChange(async v => { await this.setControlValue("keyboard", v); await p.detectKeyboard(); this.redraw(); });
          }) },
      ] },
      { type: "group", heading: "Screen-row numbers", items: [
        { name: "Screen-row numbers", desc: "Relative numbers in the left margin, one per screen row, counting exactly what gj and gk move by. The cursor row shows its line number. Turn on Settings → Editor → Readable line length so the margin has room.",
          control: { type: "toggle", key: "rowNumbers" } },
      ] },
      { type: "group", heading: "Menus", items: [
        { name: "Ctrl-N / Ctrl-P in menus", desc: "Move the selection in Obsidian's menus, like in the quick switcher. Needs Settings → Appearance → Native menus off.",
          control: { type: "toggle", key: "menuKeys" } },
      ] },
    ];
  }
}

module.exports = VimExtras;
module.exports.core = { prose, tokens, nextBad, wordAt, distance, neighbours, edits1, accents, candidates, parseList, listName, sameLang, makeLists,
  buildModel, decodeModel, encodeModel, workerSource, Model, VAULT_MIN, SEP, nearWords, detectLang, score, rankFixes, WEIGHT, around, matchCase, cleanSettings };
