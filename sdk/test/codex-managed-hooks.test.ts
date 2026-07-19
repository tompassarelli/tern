import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  expectedManagedCodexHooks, validateManagedCodexRequirements,
} from "../src/providers/codex-managed-hooks";

function requirements(
  mutate?: (document: any) => void,
  managedDir = "/etc/codex/hooks",
): string {
  const document: any = {
    allow_managed_hooks_only: true,
    allow_remote_control: false,
    managed_hook_failure_mode: "block",
    features: { hooks: true },
    hooks: {
      managed_dir: managedDir,
      ...expectedManagedCodexHooks(managedDir),
    },
  };
  mutate?.(document);
  const lines = [
    `allow_managed_hooks_only = ${JSON.stringify(document.allow_managed_hooks_only)}`,
    `allow_remote_control = ${JSON.stringify(document.allow_remote_control)}`,
    `managed_hook_failure_mode = ${JSON.stringify(document.managed_hook_failure_mode)}`,
    ...Object.entries(document)
      .filter(([key]) => ![
        "allow_managed_hooks_only", "allow_remote_control", "managed_hook_failure_mode",
        "features", "hooks",
      ].includes(key))
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    "",
    "[features]",
    `hooks = ${document.features.hooks}`,
    ...Object.entries(document.features)
      .filter(([key]) => key !== "hooks")
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    "",
    "[hooks]",
    `managed_dir = ${JSON.stringify(document.hooks.managed_dir)}`,
  ];
  const canonicalEvents = [
    "SessionStart", "SubagentStart", "PreToolUse", "PostToolUse", "Stop",
  ];
  const events = [
    ...canonicalEvents,
    ...Object.keys(document.hooks)
      .filter((event) => event !== "managed_dir" && !canonicalEvents.includes(event)),
  ];
  for (const event of events) {
    for (const group of document.hooks[event] ?? []) {
      lines.push("", `[[hooks.${event}]]`);
      if (group.matcher !== undefined) lines.push(`matcher = ${JSON.stringify(group.matcher)}`);
      for (const hook of group.hooks) {
        lines.push(
          "",
          `[[hooks.${event}.hooks]]`,
          `type = ${JSON.stringify(hook.type)}`,
          `command = ${JSON.stringify(hook.command)}`,
          `timeout = ${hook.timeout}`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

test("managed Codex requirements admit the exact full lifecycle policy", () => {
  expect(() => validateManagedCodexRequirements(requirements())).not.toThrow();
});

test("North's managed hook contract admits Firn's source requirements exactly", () => {
  const path = resolve(
    process.env.NORTH_FIRN_ROOT ?? resolve(import.meta.dir, "..", "..", "..", "nixos-config"),
    "modules", "codex", "requirements.toml",
  );
  expect(existsSync(path)).toBe(true);
  expect(() => validateManagedCodexRequirements(readFileSync(path, "utf8")))
    .not.toThrow();
});

test("managed Codex requirements reject every authority-bearing drift", () => {
  const hostile: Array<(document: any) => void> = [
    (document) => { document.allow_managed_hooks_only = false; },
    (document) => { document.allow_remote_control = true; },
    (document) => { document.managed_hook_failure_mode = "continue"; },
    (document) => { delete document.managed_hook_failure_mode; },
    (document) => { document.features.hooks = false; },
    (document) => { document.features.remote_control = false; },
    (document) => { document.unreviewed_root_authority = true; },
    (document) => { document.hooks.managed_dir = "/tmp/hooks"; },
    (document) => { document.hooks.PreToolUse[1].matcher = "^apply_patch$"; },
    (document) => {
      document.hooks.PreToolUse[1].hooks[2].command = "/etc/codex/hooks/north-clock-guard.sh";
    },
    (document) => { document.hooks.PreToolUse[1].hooks.pop(); },
    (document) => {
      document.hooks.PostToolUse.push({
        matcher: ".*",
        hooks: [{ type: "command", command: "/etc/codex/hooks/ambient", timeout: 10 }],
      });
    },
    (document) => { document.hooks.Stop[0].hooks[0].command = "/bin/true"; },
    (document) => {
      document.hooks.UserPromptSubmit = [{
        hooks: [{
          type: "command",
          command: "/etc/codex/hooks/ambient-user-prompt",
          timeout: 10,
        }],
      }];
    },
  ];
  for (const mutate of hostile)
    expect(() => validateManagedCodexRequirements(requirements(mutate))).toThrow();
});

test("managed-only in a non-requirements-like location cannot substitute for the root field", () => {
  const source = requirements().replace(
    "allow_managed_hooks_only = true\n",
    "",
  ).replace(
    "[hooks]\n",
    "[hooks]\nallow_managed_hooks_only = true\n",
  );
  expect(() => validateManagedCodexRequirements(source))
    .toThrow();
});

test("remote-control denial is root-only, present, and type-exact", () => {
  const exact = requirements();
  for (const source of [
    exact.replace("allow_remote_control = false\n", ""),
    exact.replace("allow_remote_control = false", "allow_remote_control = true"),
    exact.replace("allow_remote_control = false", 'allow_remote_control = "false"'),
    exact.replace(
      "allow_remote_control = false\n",
      "",
    ).replace(
      "[hooks]\n",
      "[hooks]\nallow_remote_control = false\n",
    ),
  ]) {
    expect(() => validateManagedCodexRequirements(source)).toThrow();
  }
});
