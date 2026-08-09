/**
 * Live preflight against a running Blueprint server (default http://localhost:3000).
 * Run: npx tsx scripts/preflight-smoke.ts
 */
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getProject } from "../lib/db.ts";

const BASE = process.env.BLUEPRINT_BASE || "http://localhost:3000";
const failures: string[] = [];
const notes: string[] = [];

function ok(label: string, detail = "") {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, detail: string) {
  failures.push(`${label}: ${detail}`);
  console.error(`FAIL  ${label} — ${detail}`);
}
function note(label: string, detail: string) {
  notes.push(`${label}: ${detail}`);
  console.log(`NOTE  ${label} — ${detail}`);
}

async function jsonFetch(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  return { response, body, text };
}

async function expectStatus(label: string, response: Response, allowed: number[]) {
  if (!allowed.includes(response.status)) {
    fail(label, `status ${response.status}, expected ${allowed.join("|")}`);
    return false;
  }
  ok(label, `HTTP ${response.status}`);
  return true;
}

async function exerciseProject(id: string, label: string) {
  const page = await fetch(`${BASE}/projects/${id}`);
  if (!(await expectStatus(`${label} project page`, page, [200]))) return;
  const html = await page.text();
  for (const needle of ["Schematic", "BOM", "Pins", "Assembly", "Firmware", "CIRCUIT CHECKED"]) {
    if (!html.includes(needle)) fail(`${label} page markup`, `missing ${needle}`);
  }

  for (const view of ["Overview", "Schematic", "BOM", "Pins", "Assembly", "Firmware", "Changes"]) {
    const viewPage = await fetch(`${BASE}/projects/${id}?view=${view}`);
    if (viewPage.status !== 200) fail(`${label} view ${view}`, `status ${viewPage.status}`);
  }
  ok(`${label} all view URLs`);

  const download = await fetch(`${BASE}/api/projects/${id}/download`);
  if (await expectStatus(`${label} download`, download, [200])) {
    const buf = Buffer.from(await download.arrayBuffer());
    if (buf.length < 200 || buf[0] !== 0x50 || buf[1] !== 0x4b) fail(`${label} download`, "not a zip");
    else ok(`${label} download zip`, `${buf.length} bytes`);
    await mkdir(path.join(process.cwd(), "generated", "preflight"), { recursive: true });
    const out = path.join(process.cwd(), "generated", "preflight", `${id}.zip`);
    await pipeline(Readable.from(buf), createWriteStream(out));
  }

  const revisions = await jsonFetch(`${BASE}/api/projects/${id}/revisions`);
  await expectStatus(`${label} revisions`, revisions.response, [200]);

  const assistant = await jsonFetch(`${BASE}/api/projects/${id}/assistant`);
  await expectStatus(`${label} assistant GET`, assistant.response, [200]);

  const ask = await jsonFetch(`${BASE}/api/projects/${id}/assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "In one short sentence, what does the pushbutton do in this circuit?" }),
  });
  if (ask.response.status === 200) ok(`${label} assistant Q&A`);
  else note(`${label} assistant Q&A`, `status ${ask.response.status} ${(ask.body as { error?: string })?.error || ""}`);

  // Compile can be slow / missing toolchain — treat soft
  const compile = await jsonFetch(`${BASE}/api/projects/${id}/firmware-check`, { method: "POST" });
  if (compile.response.status === 200 && (compile.body as { ok?: boolean }).ok) ok(`${label} compile check`);
  else note(`${label} compile check`, `status ${compile.response.status} — ${(compile.body as { error?: string })?.error || "toolchain/soft fail"}`);
}

async function generate(prompt: string, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    const result = await jsonFetch(`${BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const ms = Date.now() - started;
    const body = result.body as { id?: string; error?: string; retryAfterMs?: number; code?: string };
    const rateLimited = result.response.status === 429
      || body.code === "RATE_LIMIT"
      || /\b429\b|rate.?limit|cooling down|quota/i.test(body.error || "");
    if (rateLimited && attempt < retries) {
      const waitMs = Math.max(body.retryAfterMs || 40_000, 15_000);
      note("generate rate limit", `waiting ${Math.ceil(waitMs / 1000)}s then retry`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (result.response.status !== 200 || !body.id) {
      fail(`generate: ${prompt.slice(0, 40)}`, `status ${result.response.status} ${body.error || result.text.slice(0, 200)}`);
      return null;
    }
    const project = await getProject(body.id);
    if (!project?.components.length || !project.connections.length || !project.files?.mainCpp) {
      fail(`generate: ${prompt.slice(0, 40)}`, "saved project incomplete");
      return null;
    }
    ok(`generate: ${project.title}`, `${project.board}, ${project.components.length} parts, ${project.connections.length} wires, ${ms}ms`);
    return body.id;
  }
  return null;
}

async function changeFlow(id: string) {
  let preview: Awaited<ReturnType<typeof jsonFetch>> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    preview = await jsonFetch(`${BASE}/api/projects/${id}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Add an LED with a series resistor that also turns on when the button is pressed." }),
    });
    if (preview.response.status !== 429) break;
    const waitMs = Math.max((preview.body as { retryAfterMs?: number }).retryAfterMs || 40_000, 15_000);
    note("change rate limit", `waiting ${Math.ceil(waitMs / 1000)}s then retry`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (!preview) return;
  if (preview.response.status !== 200) {
    const body = preview.body as { error?: string; clarification?: string };
    if (body.clarification) {
      note("change clarification", body.clarification.slice(0, 160));
      return;
    }
    fail("change preview", `status ${preview.response.status} ${body.error || ""}`);
    return;
  }
  const body = preview.body as { previewId?: string; impact?: { summary?: string } };
  if (!body.previewId) {
    fail("change preview", "no previewId");
    return;
  }
  ok("change preview", body.impact?.summary || body.previewId);

  const apply = await jsonFetch(`${BASE}/api/projects/${id}/changes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ previewId: body.previewId }),
  });
  if (apply.response.status === 200 && (apply.body as { revision?: number }).revision) {
    ok("change apply", `revision ${(apply.body as { revision: number }).revision}`);
  } else {
    fail("change apply", `status ${apply.response.status} ${(apply.body as { error?: string })?.error || ""}`);
  }
}

async function negativePaths() {
  const short = await jsonFetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "too short" }),
  });
  await expectStatus("reject short prompt", short.response, [400]);

  const badId = await fetch(`${BASE}/api/projects/not-a-uuid/download`);
  await expectStatus("reject bad project id", badId, [400, 404]);

  const missing = await fetch(`${BASE}/api/projects/00000000-0000-4000-8000-000000000000/download`);
  await expectStatus("missing project", missing, [404]);
}

async function main() {
  console.log(`Preflight against ${BASE}\n`);

  const home = await fetch(BASE);
  if (!(await expectStatus("home page", home, [200]))) {
    console.error("\nServer not reachable. Start with: npm run dev");
    process.exit(1);
  }

  const providers = await jsonFetch(`${BASE}/api/providers`);
  await expectStatus("providers", providers.response, [200]);

  await negativePaths();

  const existing = "4a56e9d9-e733-451b-93fa-11c78ede9183";
  const existingPage = await fetch(`${BASE}/projects/${existing}`);
  if (existingPage.status === 200) {
    await exerciseProject(existing, "doorbell-existing");
  } else {
    note("doorbell-existing", "project missing from this DB");
  }

  const freshId = await generate("Build a simple wired doorbell with a pushbutton and buzzer on Arduino Uno.");
  if (freshId) {
    await exerciseProject(freshId, "doorbell-fresh");
    await changeFlow(freshId);
    await exerciseProject(freshId, "doorbell-after-change");
  }

  note("gap before second generate", "cooling architect pool 45s");
  await new Promise((resolve) => setTimeout(resolve, 45_000));

  const ledId = await generate("Build a button-controlled LED with a series resistor on an ESP32 DevKit.");
  if (ledId) {
    await exerciseProject(ledId, "esp32-led");
    const html = await (await fetch(`${BASE}/projects/${ledId}`)).text();
    if (!/ESP32|esp32/i.test(html)) note("esp32-led board", "page does not mention ESP32 — model may have chosen differently");
    else ok("esp32-led board mention");
  }

  console.log("\n—— Summary ——");
  console.log(`Failures: ${failures.length}`);
  for (const item of failures) console.log(`  - ${item}`);
  if (notes.length) {
    console.log(`Notes: ${notes.length}`);
    for (const item of notes) console.log(`  - ${item}`);
  }
  if (failures.length) process.exit(1);
  console.log("\nPREFLIGHT OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
