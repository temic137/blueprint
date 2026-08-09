"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type ProviderStatus = {
  estimate: { calls: number; tokens: number };
  groqQuota: { remainingRequests?: number; remainingTokens?: number; resetTokens?: string };
  providers: { groq: { configured: boolean }; cloudflare?: { configured: boolean } };
  registry: { total: number; validated: number; genericFamilies: number; datasheetDerived: number; visualOnly: number; errors: number; sources: { manifests: number; wokwi: number; schematicSymbols: number } };
};
type RecentProject = { id: string; title: string; summary: string; components: number; revision: number; updatedAt: string };
type ClarifyPackage = { id: string; label: string; recommended?: boolean; resolvedPrompt: string };
type ClarifyState = {
  understanding: string;
  questions: string[];
  packages: ClarifyPackage[];
};

const examples = [
  "Build a hands-free doorbell",
  "Build an ultrasonic parking sensor",
  "Show temperature on an OLED",
];

export default function Home() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<"idle" | "clarifying" | "building">("idle");
  const [clarify, setClarify] = useState<ClarifyState | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<string>("");
  const [error, setError] = useState("");
  const [faultCode, setFaultCode] = useState<"FAULT" | "TOO_COMPLEX" | "OUT_OF_KIT">("FAULT");
  const [providers, setProviders] = useState<ProviderStatus>();
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [recentState, setRecentState] = useState<"loading" | "ready" | "error">("loading");
  const abortRef = useRef<AbortController | null>(null);
  const refreshProviders = useCallback(() => { fetch("/api/providers").then((response) => response.json()).then(setProviders).catch(() => undefined); }, []);
  const refreshRecent = useCallback(() => { setRecentState("loading"); fetch("/api/projects").then(async (response) => { const result = await response.json() as { projects?: RecentProject[]; error?: string }; if (!response.ok) throw new Error(result.error); setRecent(result.projects || []); setRecentState("ready"); }).catch(() => setRecentState("error")); }, []);

  useEffect(() => { refreshProviders(); refreshRecent(); }, [refreshProviders, refreshRecent]);

  async function buildWithPrompt(resolvedPrompt: string) {
    setPhase("building");
    setLoading(true);
    setError("");
    abortRef.current = new AbortController();
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, resolvedPrompt }),
      signal: abortRef.current.signal,
    });
    const result = await response.json() as { id?: string; error?: string; code?: string };
    if (!response.ok || !result.id) throw Object.assign(new Error(result.error || "Generation failed."), { code: result.code });
    router.push(`/projects/${result.id}`);
  }

  async function startFlow(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setClarify(null);
    setSelectedPackage("");
    setFaultCode("FAULT");
    setPhase("clarifying");
    try {
      abortRef.current = new AbortController();
      const response = await fetch("/api/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: abortRef.current.signal,
      });
      const result = await response.json() as {
        status?: "READY_TO_BUILD" | "NEEDS_CLARIFICATION";
        prompt?: string;
        understanding?: string;
        questions?: string[];
        packages?: ClarifyPackage[];
        error?: string;
        code?: string;
      };
      if (!response.ok) throw Object.assign(new Error(result.error || "Could not review the brief."), { code: result.code });

      if (result.status === "READY_TO_BUILD") {
        await buildWithPrompt(result.prompt || prompt);
        return;
      }

      if (result.status === "NEEDS_CLARIFICATION" && result.packages?.length) {
        const recommended = result.packages.find((item) => item.recommended)?.id || result.packages[0]!.id;
        setClarify({
          understanding: result.understanding || "A few quick questions before wiring.",
          questions: result.questions || [],
          packages: result.packages,
        });
        setSelectedPackage(recommended);
        setPhase("idle");
        setLoading(false);
        return;
      }

      throw new Error("Clarify returned an unexpected response.");
    } catch (reason) {
      if ((reason as Error)?.name !== "AbortError") {
        const code = (reason as { code?: string })?.code;
        setError(reason instanceof Error ? reason.message : "Generation failed.");
        setFaultCode(code === "TOO_COMPLEX" || code === "OUT_OF_KIT" ? code : "FAULT");
      }
      setPhase("idle");
      setLoading(false);
      refreshProviders();
    } finally {
      abortRef.current = null;
    }
  }

  async function confirmAndBuild() {
    if (!clarify || !selectedPackage) return;
    const chosen = clarify.packages.find((item) => item.id === selectedPackage) || clarify.packages[0];
    if (!chosen) return;
    try {
      await buildWithPrompt(chosen.resolvedPrompt);
    } catch (reason) {
      if ((reason as Error)?.name !== "AbortError") {
        const code = (reason as { code?: string })?.code;
        setError(reason instanceof Error ? reason.message : "Generation failed.");
        setFaultCode(code === "TOO_COMPLEX" || code === "OUT_OF_KIT" ? code : "FAULT");
      }
      setPhase("idle");
      setLoading(false);
      refreshProviders();
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <main className="shell blueprint-shell">
      <nav className="nav">
        <a className="brand" href="/"><span className="brand-mark">BP</span><span>Blueprint<small>Engineering workspace</small></span></a>
        <a className="nav-link" href="#recent-title">Recent projects</a>
      </nav>
      <section className="hero">
        <h1>What will you build?</h1>
        <p className="hero-copy">Describe your idea. Blueprint will choose the parts, draw the circuit, and create the firmware and build instructions.</p>
        <form className="prompt-box" onSubmit={(event) => { void startFlow(event); }}>
          <label className="prompt-label" htmlFor="project-brief">Describe your project</label>
          <textarea
            id="project-brief"
            aria-label="Describe your hardware project"
            placeholder="Example: Build a hands-free doorbell…"
            value={prompt}
            onChange={(event) => { setPrompt(event.target.value); setClarify(null); }}
            minLength={10}
            maxLength={1000}
            required
            disabled={loading}
          />
          <div className="prompt-actions">
            <span className="prompt-hint">{prompt.length} / 1000</span>
            <button className="primary" disabled={loading || prompt.trim().length < 10}>
              {phase === "clarifying" ? "Reviewing…" : phase === "building" ? "Building…" : "Start project"}
            </button>
          </div>
        </form>

        {clarify && !loading && (
          <section className="clarify-panel" aria-label="Clarification before build">
            <div className="clarify-header">
              <strong>CLARIFY BEFORE BUILD</strong>
              <span>Pick one kit-safe option — Blueprint will not invent unsupported parts.</span>
            </div>
            <p className="clarify-understanding">{clarify.understanding}</p>
            {clarify.questions.length > 0 && (
              <ol className="clarify-questions">
                {clarify.questions.map((question) => <li key={question}>{question}</li>)}
              </ol>
            )}
            <div className="clarify-packages" role="radiogroup" aria-label="Implementation options">
              {clarify.packages.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={selectedPackage === item.id}
                  className={`clarify-option${selectedPackage === item.id ? " selected" : ""}${item.recommended ? " recommended" : ""}`}
                  onClick={() => setSelectedPackage(item.id)}
                >
                  <span className="clarify-option-mark">{selectedPackage === item.id ? "●" : "○"}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            <div className="clarify-actions">
              <button type="button" className="secondary" onClick={() => { setClarify(null); setSelectedPackage(""); }}>BACK TO BRIEF</button>
              <button type="button" className="primary" disabled={!selectedPackage} onClick={() => { void confirmAndBuild(); }}>
                BUILD THIS →
              </button>
            </div>
          </section>
        )}

        {error && <div className="error" role="alert"><strong>{faultCode === "TOO_COMPLEX" || faultCode === "OUT_OF_KIT" ? "CAN'T BUILD THIS" : "GENERATION FAULT"}</strong><span>{error}</span></div>}
        {loading && (
          <div className="generation-status" aria-live="polite">
            <div className="generation-track">
              <span className={phase === "clarifying" ? "active" : ""}>01 Clarify</span><i />
              <span className={phase === "building" ? "active" : ""}>02 Board + parts</span><i />
              <span>03 Wiring + firmware</span>
            </div>
            <button className="secondary" onClick={() => abortRef.current?.abort()}>CANCEL</button>
          </div>
        )}
        {providers && <details className="system-status">
          <summary>System status</summary>
          <div className="provider-strip" aria-label="AI provider status">
            <span><small>Estimated generation</small><strong>{providers.estimate.calls} calls / ~{(providers.estimate.tokens / 1000).toFixed(1)}K tokens</strong></span>
            <span><small>Groq</small><strong>{providers.providers.groq.configured ? "Ready" : "Offline"}</strong></span>
            <span title={`Wokwi: ${providers.registry.sources.wokwi} discovered · Symbols: ${providers.registry.sources.schematicSymbols} discovered · Manifests: ${providers.registry.sources.manifests}`}><small>Component library</small><strong>{providers.registry.total} searchable / {providers.registry.validated + providers.registry.genericFamilies + providers.registry.datasheetDerived} buildable</strong></span>
            {providers.groqQuota.remainingTokens !== undefined && <span><small>Remaining quota</small><strong>{providers.groqQuota.remainingTokens.toLocaleString()} tokens{providers.groqQuota.resetTokens ? ` / ${providers.groqQuota.resetTokens}` : ""}</strong></span>}
          </div>
        </details>}
        <div className="example-label">Try an example</div>
        <div className="examples">
          {examples.map((example) => <button type="button" className="chip" key={example} onClick={() => { setPrompt(example); setClarify(null); }}>{example}</button>)}
        </div>
        <section className="recent-projects" aria-labelledby="recent-title"><div className="recent-heading"><div><div className="example-label">Your projects</div><h2 id="recent-title">Recent projects</h2></div>{recentState === "error" && <button className="secondary" onClick={refreshRecent}>Retry</button>}</div>{recentState === "loading" && <div className="state-card">Loading recent projects…</div>}{recentState === "error" && <div className="state-card">Recent projects could not be loaded.</div>}{recentState === "ready" && !recent.length && <div className="state-card">Your generated projects will appear here.</div>}{recent.length > 0 && <div className="recent-grid">{recent.map((item) => <a href={`/projects/${item.id}`} className="recent-card" key={item.id}><small>REV {String(item.revision).padStart(2, "0")} · {item.components} COMPONENTS</small><strong>{item.title}</strong><span>{item.summary}</span><time dateTime={item.updatedAt}>{item.updatedAt.slice(0, 10)}</time></a>)}</div>}</section>
      </section>
    </main>
  );
}
