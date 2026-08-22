// Providers settings panel — a comprehensive list of API key fields for
// major AI/cloud providers, following OmniRoute's model. Each row saves
// a provider key to ~/.muster/config.json; configured-or-not flags are
// reported via GET /api/config.
import { useEffect, useState } from "react";
import { Check, CircleHelp, ExternalLink, Loader2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";

interface ProviderMeta {
  id: string;
  label: string;
  placeholder: string;
  description: string;
  href: string;
  linkLabel: string;
  configured?: boolean;
}

function ProviderRow({ provider }: { provider: ProviderMeta }) {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const configured = state.config?.providers?.[provider.id]?.configured ?? provider.configured ?? false;
  const clearing = !value.trim() && configured;

  const save = () => {
    if (saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    // Cloud deployments route provider keys into the signed-in user's own
    // encrypted vault (/api/user-keys) — your DeepSeek key powers only your
    // bots. Self-host keeps the single shared config path.
    api("/api/user-keys", {
      method: value.trim() ? "PUT" : "DELETE",
      body: JSON.stringify({ providerId: provider.configKey, apiKey: value.trim() }),
    }).catch(() =>
      // Vault endpoint absent (older server / desktop build) — fall back to
      // the global config path.
      api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ providers: { [provider.id]: { apiKey: value.trim() } } }),
      })
    )
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setValue("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="rounded-xl border border-hairline/40 bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span className="text-[13px] font-medium text-ink">{provider.label}</span>
        {configured && <span className="text-[11px] text-success">Connected</span>}
        <div className="relative ml-auto">
          <button
            type="button"
            aria-label={`About ${provider.label}`}
            onClick={() => setHelpOpen((o) => !o)}
            className="flex size-6 items-center justify-center rounded-md text-ink-secondary outline-none transition-colors hover:bg-raised hover:text-ink"
          >
            <CircleHelp size={14} />
          </button>
          {helpOpen && (
            <div className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[260px] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl">
              <div className="text-[12px] leading-[1.45] text-ink-secondary">{provider.description}</div>
              <a
                href={provider.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setHelpOpen(false)}
                className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
              >
                {provider.linkLabel}
                <ExternalLink size={12} />
              </a>
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={configured ? "••••••••  (paste to replace)" : provider.placeholder}
          aria-label={`${provider.label} API key`}
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || (!value.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            clearing
              ? "bg-raised text-danger hover:bg-raised-hover"
              : "bg-raised text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={clearing ? "Remove the saved key" : "Save"}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? "Clear" : <><Check size={13} />Save</>}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

export function ProvidersSection() {
  const [providers, setProviders] = useState<ProviderMeta[]>([]);

  useEffect(() => {
    api("/api/providers")
      .then((data: { providers: ProviderMeta[] }) => setProviders(data.providers))
      .catch(() => {});
  }, []);

  if (!providers.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {providers.map((p) => (
        <ProviderRow key={p.id} provider={p} />
      ))}
    </div>
  );
}
