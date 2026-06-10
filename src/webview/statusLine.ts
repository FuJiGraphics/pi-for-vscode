// Derives the "what is Pi doing right now" chip for the assistant status header:
// the last running step wins — a streaming thinking block reads "Thinking… <last line>",
// a running tool reads "Read · cards.ts". Falls back to the step count when nothing is
// actively running (e.g. between a tool's end and the next generation).
// Pure and DOM-free; render.ts owns where the text lands (.status-task).
import { stepDetail, shortenDetail } from "./cards";
import { isThinkingStep, thinkingPreview } from "./thinkingSteps";
import type { ActivityStep, UiMessage } from "./types";

export interface CurrentWork {
  label: string;
  detail: string;
}

export function currentWork(steps: ActivityStep[]): CurrentWork | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.status !== "running" || step.kind === "generation") continue;
    if (isThinkingStep(step)) return { label: "Thinking…", detail: thinkingPreview(step, "last") };
    return { label: step.label, detail: shortenDetail(stepDetail(step)) };
  }
  return null;
}

export function statusTaskText(message: UiMessage): string {
  const steps = message.activity?.steps ?? [];
  const work = currentWork(steps);
  if (work) return work.detail ? work.label + " · " + work.detail : work.label;
  return steps.length ? steps.length + " step" + (steps.length > 1 ? "s" : "") : "";
}
