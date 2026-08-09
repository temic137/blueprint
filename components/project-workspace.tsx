"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assemblySteps, billOfMaterials, componentReferences, COMPONENTS, humanizeProjectText, pinAssignments, projectOwnerLabels, schematicLayout, type ProjectSpec, wireLane } from "@/lib/project";

const tabs = ["Overview", "Schematic", "BOM", "Pins", "Assembly", "Firmware", "Changes"] as const;
type Tab = typeof tabs[number];

type PinPoint = { x: number; y: number };
type DrawnWire = { from: PinPoint; to: PinPoint; routeX: number; color: string; key: string; index: number };
type ChangeImpact = {
  summary: string; understanding: string; scope: "firmware" | "hardware" | "project"; risk: "low" | "medium" | "high"; warnings: string[];
  components: { added: string[]; removed: string[]; changed: string[] };
  wiringChanges: number; firmwareChanged: boolean;
};
type Revision = { revision: number; request: string; summary: string; createdAt: string; details?: { components: { added: string[]; removed: string[]; changed: string[] }; wiringChanges: number; firmwareChanged: boolean } };
type AssistantChatMessage = {
  id: string; role: "user" | "assistant"; kind: string; content: string; createdAt: string;
  metadata: null | { previewId?: string; impact?: ChangeImpact; result?: { title: string; components: number; connections: number }; revision?: number };
};

function downloadFile(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function inlineMarkdown(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function MessageBody({ content }: { content: string }) {
  const lines = content.replace(/\s+(?=\d+\.\s+\*\*)/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!.trim();
    if (!line) { index++; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trim().startsWith("```")) code.push(lines[index++]!);
      index++;
      blocks.push(<pre key={`code-${index}`}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    if (/^(?:[-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\d+\./.test(line);
      const items: string[] = [];
      while (index < lines.length && (ordered ? /^\d+\.\s+/.test(lines[index]!.trim()) : /^[-*]\s+/.test(lines[index]!.trim()))) items.push(lines[index++]!.trim().replace(/^(?:[-*]|\d+\.)\s+/, ""));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(<Tag key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</Tag>);
      continue;
    }
    blocks.push(<p key={`p-${index}`}>{inlineMarkdown(line)}</p>);
    index++;
  }
  return <div className="message-body">{blocks}</div>;
}

function ViewActions({ exportLabel, onExport }: { exportLabel?: string; onExport?: () => void }) {
  return <div className="view-actions no-print"><button className="secondary" onClick={() => window.print()}>PRINT / PDF</button>{onExport && <button className="secondary" onClick={onExport}>EXPORT {exportLabel}</button>}</div>;
}

export default function ProjectWorkspace({ id, project, revision, schematicImage }: { id: string; project: ProjectSpec; revision: number; schematicImage: string }) {
  const boardName = project.boardMeta?.name || project.board;
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "Schematic";
    const requested = new URLSearchParams(window.location.search).get("view");
    return tabs.includes(requested as Tab) ? requested as Tab : "Schematic";
  });
  const [changeRequest, setChangeRequest] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<number | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const revisionLabel = String(revision).padStart(2, "0");

  useEffect(() => { import("@wokwi/elements"); }, []);
  useEffect(() => { if (window.matchMedia("(min-width: 901px)").matches) setAssistantOpen(true); }, []);
  useEffect(() => {
    const syncView = () => {
      const requested = new URLSearchParams(window.location.search).get("view");
      if (tabs.includes(requested as Tab)) setTab(requested as Tab);
    };
    syncView();
    window.addEventListener("popstate", syncView);
    return () => window.removeEventListener("popstate", syncView);
  }, []);

  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    mainRef.current?.scrollTo({ top: 0 });
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.replaceState(null, "", url);
  }, []);

  const openAssistantWith = useCallback((request: string) => {
    setChangeRequest(request);
    setAssistantOpen(true);
    setRailOpen(false);
    setTimeout(() => document.getElementById("assistant-message")?.focus());
  }, []);

  return (
    <main className="shell blueprint-shell">
      <nav className="nav">
        <a className="brand" href="/"><span className="brand-mark">BP</span><span>Blueprint<small>Engineering workspace</small></span></a>
        <span className="project-status">Validated <i /> Rev {revisionLabel}</span>
      </nav>
      <div className={`workspace ${assistantOpen ? "" : "assistant-collapsed"} ${railOpen ? "" : "rail-collapsed"}`}>
        <aside className={`sidebar assistant-sidebar ${assistantOpen ? "is-open" : ""}`}>
          <a className="back" href="/">← NEW DRAWING</a>
          <div className="assistant-intro"><div className="project-label">Design assistant</div><h3>Change or question</h3><p>{project.summary}</p><button className="panel-close no-print" onClick={() => setAssistantOpen(false)} aria-label="Close assistant">×</button></div>
          <Assistant id={id} project={project} initialRequest={changeRequest} />
        </aside>
        <section className="main" ref={mainRef}>
          <header className="project-head">
            <div className="head-row">
              <div className="head-title"><div className="panel-toggles no-print"><button className="secondary" onClick={() => setAssistantOpen((open) => { if (!open) setRailOpen(false); return !open; })} aria-expanded={assistantOpen}>Assistant</button><button className="secondary" onClick={() => setRailOpen((open) => { if (!open) setAssistantOpen(false); return !open; })} aria-expanded={railOpen}>Details</button></div><h2>{project.title}</h2></div>
              <details className="project-actions no-print"><summary>Actions</summary><div><a href={`/api/projects/${id}/download`}>Download project ZIP</a></div></details>
            </div>
            <div className="active-view"><label htmlFor="project-view">View</label><select id="project-view" value={tab} onChange={(event) => selectTab(event.target.value as Tab)}>{tabs.map((item) => <option key={item} value={item}>{item === "Changes" ? "History" : item}</option>)}</select><small>{boardName}</small></div>
          </header>
          <div className={`content ${tab === "Schematic" || tab === "Changes" ? "content-wide" : ""}`}>
            {tab === "Overview" && <Overview project={project} />}
            {tab === "Schematic" && <Schematic project={project} schematicImage={schematicImage} selectedConnection={selectedConnection} onSelectConnection={setSelectedConnection} onRequestChange={openAssistantWith} />}
            {tab === "BOM" && <BomTable project={project} />}
            {tab === "Pins" && <PinTable project={project} onSelect={(index) => { setSelectedConnection(index); selectTab("Schematic"); }} />}
            {tab === "Assembly" && <Assembly project={project} onSelect={(index) => { setSelectedConnection(index); selectTab("Schematic"); }} />}
            {tab === "Firmware" && <Firmware id={id} project={project} />}
            {tab === "Changes" && <ProjectHistory id={id} project={project} revision={revision} />}
          </div>
        </section>
        <aside className={`project-rail ${railOpen ? "is-open" : ""}`}>
          <div className="rail-title"><strong>Project details</strong><small>{boardName} · Revision {revisionLabel}</small></div><button className="panel-close no-print" onClick={() => setRailOpen(false)} aria-label="Close project details">×</button>
          <div className="rail-group component-rail-list"><div className="side-heading">Components</div>{componentReferences(project).map((part) => <button key={part.id} onClick={() => { setChangeRequest(`I want to change ${part.label}. `); setAssistantOpen(true); setTimeout(() => document.getElementById("assistant-message")?.focus()); }} title={`Ask about or change ${part.label}`}><span><b>{part.ref}</b> {part.name}</span><small>×{part.quantity}</small></button>)}</div>
        </aside>
      </div>
    </main>
  );
}

function Assistant({ id, project, initialRequest }: { id: string; project: ProjectSpec; initialRequest: string }) {
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [pendingPreviewId, setPendingPreviewId] = useState<string | null>(null);
  const [request, setRequest] = useState(initialRequest);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${id}/assistant`);
    const result = await response.json() as { messages?: AssistantChatMessage[]; pendingPreviewId?: string | null; error?: string };
    if (!response.ok) throw new Error(result.error || "Could not load this project conversation.");
    setMessages(result.messages || []);
    setPendingPreviewId(result.pendingPreviewId || null);
    setLoading(false);
  }, [id]);

  useEffect(() => { refresh().catch((reason) => { setLoading(false); setError(reason instanceof Error ? reason.message : "Could not load this project conversation."); }); }, [refresh]);
  useEffect(() => { if (initialRequest) { setRequest(initialRequest); setTimeout(() => document.getElementById("assistant-message")?.focus()); } }, [initialRequest]);
  useEffect(() => { threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" }); }, [messages, busy]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const content = request.trim();
    if (!content || busy) return;
    setBusy(true);
    setError("");
    setRequest("");
    setMessages((current) => [...current, { id: `pending-${Date.now()}`, role: "user", kind: "message", content, metadata: null, createdAt: new Date().toISOString() }]);
    try {
      abortRef.current = new AbortController();
      const response = await fetch(`/api/projects/${id}/assistant`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: content }), signal: abortRef.current.signal });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The assistant could not respond.");
    } catch (reason) {
      if ((reason as Error)?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "The assistant could not respond.");
    } finally {
      abortRef.current = null;
      await refresh().then(() => setError("")).catch(() => undefined);
      setBusy(false);
    }
  }

  async function apply(previewId: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${id}/changes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewId }) });
      const result = await response.json() as { revision?: number; error?: string };
      if (!response.ok || !result.revision) throw new Error(result.error || "Could not apply the preview.");
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not apply the preview.");
      setBusy(false);
    }
  }

  return <section className="assistant-chat" aria-label="Project assistant">
    <div className="assistant-thread" ref={threadRef} aria-live="polite">
      {loading && <div className="state-card">LOADING CONVERSATION…</div>}
      {!loading && !messages.length && <div className="assistant-welcome"><strong>I know this project.</strong><span>Ask how it works, compare components, explore an idea, or request a change. I will ask before guessing and nothing changes without your approval.</span></div>}
      {messages.map((message) => {
        const preview = message.kind === "preview" ? message.metadata : null;
        const impact = preview?.impact;
        return <article className={`assistant-message ${message.role} message-${message.kind}`} key={message.id}>
          <small>{message.role === "user" ? "YOU" : message.kind === "clarify" ? "ONE DETAIL NEEDED" : "BLUEPRINT"}</small>
          <MessageBody content={humanizeProjectText(message.content, project)} />
          <div className="message-actions no-print"><button onClick={() => navigator.clipboard.writeText(message.content)}>COPY</button>{message.role === "user" && <button onClick={() => { setRequest(message.content); document.getElementById("assistant-message")?.focus(); }}>EDIT</button>}</div>
          {preview?.previewId && impact && <div className="assistant-preview">
            <div><strong>{impact.summary}</strong><span className={`risk risk-${impact.risk}`}>{impact.risk.toUpperCase()} RISK</span></div>
            <dl><div><dt>LEVEL</dt><dd>{impact.scope.toUpperCase()}</dd></div><div><dt>PARTS</dt><dd>{impact.components.added.length + impact.components.removed.length + impact.components.changed.length} CHANGES</dd></div><div><dt>WIRES</dt><dd>{impact.wiringChanges} CHANGES</dd></div><div><dt>CODE</dt><dd>{impact.firmwareChanged ? "UPDATED" : "UNCHANGED"}</dd></div></dl>
            {impact.warnings.map((warning) => <span className="assistant-note" key={warning}>△ {warning}</span>)}
            {preview.previewId === pendingPreviewId ? <button className="primary" disabled={busy || impact.risk === "high"} onClick={() => apply(preview.previewId!)}>{impact.risk === "high" ? "BLOCKED — REVIEW SAFETY NOTES" : "APPLY THIS PREVIEW"}</button> : <em>SUPERSEDED</em>}
          </div>}
        </article>;
      })}
      {busy && <div className="assistant-thinking"><i /><span>Reading the project and checking the engineering details…</span><button onClick={() => abortRef.current?.abort()}>STOP</button></div>}
    </div>
    {error && <div className="assistant-error" role="alert"><span>{error}</span><button onClick={() => refresh().catch(() => undefined)}>RETRY</button></div>}
    <form className="assistant-composer" onSubmit={send}>
      <label htmlFor="assistant-message">ASK OR CHANGE THIS PROJECT</label>
      <textarea id="assistant-message" value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Ask a question, compare options, or describe a change…" minLength={2} maxLength={1200} required />
      <div className="composer-footer"><small>{request.length} / 1200</small><button className="primary" disabled={busy}>{busy ? "THINKING…" : "SEND"}</button></div>
    </form>
  </section>;
}

function Firmware({ id, project }: { id: string; project: ProjectSpec }) {
  const [file, setFile] = useState<"mainCpp" | "platformioIni">("mainCpp");
  const [compile, setCompile] = useState<"idle" | "running" | "ok" | "fail">("idle");
  const [details, setDetails] = useState("");
  const family = project.boardMeta?.family || "";
  const hostOnly = family === "raspberrypi" || project.boardMeta?.platform === "linux_arm";
  const content = file === "mainCpp" ? project.files.mainCpp : project.files.platformioIni;
  const label = file === "mainCpp" ? "src/main.cpp" : "platformio.ini";

  async function runCompile() {
    if (hostOnly || compile === "running") return;
    setCompile("running");
    setDetails("");
    try {
      const response = await fetch(`/api/projects/${id}/firmware-check`, { method: "POST" });
      const result = await response.json() as { ok?: boolean; details?: string; error?: string };
      if (!response.ok || !result.ok) {
        setCompile("fail");
        setDetails(result.details || result.error || "Firmware did not compile.");
        return;
      }
      setCompile("ok");
      setDetails(result.details || "Compile succeeded.");
    } catch (error) {
      setCompile("fail");
      setDetails(error instanceof Error ? error.message : "Compile check failed.");
    }
  }

  return <section>
    <div className="section-kicker">FIRMWARE / SHEET 06</div>
    <div className="schematic-heading">
      <div>
        <h3>Board sketch</h3>
        <p className="project-summary">Generated from the accepted netlist for {project.boardMeta?.name || project.board}. Circuit wiring stays authoritative.</p>
      </div>
      <div className="schematic-tools no-print">
        <div className="schematic-engine" role="group" aria-label="Firmware file">
          <button className={file === "mainCpp" ? "active" : ""} onClick={() => setFile("mainCpp")}>MAIN.CPP</button>
          <button className={file === "platformioIni" ? "active" : ""} onClick={() => setFile("platformioIni")}>PLATFORMIO.INI</button>
        </div>
        <button className="secondary" onClick={() => navigator.clipboard.writeText(content)}>COPY</button>
        <button className="secondary" onClick={() => downloadFile(file === "mainCpp" ? "main.cpp" : "platformio.ini", content, file === "platformioIni" ? "text/plain" : "text/x-c")}>EXPORT</button>
        {!hostOnly && <button className="primary" disabled={compile === "running"} onClick={runCompile}>{compile === "running" ? "COMPILING…" : "COMPILE CHECK"}</button>}
      </div>
    </div>
    {hostOnly && <div className="state-card">This board uses a host placeholder sketch, not PlatformIO MCU firmware.</div>}
    {compile !== "idle" && <section className={`compile-panel ${compile === "ok" ? "compile-panel-passed" : compile === "fail" ? "compile-panel-failed" : "compile-panel-idle"}`} aria-live="polite">
      <div><strong>{compile === "running" ? "COMPILING" : compile === "ok" ? "COMPILE PASSED" : "COMPILE FAILED"}</strong><small>{label}</small></div>
      {details && <pre>{details}</pre>}
      {compile !== "running" && <div className="compile-actions"><button className="secondary" onClick={() => { setCompile("idle"); setDetails(""); }}>CLOSE</button></div>}
    </section>}
    <pre className="firmware-source" aria-label={label}><code>{content}</code></pre>
  </section>;
}

function ProjectHistory({ id, project, revision }: { id: string; project: ProjectSpec; revision: number }) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Revision>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => { setLoading(true); setError(""); fetch(`/api/projects/${id}/revisions`).then(async (response) => { const result = await response.json() as { revisions?: Revision[]; error?: string }; if (!response.ok) throw new Error(result.error || "Could not load project history."); setRevisions(result.revisions || []); }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load project history.")).finally(() => setLoading(false)); }, [id]);
  useEffect(load, [load]);
  async function restore(target: number) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${id}/revisions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: target }) });
      const result = await response.json() as { revision?: number; error?: string };
      if (!response.ok || !result.revision) throw new Error(result.error || "Could not restore revision.");
      window.location.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not restore revision."); setBusy(false); }
  }
  const details = selected?.details;
  const partCount = details ? details.components.added.length + details.components.removed.length + details.components.changed.length : 0;
  return <section><div className="section-kicker">REVISION REGISTER</div><h3>Project history</h3><p className="project-summary">Restoring creates a new revision; it never deletes the versions between.</p>{loading && <div className="state-card">LOADING PROJECT HISTORY…</div>}{error && <div className="error"><strong>HISTORY UNAVAILABLE</strong><span>{error}</span><button className="secondary" onClick={load}>RETRY</button></div>}{!loading && !error && !revisions.length && <div className="state-card">No saved revisions yet.</div>}<div className="revision-panel history-panel"><div className="side-heading">PROJECT VERSIONS</div>{revisions.map((item) => <div className="revision-row" key={item.revision}><span>REV {String(item.revision).padStart(2, "0")}</span><div><strong>{humanizeProjectText(item.summary, project)}</strong><small>{humanizeProjectText(item.request, project)} · {new Date(item.createdAt).toLocaleString()}</small></div>{item.revision === revision ? <em>CURRENT</em> : <button disabled={busy} onClick={() => setSelected(item)}>PREVIEW RESTORE</button>}</div>)}</div>{selected && <div className="restore-confirm" role="dialog" aria-modal="true" aria-label={`Restore revision ${selected.revision}`}><div><small>RESTORE PREVIEW</small><h4>Restore revision {String(selected.revision).padStart(2, "0")}?</h4><p>This will create a new revision from the selected version. Your current revision remains in history.</p></div><dl><div><dt>PARTS</dt><dd>{partCount} changes</dd></div><div><dt>WIRES</dt><dd>{details?.wiringChanges ?? 0} changes</dd></div><div><dt>FIRMWARE</dt><dd>{details?.firmwareChanged ? "Different" : "Unchanged"}</dd></div></dl>{details && [...details.components.added.map((item) => `+ ${item}`), ...details.components.removed.map((item) => `− ${item}`), ...details.components.changed.map((item) => `~ ${item}`)].map((item) => <p className="diff-line" key={item}>{item}</p>)}<div className="preview-actions"><button className="secondary" onClick={() => setSelected(undefined)}>CANCEL</button><button className="primary" disabled={busy} onClick={() => restore(selected.revision)}>{busy ? "RESTORING…" : "RESTORE AS NEW REVISION"}</button></div></div>}</section>;
}

function Schematic({ project, schematicImage, selectedConnection, onSelectConnection, onRequestChange }: { project: ProjectSpec; schematicImage: string; selectedConnection: number | null; onSelectConnection: (index: number | null) => void; onRequestChange: (request: string) => void }) {
  const [engine, setEngine] = useState<"tscircuit" | "wokwi">("wokwi");
  const [viewerKey, setViewerKey] = useState(0);
  return <>
    <div className="section-kicker">ELECTRICAL SCHEMATIC / SHEET 02</div>
    <div className="schematic-heading"><div><h3>Wiring diagram</h3><p className="project-summary">Select any W-number to trace the same connection across every project view.</p></div><div className="schematic-tools no-print"><div className="schematic-engine" role="group" aria-label="Schematic view"><button className={engine === "wokwi" ? "active" : ""} onClick={() => setEngine("wokwi")}>PHYSICAL WIRING</button><button className={engine === "tscircuit" ? "active" : ""} onClick={() => setEngine("tscircuit")}>CIRCUIT SCHEMATIC</button></div><button className="secondary" onClick={() => { onSelectConnection(null); setViewerKey((key) => key + 1); }}>FIT / RESET</button><button className="secondary" onClick={() => window.print()}>PRINT / PDF</button></div></div>
    {engine === "tscircuit" && schematicImage ? <div key={viewerKey} className="tscircuit-canvas"><img src={schematicImage} alt={`${project.title} circuit schematic`} /></div> : <Wiring key={viewerKey} project={project} hideHeading selectedConnection={selectedConnection} onSelectConnection={onSelectConnection} onRequestChange={onRequestChange} />}
  </>;
}

function ChangeOrder({ id, revision, initialRequest, compact = false }: { id: string; revision: number; initialRequest: string; compact?: boolean }) {
  const fieldId = compact ? "assistant-change-request" : "change-request";
  const [request, setRequest] = useState(initialRequest);
  const [preview, setPreview] = useState<{ previewId: string; impact: ChangeImpact; result: { title: string; components: number; connections: number } }>();
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [busy, setBusy] = useState<"preview" | "apply" | "restore" | "">("");
  const [error, setError] = useState("");
  const [clarification, setClarification] = useState<{ understanding: string; question: string }>();
  const refreshRevisions = useCallback(() => {
    fetch(`/api/projects/${id}/revisions`).then((response) => response.json()).then((result: { revisions?: Revision[] }) => setRevisions(result.revisions || [])).catch(() => undefined);
  }, [id]);

  useEffect(() => { setRequest(initialRequest); setPreview(undefined); setError(""); }, [initialRequest]);
  useEffect(() => { if (!compact) refreshRevisions(); }, [compact, refreshRevisions]);

  async function analyze(event: React.FormEvent) {
    event.preventDefault();
    setBusy("preview");
    setError("");
    setPreview(undefined);
    setClarification(undefined);
    try {
      const response = await fetch(`/api/projects/${id}/changes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request }) });
      const result = await response.json() as { previewId?: string; impact?: ChangeImpact; result?: { title: string; components: number; connections: number }; clarification?: { understanding: string; question: string }; error?: string };
      if (response.ok && result.clarification) { setClarification(result.clarification); return; }
      if (!response.ok || !result.previewId || !result.impact || !result.result) throw new Error(result.error || "Change analysis failed.");
      setPreview({ previewId: result.previewId, impact: result.impact, result: result.result });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Change analysis failed.");
    } finally {
      setBusy("");
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy("apply");
    setError("");
    try {
      const response = await fetch(`/api/projects/${id}/changes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewId: preview.previewId }) });
      const result = await response.json() as { revision?: number; error?: string };
      if (!response.ok || !result.revision) throw new Error(result.error || "Could not apply revision.");
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not apply revision.");
      setBusy("");
    }
  }

  async function restore(target: number) {
    setBusy("restore");
    setError("");
    try {
      const response = await fetch(`/api/projects/${id}/revisions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: target }) });
      const result = await response.json() as { revision?: number; error?: string };
      if (!response.ok || !result.revision) throw new Error(result.error || "Could not restore revision.");
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restore revision.");
      setBusy("");
    }
  }

  const componentChanges = preview ? [...preview.impact.components.added.map((item) => `+ ${item}`), ...preview.impact.components.removed.map((item) => `− ${item}`), ...preview.impact.components.changed.map((item) => `~ ${item}`)] : [];

  return <section className={`change-order ${compact ? "compact-change" : ""}`} aria-label="Project changes">
    <div className="change-order-title"><div><small>PROJECT CHANGES / CURRENT VERSION {String(revision).padStart(2, "0")}</small><h3>Change this project</h3><p>Describe one change in ordinary words. Blueprint will update every affected section—parts, wiring, code, and instructions—as one complete project.</p></div></div>
    <div className="change-layout">
      <div className="change-main">
        <form className="change-form" onSubmit={analyze}>
          <label htmlFor={fieldId}>WHAT WOULD YOU LIKE TO CHANGE?</label>
          <textarea id={fieldId} value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Example: Use one rotary encoder instead of the knob, but keep it controlling the same hand movement." minLength={5} maxLength={800} required />
          <div className="change-help">If a word could mean different parts, include what the part should do and how many you need.</div>
          <div className="change-actions"><span>Your current project stays unchanged until you approve the preview.</span><button className="primary" disabled={Boolean(busy)}>{busy === "preview" ? "CHECKING YOUR REQUEST…" : "REVIEW PROPOSED CHANGE"}</button></div>
        </form>
        {error && <div className="error" role="alert"><strong>COULD NOT CHECK THIS CHANGE</strong><span>{error}</span></div>}
        {busy === "preview" && <div className="change-progress" aria-live="polite"><span>01 UNDERSTAND REQUEST</span><i /><span>02 UPDATE WHOLE PROJECT</span><i /><span>03 SAFETY CHECK</span></div>}
        {clarification && <div className="clarification" role="status"><small>ONE DETAIL IS UNCLEAR</small><strong>{clarification.question}</strong><p>What Blueprint currently understands: {clarification.understanding}</p><button className="secondary" onClick={() => { setRequest(`${request.trim()}\n\nTo clarify: `); setClarification(undefined); document.getElementById(fieldId)?.focus(); }}>ADD THE MISSING DETAIL</button></div>}
        {preview && <div className="change-preview">
          <div className="preview-heading"><div><small>PROPOSED VERSION {String(revision + 1).padStart(2, "0")}</small><h4>{preview.impact.summary}</h4><p>Blueprint understood: {preview.impact.understanding}</p></div><span className={`risk risk-${preview.impact.risk}`}>{preview.impact.risk.toUpperCase()} RISK</span></div>
          <div className="impact-grid">
            <div><small>CHANGE LEVEL</small><strong>{preview.impact.scope.toUpperCase()}</strong><p>{preview.result.title}</p></div>
            <div><small>PARTS</small><strong>{componentChanges.length ? `${componentChanges.length} CHANGES` : "UNCHANGED"}</strong>{componentChanges.map((item) => <p key={item}>{item}</p>)}</div>
            <div><small>WIRES</small><strong>{preview.impact.wiringChanges ? `${preview.impact.wiringChanges} CONNECTION CHANGES` : "UNCHANGED"}</strong><p>{preview.result.connections} connections after the change</p></div>
            <div><small>CODE</small><strong>{preview.impact.firmwareChanged ? "UPDATED" : "UNCHANGED"}</strong><p>{preview.result.components} components after the change</p></div>
          </div>
          {preview.impact.warnings.length > 0 && <div className="change-warnings"><strong>ENGINEERING NOTES</strong>{preview.impact.warnings.map((warning) => <p key={warning}>△ {warning}</p>)}</div>}
          <div className="preview-actions"><button className="secondary" onClick={() => setPreview(undefined)}>DISCARD PREVIEW</button><button className="primary" onClick={apply} disabled={Boolean(busy) || preview.impact.risk === "high"}>{busy === "apply" ? "UPDATING PROJECT…" : preview.impact.risk === "high" ? "BLOCKED — REVIEW NOTES" : "MAKE THESE CHANGES"}</button></div>
        </div>}
      </div>
      {!compact && <aside className="revision-panel">
        <div className="side-heading">PROJECT VERSIONS</div>
        {revisions.map((item) => <div className="revision-row" key={item.revision}>
          <span>REV {String(item.revision).padStart(2, "0")}</span>
          <div><strong>{item.summary}</strong><small>{item.request}</small></div>
          {item.revision === revision ? <em>CURRENT</em> : <button disabled={Boolean(busy)} onClick={() => restore(item.revision)}>USE THIS VERSION</button>}
        </div>)}
      </aside>}
    </div>
  </section>;
}

function Overview({ project }: { project: ProjectSpec }) {
  return <>
    <div className="section-kicker">GENERAL ARRANGEMENT / SHEET 01</div>
    <h3>Project overview</h3>
    <div className="overview-grid">
      <div className="metric"><div className="metric-label">Controller</div><div className="metric-value">{project.boardMeta?.name || project.board}</div></div>
      <div className="metric"><div className="metric-label">Components</div><div className="metric-value">{project.components.length}</div></div>
      <div className="metric"><div className="metric-label">Connections</div><div className="metric-value">{project.connections.length}</div></div>
    </div>
    <div className="card"><h4>DESIGN INTENT</h4><p className="project-summary">{project.summary}</p></div>
    {project.explanations?.length ? <div className="card"><h4>WHY THESE PARTS</h4><ul className="steps">{project.explanations.map((item) => {
      const label = project.components.find((component) => component.id === item.componentId)?.name || item.componentId;
      return <li key={item.componentId}><strong>{label}:</strong> {item.text}</li>;
    })}</ul></div> : null}
    {project.generation && <details className="card generation-card"><summary>Generation details</summary><p className="project-summary">{project.generation.calls} calls · {(project.generation.inputTokens + project.generation.outputTokens).toLocaleString()} tokens · {project.generation.providers.join(" + ")}</p><p className="generation-models">{project.generation.models.join(" → ")}</p></details>}
    <div className="card"><h4>ASSEMBLY PREVIEW</h4><ol className="steps">{assemblySteps(project).slice(0, 4).map((step) => <li key={step.wire}>{step.text}</li>)}</ol></div>
  </>;
}

type NetFilter = "all" | "power" | "ground" | "signal";

function netKind(connection: ProjectSpec["connections"][number]): Exclude<NetFilter, "all"> {
  const text = `${connection.fromPin} ${connection.toPin} ${connection.purpose}`.toLowerCase();
  if (/\b(?:gnd|ground|negative|return)\b/.test(text)) return "ground";
  if (/\b(?:vcc|vin|3v3|5v|power|supply|positive|vmot)\b/.test(text)) return "power";
  return "signal";
}

function Wiring({ project, hideHeading = false, selectedConnection = null, onSelectConnection = () => undefined, onRequestChange = () => undefined }: { project: ProjectSpec; hideHeading?: boolean; selectedConnection?: number | null; onSelectConnection?: (index: number | null) => void; onRequestChange?: (request: string) => void }) {
  const diagramRef = useRef<HTMLDivElement>(null);
  const portRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const [wires, setWires] = useState<DrawnWire[]>([]);
  const [hoveredWire, setHoveredWire] = useState<number | null>(null);
  const [filter, setFilter] = useState<NetFilter>("all");
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const [compactLayout, setCompactLayout] = useState(false);
  const activeWire = hoveredWire ?? selectedConnection;

  const draw = useCallback(() => {
    const diagram = diagramRef.current;
    if (!diagram) return;
    const bounds = diagram.getBoundingClientRect();
    const point = (component: string, pin: string) => {
      const port = portRefs.current[`${component}:${pin}`];
      if (!port) return null;
      const portBounds = port.getBoundingClientRect();
      return { x: portBounds.left + portBounds.width / 2 - bounds.left, y: portBounds.top + portBounds.height / 2 - bounds.top };
    };
    setWires(project.connections.flatMap((connection, index) => {
      const from = point(connection.fromComponent, connection.fromPin);
      const to = point(connection.toComponent, connection.toPin);
      if (!from || !to) return [];
      return [{
        from, to, color: connection.color, index,
        routeX: wireLane(index, project.connections.length, Math.min(from.x, to.x), Math.max(from.x, to.x)),
        key: `${connection.fromComponent}-${connection.fromPin}-${connection.toComponent}-${connection.toPin}-${index}`,
      }];
    }));
  }, [project]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(draw);
    import("@wokwi/elements").then(() => {
      if (diagramRef.current) observer.observe(diagramRef.current);
      Object.values(portRefs.current).forEach((port) => port && observer.observe(port));
      requestAnimationFrame(() => requestAnimationFrame(draw));
      timer = setTimeout(draw, 250);
    });
    window.addEventListener("resize", draw);
    return () => { clearTimeout(timer); observer.disconnect(); window.removeEventListener("resize", draw); };
  }, [draw]);

  const pinsFor = (owner: string) => [...new Set(project.connections.flatMap((wire) => [
    ...(wire.fromComponent === owner ? [wire.fromPin] : []),
    ...(wire.toComponent === owner ? [wire.toPin] : []),
  ]))];
  const boardPins = pinsFor("board");
  const boardName = project.boardMeta?.name || project.board;
  const ownerName = (owner: string) => owner === "board" ? boardName : project.components.find((component) => component.id === owner)?.name || owner;
  const normalLayout = schematicLayout(project.components);
  const componentTops = compactLayout ? project.components.map((_, index) => 28 + index * 112) : normalLayout.tops;
  const diagramHeight = compactLayout ? Math.max(510, 190 + project.components.length * 112) : normalLayout.height;
  const ownerLabels = projectOwnerLabels(project);
  const selectedPart = selectedOwner === "board" ? { name: boardName, type: "controller", count: 1 } : (() => {
    const component = project.components.find((part) => part.id === selectedOwner);
    if (!component) return null;
    const type = component.type || component.id;
    return { name: component.name, type, count: project.components.filter((part) => (part.type || part.id) === type).length };
  })();
  const visibleConnection = (index: number) => filter === "all" || netKind(project.connections[index]!) === filter;
  const terminals = (owner: string, pins: string[]) => <div className={`terminal-rail ${owner === "board" ? "board-rail" : "component-rail"}`}>
    {pins.map((pin) => <span className="terminal" key={pin}>
      {owner !== "board" && <span className="terminal-label">{pin}</span>}
      <span className="terminal-dot" ref={(node) => { portRefs.current[`${owner}:${pin}`] = node; }} title={`${owner} ${pin}`} />
      {owner === "board" && <span className="terminal-label">{pin}</span>}
    </span>)}
  </div>;
  const boardVisual = () => {
    const visual = project.boardMeta?.visual;
    if (visual) return React.createElement(visual);
    if (project.board === "esp32cam") return <div className="esp32cam-board"><strong>ESP32-CAM</strong><span>OV2640 CAMERA</span><i>AI THINKER</i></div>;
    return <div className="generic-module">{boardName}</div>;
  };

  return <>
    {!hideHeading && <><div className="section-kicker">ELECTRICAL SCHEMATIC / SHEET 02</div><h3>Wiring diagram</h3><p className="project-summary">Connect each labeled {boardName} terminal to the matching labeled component terminal.</p></>}
    <div className="schematic-commandbar no-print" aria-label="Schematic editing tools">
      <div className="net-filters" role="group" aria-label="Connection filter">{(["all", "power", "ground", "signal"] as const).map((kind, index) => <button key={kind} className={filter === kind ? "active" : ""} aria-pressed={filter === kind} onClick={() => setFilter(kind)}><kbd>{index + 1}</kbd>{kind}</button>)}</div>
      <button className={compactLayout ? "active" : ""} aria-pressed={compactLayout} onClick={() => setCompactLayout((value) => !value)}><kbd>A</kbd>{compactLayout ? "SPREAD PARTS" : "ALIGN / COMPACT"}</button>
      <span className="selection-status">{selectedPart ? `SELECTED: ${ownerLabels.get(selectedOwner || "")?.label || selectedPart.name}` : "SELECT A PART OR NET"}</span>
      {selectedPart && selectedOwner !== "board" && <><button onClick={() => onRequestChange(`Replace all ${selectedPart.count} ${selectedPart.name} component${selectedPart.count === 1 ? "" : "s"} with `)}>REPLACE {selectedPart.count > 1 ? "ALL MATCHING" : "PART"}</button><button onClick={() => onRequestChange(`Duplicate ${ownerLabels.get(selectedOwner || "")?.label || selectedPart.name} and its directly connected supporting circuit as one additional independent channel. Preserve the existing channel and choose safe, non-conflicting pins.`)}>DUPLICATE SUBCIRCUIT</button></>}
      {(selectedOwner || selectedConnection !== null || filter !== "all") && <button onClick={() => { setSelectedOwner(null); onSelectConnection(null); setFilter("all"); }}>CLEAR</button>}
    </div>
    <div className="diagram" ref={diagramRef} style={{ height: `${diagramHeight}px` }} tabIndex={0} aria-label="Interactive wiring diagram. Shortcuts: 1 all nets, 2 power, 3 ground, 4 signal, A align, Escape clear." onKeyDown={(event) => {
      if (["1", "2", "3", "4"].includes(event.key)) setFilter((["all", "power", "ground", "signal"] as const)[Number(event.key) - 1]!);
      else if (event.key.toLowerCase() === "a") setCompactLayout((value) => !value);
      else if (event.key === "Escape") { setSelectedOwner(null); onSelectConnection(null); setFilter("all"); }
    }}>
      <div className="diagram-coordinate coordinate-x">A&nbsp;&nbsp;&nbsp;B&nbsp;&nbsp;&nbsp;C&nbsp;&nbsp;&nbsp;D&nbsp;&nbsp;&nbsp;E&nbsp;&nbsp;&nbsp;F</div>
      <div className="diagram-coordinate coordinate-y">1<br />2<br />3<br />4<br />5</div>
      <div className="diagram-label">DWG: BP-EL-02 / SCALE: NTS</div>
      <div className={`part board-part hardware-group ${selectedOwner === "board" ? "is-selected" : ""}`}>
        <button className="part-selector" onClick={() => setSelectedOwner(selectedOwner === "board" ? null : "board")} aria-pressed={selectedOwner === "board"} aria-label={`Select ${boardName}`}>{boardVisual()}</button>
        {terminals("board", boardPins)}
      </div>
      {project.components.map((component, index) => {
        const type = component.type || component.id;
        const definition = COMPONENTS[type];
        const pins = pinsFor(component.id);
        return <div className={`part component-part part-${type} ${selectedOwner === component.id ? "is-selected" : ""}`} style={{ top: `${componentTops[index]}px` }} key={component.id}>
          {terminals(component.id, pins)}
          <button className="component-visual part-selector" onClick={() => setSelectedOwner(selectedOwner === component.id ? null : component.id)} aria-pressed={selectedOwner === component.id} aria-label={`Select ${component.name}`}>
            {definition?.tag ? React.createElement(definition.tag) : <div className="generic-module">{component.name}</div>}
            <span className="part-name">{component.name}{component.registry && <small className={`support-badge support-${component.registry.supportLevel}`}>{component.registry.supportLevel}</small>}</span>
          </button>
        </div>;
      })}
      <svg className="wires" viewBox={`0 0 ${diagramRef.current?.clientWidth || 900} ${diagramRef.current?.clientHeight || diagramHeight}`} aria-label="Circuit connection lines">
        {wires.filter((wire) => visibleConnection(wire.index)).map((wire) => <g
          className={`wire-group ${(activeWire !== null && activeWire !== wire.index) || (activeWire === null && selectedOwner && ![project.connections[wire.index]!.fromComponent, project.connections[wire.index]!.toComponent].includes(selectedOwner)) ? "is-muted" : ""} ${activeWire === wire.index ? "is-active" : ""}`}
          key={wire.key}
          onMouseEnter={() => setHoveredWire(wire.index)}
          onMouseLeave={() => setHoveredWire(null)}
          tabIndex={0}
          role="button"
          aria-label={`Select wire W${String(wire.index + 1).padStart(2, "0")}`}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelectConnection(selectedConnection === wire.index ? null : wire.index); }}
          onClick={() => onSelectConnection(selectedConnection === wire.index ? null : wire.index)}
        >
          <path className="wire-hit" d={`M${wire.from.x} ${wire.from.y} H${wire.routeX} V${wire.to.y} H${wire.to.x}`} fill="none" />
          <path className="wire-underlay" d={`M${wire.from.x} ${wire.from.y} H${wire.routeX} V${wire.to.y} H${wire.to.x}`} fill="none" />
          <path className="wire-color" d={`M${wire.from.x} ${wire.from.y} H${wire.routeX} V${wire.to.y} H${wire.to.x}`} fill="none" stroke={wire.color} strokeWidth="3" />
          <circle cx={wire.from.x} cy={wire.from.y} r="4" fill={wire.color} />
          <circle cx={wire.to.x} cy={wire.to.y} r="4" fill={wire.color} />
          <circle className="wire-junction" cx={wire.routeX} cy={wire.from.y} r="3" />
          <text className="wire-callout" x={wire.routeX + 4} y={(wire.from.y + wire.to.y) / 2 - 4}>W{String(wire.index + 1).padStart(2, "0")}</text>
        </g>)}
      </svg>
      <div className="diagram-legend"><span><i className="legend-power" />POWER</span><span><i className="legend-ground" />GROUND</span><span><i className="legend-signal" />SIGNAL</span></div>
    </div>
    <div className="wire-schedule">
      <div className="wire-schedule-head"><span>WIRE CONNECTION SCHEDULE</span><small>HOVER TO TRACE / CLICK TO LOCK</small>{selectedConnection !== null && <button onClick={() => onSelectConnection(null)}>SHOW ALL</button>}</div>
      <div className="wire-list">
        {project.connections.map((connection, index) => ({ connection, index })).filter(({ index }) => visibleConnection(index)).map(({ connection, index }) => <button
          className={`wire-row ${activeWire === index ? "active" : ""}`}
          key={`${connection.fromComponent}-${connection.fromPin}-${connection.toComponent}-${connection.toPin}-${index}`}
          onMouseEnter={() => setHoveredWire(index)}
          onMouseLeave={() => setHoveredWire(null)}
          onFocus={() => setHoveredWire(index)}
          onBlur={() => setHoveredWire(null)}
          aria-pressed={selectedConnection === index}
          onClick={() => onSelectConnection(selectedConnection === index ? null : index)}
        >
          <span className="wire-number" style={{ borderColor: connection.color }}>W{String(index + 1).padStart(2, "0")}</span>
          <span className="wire-endpoint"><strong>{ownerName(connection.fromComponent)}</strong><small>{connection.fromPin}</small></span>
          <span className="wire-arrow">→</span>
          <span className="wire-endpoint"><strong>{ownerName(connection.toComponent)}</strong><small>{connection.toPin}</small></span>
          <span className="wire-purpose">{connection.purpose}</span>
        </button>)}
      </div>
    </div>
  </>;
}

function BomTable({ project }: { project: ProjectSpec }) {
  const rows = billOfMaterials(project);
  const quote = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = ["Reference,Quantity,Component,Type,Support,Purpose", ...rows.map((row) => [row.ref, row.quantity, row.component, row.type, row.support, row.purpose].map(quote).join(","))].join("\n");
  return <section className="printable-view"><div className="section-heading"><div><div className="section-kicker">PURCHASING SCHEDULE / SHEET 03</div><h3>Bill of materials</h3><p className="project-summary">One row per unique part, derived from the validated hardware.</p></div><ViewActions exportLabel="CSV" onExport={() => downloadFile(`${project.title}-bom.csv`, csv, "text/csv")} /></div><div className="table-scroll"><table className="pin-table"><thead><tr><th>Ref</th><th>Qty</th><th>Component</th><th>Type</th><th>Support</th><th>Purpose</th></tr></thead><tbody>{rows.map((row) => <tr key={row.ref}><td><strong>{row.ref}</strong></td><td>{row.quantity}</td><td>{row.component}</td><td>{row.type}</td><td>{row.support}</td><td>{row.purpose}</td></tr>)}</tbody></table></div></section>;
}

function PinTable({ project, onSelect }: { project: ProjectSpec; onSelect: (index: number) => void }) {
  const rows = pinAssignments(project);
  const quote = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = ["Wire,Component,Pin,Connected to,Connected pin,Purpose", ...rows.map((row, index) => [`W${String(index + 1).padStart(2, "0")}`, row.component, row.pin, row.connectedTo, row.connectedPin, row.purpose].map(quote).join(","))].join("\n");
  return <section className="printable-view"><div className="section-heading"><div><div className="section-kicker">TERMINATION SCHEDULE / SHEET 04</div><h3>Pin assignments</h3><p className="project-summary">Readable component references replace internal database IDs.</p></div><ViewActions exportLabel="CSV" onExport={() => downloadFile(`${project.title}-pins.csv`, csv, "text/csv")} /></div><div className="table-scroll"><table className="pin-table"><thead><tr><th>Wire</th><th>Component</th><th>Pin</th><th>Connected to</th><th>Purpose</th><th className="no-print">Locate</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.component}-${row.pin}-${index}`}><td><strong>W{String(index + 1).padStart(2, "0")}</strong></td><td>{row.component}</td><td>{row.pin}</td><td>{row.connectedTo} · {row.connectedPin}</td><td>{row.purpose}</td><td className="no-print"><button className="table-action" onClick={() => onSelect(index)}>SHOW WIRE</button></td></tr>)}</tbody></table></div></section>;
}

function Assembly({ project, onSelect }: { project: ProjectSpec; onSelect: (index: number) => void }) {
  const steps = assemblySteps(project);
  const [done, setDone] = useState<Set<number>>(new Set());
  const text = steps.map((step, index) => `${index + 1}. ${step.text}`).join("\n");
  return <section className="printable-view"><div className="section-heading"><div><div className="section-kicker">BUILD SEQUENCE / SHEET 05</div><h3>Assembly instructions</h3><p className="project-summary">Generated from the validated connection schedule, never from unverified prose.</p></div><ViewActions exportLabel="TXT" onExport={() => downloadFile(`${project.title}-assembly.txt`, text)} /></div><div className="assembly-progress no-print"><span>{done.size} OF {steps.length} COMPLETE</span><progress max={steps.length} value={done.size} /></div><ol className="assembly-list">{steps.map((step, index) => <li className={done.has(index) ? "done" : ""} key={`${step.wire}-${index}`}><label><input className="no-print" type="checkbox" checked={done.has(index)} onChange={() => setDone((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span><strong>{step.wire}</strong>{step.text}</span></label>{step.connectionIndex !== null && <button className="table-action no-print" onClick={() => onSelect(step.connectionIndex)}>SHOW {step.wire}</button>}</li>)}</ol></section>;
}
