// A deferred required connection is a notice, never a second onboarding.
import { useStore } from "@/state/store";

export function StorageGate({ onSetup }: { onSetup: () => void }) {
  const { state } = useStore();
  if (!state.config?.storageGate?.required || state.config.storageGate.satisfied) return null;
  return (
    <aside aria-label="Finish workspace setup" className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-lg flex-wrap items-center gap-3 rounded-2xl border border-hairline bg-card p-4 text-ink shadow-xl">
      <p className="min-w-0 flex-1 text-sm">Connect Google Drive before creating or sending work. You can still look around.</p>
      <button type="button" onClick={onSetup} className="min-h-11 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white">Continue setup</button>
    </aside>
  );
}
