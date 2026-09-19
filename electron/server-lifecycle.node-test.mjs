import assert from "node:assert/strict";
import test from "node:test";
import { createServerLifecycle } from "./server-lifecycle.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(start) {
  const calls = [];
  const stopped = [];
  const states = [];
  const controller = createServerLifecycle({
    start: async (port, exit, signal) => {
      const call = { port, exit, signal, child: { pid: calls.length + 1 } };
      calls.push(call);
      return start ? start(call) : call.child;
    },
    stop: (child) => { stopped.push(child); calls.find((call) => call.child === child)?.exit(0); },
    onState: (state) => states.push(state),
  });
  return { controller, calls, stopped, states };
}
for (const code of [0, 1]) test(`owned running exit ${code} stops without automatic restart`, async () => {
  const f = fixture();
  await f.controller.start([20001, 20002]);
  f.calls[0].exit(code);
  assert.equal(f.controller.snapshot().phase, "stopped");
  assert.equal(f.controller.snapshot().exitCode, code);
  assert.equal(f.controller.snapshot().child, null);
  assert.equal(f.calls.length, 1);
});
test("quit invalidates before intentional child exit and cannot retry", async () => {
  const f = fixture();
  await f.controller.start([20001]);
  f.controller.quit();
  await f.controller.retry();
  assert.equal(f.controller.snapshot().phase, "quitting");
  assert.deepEqual(f.stopped, [f.calls[0].child]);
  assert.equal(f.states.filter((state) => state.phase === "stopped").length, 0);
  assert.equal(f.calls.length, 1);
});
test("retired child exit cannot stop replacement and retry keeps original origin", async () => {
  const f = fixture();
  await f.controller.start([20001, 20002]);
  f.calls[0].exit(1);
  await f.controller.retry();
  f.calls[0].exit(1);
  assert.equal(f.controller.snapshot().child, f.calls[1].child);
  assert.equal(f.controller.snapshot().phase, "running");
  assert.deepEqual(f.calls.map((call) => call.port), [20001, 20001]);
});
test("concurrent retry shares one start operation", async () => {
  const gate = deferred();
  let count = 0;
  const f = fixture(async (call) => ++count === 1 ? call.child : gate.promise);
  await f.controller.start([20001]);
  f.calls[0].exit(1);
  const first = f.controller.retry();
  const second = f.controller.retry();
  assert.equal(first, second);
  await Promise.resolve();
  gate.resolve(f.calls[1].child);
  await first;
  assert.equal(f.calls.length, 2);
});
test("exit during readiness never adopts a dead child", async () => {
  const f = fixture((call) => { call.exit(0); return call.child; });
  await f.controller.start([20001]);
  assert.equal(f.controller.snapshot().phase, "stopped");
  assert.equal(f.states.some((state) => state.phase === "running"), false);
});
test("quit while readiness awaits aborts and disposes late owned child", async () => {
  const gate = deferred();
  const f = fixture(() => gate.promise);
  const result = f.controller.start([20001, 20002]);
  await Promise.resolve();
  f.controller.quit();
  assert.equal(f.calls[0].signal.aborted, true);
  gate.resolve(f.calls[0].child);
  await result;
  assert.equal(f.controller.snapshot().phase, "quitting");
  assert.deepEqual(f.stopped, [f.calls[0].child]);
  assert.equal(f.calls.length, 1);
});
test("rejected foreign listener is never adopted or stopped; explicit retry uses first initial port", async () => {
  const f = fixture(() => null);
  await f.controller.start([20001, 20002]);
  assert.equal(f.controller.snapshot().phase, "stopped");
  await f.controller.retry();
  assert.deepEqual(f.calls.map((call) => call.port), [20001, 20002, 20001]);
  assert.deepEqual(f.stopped, []);
});
test("initial fallback binds successful port for all subsequent retries", async () => {
  const f = fixture((call) => call.port === 20001 ? null : call.child);
  await f.controller.start([20001, 20002]);
  f.calls[1].exit(1);
  await f.controller.start([20003]);
  assert.deepEqual(f.calls.map((call) => call.port), [20001, 20002, 20002]);
});
test("quit before queued startup never spawns a child", async () => {
  const f = fixture();
  const result = f.controller.start([20001]);
  f.controller.quit();
  await result;
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.snapshot().phase, "quitting");
});
test("failed initial probe exit cannot stop the selected alternate", async () => {
  const f = fixture((call) => {
    if (call.port === 20001) throw new Error("owned startup failed");
    return call.child;
  });
  await f.controller.start([20001, 20002]);
  f.calls[0].exit(1);
  assert.equal(f.controller.snapshot().phase, "running");
  assert.equal(f.controller.snapshot().child, f.calls[1].child);
  assert.equal(f.controller.snapshot().port, 20002);
});
test("renderer requests require a verified running child and stop immediately on exit or quit", async () => {
  const gate = deferred();
  let first = true;
  const f = fixture((call) => {
    if (first) { first = false; return gate.promise; }
    return call.child;
  });
  const url = "http://127.0.0.1:20001/api/events";
  assert.equal(f.controller.allowsRequest(url), false);
  const starting = f.controller.start([20001]);
  await Promise.resolve();
  assert.equal(f.controller.allowsRequest(url), false);
  gate.resolve(f.calls[0].child);
  await starting;
  assert.equal(f.controller.allowsRequest(url), true);
  f.calls[0].exit(0);
  assert.equal(f.controller.allowsRequest(url), false);
  const retry = f.controller.retry();
  assert.equal(f.controller.allowsRequest(url), false);
  await retry;
  assert.equal(f.controller.allowsRequest(url), true);
  f.controller.quit();
  assert.equal(f.controller.allowsRequest(url), false);
});
test("running renderer only reaches the selected origin without URL credentials", async () => {
  const f = fixture();
  await f.controller.start([20001]);
  assert.equal(f.controller.allowsRequest("http://127.0.0.1:20001/app?view=settings#account"), true);
  for (const url of [
    "http://127.0.0.1:20002/api/events", "http://localhost:20001/api/events",
    "https://127.0.0.1:20001/api/events", "http://127.0.0.1.evil.example:20001/",
    "http://alice@127.0.0.1:20001/", "http://:secret@127.0.0.1:20001/",
    "file:///app", "data:text/html,hello", "/api/events", "not a URL",
  ]) assert.equal(f.controller.allowsRequest(url), false, url);
});
test("a foreign replacement rejected on explicit retry cannot receive renderer requests", async () => {
  let foreign = false;
  const f = fixture((call) => foreign ? null : call.child);
  await f.controller.start([20001]);
  f.calls[0].exit(1);
  foreign = true;
  await f.controller.retry();
  assert.equal(f.controller.allowsRequest("http://127.0.0.1:20001/api/events"), false);
  assert.equal(f.controller.allowsRequest("http://127.0.0.1:20002/api/events"), false);
  assert.deepEqual(f.stopped, []);
});
