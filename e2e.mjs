// Live end-to-end check: real key presses and the real spellchecker in a running Obsidian.
//   1. start Obsidian with the debug port:   obsidian --remote-debugging-port=9222
//   2. node e2e.mjs   (Vim key bindings on, native menus off, Vim Extras enabled; the
//      ranking cases only run with word lists set, the language ones with a French and an
//      English one: fr_50k.txt + en_50k.txt from FrequencyWords;
//      PORT=9344 node e2e.mjs for another port)
// Uses a scratch note zz-vim-extras-e2e.md (deleted at the end). Prints PASS/FAIL per case.
// Note: port 9222 lets any local process drive Obsidian; relaunch normally when done.

const list = await (await fetch(`http://localhost:${process.env.PORT || 9222}/json/list`)).json();
const ws = new WebSocket(list.find(p => p.type === "page" && p.url.endsWith("/index.html")).webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0;
const pend = {};
ws.onmessage = e => { const m = JSON.parse(e.data); pend[m.id]?.(m); };
const call = (method, params) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => (await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NOTE = "zz-vim-extras-e2e.md";

async function key(k) {
  const special = { "<Esc>": ["Escape", 27], "<CR>": ["Enter", 13] }[k];
  const ctrl = /^<C-(.)>$/.exec(k);
  if (ctrl) {
    const K = ctrl[1].toUpperCase();
    for (const type of ["keyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type, key: ctrl[1], code: "Key" + K, windowsVirtualKeyCode: K.charCodeAt(0), modifiers: 2 });
  } else if (special) {
    for (const type of ["keyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type, key: special[0], code: special[0], windowsVirtualKeyCode: special[1] });
  } else {
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k, unmodifiedText: k });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: k });
  }
  await sleep(80);
}
const keys = async s => { for (const k of s.match(/<[^>]+>|./gu)) await key(k); };
// every edit goes through here: refuse to touch anything but the scratch note
async function fresh() {
  if ((await ev(`app.workspace.getActiveFile()?.path`)) !== NOTE) throw new Error("the scratch note is not the active one, stopping");
  await ev(`(()=>{const e=app.workspace.activeEditor.editor;e.setValue("");e.focus()})()`);
  await keys("<Esc>");
}
const doc = () => ev(`app.workspace.activeEditor.editor.getValue()`);
const menu = () => ev(`[...document.querySelectorAll(".menu .menu-item")].map(e=>(e.classList.contains("selected")?"*":"")+e.textContent.trim())`);
const popup = () => ev(`[...document.querySelectorAll(".suggestion-container .suggestion-item")].map(e=>(e.classList.contains("is-selected")?"*":"")+e.textContent.trim())`);

let fails = 0;
const report = (ok, name, detail) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "\n      " + detail}`); };

// Vim Extras asks the spellchecker directly, so the text can be set (typing would set off
// latex-suite's $ pairing and Completr).
const typeIn = async text => { await fresh(); await ev(`app.workspace.activeEditor.editor.setValue(${JSON.stringify(text)})`); await keys("<Esc>"); };
const cursor = () => ev(`JSON.stringify(app.workspace.activeEditor.editor.getCursor())`).then(JSON.parse);
const clean = items => items.map(s => s.replace(/^\*/, ""));
// one dictionary check costs 0.06 ms in one profile, 2 ms in a fresh macOS one: give the
// background pass time to finish before judging the full list
const WARM = 2500;

// z= then pick `fix` with 1-9, or with Ctrl-n … Enter when `how` is "ctrl"
async function fixWith(name, text, moves, fix, want, how = "digit") {
  await typeIn(text);
  await sleep(WARM); // the background pass has worked out the full list (the cold z= is timed below)
  await keys(moves + "z=");
  await sleep(700);
  const items = clean(await menu());
  const n = items.findIndex(s => s.replace(/^\d+\s+/, "") === fix);
  if (n < 0 || n > 8) { await keys("<Esc>"); return report(false, name, `no "${fix}" in the first 9 of ${JSON.stringify(items)}`); }
  if (how === "digit") await keys(String(n + 1));
  else { for (let i = 0; i < n; i++) await keys("<C-n>"); await keys("<CR>"); }
  await sleep(300);
  const got = await doc();
  report(got === want, name, `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
}

await ev(`(async()=>{const f=app.vault.getAbstractFileByPath('${NOTE}')||await app.vault.create('${NOTE}','');
  await app.workspace.getLeaf(false).openFile(f);await new Promise(r=>setTimeout(r,500))})()`);
// Without a word list the ranking is whatever the system spellchecker accepts: a fresh macOS
// profile checks every language and takes "bosjuor" or "helö" as words, so the cases that
// judge the order of the fixes need the (French) word list.
const wordList = await ev(`app.plugins.plugins["vim-extras"].settings.wordLists.trim()`);
const langs = await ev(`app.plugins.plugins["vim-extras"].lists.map(l=>l.name.slice(0,2))`);
const bilingual = langs.includes("fr") && langs.includes("en");
try {
  // z= menu: only corrections (numbered), the best one pre-selected, then "Add … to the dictionary"
  {
    await typeIn("bonjuor le monde ");
    await sleep(WARM);
    await keys("0z=");
    await sleep(700);
    const items = await menu();
    report((!wordList || /^\*1\s+bonjour$/.test(items[0])) && items.at(-1).startsWith("Add “bonjuor”") && !items.some(s => /Add link|Paste/.test(s)),
      "z= lists corrections only, best first and selected", JSON.stringify(items));
    await keys("<Esc>");
  }
  await fixWith("z= then a digit", "bonjuor le monde ", "0ll", "bonjour", "bonjour le monde ");
  await fixWith("z= then Ctrl-n … Enter", "bonjuor le monde ", "0e", "bonjour", "bonjour le monde ", "ctrl");
  if (wordList) {
    await fixWith("z= preferred list first: mond → monde", "le mond est beau ", "0w", "monde", "le monde est beau ");
    await typeIn("le mond est beau ");
    await sleep(WARM);
    await keys("0wz=");
    await sleep(300);
    const items = await menu();
    report(/^\*1\s+monde$/.test(items[0]), "z= puts the preferred-list fix first: mond → monde before mound", JSON.stringify(items));
    await keys("<Esc>");
  }
  await fixWith("z= accents: theoreme → théorème", "un theoreme ici ", "0w", "théorème", "un théorème ici ");
  await fixWith("z= keeps a capital: Bonjuor → Bonjour", "Bonjuor toi ", "0", "Bonjour", "Bonjour toi ");
  if (wordList) await fixWith("z= on an English word", "helo world ", "0", "hello", "hello world ");
  {
    await typeIn("bonjuor le monde ");
    await keys("01z=");
    await sleep(700);
    report((wordList ? (await doc()) === "bonjour le monde " : (await doc()) !== "bonjuor le monde ") && !(await menu()).length, "1z= fixes without a menu", JSON.stringify(await doc()));
  }
  {
    await typeIn("tout va bien ");
    await keys("0z=");
    await sleep(700);
    const items = clean(await menu());
    report(!items.slice(0, -1).some(s => /^\d/.test(s)) || items.length > 0, "z= on a correct word does not crash", JSON.stringify(items));
    await keys("<Esc>");
  }

  // ]s / [s
  // "mondz", not "mond": a profile with German or Dutch on accepts "mond"
  const TEXT = "bonjour le mondz\nsoit $mondz$ ici\nfin bonjuor encore";
  const jump = async (name, moves, want) => {
    await typeIn(TEXT);
    await keys("gg0" + moves);
    const c = await cursor();
    report(c.line === want[0] && c.ch === want[1], name, `want ${JSON.stringify(want)} got ${JSON.stringify(c)}`);
  };
  await jump("]s goes to the first misspelling", "]s", [0, 11]);
  await jump("]s]s skips the maths", "]s]s", [2, 4]);
  await jump("2]s", "2]s", [2, 4]);
  await jump("]s wraps to the top", "]s]s]s", [0, 11]);
  await jump("[s from the top wraps to the bottom", "[s", [2, 4]);
  await jump("]s then [s comes back", "2]s[s", [0, 11]);
  {
    await typeIn("un mondz ici ");
    await keys("0d]s");
    report((await doc()) === "mondz ici ", "d]s deletes up to the misspelling", JSON.stringify(await doc()));
  }

  // zg / zw: a made-up word, removed again at the end
  {
    const W = "qzvkwxlemme";
    await typeIn(`ici ${W} fin `);
    await keys("0]s");
    const found = (await cursor()).ch === 4;
    await keys("zg");
    await sleep(300);
    await keys("0]s");
    const skipped = (await cursor()).ch !== 4;
    await keys("0wzw");
    await sleep(300);
    await keys("0]s");
    const back = (await cursor()).ch === 4;
    report(found && skipped && back, "zg adds a word (]s skips it), zw takes it back out", JSON.stringify({ found, skipped, back }));
  }
  // underlines: ours, fast, and only in prose
  {
    await fresh();
    const t0 = Date.now();
    await ev(`app.workspace.activeEditor.editor.setValue("Soit bonjuor ici et \`bonjuor\` en code, puis fonctoin.")`);
    let marks = [];
    for (let i = 0; i < 50 && marks.length < 2; i++) { await sleep(20); marks = await ev(`[...document.querySelectorAll(".workspace-leaf.mod-active .vim-extras-bad")].map(e=>e.textContent)`); }
    const ms = Date.now() - t0;
    report(JSON.stringify(marks) === '["bonjuor","fonctoin"]', "underlines the misspellings in prose, not in code", JSON.stringify(marks));
    report(ms < 600, `underlines appear ${ms} ms after the text changes (limit 600)`, String(ms));
    await keys("0wzg");
    await sleep(500);
    marks = await ev(`[...document.querySelectorAll(".workspace-leaf.mod-active .vim-extras-bad")].map(e=>e.textContent)`);
    await keys("0wzw");
    await sleep(300);
    report(JSON.stringify(marks) === '["fonctoin"]', "zg removes the underline", JSON.stringify(marks));
  }

  // speed: after a pause the note is prepared, so z= and ]s only read caches
  {
    await typeIn("Une phrase avec des fautes: bonjuor, problemme, theoreme et mond.\n".repeat(40) + "fin ");
    await sleep(2500); // idle: the background checks the note and prepares the fixes
    const ms = await ev(`(()=>{const e=app.workspace.activeEditor.editor;e.setCursor({line:20,ch:30});
      const t=performance.now();app.commands.executeCommandById("vim-extras:suggest");const d=performance.now()-t;
      return [d, document.querySelectorAll(".menu .menu-item").length]})()`);
    await keys("<Esc>");
    report(ms[0] < 30 && ms[1] > 1, `z= opens in ${ms[0].toFixed(1)} ms (limit 30)`, JSON.stringify(ms));
    const js = await ev(`(()=>{const e=app.workspace.activeEditor.editor;const v=e.cm;const a=(v.plugins||[]).map(p=>p.value).find(x=>x&&x.cm&&x.cm.state&&x.cm.state.vim).cm;
      e.setCursor({line:0,ch:0});const V=window.CodeMirrorAdapter.Vim;const t=performance.now();
      for(let i=0;i<20;i++){V.handleKey(a,"]","user");V.handleKey(a,"s","user");}return (performance.now()-t)/20})()`);
    report(js < 15, `]s moves in ${js.toFixed(2)} ms (limit 15)`, String(js));
    const fresh12 = "zorglub" + Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 5); // never seen before
    await typeIn(`un mot tout neuf: ${fresh12} `);
    const cold = await ev(`(()=>{const e=app.workspace.activeEditor.editor;e.setCursor({line:0,ch:20});
      const t=performance.now();app.commands.executeCommandById("vim-extras:suggest");return performance.now()-t})()`);
    await keys("<Esc>");
    // worst case: a long made-up word nobody paused on (Chromium's own list is ~250 ms of it)
    report(cold < 600, `z= on a long made-up word not prepared yet: ${cold.toFixed(0)} ms (limit 600)`, String(cold));
  }

  // Ctrl-N / Ctrl-P walk a menu (the z= one), and never create a note
  {
    report((await ev(`app.vault.getConfig("nativeMenus")`)) === false, "native menus are off (Ctrl-N/P can't reach native ones)", "Settings → Appearance → Native menus: turn it off");
    await typeIn("bonjuor ");
    await sleep(1200);
    await keys("0z=");
    await sleep(800);
    await keys("<C-n><C-n><C-p>");
    const sel = (await menu()).findIndex(s => s.startsWith("*"));
    const still = (await ev(`app.workspace.getActiveFile()?.path`)) === NOTE;
    // the z= menu opens with its best suggestion selected (0): down, down, up → 1
    report(sel === 1 && still, "Ctrl-N Ctrl-N Ctrl-P in a menu", `selected ${sel}, still on the note: ${still}`);
    await keys("<Esc>");
  }

  // screen-row numbers: each label is where that many gj land
  {
    await typeIn(Array.from({ length: 12 }, (_, i) => `ligne ${i} ` + "mot ".repeat(i % 3 ? 4 : 60)).join("\n"));
    await keys("gg0");
    await sleep(500);
    const rows = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll(".workspace-leaf.mod-active .vim-extras-rows div")].map(d=>[d.textContent,d.dataset.head,d.className]))`));
    const cur = rows.find(r => r[2] === "vim-extras-row-cur");
    const labelled = rows.filter(r => r[1]);
    const n = labelled.find(r => r[0] === "3");
    let landed = null;
    if (n) { await keys("3gj"); landed = await ev(`app.workspace.activeEditor.editor.posToOffset(app.workspace.activeEditor.editor.getCursor())`); }
    report(cur && cur[0] === "1" && labelled.length > 12 && n && String(landed) === n[1], "row numbers: cursor row shows 1, wrapped rows are counted, 3gj lands on the row labelled 3",
      JSON.stringify({ cur, labelled: labelled.length, n, landed }));
    await ev(`app.commands.executeCommandById("vim-extras:toggle-row-numbers")`);
    const hidden = await ev(`getComputedStyle(document.querySelector(".workspace-leaf.mod-active .vim-extras-rows")).display`);
    await ev(`app.commands.executeCommandById("vim-extras:toggle-row-numbers")`);
    await sleep(300);
    const back = await ev(`getComputedStyle(document.querySelector(".workspace-leaf.mod-active .vim-extras-rows")).display`);
    report(hidden === "none" && back !== "none", "toggle command hides and shows them", JSON.stringify({ hidden, back }));
  }
  // languages: each paragraph's own, the badge shows it, a note can force one
  if (bilingual) {
    const EN = "The proof of this theorme is short and the result is clear.", FR = "La preuve de ce theorme est courte et le résultat est clair.";
    const first = async (line, word) => {
      await keys(`${line + 1}G0`);
      const ch = (await ev(`app.workspace.activeEditor.editor.getLine(${line})`)).indexOf(word);
      await ev(`app.workspace.activeEditor.editor.setCursor({line:${line},ch:${ch}})`);
      await keys("z=");
      await sleep(400);
      const items = clean(await menu());
      await keys("<Esc>");
      return (items[0] || "").replace(/^\d+\s+/, "");
    };
    const badge = async () => { await sleep(500); return ev(`(()=>{const b=document.querySelector(".vim-extras-lang");return b&&b.isShown()?b.textContent+(b.hasClass("is-forced")?"!":""):null})()`); };
    await typeIn(`${EN}\n\n${FR}`);
    await sleep(WARM);
    const en = await first(0, "theorme"), enBadge = await badge(), fr = await first(2, "theorme"), frBadge = await badge();
    report(en === "theorem" && fr !== "theorem" && /^th[ée]or/.test(fr), "z= follows each paragraph's language", JSON.stringify({ en, fr }));
    report(enBadge === "EN" && frBadge === "FR", "the badge shows the paragraph's language", JSON.stringify({ enBadge, frBadge }));
    await ev(`(async()=>{const f=app.vault.getAbstractFileByPath('${NOTE}');await app.vault.modify(f,${JSON.stringify("---\nlang: en\n---\n" + FR)})})()`);
    await sleep(1500);
    const forced = await first(3, "theorme"), forcedBadge = await badge();
    report(forced === "theorem" && forcedBadge === "EN!", "lang: en in the frontmatter forces English", JSON.stringify({ forced, forcedBadge }));
  }

  // the fix you take comes first next time (then forgotten again)
  if (wordList) {
    const before = await ev(`JSON.stringify(app.plugins.plugins["vim-extras"].picks["mondz"] || null)`);
    await typeIn("le mondz est beau ");
    await sleep(WARM);
    await keys("0wz=");
    await sleep(400);
    const items = clean(await menu()).filter(s => /^\d/.test(s)).map(s => s.replace(/^\d+\s+/, ""));
    await keys("<Esc>");
    if (items.length < 2) report(false, "z= remembers the fix you took", JSON.stringify(items));
    else {
      await keys("0w2z=");
      await typeIn("un mondz ici ");
      await keys("0wz=");
      await sleep(400);
      const again = clean(await menu())[0].replace(/^\d+\s+/, "");
      await keys("<Esc>");
      report(again === items[1], "z= remembers the fix you took", JSON.stringify({ took: items[1], now: again }));
    }
    await ev(`(()=>{const p=app.plugins.plugins["vim-extras"],b=${before};if(b)p.picks["mondz"]=b;else delete p.picks["mondz"];return p.saveSettings()})()`);
  }
  report((await ev(`app.workspace.getActiveFile()?.path`)) === NOTE, "never left the scratch note", "");
} catch (e) {
  fails++;
  console.log("CRASH ", e.message);
} finally {
  await keys("<Esc><Esc>");
  await ev(`(()=>{const s=require("electron").remote.session.defaultSession;for(const w of ["qzvkwxlemme","bonjuor"])s.removeWordFromSpellCheckerDictionary(w)})()`);
  // empty it first, so Completr's word scanner never learns the test typos
  await ev(`(()=>{if(app.workspace.getActiveFile()?.path==='${NOTE}')app.workspace.activeEditor.editor.setValue("")})()`);
  const left = await ev(`(async()=>{const f=app.vault.getAbstractFileByPath('${NOTE}');if(f){await app.vault.modify(f,"");await app.vault.delete(f)}return !!app.vault.getAbstractFileByPath('${NOTE}')})()`);
  if (left !== false) { fails++; console.log(`FAIL  cleanup: ${NOTE} was not deleted`); }
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
ws.close();
process.exit(fails ? 1 : 0);
