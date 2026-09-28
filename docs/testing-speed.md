# Running the tests faster

The suite is **418 files / ~6,200 tests and about 12 minutes**. That run is the
biggest tax on shipping here, so this file records what was measured, what was
changed, and — more importantly — what was deliberately left alone.

## What the measurement says

One serial run, per-file timings:

| Bucket | Time | Share of the 12 min |
|---|---|---|
| Slowest 10 files | 223 s | **31%** |
| Slowest 25 files | 419 s | **58%** |
| Slowest 50 files | 601 s | **83%** |
| Everything else (368 files) | 120 s | 17% |

So the time is concentrated, not spread. 368 files cost less than the worst 25.

**Why those files are slow:** 53 `server/**/*.test.ts` files call `spawn(`, and
**44 spawn a real `node` child** running `server/index.ts` — 10,752 lines — under
`--experimental-strip-types`, so every boot re-strips a 10k-line file at runtime
with no build cache to amortise it. Two smaller taxes: `setupFiles` imports
SQLite for all 418 files whether they need it, and `waitForExit` defaults to a
5,000 ms grace plus a 2,000 ms SIGKILL follow-up, so teardown can cost 7 s.

## What changed: CI is sharded, four ways

`.github/workflows/ci.yml` splits the serial `test` job into `test-shard`
(1/4 … 4/4) and `test-integrations`. Measured on one shard locally: **108 files,
1674 tests, 231 s** — so four in parallel land near 4 minutes instead of 12.

`fileParallelism: false` is **untouched**. Every shard is still strictly serial,
so the determinism the suite has today is unchanged. Sharding is the runner
boundary, not a change in how tests share a machine. Balance is vitest's own, not
a hand-kept list, so a new slow file cannot silently unbalance it.

`fail-fast: false`, so one slow shard does not cancel the other three — you get
every failure at once instead of one and then a rerun.

## `pnpm test` is bigger than `vitest run`

Worth knowing before you quote a number. `pnpm test` is:

```
vitest run && broker:test && test:updater && test:desktop-lifecycle && test:packaged-server
```

and `test:packaged-server` runs `pnpm build:server` first. Those non-vitest steps
stay in one job in CI so the build happens once and a failure still reads as its
own named job.

## Running one shard locally

```bash
pnpm test:shard 1/4      # -> vitest run --shard 1/4
npx vitest run --shard=1/4   # identical; this is the form CI uses
```

Both were run and both report **108 files / 1674 tests** for shard 1 of 4.

## The fast inner loop — and why it is NOT a gate

```bash
pnpm test:related server/boot-order.ts src/components/RecoveryCard.tsx
```

`vitest related` walks the import graph and runs only the tests that reach those
files. For a narrow change that is **25 s against 720 s** — a 28× difference,
and it is the loop to actually use while working.

**It is a fast inner loop, not a pre-commit gate, and the reason is specific.**

`npx vitest related --run server/index.ts` reports:

```
No test files found, exiting with code 0
```

Zero tests. That is not a bug in the tool — it is the truth about this codebase.
No test file *imports* `server/index.ts`, because importing it starts a server.
The 44 integration tests that exercise it do so by **spawning it as a child
process**, which the import graph cannot see.

So a related-only gate would go green on a change to the most connected file in
the project while every integration test that depends on it silently did not run.
A gate that is wrong in the direction of passing is worse than no gate, so this
is documented as advisory and the full run stays the gate.

## Deliberately not changed

- **`fileParallelism`.** The comment claims parallel files flake. That is a
  load-bearing claim on a 12-minute tax and it has never been re-measured — and
  44 files each booting a real server is precisely the load that produces
  load-sensitive flakes, so the flakes may have been *caused* by the thing they
  are attributed to. That is falsifiable and worth re-testing deliberately, in
  its own change, with flake-rate data behind it. Not smuggled in beside a
  performance commit.
- **The 5 s teardown grace.** Shortening it trades teardown reliability for
  speed, and a leaked child process is a much worse failure than a slow one.
- **Making the SQLite setup file conditional.** It would need a per-file opt-in,
  and a file that forgets to opt in fails at import rather than at a test.

## One trap, recorded

I started a timing run and then reached for `vitest related` to check a script.
A second vitest against the same worktree would have skewed the measurement
*and* could have produced a spurious failure that looked like a real one. Stopped
and waited. Do not run two vitest processes against one checkout.
