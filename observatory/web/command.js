// command.js — the COMMAND LAYER over the agent graph (item 2):
//   · cmd-K quick-action palette — select a node, fire an action (assign / reconsider /
//     deep-research / spawn / stop / watch / relate / preset / …)
//   · multi-select → group into a @team (the selection bar + palette "Group")
//   · VOICE push-to-talk (Web Speech API) dictating into the palette + the steer box
// Pure client glue: every action lands on the existing bridge verbs (steer / node /
// edge / retract) and the Graph API — nothing here needs a bridge restart.
'use strict';

(function () {
  const $ = s => document.querySelector(s);
  const ce = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const G = () => window.Graph;
  // link gestures live on the canvas — hop to the Graph tab first so the armed
  // source→target click flow has something to draw on.
  const toGraph = () => showTab('graph');
  const steer = (to, body) => fetch('/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body }) }).then(r => r.json()).catch(() => ({ ok: false }));

  // ---- action catalog: each is contextual on the current selection -----------------
  // when(ctx) gates visibility; run(ctx) executes. ctx = {sel, agents, works, teams, one, primary}.
  const ACTIONS = [
    { id: 'assign', label: '⮕ Assign work to this agent', hint: 'draw agent → work',
      when: c => c.agents.length === 1, run: () => { toGraph(); G().startLink('assign'); } },
    { id: 'reconsider', label: '↻ Reconsider current approach', hint: 'ping the agent',
      when: c => c.agents.length >= 1,
      run: c => c.agents.forEach(a => steer(handle(a.id), 'reconsider your current approach — sanity-check the plan and report back. (from lodestar web)')) },
    { id: 'research', label: '🔎 Deep research…', hint: 'dispatch a research task',
      when: () => true, run: c => {
        const topic = prompt('Deep research on:'); if (!topic) return;
        const to = c.agents[0] ? handle(c.agents[0].id) : 'coordinator';
        steer(to, `run deep research on: ${topic}. fan out sources, verify, report a cited synthesis. (from lodestar web)`);
        toast(`🔎 research dispatched → ${to}`);
      } },
    { id: 'spawn', label: '✦ Spawn a sub-agent…', hint: 'ask coordinator to spawn',
      when: () => true, run: c => {
        const task = prompt('Spawn an agent to:'); if (!task) return;
        const ctx = c.primary ? ` (context: ${c.primary.id})` : '';
        steer('coordinator', `spawn an agent to: ${task}${ctx}. (requested from lodestar web)`);
        toast('✦ spawn requested → coordinator');
      } },
    { id: 'stop', label: '■ Stop / stand down', hint: 'halt the agent',
      when: c => c.agents.length >= 1,
      run: c => c.agents.forEach(a => steer(handle(a.id), 'stop — stand down your current work and await instruction. (from lodestar web)')) },
    { id: 'watch', label: '👁 Watch a thread', hint: 'draw agent → thread',
      when: c => c.agents.length === 1, run: () => { toGraph(); G().startLink('watch'); } },
    { id: 'depends', label: '⛓ Add a dependency', hint: 'draw work → work',
      when: c => c.works.length === 1, run: () => { toGraph(); G().startLink('depends'); } },
    { id: 'relates', label: '∞ Relate to another node', hint: 'draw node → node',
      when: c => c.one, run: () => { toGraph(); G().startLink('relates'); } },
    { id: 'group', label: '⬡ Group into a team', hint: 'team the selected agents',
      when: c => c.agents.length >= 2, run: () => {
        const reqs = prompt('Team mandate (operational_requirements) — optional:');
        toGraph(); G().groupSelection(reqs || '');
      } },
    { id: 'together', label: '▶ Work together', hint: 'ping every teammate',
      when: c => c.teams.length === 1, run: c => G().teamWorkTogether(c.teams[0].id) },
    { id: 'ungroup', label: '⬡ Ungroup the team', hint: 'dissolve it',
      when: c => c.teams.length === 1, run: c => G().ungroupTeam(c.teams[0].id) },
    { id: 'newwork', label: '✛ New work node', hint: 'mint a work node',
      when: () => true, run: () => { toGraph(); G().createWork(); } },
    { id: 'relayout', label: '⟳ Re-run layout', hint: 'rearrange the graph',
      when: () => true, run: () => { toGraph(); G().relayout(); } },
  ];
  const handle = id => id.startsWith('@agent:') ? id.slice('@agent:'.length) : id;
  const toast = msg => { const a = $('#cmd-toast'); if (!a) return; a.textContent = msg; a.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => a.classList.remove('show'), 1800); };

  function ctx() {
    const sel = (G() && G().selectedNodes && G().selectedNodes()) || [];
    return { sel, primary: sel[0],
      agents: sel.filter(n => n.type === 'agent'),
      works: sel.filter(n => n.type === 'work'),
      teams: sel.filter(n => n.type === 'team'), one: sel.length === 1 };
  }
  // preset views are commands too — fold them in so ⌘K drives the whole view engine.
  function presetActions() {
    if (!G() || !G().listPresets) return [];
    const { builtin, user } = G().listPresets();
    return [...builtin, ...user].map(name => ({ id: 'preset:' + name, label: `▢ View: ${name}`,
      hint: 'apply preset', when: () => true, run: () => { toGraph(); G().applyPreset(name); } }));
  }
  // a freeform query with an agent selected = a natural-language steer (pairs with voice).
  function freeformAction(q, c) {
    if (!q || !c.agents.length) return null;
    const to = c.agents.map(a => handle(a.id));
    return { id: 'steer', label: `🗣 Steer ${to.join(', ')}: “${q}”`, hint: 'send as a message',
      when: () => true, run: () => { to.forEach(t => steer(t, q + ' (from lodestar web)')); toast(`→ steered ${to.length}`); } };
  }

  // ---- palette DOM -----------------------------------------------------------------
  let pal, input, listEl, micBtn, items = [], hi = 0;
  function build() {
    pal = ce('div', 'cmd-pal hidden');
    const box = ce('div', 'cmd-box');
    const row = ce('div', 'cmd-inrow');
    input = ce('input', 'cmd-input'); input.type = 'text'; input.placeholder = '⌘K — type a command, or hold 🎤 to speak…'; input.autocomplete = 'off'; input.spellcheck = false;
    micBtn = ce('button', 'cmd-mic', '🎤'); micBtn.title = 'push-to-talk (hold)';
    row.append(input, micBtn);
    listEl = ce('div', 'cmd-list');
    const ctxBar = ce('div', 'cmd-ctx'); ctxBar.id = 'cmd-ctx';
    box.append(row, ctxBar, listEl);
    pal.append(box);
    document.body.append(pal);
    // toast lives on <body>, not inside the overlay — actions toast AFTER the palette closes.
    document.body.append(Object.assign(ce('div', 'cmd-toast'), { id: 'cmd-toast' }));

    pal.addEventListener('mousedown', e => { if (e.target === pal) close(); });
    input.addEventListener('input', render);
    input.addEventListener('keydown', navKeys);
    wireVoice(micBtn, t => { input.value = t; render(); }, true);
  }
  function open() {
    if (!pal) build();
    pal.classList.remove('hidden'); input.value = ''; hi = 0;
    const c = ctx();
    $('#cmd-ctx').textContent = c.sel.length
      ? `selection: ${c.sel.map(n => n.label).join(', ')}` : 'no selection — global commands';
    render(); input.focus();
  }
  function close() { if (pal) pal.classList.add('hidden'); }
  function toggle() { pal && !pal.classList.contains('hidden') ? close() : open(); }

  function render() {
    const c = ctx();
    const q = input.value.trim().toLowerCase();
    let pool = [...ACTIONS.filter(a => a.when(c)), ...presetActions()];
    const ff = freeformAction(input.value.trim(), c);
    items = pool.filter(a => !q || a.label.toLowerCase().includes(q) || a.id.includes(q));
    if (ff && (!items.length || q)) items.push(ff);   // freeform steer as a fallthrough
    if (hi >= items.length) hi = Math.max(0, items.length - 1);
    listEl.innerHTML = '';
    items.forEach((a, i) => {
      const r = ce('div', 'cmd-item' + (i === hi ? ' on' : ''));
      r.append(ce('span', 'cmd-lbl', a.label));
      if (a.hint) r.append(ce('span', 'cmd-hint', a.hint));
      r.onmouseenter = () => { hi = i; paint(); };
      r.onclick = () => exec(i);
      listEl.append(r);
    });
    if (!items.length) listEl.append(ce('div', 'cmd-empty', 'no matching command'));
  }
  function paint() { [...listEl.children].forEach((r, i) => r.classList.toggle('on', i === hi)); }
  function navKeys(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(items.length - 1, hi + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(0, hi - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); exec(hi); }
  }
  function exec(i) {
    const a = items[i]; if (!a) return;
    close();
    try { a.run(ctx()); } catch (err) { toast('command failed: ' + err.message); }
  }

  // ---- VOICE (Web Speech API push-to-talk) -----------------------------------------
  // hold the mic → recognize; interim transcripts stream into the target input; release
  // stops. Degrades to a disabled mic when the browser has no SpeechRecognition.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function wireVoice(btn, onText, live) {
    if (!SR) { btn.disabled = true; btn.title = 'voice unsupported in this browser'; return; }
    let rec = null, base = '';
    const start = e => {
      e.preventDefault();
      base = live ? '' : (onText.current || '');
      rec = new SR(); rec.interimResults = true; rec.continuous = true; rec.lang = 'en-US';
      rec.onresult = ev => {
        let txt = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
        onText((base ? base + ' ' : '') + txt.trim());
      };
      rec.onerror = () => stop();
      btn.classList.add('rec'); try { rec.start(); } catch (_) {}
    };
    const stop = () => { btn.classList.remove('rec'); if (rec) { try { rec.stop(); } catch (_) {} rec = null; } };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
  }

  // a mic on the steer box too — dictate a message, then ↵ to send.
  function wireSteerMic() {
    const form = $('#steer-form'), body = $('#steer-body');
    if (!form || !body || form.querySelector('.cmd-mic')) return;
    const mic = ce('button', 'cmd-mic steer-mic', '🎤'); mic.type = 'button'; mic.title = 'push-to-talk (hold)';
    form.insertBefore(mic, form.querySelector('button[type="submit"]'));
    wireVoice(mic, t => { body.value = t; }, true);
  }

  // ---- boot ------------------------------------------------------------------------
  // ⌘K / Ctrl-K from anywhere; selection bar reflects multi-select live.
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); toggle(); }
  });
  // floating selection bar: appears on the graph when ≥1 node is multi-selected.
  let selBar;
  document.addEventListener('fs:selection', e => {
    const sel = e.detail || [];
    if (!selBar) { selBar = ce('div', 'sel-bar hidden'); document.body.append(selBar); }
    if (sel.length < 2) { selBar.classList.add('hidden'); return; }
    const agents = sel.filter(n => n.type === 'agent').length;
    selBar.innerHTML = '';
    selBar.append(ce('span', 'sel-count', `${sel.length} selected`));
    if (agents >= 2) {
      const g = ce('button', 'sel-btn', `⬡ Group ${agents} agents`);
      g.onclick = () => { const reqs = prompt('Team mandate — optional:'); G().groupSelection(reqs || ''); };
      selBar.append(g);
    }
    const k = ce('button', 'sel-btn ghost', '⌘K actions');
    k.onclick = open; selBar.append(k);
    selBar.classList.remove('hidden');
  });

  wireSteerMic();
  const hintBtn = $('#cmdk-hint'); if (hintBtn) hintBtn.onclick = open;
  window.CommandLayer = { open, close, toggle };
})();
