// timetape.js — scrubbable last-N-min activity ribbon. Temporal view of agent
// activity: three lanes (msg / session / run) positioned by time, cumulative-cost
// sparkline, live now-line, scrubber with event readout. Data: GET /timetape
// (sent_at/started_at/ended_at from the graph) + live commit ticks.
'use strict';

const TimeTape = (function () {
  const $ = id => document.getElementById(id);
  const PORT = () => parseInt(($('port') || {}).value, 10) || 7978;
  let mins = 30;
  let data = { now: Date.now(), events: [] };
  const live = [];            // client-stamped live commits (firehose ticks)
  let pollT = null;
  const KIND_LANE = { msg: 'tt-lane-msg', session: 'tt-lane-session', run: 'tt-lane-run' };

  function init() {
    $('tt-range').querySelectorAll('button').forEach(b => b.onclick = () => {
      $('tt-range').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      mins = parseInt(b.dataset.mins, 10); refresh();
    });
    const track = $('tt-track');
    track.addEventListener('mousemove', onScrub);
    track.addEventListener('mouseleave', () => { $('tt-scrub').style.opacity = 0; $('tt-readout').textContent = '— hover the ribbon —'; });
    window.addEventListener('resize', render);
    refresh();
    pollT = setInterval(refresh, 5000);
  }

  async function refresh() {
    try {
      const r = await fetch(`/timetape?port=${PORT()}&mins=${mins}`);
      data = await r.json();
      pruneLive();
      render();
    } catch (e) { /* bridge transient — keep last frame */ }
  }

  function win() {
    const now = Date.now();                       // tick the right edge smoothly between polls
    return { t0: now - mins * 60000, t1: now, w: $('tt-track').clientWidth || 1 };
  }
  const xOf = (t, W) => ((t - W.t0) / (W.t1 - W.t0)) * W.w;

  function pruneLive() {
    const cutoff = Date.now() - mins * 60000;
    while (live.length && live[0].t < cutoff) live.shift();
  }

  // a live commit arrives → stamp it now, tick it onto the ribbon immediately, pulse now-line.
  function onCommit(m) {
    live.push({ t: Date.now(), kind: 'commit', label: `${m.op} ${m.p}` });
    if (live.length > 400) live.shift();
    const now = $('tt-now'); if (now) { now.classList.remove('pulse'); void now.offsetWidth; now.classList.add('pulse'); }
    render();
  }

  function render() {
    const W = win();
    Object.values(KIND_LANE).forEach(id => { const l = $(id); if (l) l.innerHTML = ''; });
    // event dots, per lane
    let totalCost = 0;
    const runs = [];
    (data.events || []).forEach(ev => {
      const laneId = KIND_LANE[ev.kind]; if (!laneId) return;
      const x = xOf(ev.t, W); if (x < -4 || x > W.w + 4) return;
      const dot = document.createElement('span');
      dot.className = 'tt-dot ' + ev.kind;
      dot.style.left = x + 'px';
      if (ev.kind === 'run') { runs.push(ev); if (ev.cost) dot.style.transform = `scale(${Math.min(2.4, 1 + ev.cost)})`; }
      dot.title = tooltip(ev);
      $(laneId).append(dot);
    });
    // faint live-commit ticks ride the msg lane
    live.forEach(ev => {
      const x = xOf(ev.t, W); if (x < 0 || x > W.w) return;
      const dot = document.createElement('span');
      dot.className = 'tt-dot commit'; dot.style.left = x + 'px'; dot.title = ev.label;
      $('tt-lane-msg').append(dot);
    });
    renderCostSpark(W, runs);
    // now-line sits at the right edge
    $('tt-now').style.left = (W.w - 1) + 'px';
    const c = (data.events || []).filter(e => e.kind === 'run').reduce((s, e) => s + (e.cost || 0), 0);
    $('tt-cost').textContent = c ? `Σ $${c.toFixed(2)} over ${mins}m` : '';
  }

  // cumulative cost as a filled area — the "cost accruing" curve over the window.
  function renderCostSpark(W, runs) {
    const svg = $('tt-cost-spark');
    const h = $('tt-track').clientHeight || 64;
    svg.setAttribute('viewBox', `0 0 ${W.w} ${h}`);
    svg.setAttribute('width', W.w); svg.setAttribute('height', h);
    runs.sort((a, b) => a.t - b.t);
    const total = runs.reduce((s, r) => s + (r.cost || 0), 0);
    if (!total) { svg.innerHTML = ''; return; }
    let cum = 0;
    const pts = [[0, h]];
    runs.forEach(r => { cum += (r.cost || 0); const x = xOf(r.t, W); pts.push([x, h - (cum / total) * (h - 6) - 2]); });
    pts.push([W.w, pts[pts.length - 1][1]], [W.w, h]);
    const d = 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
    svg.innerHTML = `<path d="${d}Z" fill="rgba(74,222,128,.10)" stroke="rgba(74,222,128,.5)" stroke-width="1"/>`;
  }

  function tooltip(ev) {
    const tm = new Date(ev.t).toLocaleTimeString();
    if (ev.kind === 'msg') return `${tm}  ${ev.from || '?'} → ${ev.to || '?'}\n${ev.label || ''}`;
    if (ev.kind === 'run') return `${tm}  run ${ev.agent || ''}  $${(ev.cost || 0).toFixed(3)}`;
    if (ev.kind === 'session') return `${tm}  ${ev.agent || ''} started\n${ev.label || ''}`;
    return tm;
  }

  function onScrub(e) {
    const track = $('tt-track');
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const scrub = $('tt-scrub'); scrub.style.left = x + 'px'; scrub.style.opacity = 1;
    const W = win();
    const t = W.t0 + (x / W.w) * (W.t1 - W.t0);
    const span = (mins * 60000) * (16 / W.w);       // ~16px of slack around the cursor
    const near = (data.events || []).filter(ev => Math.abs(ev.t - t) <= span).sort((a, b) => b.t - a.t);
    const ago = Math.max(0, Math.round((W.t1 - t) / 1000));
    const when = ago < 90 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
    if (!near.length) { $('tt-readout').textContent = `${when} · (quiet)`; return; }
    const top = near[0];
    const more = near.length > 1 ? ` (+${near.length - 1})` : '';
    $('tt-readout').textContent = `${when} · ${labelOf(top)}${more}`;
  }
  function labelOf(ev) {
    if (ev.kind === 'msg') return `✉ ${ev.from || '?'}→${ev.to || '?'}: ${ev.label || ''}`;
    if (ev.kind === 'run') return `◷ ${ev.agent || ''} $${(ev.cost || 0).toFixed(3)}`;
    if (ev.kind === 'session') return `▸ ${ev.agent || ''} ${ev.label || ''}`;
    return ev.kind;
  }

  return { init, refresh, onCommit };
})();
