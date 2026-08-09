import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { ensureBoardCard, toBoardProfile } from "./boards.ts";
import { ProjectSpecSchema, validateIntentCoverage, type ProjectSpec } from "./project.ts";

const globalForDb = globalThis as unknown as { blueprintSql?: Sql; blueprintSchema?: Promise<void> };

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured.");
  globalForDb.blueprintSql ??= postgres(url, { max: 1, prepare: false, ssl: "require", connect_timeout: 10, idle_timeout: 20 });
  return globalForDb.blueprintSql;
}

async function ensureSchema() {
  if (!globalForDb.blueprintSchema) {
    const sql = database();
    globalForDb.blueprintSchema = sql.begin(async (tx) => {
      await tx`CREATE TABLE IF NOT EXISTS projects (
        id text PRIMARY KEY, prompt text NOT NULL, spec jsonb NOT NULL, created_at text NOT NULL
      )`;
      await tx`CREATE TABLE IF NOT EXISTS project_revisions (
        id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        revision integer NOT NULL, spec jsonb NOT NULL, change_request text NOT NULL,
        summary text NOT NULL, created_at text NOT NULL, UNIQUE(project_id, revision)
      )`;
      await tx`CREATE TABLE IF NOT EXISTS change_previews (
        id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request text NOT NULL, spec jsonb NOT NULL, impact jsonb NOT NULL,
        created_at text NOT NULL, applied_at text
      )`;
      await tx`CREATE TABLE IF NOT EXISTS assistant_messages (
        id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role text NOT NULL CHECK(role IN ('user', 'assistant')), kind text NOT NULL,
        content text NOT NULL, metadata jsonb, created_at text NOT NULL
      )`;
      await tx`CREATE INDEX IF NOT EXISTS assistant_messages_project_created ON assistant_messages(project_id, created_at)`;
      await tx`CREATE TABLE IF NOT EXISTS component_candidates (
        id text PRIMARY KEY, source_name text NOT NULL, source_url text,
        datasheet_excerpt text NOT NULL, manifest jsonb NOT NULL, review jsonb NOT NULL,
        status text NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        created_at text NOT NULL, reviewed_at text
      )`;
      await tx`CREATE INDEX IF NOT EXISTS component_candidates_status_created ON component_candidates(status, created_at)`;
      await tx`CREATE TABLE IF NOT EXISTS component_manifests (
        id text PRIMARY KEY, manifest jsonb NOT NULL, updated_at text NOT NULL
      )`;
    }).then(() => undefined).catch((error) => {
      globalForDb.blueprintSchema = undefined;
      throw error;
    });
  }
  await globalForDb.blueprintSchema;
}

function hydrateBoardMeta(spec: ProjectSpec): ProjectSpec {
  if (spec.boardMeta) return spec;
  try { return { ...spec, boardMeta: toBoardProfile(ensureBoardCard(spec.board)) }; }
  catch { return spec; }
}

function parsedSpec(value: unknown) {
  return hydrateBoardMeta(ProjectSpecSchema.parse(typeof value === "string" ? JSON.parse(value) : value));
}

export type ComponentCandidateRow = {
  id: string; sourceName: string; sourceUrl: string | null; manifest: unknown; review: unknown;
  status: "pending" | "approved" | "rejected"; createdAt: string; reviewedAt: string | null;
};

export async function saveComponentCandidate(sourceName: string, sourceUrl: string | null, datasheetText: string, manifest: unknown, review: unknown) {
  await ensureSchema();
  const sql = database();
  const id = randomUUID();
  await sql`INSERT INTO component_candidates ${sql({ id, source_name: sourceName, source_url: sourceUrl,
    datasheet_excerpt: datasheetText.slice(0, 4_000), manifest: sql.json(manifest as never), review: sql.json(review as never),
    status: "pending", created_at: new Date().toISOString() })}`;
  return id;
}

export async function listComponentCandidates(limit = 50): Promise<ComponentCandidateRow[]> {
  await ensureSchema();
  const rows = await database()`SELECT id, source_name, source_url, manifest, review, status, created_at, reviewed_at
    FROM component_candidates ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((row) => ({ id: row.id, sourceName: row.source_name, sourceUrl: row.source_url,
    manifest: row.manifest, review: row.review, status: row.status, createdAt: row.created_at, reviewedAt: row.reviewed_at } as ComponentCandidateRow));
}

export async function reviewComponentCandidate(id: string, status: "approved" | "rejected") {
  await ensureSchema();
  const rows = await database()`UPDATE component_candidates SET status = ${status}, reviewed_at = ${new Date().toISOString()}
    WHERE id = ${id} AND status = 'pending' RETURNING id`;
  if (rows.length !== 1) throw new Error("Candidate not found or already reviewed.");
}

export async function approvedComponentManifestValues() {
  await ensureSchema();
  const rows = await database()`SELECT manifest FROM component_candidates WHERE status = 'approved' ORDER BY created_at`;
  return rows.map((row) => row.manifest as unknown);
}

export async function saveComponentManifest(id: string, manifest: unknown) {
  await ensureSchema();
  const sql = database();
  await sql`INSERT INTO component_manifests (id, manifest, updated_at)
    VALUES (${id}, ${sql.json(manifest as never)}, ${new Date().toISOString()})
    ON CONFLICT (id) DO UPDATE SET manifest = EXCLUDED.manifest, updated_at = EXCLUDED.updated_at`;
}

export async function listComponentManifestValues() {
  await ensureSchema();
  const rows = await database()`SELECT manifest FROM component_manifests ORDER BY id`;
  return rows.map((row) => row.manifest as unknown);
}

async function ensureBaseline(projectId: string, spec: unknown, createdAt: string) {
  const sql = database();
  await sql`INSERT INTO project_revisions (id, project_id, revision, spec, change_request, summary, created_at)
    VALUES (${randomUUID()}, ${projectId}, 1, ${sql.json(spec as never)}, 'Original generation', 'Initial validated project', ${createdAt})
    ON CONFLICT (project_id, revision) DO NOTHING`;
}

export async function saveProject(id: string, prompt: string, spec: ProjectSpec) {
  const missing = validateIntentCoverage(prompt, spec);
  if (missing.length) throw new Error(`Project does not satisfy its brief: ${missing.join(" ")}`);
  await ensureSchema();
  const sql = database();
  const now = new Date().toISOString();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO projects (id, prompt, spec, created_at) VALUES (${id}, ${prompt}, ${tx.json(spec as never)}, ${now})`;
    await tx`INSERT INTO project_revisions (id, project_id, revision, spec, change_request, summary, created_at)
      VALUES (${randomUUID()}, ${id}, 1, ${tx.json(spec as never)}, 'Original generation', 'Initial validated project', ${now})`;
  });
}

export async function getProject(id: string): Promise<ProjectSpec | null> {
  await ensureSchema();
  const rows = await database()`SELECT spec, created_at FROM projects WHERE id = ${id}`;
  if (!rows[0]) return null;
  await ensureBaseline(id, rows[0].spec, rows[0].created_at);
  return parsedSpec(rows[0].spec);
}

export async function getProjectPrompt(id: string) {
  await ensureSchema();
  const rows = await database()`SELECT prompt FROM projects WHERE id = ${id}`;
  return rows[0]?.prompt as string | undefined || null;
}

export async function getCurrentRevision(id: string) {
  await ensureSchema();
  const rows = await database()`SELECT COALESCE(MAX(revision), 0)::int revision FROM project_revisions WHERE project_id = ${id}`;
  return rows[0]?.revision as number || 0;
}

export async function listRecentProjects(limit = 8) {
  await ensureSchema();
  const rows = await database()`SELECT p.id, p.spec, COALESCE(MAX(r.revision), 1)::int revision,
    COALESCE(MAX(r.created_at), p.created_at) updated_at
    FROM projects p LEFT JOIN project_revisions r ON r.project_id = p.id
    GROUP BY p.id ORDER BY updated_at DESC LIMIT ${limit}`;
  return rows.map((row) => { const project = parsedSpec(row.spec); return { id: row.id as string, title: project.title,
    summary: project.summary, components: project.components.length, revision: row.revision as number, updatedAt: row.updated_at as string }; });
}

export async function listRevisions(projectId: string) {
  await ensureSchema();
  const rows = await database()`SELECT revision, spec, change_request, summary, created_at
    FROM project_revisions WHERE project_id = ${projectId} ORDER BY revision DESC`;
  return rows.map((row) => ({ revision: row.revision as number, spec: JSON.stringify(row.spec),
    change_request: row.change_request as string, summary: row.summary as string, created_at: row.created_at as string }));
}

export async function saveChangePreview(projectId: string, request: string, spec: ProjectSpec, impact: unknown) {
  await ensureSchema();
  const sql = database();
  const id = randomUUID();
  const now = new Date().toISOString();
  await sql.begin(async (tx) => {
    await tx`UPDATE change_previews SET applied_at = ${now} WHERE project_id = ${projectId} AND applied_at IS NULL`;
    await tx`INSERT INTO change_previews (id, project_id, request, spec, impact, created_at)
      VALUES (${id}, ${projectId}, ${request}, ${tx.json(spec as never)}, ${tx.json(impact as never)}, ${now})`;
  });
  return id;
}

export async function getLatestChangePreview(projectId: string) {
  await ensureSchema();
  const rows = await database()`SELECT id, request, spec, impact, created_at FROM change_previews
    WHERE project_id = ${projectId} AND applied_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  return { id: row.id as string, request: row.request as string, spec: parsedSpec(row.spec), impact: row.impact as unknown, createdAt: row.created_at as string };
}

export type AssistantMessage = { id: string; role: "user" | "assistant"; kind: string; content: string; metadata: Record<string, unknown> | null; createdAt: string };

export async function saveAssistantMessage(projectId: string, role: AssistantMessage["role"], kind: string, content: string, metadata?: Record<string, unknown>) {
  await ensureSchema();
  const sql = database();
  const message = { id: randomUUID(), role, kind, content, metadata: metadata || null, createdAt: new Date().toISOString() } satisfies AssistantMessage;
  await sql`INSERT INTO assistant_messages (id, project_id, role, kind, content, metadata, created_at)
    VALUES (${message.id}, ${projectId}, ${role}, ${kind}, ${content}, ${metadata ? sql.json(metadata as never) : null}, ${message.createdAt})`;
  return message;
}

export async function listAssistantMessages(projectId: string, limit = 30): Promise<AssistantMessage[]> {
  await ensureSchema();
  const rows = await database()`SELECT * FROM (SELECT id, role, kind, content, metadata, created_at FROM assistant_messages
    WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT ${limit}) messages ORDER BY created_at`;
  return rows.map((row) => ({ id: row.id as string, role: row.role as AssistantMessage["role"], kind: row.kind as string,
    content: row.content as string, metadata: row.metadata as Record<string, unknown> | null, createdAt: row.created_at as string }));
}

export async function getChangePreview(projectId: string, previewId: string) {
  await ensureSchema();
  const rows = await database()`SELECT request, spec, impact FROM change_previews
    WHERE id = ${previewId} AND project_id = ${projectId} AND applied_at IS NULL`;
  const row = rows[0];
  return row ? { request: row.request as string, spec: parsedSpec(row.spec), impact: row.impact as unknown } : null;
}

export async function applyChangePreview(projectId: string, previewId: string) {
  await ensureSchema();
  return database().begin(async (tx) => {
    const rows = await tx`SELECT request, spec, impact FROM change_previews
      WHERE id = ${previewId} AND project_id = ${projectId} AND applied_at IS NULL FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new Error("This change preview is missing or has already been applied.");
    const spec = parsedSpec(row.spec);
    const current = await tx`SELECT COALESCE(MAX(revision), 0)::int revision FROM project_revisions WHERE project_id = ${projectId}`;
    const revision = (current[0]?.revision as number || 0) + 1;
    const now = new Date().toISOString();
    await tx`UPDATE projects SET spec = ${tx.json(spec as never)} WHERE id = ${projectId}`;
    await tx`INSERT INTO project_revisions (id, project_id, revision, spec, change_request, summary, created_at)
      VALUES (${randomUUID()}, ${projectId}, ${revision}, ${tx.json(spec as never)}, ${row.request as string},
      ${(row.impact as { summary?: string })?.summary || "Applied validated change"}, ${now})`;
    await tx`UPDATE change_previews SET applied_at = ${now} WHERE id = ${previewId}`;
    return revision;
  });
}

export async function restoreRevision(projectId: string, targetRevision: number) {
  await ensureSchema();
  return database().begin(async (tx) => {
    const targets = await tx`SELECT spec FROM project_revisions WHERE project_id = ${projectId} AND revision = ${targetRevision} FOR UPDATE`;
    if (!targets[0]) throw new Error("Revision not found.");
    const spec = parsedSpec(targets[0].spec);
    const current = await tx`SELECT COALESCE(MAX(revision), 0)::int revision FROM project_revisions WHERE project_id = ${projectId}`;
    const revision = (current[0]?.revision as number || 0) + 1;
    await tx`UPDATE projects SET spec = ${tx.json(spec as never)} WHERE id = ${projectId}`;
    await tx`INSERT INTO project_revisions (id, project_id, revision, spec, change_request, summary, created_at)
      VALUES (${randomUUID()}, ${projectId}, ${revision}, ${tx.json(spec as never)}, ${`Restore revision ${targetRevision}`},
      ${`Restored drawing revision ${targetRevision}`}, ${new Date().toISOString()})`;
    return revision;
  });
}
