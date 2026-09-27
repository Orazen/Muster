import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { ONBOARDING_ENGINES, onboardingEngine, readOnboardingProviders, saveOnboardingProvider } from "@/lib/onboarding-providers";
import { EngineSetup } from "./EngineSetup";

type ProviderSetup = Awaited<ReturnType<typeof readOnboardingProviders>>;
const button = "min-h-11 w-full whitespace-normal break-words rounded-lg bg-raised px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50";

export function OnboardingProviders({ instances, isDesktop }: { instances: InstanceInfo[] | null; isDesktop: boolean }) {
  const { state, dispatch, refreshInstances } = useStore();
  const [setup, setSetup] = useState<ProviderSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [providerId, setProviderId] = useState("openai");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    setSetup(null);
    void readOnboardingProviders(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSetup(result);
        setProviderId((current) => result.providers.some((provider) => provider.id === current) ? current : result.providers[0]?.id ?? "");
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError("Provider setup could not be checked. Try again, or open Providers settings.");
      });
    return () => controller.abort();
  }, [reload]);

  const provider = setup?.providers.find((candidate) => candidate.id === providerId);
  const configured = provider && state.config?.providers?.[provider.configKey]?.configured === true;
  const openProviders = () => dispatch({ type: "toggleAppSettings", open: true, section: "providers" });

  const checkAgain = async () => {
    if (checking) return;
    setChecking(true);
    try { await refreshInstances(); }
    finally { if (alive.current) setChecking(false); }
  };

  const save = async () => {
    if (savingRef.current || !provider || !setup?.destination || !key.trim()) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const config = await saveOnboardingProvider(setup.destination, provider, key, api);
      if (alive.current) {
        dispatch({ type: "configStatus", config });
        setKey("");
        setNotice(`${provider.label} key saved. It has not been tested with a model request.`);
      }
      await refreshInstances();
    } catch {
      if (alive.current) setSaveError("The key save could not be confirmed. Check provider status in Settings before trying again.");
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  };

  return (
    <div className="min-w-0 space-y-4">
      <section aria-label="AI account setup" className="min-w-0 space-y-2">
        <h2 className="text-[15px] font-semibold text-ink">Use an AI account</h2>
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">
          {isDesktop ? "Choose an installed engine, or follow its setup steps. Sign-in happens in the engine’s own flow." : "Claude, ChatGPT via Codex, and OpenCode can run through the desktop app. On the web, bring an API key below."}
        </p>
        <fieldset aria-label="Engine status" className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
          {instances === null ? <span className="text-[12px] text-ink-secondary">Checking for engines…</span>
            : instances.length === 0 ? <span className="text-[12px] text-ink-secondary">No engine detected yet</span>
              : instances.map((instance) => <span key={instance.instanceId} className="max-w-full break-words rounded-lg bg-raised px-2 py-1 text-[12px] text-ink">
                {instance.displayName} · {instance.snapshot.authenticated === false ? "Needs sign-in" : instance.snapshot.state === "available" ? "Available" : "Needs setup"}
              </span>)}
        </fieldset>
        {ONBOARDING_ENGINES.map((choice) => {
          const instance = onboardingEngine(instances, choice.driverKind);
          const ready = instance?.snapshot.state === "available" && instance.snapshot.authenticated === true;
          const platform = isDesktop ? window.ogb?.platform : undefined;
          const matchingHost = !instance?.hostPlatform || !platform || instance.hostPlatform === platform;
          // The existing Codex descriptor links to GitHub. New onboarding
          // must not expose repository URLs as product-facing setup links.
          const safeInstance = instance && instance.install?.docsUrl?.includes("github.com")
            ? { ...instance, install: { ...instance.install, docsUrl: undefined } } : instance;
          return (
            <div key={choice.driverKind} className="min-w-0 rounded-xl border border-hairline/40 bg-card p-3">
              <h3 className="flex items-center gap-2 text-[13px] font-medium text-ink">{ready && isDesktop && <Check size={14} className="shrink-0 text-success" />}{choice.label}</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{choice.detail}</p>
              {isDesktop && (instances === null ? <p className="mt-2 text-[12px] text-ink-secondary">Checking this installation…</p>
                : !instance ? <p className="mt-2 text-[12px] text-ink-secondary">This engine is not offered by the current installation.</p>
                  : !matchingHost ? <p className="mt-2 text-[12px] text-ink-secondary">This engine runs on another machine. Set it up on that host, or use a provider key.</p>
                    : ready ? <p className="mt-2 text-[12px] text-success">Installed and signed in.</p>
                      : instance.snapshot.state === "available" && instance.snapshot.authenticated === undefined
                        ? <p className="mt-2 text-[12px] text-ink-secondary">Installed. Account status has not been reported.</p>
                        : safeInstance && <EngineSetup instance={safeInstance} className="mt-2" />)}
            </div>
          );
        })}
        {isDesktop ? <button type="button" onClick={() => void checkAgain()} disabled={checking} className={button}>{checking ? "Checking engines…" : "Check engines again"}</button>
          : <a href="https://muster.today/download.html" target="_blank" rel="noopener noreferrer" className={`${button} block text-center`}>Download Muster desktop</a>}
        {isDesktop && <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })} className={button}>Other engines and accounts</button>}
      </section>

      <section aria-label="Bring your own API key" className="min-w-0 space-y-2 rounded-xl border border-hairline/40 bg-card p-3">
        <h2 className="text-[15px] font-semibold text-ink">Bring your own API key</h2>
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">API usage is billed by your provider, separately from a chat subscription. Connecting AI does not grant Gmail or Drive access.</p>
        {!setup && !loadError && <p role="status" className="text-[12px] text-ink-secondary">Checking key setup…</p>}
        {loadError && <><p role="alert" className="text-[12px] text-danger">{loadError}</p><button type="button" className={button} onClick={() => setReload((value) => value + 1)}>Retry provider check</button></>}
        {setup?.destination && provider ? (
          <form className="min-w-0 space-y-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label className="block text-[12px] text-ink-secondary" htmlFor="onboarding-ai-provider">AI provider</label>
            <select id="onboarding-ai-provider" value={providerId} disabled={saving} onChange={(event) => { setProviderId(event.target.value); setKey(""); setNotice(null); setSaveError(null); }} className="block w-full min-w-0 max-w-full rounded-lg border border-hairline/40 bg-inset px-2 py-2 text-[13px] text-ink">
              {setup.providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
            {configured && <p className="text-[12px] text-success">A key is already saved. Enter a new key only to replace it.</p>}
            <label className="block text-[12px] text-ink-secondary" htmlFor="onboarding-ai-key">{provider.label} API key</label>
            <input id="onboarding-ai-key" type="password" autoComplete="off" spellCheck={false} value={key} disabled={saving} placeholder={provider.placeholder} onChange={(event) => setKey(event.target.value)} className="block w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink" />
            <button type="submit" disabled={saving || !key.trim()} className={`${button} flex items-center justify-center gap-2`}>{saving && <Loader2 size={13} className="shrink-0 animate-spin" />}{saving ? "Saving key…" : "Save provider key"}</button>
          </form>
        ) : setup && <p className="text-[12px] leading-relaxed text-ink-secondary">Use Providers settings to add a key for this installation.</p>}
        {notice && <p role="status" className="break-words text-[12px] text-success">{notice}</p>}
        {saveError && <p role="alert" className="break-words text-[12px] text-danger">{saveError}</p>}
        <button type="button" onClick={openProviders} className={button}>Add a provider key</button>
        <p className="text-[11.5px] leading-relaxed text-ink-secondary">Providers settings also supports custom API endpoints and model lists.</p>
      </section>
    </div>
  );
}
