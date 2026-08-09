import JSZip from "jszip";
import { getProject } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) return new Response("Project not found", { status: 404 });

  const zip = new JSZip();
  zip.file("platformio.ini", project.files.platformioIni);
  zip.file("src/main.cpp", project.files.mainCpp);
  zip.file("README.md", `# ${project.title}\n\n${project.summary}\n\n## Assembly\n\n${project.instructions.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n`);
  const body = await zip.generateAsync({ type: "uint8array" });
  return new Response(body.buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.zip"`,
    },
  });
}
