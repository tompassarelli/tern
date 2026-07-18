import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { subscribeFeed } from "../src/coordination";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  killed = false;

  kill() {
    this.killed = true;
    return true;
  }
}

test("subscription failures back off, delivered mail resets, and stop cancels rearm", () => {
  const children: FakeChild[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  const mail: string[] = [];
  let clock = 0;
  const stop = subscribeFeed("agent-test", (summary) => mail.push(summary), {
    spawn: (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as any,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer) => { (timer as (typeof scheduled)[number]).cancelled = true; },
    now: () => clock,
    initialBackoffMs: 100,
    maxBackoffMs: 1_000,
    healthyResetMs: 30_000,
  });

  expect(children).toHaveLength(1);
  children[0].emit("close", 1);
  expect(children).toHaveLength(1);
  expect(scheduled[0].delayMs).toBe(100);

  scheduled[0].callback();
  expect(children).toHaveLength(2);
  clock = 10;
  children[1].emit("close", 1);
  expect(scheduled[1].delayMs).toBe(200);

  scheduled[1].callback();
  children[2].stdout.emit("data", Buffer.from(
    "✉  MAIL @msg:test  (to agent-test)\n   from: peer\n   subject: update\n   body: done\n",
  ));
  children[2].emit("close", 0);
  expect(mail).toEqual(["[north real-time ping from peer — update]\ndone"]);
  expect(scheduled[2].delayMs).toBe(0);

  stop();
  expect(scheduled[2].cancelled).toBe(true);
  expect(children[2].killed).toBe(true);
});

test("subscription waits for stdout close and rearms when the mail callback throws", () => {
  const children: FakeChild[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const seen: string[] = [];
  const stop = subscribeFeed("agent-test", (summary) => {
    seen.push(summary);
    throw new Error("consumer rejected delivery");
  }, {
    spawn: (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as any,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs };
      scheduled.push(timer);
      return timer;
    },
    cancel: () => {},
    now: () => 0,
    initialBackoffMs: 100,
    maxBackoffMs: 1_000,
    healthyResetMs: 30_000,
  });

  children[0].emit("exit", 0);
  expect(seen).toEqual([]);
  expect(scheduled).toEqual([]);

  children[0].stdout.emit("data", Buffer.from(
    "✉  MAIL @msg:test  (to agent-test)\n   from: peer\n   subject: late\n   body: final chunk\n",
  ));
  children[0].emit("close", 0);
  expect(seen).toEqual(["[north real-time ping from peer — late]\nfinal chunk"]);
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0].delayMs).toBe(0);

  scheduled[0].callback();
  expect(children).toHaveLength(2);
  stop();
});

test("subscription kills oversized output, delivers no partial mail, and backs off", () => {
  const children: FakeChild[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const mail: string[] = [];
  const stop = subscribeFeed("agent-test", (summary) => mail.push(summary), {
    spawn: (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as any,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs };
      scheduled.push(timer);
      return timer;
    },
    cancel: () => {},
    now: () => 0,
    initialBackoffMs: 100,
    maxBackoffMs: 1_000,
    healthyResetMs: 30_000,
    maxOutputBytes: 32,
  });

  children[0].stdout.emit("data", Buffer.from(
    "from: peer\nsubject: forged\nbody: partial\n",
  ));
  expect(children[0].killed).toBe(true);
  children[0].emit("close", null, "SIGKILL");
  expect(mail).toEqual([]);
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0].delayMs).toBe(100);
  stop();
});
