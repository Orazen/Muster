# Verified delivery — how a change earns the word "shipped"

The owner rule: **always commit, then wait and check for success, and verify the
commit actually pushed.** A push is not a receipt. This file is the procedure
that turns a local edit into a verified change, and the failure modes it exists
to prevent.

Work one slice at a time. A slice is not done until its typecheck, its touched
tests and its lint are green **and** CI has finished on the pushed commit.

## The loop

1. **Scope before you touch anything.** `git status --short` and
   `git diff --stat`. Any edit you did not make belongs to another agent until
   proven otherwise — establish its origin before it can end up in your commit.
2. **Read the map, not the tree.** `docs/plans/astra-gpt6-mvp-brief.md`, the
   current-state doc, the stability contract, and the **last** ledger entry in
   `docs/plans/ceo-log.md`. Check whether the work is already shipped before
   re-implementing it. Historical counts in the orientation hub are stale; the
   ledger tail is the authority.
3. **Verify before committing.** In order: `npx tsc --noEmit -p tsconfig.server.json`,
   `npx vitest run <touched files>`, `npm run lint`.
4. **Commit the slice, not the tree.** Stage the paths you changed. Review the
   staged diff. Pathless commit message.
5. **Push, then stop and wait.** Do not report the work as done here.
6. **Watch CI to a terminal state** on the exact SHA you pushed:
   `gh run watch <run-id> --exit-status`. Find the run with
   `gh run list --commit <sha>`.
7. **Report the real numbers**, and compare them to the latest accepted
   baseline. Any decrease is called out explicitly, never smoothed over.

## Why each step is load-bearing

**Never "commit and assume."** A commit that was never pushed does not exist
for anyone else, and a push that failed CI does not exist as a working build.
Both failures are silent from the author's machine, which is exactly why the
watch step is mandatory rather than advisory.

**CI is the authority, not the local run.** A local suite proves the code
compiles and the touched behavior holds. CI proves it on a clean checkout with
a frozen lockfile, on hardware that is not simultaneously running someone
else's suite. When the two disagree, CI decides.

**One claimant per file at a time.** Two agents editing the same file produce
work neither can attribute. If a file you need is dirty, it is in use — pick a
different region, or wait. Surgical edits in disjoint regions, committed
promptly, are what let parallel work stay parallel.

## The failure modes this prevents

### A failed local run caused by load, not by logic

The suites boot real servers with wall-clock startup deadlines and open real
sockets. On a machine that is oversubscribed, a 20-second boot deadline is
missed and a socket is reset under an in-flight request — failures that look
exactly like a logic bug and are not one.

Check before believing a local failure:

```bash
uptime                                   # load average
ps aux | grep -E "vitest|typescript@"   # competing suites/typechecks
```

A load average in the hundreds means the result is about the machine, not the
code. Re-run when it settles, or defer to CI — but never "fix" code to satisfy
a run that the machine, not the change, broke.

### Invalidating an in-flight run

Editing a shared setup file, or any file an in-flight suite already imported,
invalidates that run's numbers. A run that saw a half-applied change reports
failures that belong to neither state. Let a run finish before touching
anything it depends on.

### Sweeping another agent's work into your commit

`git add -A` under concurrent work commits other people's unverified edits
under your message, and their breakage then lands in your CI run. Stage the
paths you changed. If you find an unexpected edit, establish its origin before
including it — never sweep it in on the assumption that it was fine.

### Concluding from a stale baseline

Test counts only mean something relative to a baseline. Read the newest ledger
entry, not the count quoted in an older doc or in the orientation hub. Report
the delta every time.

## Reporting template

State the outcome first, then the evidence:

- What changed, in one sentence.
- The verification actually run, with real numbers: typecheck, touched tests,
  lint, and the CI run id with its conclusion.
- The baseline compared against, and whether the count rose or fell.
- Anything skipped or still open, named plainly.

Honest reporting over optimism. If something failed, show the output and say
so.
