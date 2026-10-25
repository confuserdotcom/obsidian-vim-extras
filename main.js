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
const { Plugin = class {}, PluginSettingTab = class {}, Setting = class {}, Notice = class { constructor(m) { console.log(m); } }, Menu } = obsidian;
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
// Accent-aware Damerau-Levenshtein: case = 0.05, accent = 0.2, a missing letter = 0.9 (typos
// drop letters more than they add them), splitting a word = 1.5, anything else = 1.
function distance(a, b) {
  const x = [...a], y = [...b];
  const d = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  const del = c => (joiner(c) ? 1.5 : 1), ins = c => (joiner(c) ? 1.5 : 0.9);
  const sub = (p, q) => (p === q ? 0 : p.toLowerCase() === q.toLowerCase() ? 0.05 : base(p) === base(q) ? 0.2 : 1);
  for (let i = 1; i <= x.length; i++) d[i][0] = d[i - 1][0] + del(x[i - 1]);
  for (let j = 1; j <= y.length; j++) d[0][j] = d[0][j - 1] + ins(y[j - 1]);
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + del(x[i - 1]), d[i][j - 1] + ins(y[j - 1]), d[i - 1][j - 1] + sub(x[i - 1], y[j - 1]));
    if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return Math.round(d[x.length][y.length] * 1000) / 1000;
}

// Plain letters only: accents get their own, much smaller pass (accents), which cuts the
// spellings to check by ~40 % (each check costs 0.1–0.25 ms).
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

// lists: [{src, list}] with src "primary" (in the preferred word list) | "both" (Chromium's
// own suggestions) | "edits" (the other near spellings) | "other". Closest first; ties go to
// the source order above.
const PENALTY = { primary: 0, edits: 0.05, both: 0.1, other: 0.3 };
function rank(word, lists, max = 9) {
  const score = new Map();
  for (const { src, list } of lists) list.forEach((s, i) => {
    if (s === word) return;
    const v = distance(word, s) + (PENALTY[src] ?? 0.1) + i * 0.001;
    if (!score.has(s) || v < score.get(s)) score.set(s, v);
  });
  return [...score].sort((p, q) => p[1] - q[1]).slice(0, max).map(p => p[0]);
}

// The spellchecker accepts a word in any of its languages without saying which one, so on a
// tie (mond → monde or mound) the preferred word list decides: one word per line, a trailing
// s counts too (a plural).
const wordListOf = set => w => { const l = w.toLowerCase(); return set.has(l) || set.has(w) || (/s$/.test(l) && set.has(l.slice(0, -1))); };
const byLanguage = (good, isPreferred) => [{ src: "primary", list: good.filter(isPreferred) }, { src: "edits", list: good.filter(w => !isPreferred(w)) }];
let isPreferred = () => false;

// Bonjuor → Bonjour, MOND → MONDE; a suggestion with its own capitals (Cauchy) keeps them.
function matchCase(orig, sug) {
  if (sug !== sug.toLowerCase()) return sug;
  if ([...orig].length > 1 && orig === orig.toUpperCase() && orig !== orig.toLowerCase()) return sug.toUpperCase();
  if (orig[0] !== orig[0].toLowerCase()) return sug[0].toUpperCase() + sug.slice(1);
  return sug;
}

// ─── Electron spellchecker ─────────────────────────────────────────────────────
// Measured: isWordMisspelled ≈ 0.06–0.25 ms, getWordSuggestions ≈ 50–150 ms. So nothing slow
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

// The ranked fixes for a word, one step at a time (each yield = a chance to hand the thread
// back): every one-edit / accent spelling the dictionary accepts, plus Chromium's own list.
function* fixesJob(word) {
  const good = [];
  for (const c of candidates(word)) { if (!isBad(c)) good.push(c); yield "check"; }
  yield "suggest"; // the next step is one 50–250 ms call: the runner gives it a fresh idle slot
  const chromium = webFrame.getWordSuggestions(word);
  fixCache.set(word, rank(word, [...byLanguage(good, isPreferred), { src: "both", list: chromium }]));
}
// Right now (z= on a word the background hasn't reached yet). A check costs 0.06 ms on one
// machine and 2 ms on another (macOS checking every language: ~700 spellings = 1.5 s), so the
// near spellings get at most COLD_MS, accents first; the ones in the preferred word list are
// words without asking. When all of them were checked and they give 3 fixes, Chromium's slow
// list is skipped this once (where checks are slow, it is fast). Not cached: the background
// works out the full list, so a z= a moment later shows it.
const COLD_MS = 150;
function fixes(word) {
  if (fixCache.has(word)) return fixCache.get(word);
  const cands = [...new Set([...accents(word), ...edits1(word)])];
  const good = cands.filter(c => isPreferred(c)), end = Date.now() + COLD_MS;
  let all = true;
  for (const c of cands) {
    if (good.includes(c)) continue;
    if (Date.now() > end) { all = false; break; }
    if (!isBad(c)) good.push(c);
  }
  const lists = byLanguage(good, isPreferred);
  return rank(word, all && good.length >= 3 ? lists : [...lists, { src: "both", list: webFrame.getWordSuggestions(word) }]);
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
    this.idle = requestIdleCallback(() => {
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
  destroy() { rowViews.delete(this); this.gone = true; cancelIdleCallback(this.idle); this.view.scrollDOM.removeEventListener("scroll", this.onScroll); this.dom.remove(); }
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
const DEFAULTS = { spelling: true, underline: true, wordList: "", rowNumbers: true, menuKeys: true };
const cleanSettings = s => {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (s && typeof s[k] === typeof DEFAULTS[k]) out[k] = s[k];
  return out;
};

class VimExtras extends Plugin {
  async onload() {
    plugin = this;
    this.patched = [];
    this.settings = cleanSettings(await this.loadData());
    if (paintField) this.registerEditorExtension(paintField);
    if (CMView) this.registerEditorExtension(CMView.ViewPlugin.fromClass(RowNumbers));
    this.app.workspace.onLayoutReady(() => { this.patchReloads(); this.applyKeys(); });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => { this.patchReloads(); this.applyKeys(); }));
    const s = session();
    if (s) s.listWordsInSpellCheckerDictionary().then(ws => { for (const w of ws) added.add(w); }).catch(() => {});
    this.app.workspace.onLayoutReady(() => this.loadWordList());
    // background: check the note and prepare the fixes whenever you pause
    let timer = null;
    this.soon = () => { clearTimeout(timer); timer = setTimeout(() => this.warm(), 150); };
    this.register(() => clearTimeout(timer));
    this.registerEvent(this.app.workspace.on("editor-change", this.soon));
    this.registerEvent(this.app.workspace.on("file-open", this.soon));
    this.app.workspace.onLayoutReady(this.soon);
    this.addCommand({ id: "suggest", name: "Spelling suggestions (z=)", editorCheckCallback: c => this.settings.spelling && (c || this.suggest(0), true) });
    this.addCommand({ id: "add-word", name: "Add word to dictionary (zg)", editorCheckCallback: c => this.settings.spelling && (c || this.dictionary(true), true) });
    this.addCommand({ id: "remove-word", name: "Remove word from dictionary (zw)", editorCheckCallback: c => this.settings.spelling && (c || this.dictionary(false), true) });
    this.addCommand({ id: "toggle-row-numbers", name: "Toggle screen-row numbers", callback: () => { this.settings.rowNumbers = !this.settings.rowNumbers; this.saveSettings(); } });
    this.addSettingTab(new VimExtrasSettings(this.app, this));
    this.apply();
  }

  onunload() {
    unregister();
    if (this.unpatchMenus) this.unpatchMenus();
    if (this.idleId) cancelIdleCallback(this.idleId);
    this.job = null;
    for (const [obj, name, orig] of this.patched) obj[name] = orig;
    document.body.classList.remove("vim-extras-underline", "vim-extras-rows-off");
    if (plugin === this) plugin = null;
  }

  async saveSettings() {
    this.settings = cleanSettings(this.settings);
    this.apply(); // before the write, so a toggle shows at once
    await this.saveData(this.settings);
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
  }
  applyKeys() { if (this.settings.spelling) register(); else unregister(); }

  async loadWordList() {
    isPreferred = () => false;
    fixCache.clear();
    const path = this.settings.wordList.trim();
    if (!path) return;
    try {
      const text = await this.app.vault.adapter.read(obsidian.normalizePath ? obsidian.normalizePath(path) : path);
      isPreferred = wordListOf(new Set(text.split(/\r?\n/).map(w => w.trim()).filter(Boolean)));
      fixCache.clear();
    } catch (e) {
      new Notice(`Vim Extras: couldn't read the word list “${path}”`);
    }
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
    const underline = this.settings.underline;
    this.job = (function* () {
      const bad = [];
      for (const w of words) { if (isBad(w)) bad.push(w); yield "check"; }
      // every word is checked: underline them (if the note is still the text we checked)
      if (underline && view && view.dom.isConnected && view.state.doc.toString() === text) paint(view, all);
      for (const w of bad) if (!fixCache.has(w)) yield* fixesJob(w);
    })();
    this.idle();
  }
  idle() {
    if (this.idleId || !this.job) return;
    this.idleId = requestIdleCallback(deadline => {
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
    const sugs = fixes(tok.text).map(s => matchCase(tok.text, s));
    if (n) {
      if (!sugs[n - 1]) return new Notice(`No suggestion ${n} for “${tok.text}”`);
      return this.replace(editor, tok, sugs[n - 1]);
    }
    const menu = new Menu();
    if (menu.setUseNativeMenu) menu.setUseNativeMenu(false); // Ctrl-n/p and 1-9 need Obsidian's own menu
    sugs.forEach((s, i) => menu.addItem(item => item.setTitle(`${i + 1}   ${s}`).onClick(() => this.replace(editor, tok, s))));
    if (!sugs.length) menu.addItem(item => item.setTitle(`No suggestions for “${tok.text}”`).setDisabled(true));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(`Add “${tok.text}” to the dictionary   zg`).onClick(() => this.dictionary(true, tok.text)));
    const view = editor.cm, c = view.coordsAtPos(editor.posToOffset({ line: tok.line, ch: tok.from }));
    menu.showAtPosition({ x: c ? c.left : 0, y: c ? c.bottom : 0 });
    sugs.slice(0, 9).forEach((s, i) => menu.scope.register([], String(i + 1), () => { menu.hide(); this.replace(editor, tok, s); return false; }));
    if (sugs.length && menu.select) menu.select(0); // Enter takes the best one
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

class VimExtrasSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this, p = this.plugin, set = async (k, v) => { p.settings[k] = v; await p.saveSettings(); };
    containerEl.empty();
    if (!vimApi())
      containerEl.createEl("p", { text: "Vim mode is off: the spelling keys and the screen-row numbers need Settings → Editor → Vim key bindings, or the Vim Motions plugin.", cls: "mod-warning" });

    new Setting(containerEl).setName("Spelling").setHeading();
    new Setting(containerEl).setName("Spelling keys").setDesc("]s [s jump to the next or previous misspelled word, z= lists fixes, zg adds a word to the dictionary and zw takes it out. Uses the languages in Settings → Editor → Spellcheck.")
      .addToggle(t => t.setValue(p.settings.spelling).onChange(v => { set("spelling", v); this.display(); }));
    if (p.settings.spelling) {
      new Setting(containerEl).setName("Own underline").setDesc("Underline the misspelled words the way ]s sees them: the whole note at once, never inside maths, code or links. Hides the built-in underline in the editor.")
        .addToggle(t => t.setValue(p.settings.underline).onChange(v => set("underline", v)));
      new Setting(containerEl).setName("Preferred word list").setDesc("Optional. A file in the vault with one word per line, for example a dictionary of your main language. When two fixes are as close, z= puts the one in this list first.")
        .addText(t => t.setPlaceholder("words/french.txt").setValue(p.settings.wordList).onChange(async v => { await set("wordList", v); await p.loadWordList(); }));
    }

    new Setting(containerEl).setName("Screen-row numbers").setHeading();
    new Setting(containerEl).setName("Screen-row numbers").setDesc("Relative numbers in the left margin, one per screen row, counting exactly what gj and gk move by. The cursor row shows its line number. Turn on Settings → Editor → Readable line length so the margin has room.")
      .addToggle(t => t.setValue(p.settings.rowNumbers).onChange(v => set("rowNumbers", v)));

    new Setting(containerEl).setName("Menus").setHeading();
    new Setting(containerEl).setName("Ctrl-N / Ctrl-P in menus").setDesc("Move the selection in Obsidian's menus, like in the quick switcher. Needs Settings → Appearance → Native menus off.")
      .addToggle(t => t.setValue(p.settings.menuKeys).onChange(v => set("menuKeys", v)));
  }
}

module.exports = VimExtras;
module.exports.core = { prose, tokens, nextBad, wordAt, distance, rank, edits1, accents, candidates, matchCase, wordListOf, byLanguage, cleanSettings };
