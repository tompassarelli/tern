import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiProvider } from "../src/providers/openai";
import { ProviderRetrySafeError } from "../src/providers";

const savedBin = process.env.NORTH_CODEX_BIN;
const temporary: string[] = [];
afterEach(() => {
  if (savedBin === undefined) delete process.env.NORTH_CODEX_BIN;
  else process.env.NORTH_CODEX_BIN = savedBin;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("Codex error events terminate and reap the child before propagating", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-child-"));
  temporary.push(directory);
  const command = join(directory, "fake-codex");
  const terminated = join(directory, "terminated");
  writeFileSync(command, `#!/usr/bin/env bash
trap 'printf terminated > "${terminated}"; exit 0' TERM
printf '%s\\n' '{"type":"error","message":"capacity unavailable after request acceptance"}'
while true; do :; done
`);
  chmodSync(command, 0o700);
  process.env.NORTH_CODEX_BIN = command;
  const query = openaiProvider.query({ prompt: "x", options: {} as any });
  await expect(async () => { for await (const _ of query as AsyncIterable<any>) {} })
    .toThrow("capacity unavailable after request acceptance");
  expect(existsSync(terminated)).toBe(true);
  expect(readFileSync(terminated, "utf8")).toBe("terminated");
});

test("Codex pre-acceptance process rejection is explicitly retry-safe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-reject-"));
  temporary.push(directory);
  const command = join(directory, "fake-codex");
  writeFileSync(command, "#!/usr/bin/env bash\nprintf 'not authenticated' >&2\nexit 2\n");
  chmodSync(command, 0o700);
  process.env.NORTH_CODEX_BIN = command;
  const query = openaiProvider.query({ prompt: "x", options: {} as any });
  let caught: unknown;
  try { for await (const _ of query as AsyncIterable<any>) {} }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ProviderRetrySafeError);
  expect((caught as Error).message).toContain("not authenticated");
});

test("a genuinely missing Codex executable is handled and retry-safe", async () => {
  process.env.NORTH_CODEX_BIN = join(tmpdir(), `north-no-such-codex-${process.pid}`);
  const query = openaiProvider.query({ prompt: "x", options: {} as any });
  let caught: unknown;
  try { for await (const _ of query as AsyncIterable<any>) {} }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ProviderRetrySafeError);
  expect((caught as Error).message).toContain("ENOENT");
});
