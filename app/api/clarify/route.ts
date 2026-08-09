import { NextResponse } from "next/server";
import { clarifyProject } from "@/lib/clarify";
import { looksBeyondCircuitScope, complexityRejectMessage } from "@/lib/scope-proposal";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { prompt?: unknown };
    if (typeof body.prompt !== "string" || body.prompt.trim().length < 10 || body.prompt.length > 1000) {
      return NextResponse.json({ error: "Describe the project in 10–1000 characters." }, { status: 400 });
    }
    const prompt = body.prompt.trim();
    if (looksBeyondCircuitScope(prompt)) {
      return NextResponse.json({
        error: complexityRejectMessage("the brief asks for ML, translation, computer vision, apps, or other product-scale work"),
        code: "TOO_COMPLEX",
      }, { status: 422 });
    }
    return NextResponse.json(await clarifyProject(prompt));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Clarify failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
