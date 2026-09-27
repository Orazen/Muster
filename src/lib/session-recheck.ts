/** API authorization failures are not proof that the browser session expired.
 * AuthProvider owns the actual check; request callers only signal it. Capture
 * the current owner before a request so a retired account cannot refresh a
 * replacement provider, and coalesce a burst of rejected hydration calls. */
interface SessionRecheckOwner { check: () => Promise<void>; pending: Promise<void> | null }

export function createSessionRecheckCoordinator() {
  let owner: SessionRecheckOwner | null = null;
  return {
    register(check: () => Promise<void>): () => void {
      const registered: SessionRecheckOwner = { check, pending: null };
      owner = registered;
      return () => { if (owner === registered) owner = null; };
    },
    capture(): () => Promise<void> {
      const registered = owner;
      return () => {
        if (!registered || owner !== registered) return Promise.resolve();
        if (registered.pending) return registered.pending;
        const pending = Promise.resolve().then(() => {
          if (owner === registered) return registered.check();
        }).then(() => {}, () => {}).finally(() => {
          if (registered.pending === pending) registered.pending = null;
        });
        registered.pending = pending;
        return pending;
      };
    },
  };
}

export const sessionRecheck = createSessionRecheckCoordinator();
