// Providers settings panel — a comprehensive list of API key fields for
// major AI/cloud providers, following OmniRoute's model. Each row saves
// a provider key to ~/.muster/config.json; configured-or-not flags are
// reported via GET /api/config. Below the built-in keys sits the BYOK
// "Add model provider" form: any OpenAI- or Anthropic-compatible endpoint
// becomes a first-class instance in the model picker.
import { useEffect, useState } from "react";
import { Check, CircleHelp, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { ProviderFallbackPreference } from "./ProviderFallbackPreference";

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
  const { state, dispatch, refreshInstances } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

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
      body: JSON.stringify({ providerId: provider.id, apiKey: value.trim() }),
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
        // Vault save registers new instances server-side; refresh the
        // client's instance list so the model picker sees them immediately.
        void refreshInstances();
        setValue("");
        // Keys are write-only — nothing echoes back, so say plainly that the
        // save landed before the field goes quiet again.
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 4000);
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
        {justSaved && <span className="text-[11px] font-medium text-success">Saved ✓</span>}
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

  return (
    <div className="flex flex-col gap-2">
      <ProviderFallbackPreference />
      {providers.map((p) => (
        <ProviderRow key={p.id} provider={p} />
      ))}
      <CustomProvidersCard />
    </div>
  );
}

interface CustomProviderMeta {
  id: string;
  name: string;
  baseUrl: string;
  format: "openai" | "anthropic";
  models: string[];
  configured: boolean;
  instanceId: string;
}

/** BYOK "Add model provider" — any OpenAI- or Anthropic-compatible
 * endpoint becomes a first-class instance in the model picker. The form
 * mirrors the wire contract: name, base URL, key, wire format, and the
 * model list (fetched from the endpoint or entered by hand). */
function CustomProvidersCard() {
  const { refreshInstances } = useStore();
  const [list, setList] = useState<CustomProviderMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [format, setFormat] = useState<"openai" | "anthropic">("openai");
  const [models, setModels] = useState<string[]>([]);
  const [modelDraft, setModelDraft] = useState("");
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    api("/api/custom-providers")
      .then((data: { providers: CustomProviderMeta[] }) => {
        setList(data.providers);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const resetForm = () => {
    setName("");
    setBaseUrl("");
    setApiKey("");
    setModels([]);
    setModelDraft("");
    setError(null);
  };

  const addModelDraft = () => {
    const id = modelDraft.trim();
    if (!id || models.includes(id) || models.length >= 64) return;
    setModels((current) => [...current, id]);
    setModelDraft("");
  };

  const fetchModels = () => {
    if (!baseUrl.trim() || fetching) return;
    setFetching(true);
    setError(null);
    api("/api/custom-providers/fetch-models", {
      method: "POST",
      body: JSON.stringify({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined }),
    })
      .then((data: { models: string[] }) => {
        if (data.models.length === 0) {
          setError("The endpoint answered but listed no models — enter them manually below.");
          return;
        }
        setModels((current) => Array.from(new Set([...current, ...data.models])).slice(0, 64));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setFetching(false));
  };

  const save = () => {
    if (saving) return;
    setError(null);
    if (!name.trim() || !baseUrl.trim() || models.length === 0) {
      setError("Name, Base URL, and at least one model are required.");
      return;
    }
    setSaving(true);
    api("/api/custom-providers", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        format,
        models,
        apiKey: apiKey.trim() || undefined,
      }),
    })
      .then(() => {
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 4000);
        resetForm();
        setOpen(false);
        return Promise.all([
          api("/api/custom-providers").then((data: { providers: CustomProviderMeta[] }) => setList(data.providers)),
          // new instance lands in the model picker immediately
          refreshInstances(),
        ]);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const remove = (id: string) => {
    api(`/api/custom-providers/${id}`, { method: "DELETE" })
      .then(() =>
        Promise.all([
          api("/api/custom-providers").then((data: { providers: CustomProviderMeta[] }) => setList(data.providers)),
          refreshInstances(),
        ]),
      )
      .catch((e: Error) => setError(e.message));
  };

  const field = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  return (
    <div className="rounded-xl border border-hairline/40 bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-ink">Custom model providers</span>
        {justSaved && <span className="text-[11px] font-medium text-success">Saved ✓</span>}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover"
        >
          <Plus size={13} /> Add model provider
        </button>
      </div>

      {loaded && list.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {list.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-2">
              <span className={cn("size-1.5 rounded-full", p.configured ? "bg-success" : "bg-raised-hover")} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{p.name}</span>
              <span className="hidden shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-ink-secondary sm:inline">
                {p.format}
              </span>
              <span className="shrink-0 text-[11px] text-ink-secondary">{p.models.length} models</span>
              <button
                type="button"
                aria-label={`Remove ${p.name}`}
                onClick={() => remove(p.id)}
                className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="mt-3 flex flex-col gap-2.5 rounded-lg border border-hairline/40 bg-inset p-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name — e.g. DeepSeek" aria-label="Provider name" autoComplete="off" className={field} />
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" aria-label="Base URL" autoComplete="off" className={field} />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API key — leave empty for local servers (Ollama)"
            aria-label="API key"
            autoComplete="off"
            className={field}
          />
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value === "anthropic" ? "anthropic" : "openai")}
            aria-label="API format"
            className={field}
          >
            <option value="openai">OpenAI chat completions (/v1/chat/completions)</option>
            <option value="anthropic">Anthropic messages (/v1/messages)</option>
          </select>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-secondary">
                Model list {models.length > 0 && <span className="text-ink">({models.length})</span>}
              </span>
              <button
                type="button"
                onClick={fetchModels}
                disabled={fetching || !baseUrl.trim()}
                className="rounded-md bg-raised px-2 py-1 text-[11.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {fetching ? "Fetching…" : "Fetch models"}
              </button>
            </div>
            {models.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setModels((current) => current.filter((x) => x !== m))}
                    className="group flex items-center gap-1 rounded-md bg-raised px-2 py-1 font-mono text-[11.5px] text-ink"
                    title="Remove"
                  >
                    {m}
                    <span className="text-ink-secondary group-hover:text-danger">×</span>
                  </button>
                ))}
              </div>
            )}
            <input
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addModelDraft()}
              placeholder="Type a model id and press Enter — e.g. my-model-v1"
              aria-label="Add model"
              autoComplete="off"
              className={field}
            />
            {models.length === 0 && (
              <p className="mt-1 text-[11.5px] text-ink-secondary">Add at least one model before adding the provider.</p>
            )}
          </div>

          {error && <div className="text-[12px] text-danger">{error}</div>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-[13px] font-medium text-white disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : (
                <>
                  <Check size={13} />Add provider
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                resetForm();
              }}
              className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
