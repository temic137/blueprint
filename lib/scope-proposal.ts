/** Blueprint v1: simple breadboard projects only. Over-scope ideas are rejected outright. */

/** Heuristic: idea needs ML/software/product work beyond a simple wired circuit. */
export function looksBeyondCircuitScope(prompt: string) {
  return /\b(machine learning|\bML\b|neural|deep learning|train(ed|ing)? (a )?model|tensorflow|pytorch|llm|large language|computer vision|sign language|speech (to )?text|voice recognition|natural language|translate\w*|full[- ]?stack|mobile app|cloud backend|saas|dataset|inference server|recognil[sz]e|classifier)\b/i.test(prompt);
}

export function isComplexityValidationFailure(errors: readonly string[]) {
  const text = errors.join("\n");
  return /too_big|too big|components.*(max|maximum|at most|more than|<=\s*12)|more than 12|at most 12|too many parts/i.test(text);
}

export function complexityRejectMessage(reason: string) {
  return [
    "I can't build this.",
    "Blueprint currently only drafts simple low-voltage breadboard projects (about ≤12 parts): buttons, LEDs, buzzers, basic sensors, straightforward wiring.",
    "It does not build ML, translation, computer vision, apps, or other product-scale systems.",
    reason ? `Why this was rejected: ${reason}` : "",
    "Try a simpler hardware brief — for example: “Arduino doorbell with a pushbutton and buzzer.”",
  ].filter(Boolean).join(" ");
}
