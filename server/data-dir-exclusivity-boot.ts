// Synchronous boot guard: refuse server startup while an exclusive restore
// holds or is crashed-in the data directory, before any writer (auth database,
// store, message database) is constructed. The refusal/recovery semantics live
// in ./data-dir-exclusivity.ts; this file only binds them to the real DATA_DIR
// at import time, exactly like ./drive-visible-startup-refusal.ts.
import { DATA_DIR } from "./data-root-path.ts";
import { assertNoLiveExclusiveRestoreClaim } from "./data-dir-exclusivity.ts";

assertNoLiveExclusiveRestoreClaim(DATA_DIR);
