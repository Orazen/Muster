// Test-only preload for spawned fixture servers: while the arm file named by
// OMB_TEST_SQL_BREAKER_FILE holds a positive integer budget, the first
// `budget` executions of SQL statements matching
// OMB_TEST_SQL_BREAKER_PATTERN (default: the session delete inside
// better-auth's revokeUnprovenAccountAccess) throw, so a suite can
// reproduce PARTIAL cleanup states that no HTTP-level fixture can reach.
// The budget is re-read on every statement execution, so writing "0" (or
// deleting the file) disarms even already-prepared statements. Without the
// env var this module is inert, and no production entry point ever imports
// it.
const armFile = process.env.OMB_TEST_SQL_BREAKER_FILE ?? "";
if (armFile) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const pattern = new RegExp(process.env.OMB_TEST_SQL_BREAKER_PATTERN ?? 'DELETE FROM "session"', "i");
  const readBudget = () => {
    try {
      return Number.parseInt(readFileSync(armFile, "utf8").trim(), 10) || 0;
    } catch {
      return 0;
    }
  };
  const { DatabaseSync } = await import("node:sqlite");
  const originalPrepare = DatabaseSync.prototype.prepare;

  /** Named seam between the real driver and the breaker so the patched
   * prototype entry stays a typed function call, not dynamic dispatch. */
  function prepareMaybeBreaking(db, sql, ...rest) {
    const statement = originalPrepare.call(db, sql, ...rest);
    if (!pattern.test(sql)) return statement;
    // A plain delegation object, NOT a prototype-chain wrapper: node:sqlite's
    // native methods reject any receiver that is not the real statement
    // instance ("Illegal invocation"), so every method the Kysely node-sqlite
    // driver touches (columns to pick all-vs-run, then run/all/get/iterate)
    // must be invoked ON the real statement.
    const failing = {
      columns: () => statement.columns(),
      all: (...args) => statement.all(...args),
      get: (...args) => statement.get(...args),
      iterate: (...args) => statement.iterate(...args),
      run: (...args) => {
        const budget = readBudget();
        if (budget <= 0) return statement.run(...args);
        try {
          writeFileSync(armFile, String(budget - 1));
        } catch {
          // Losing the decrement only risks one extra simulated failure.
        }
        throw new Error(`OMB_TEST_SQL_BREAKER: simulated failure for ${sql}`);
      },
    };
    return failing;
  }

  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    return prepareMaybeBreaking(this, sql, ...rest);
  };
}
