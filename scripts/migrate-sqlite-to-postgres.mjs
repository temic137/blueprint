import { DatabaseSync } from "node:sqlite";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not configured.");

const source = new DatabaseSync("blueprint.db", { readOnly: true });
const sql = postgres(url, { max: 1, prepare: false, ssl: "require", connect_timeout: 10 });

await sql.begin(async (tx) => {
  await tx`CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY, prompt text NOT NULL, spec jsonb NOT NULL, created_at text NOT NULL)`;
  await tx`CREATE TABLE IF NOT EXISTS project_revisions (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, revision integer NOT NULL, spec jsonb NOT NULL, change_request text NOT NULL, summary text NOT NULL, created_at text NOT NULL, UNIQUE(project_id, revision))`;
  await tx`CREATE TABLE IF NOT EXISTS change_previews (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, request text NOT NULL, spec jsonb NOT NULL, impact jsonb NOT NULL, created_at text NOT NULL, applied_at text)`;
  await tx`CREATE TABLE IF NOT EXISTS assistant_messages (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, role text NOT NULL CHECK(role IN ('user', 'assistant')), kind text NOT NULL, content text NOT NULL, metadata jsonb, created_at text NOT NULL)`;
  await tx`CREATE INDEX IF NOT EXISTS assistant_messages_project_created ON assistant_messages(project_id, created_at)`;
  await tx`CREATE TABLE IF NOT EXISTS component_candidates (id text PRIMARY KEY, source_name text NOT NULL, source_url text, datasheet_excerpt text NOT NULL, manifest jsonb NOT NULL, review jsonb NOT NULL, status text NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')), created_at text NOT NULL, reviewed_at text)`;
  await tx`CREATE INDEX IF NOT EXISTS component_candidates_status_created ON component_candidates(status, created_at)`;
  await tx`CREATE TABLE IF NOT EXISTS component_manifests (id text PRIMARY KEY, manifest jsonb NOT NULL, updated_at text NOT NULL)`;

  for (const row of source.prepare("SELECT * FROM projects").all()) {
    await tx`INSERT INTO projects VALUES (${row.id}, ${row.prompt}, ${tx.json(JSON.parse(row.spec))}, ${row.created_at}) ON CONFLICT (id) DO NOTHING`;
  }
  for (const row of source.prepare("SELECT * FROM project_revisions").all()) {
    await tx`INSERT INTO project_revisions VALUES (${row.id}, ${row.project_id}, ${row.revision}, ${tx.json(JSON.parse(row.spec))}, ${row.change_request}, ${row.summary}, ${row.created_at}) ON CONFLICT (id) DO NOTHING`;
  }
  for (const row of source.prepare("SELECT * FROM change_previews").all()) {
    await tx`INSERT INTO change_previews VALUES (${row.id}, ${row.project_id}, ${row.request}, ${tx.json(JSON.parse(row.spec))}, ${tx.json(JSON.parse(row.impact))}, ${row.created_at}, ${row.applied_at}) ON CONFLICT (id) DO NOTHING`;
  }
  for (const row of source.prepare("SELECT * FROM assistant_messages").all()) {
    await tx`INSERT INTO assistant_messages VALUES (${row.id}, ${row.project_id}, ${row.role}, ${row.kind}, ${row.content}, ${row.metadata ? tx.json(JSON.parse(row.metadata)) : null}, ${row.created_at}) ON CONFLICT (id) DO NOTHING`;
  }
  for (const row of source.prepare("SELECT * FROM component_candidates").all()) {
    await tx`INSERT INTO component_candidates VALUES (${row.id}, ${row.source_name}, ${row.source_url}, ${row.datasheet_excerpt}, ${tx.json(JSON.parse(row.manifest))}, ${tx.json(JSON.parse(row.review))}, ${row.status}, ${row.created_at}, ${row.reviewed_at}) ON CONFLICT (id) DO NOTHING`;
  }
});

for (const table of ["projects", "project_revisions", "change_previews", "assistant_messages", "component_candidates", "component_manifests"]) {
  const [{ count }] = await sql.unsafe(`SELECT count(*)::int count FROM ${table}`);
  console.log(`${table}: ${count}`);
}

await sql.end();
source.close();
