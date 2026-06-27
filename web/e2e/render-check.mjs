// Headless render check — drives the system Chrome via puppeteer-core, loads the
// running app, waits for the async Cytoscape mount + agent roster, asserts the
// real post-JS DOM. Run: bun run render-check.mjs  (server must be on :4000)
//
// Self-QA harness so a human never has to eyeball "did it render".

import puppeteer from "puppeteer-core";
import net from "node:net";

const URL = process.env.URL || "http://localhost:4000";
const CHROME = process.env.CHROME || "/run/current-system/sw/bin/google-chrome-stable";

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
}

// One op per connection (the fram daemon is one-request-per-socket, except
// :subscribe). Open, send, read one line, close.
function op(port, line) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        sock.end();
        resolve(buf.split("\n")[0]);
      }
    });
    sock.on("error", () => resolve(null));
    sock.write(line + "\n");
    setTimeout(() => { try { sock.end(); } catch {} resolve(null); }, 4000);
  });
}

// Fire a real commit (OCC: version on one conn, assert with base on another) so
// the DaemonSubscriber broadcasts → the page should receive a live push.
async function commitProbe(port = 7978) {
  const vline = await op(port, "{:op :version}");
  const m = vline && vline.match(/:version\s+(\d+)/);
  if (!m) return false;
  const resp = await op(port, `{:op :assert :te "@_rtprobe" :p "ping" :r "${Date.now()}" :base ${m[1]}}`);
  return resp != null && resp.includes(":ok");
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });

  await page.goto(URL, { waitUntil: "networkidle2", timeout: 15000 });

  // panels render (SSR + hydrate)
  const panels = await page.$$eval('[data-testid="panel"]', (els) => els.length);
  check("two panels", panels === 2, `found ${panels}`);

  const body = await page.evaluate(() => document.body.innerText);
  check("pane titles", body.includes("work bench") && body.includes("agent chat"), "");

  // tailwind actually applied (everforest bg token resolved, not unstyled)
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("tailwind theme applied (everforest bg)", bg === "rgb(39, 46, 51)", bg);

  // agent picker (below cli) + chat area
  const picks = await page.$$eval('[data-testid="pick-row"]', (els) => els.length);
  check("picker rows", picks >= 0, `${picks} rows`);
  const sel = await page.$$eval('[data-sel="1"]', (els) => els.length);
  check("one selected pick", picks === 0 || sel === 1, `${sel} selected`);
  const chat = await page.$('[data-testid="chat"]');
  check("chat area present", chat !== null);

  // clicking a picker row swaps selection (if >1 agent)
  if (picks > 1) {
    const before = await page.$eval('[data-sel="1"]', (e) => e.textContent);
    await page.$$eval('[data-testid="pick-row"]', (els) => els[els.length - 1].click());
    await new Promise((r) => setTimeout(r, 400));
    const after = await page.$eval('[data-sel="1"]', (e) => e.textContent);
    check("click selects different agent", before !== after, "selection moved");
  }

  // Default view is Board (kanban): lanes render server-side, no #cy yet.
  const lanes = await page.$$eval('[data-testid="kanban"] > div', (els) => els.length);
  check("kanban lanes (board default)", lanes === 4, `${lanes} lanes`);
  const toggle = await page.$('[data-testid="view-toggle"]');
  check("view toggle present", toggle !== null);

  // Toggle to Graph → Cytoscape mounts (injects <canvas> layers into #cy).
  let canvases = 0;
  if (toggle) {
    await toggle.click();
    try {
      await page.waitForSelector("#cy canvas", { timeout: 8000 });
      canvases = await page.$$eval("#cy canvas", (els) => els.length);
    } catch (_) {}
  }
  check("graph view mounts cytoscape on toggle", canvases > 0, `${canvases} canvas layers`);

  // graph has nodes (cytoscape instance node count, via the global if exposed)
  const apiNodes = await page.evaluate(async () => {
    try {
      const d = await fetch("/api/dag").then((r) => r.json());
      return (d.nodes || []).length;
    } catch {
      return -1;
    }
  });
  check("/api/dag nodes", apiNodes > 0, `${apiNodes} nodes`);

  // Realtime push: fire a real daemon commit; the subscribed page should bump
  // its synced counter via the GenServer → PubSub → Hologram realtime path.
  // Settle first — realtime broadcasts are at-most-once (no replay), so the
  // client must finish subscribing before the commit fires.
  await new Promise((r) => setTimeout(r, 2500));
  const syncedBefore = await page.$eval('[data-testid="synced"]', (e) => e.textContent).catch(() => null);
  await commitProbe(7978);
  let syncedAfter = syncedBefore;
  for (let i = 0; i < 16 && syncedAfter === syncedBefore; i++) {
    await new Promise((r) => setTimeout(r, 300));
    syncedAfter = await page.$eval('[data-testid="synced"]', (e) => e.textContent).catch(() => null);
  }
  check("realtime push (synced bumps on daemon commit)", syncedBefore !== null && syncedAfter !== syncedBefore, `${syncedBefore} -> ${syncedAfter}`);

  check("no page JS errors", errors.length === 0, errors.slice(0, 3).join(" ;; "));

  const pass = checks.every((c) => c.ok);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  (" + c.detail + ")" : ""}`);
  console.log(pass ? "\n✅ ALL PASS" : "\n❌ FAILURES");
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
