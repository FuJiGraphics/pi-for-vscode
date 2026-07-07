// The pi status strip: a slim line pinned above the composer for the whole run — the
// panel's signature element (Claude Code keeps its status line at the bottom the same
// way). pi.dev's block mark ticks, a pixel-font gerund rotates every 2.5s, and the live
// facts read alongside: elapsed seconds, the current step, and the turn's token total.
// Painted per frame by the animator; render() flips its visibility on run state.
import { state } from "./state";
import { statusStripEl } from "./dom";
import { thinkingLabel } from "./spinner";
import { piMarkHtml } from "./piMark";
import { pixelWordHtml } from "./pixelFont";
import { statusTaskText } from "./statusLine";
import { tokCost } from "./cards";

let mounted = false;

function mount(): void {
  statusStripEl.innerHTML =
    piMarkHtml("spinner") +
    '<span class="pixel-word"></span>' +
    '<span class="strip-time"></span>' +
    '<span class="strip-task"></span>' +
    '<span class="strip-usage"></span>' +
    '<span class="strip-hint">esc to stop</span>';
  mounted = true;
}

function setText(selector: string, value: string): void {
  const el = statusStripEl.querySelector(selector);
  if (el && el.textContent !== value) el.textContent = value;
}

export function paintStatusStrip(): void {
  if (!state.running) {
    if (!statusStripEl.hidden) {
      statusStripEl.hidden = true;
      statusStripEl.innerHTML = "";
      mounted = false;
    }
    return;
  }
  if (statusStripEl.hidden) statusStripEl.hidden = false;
  if (!mounted) mount();

  const message = state.messages.find((m) => m.id === state.currentAssistantId);
  const { word, seconds } = thinkingLabel(message?.createdAt ?? Date.now());
  const wordEl = statusStripEl.querySelector(".pixel-word");
  if (wordEl && wordEl.getAttribute("data-word") !== word) {
    wordEl.setAttribute("data-word", word);
    wordEl.innerHTML = pixelWordHtml(word);
  }
  setText(".strip-time", seconds > 0 ? seconds + "s" : "");
  setText(".strip-task", message ? statusTaskText(message) : "");
  setText(".strip-usage", message?.tokens ? tokCost(message.tokens, message.cost || 0) : "");
}
