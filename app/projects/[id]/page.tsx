import { notFound } from "next/navigation";
import ProjectWorkspace from "@/components/project-workspace";
import { projectToCircuitJson } from "@/lib/circuit-json";
import { getCurrentRevision, getProject } from "@/lib/db";
import { convertCircuitJsonToSchematicSvg } from "circuit-to-svg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();
  let schematicImage = "";
  try { schematicImage = `data:image/svg+xml;base64,${Buffer.from(convertCircuitJsonToSchematicSvg(projectToCircuitJson(project) as never[])).toString("base64")}`; }
  catch (error) { console.error("Schematic SVG generation failed; physical wiring remains available", error); }
  return <ProjectWorkspace id={id} project={project} revision={await getCurrentRevision(id)} schematicImage={schematicImage} />;
}
