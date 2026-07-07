// The single "start a new session" entry point (toolbar + button, /new command). The
// visible view swaps to a fresh provisional composer IMMEDIATELY — no host round-trip —
// then the host commits a real session in the background and its `activate` re-keys the
// provisional view (promoteProvisional). Clicking + while already on the fresh provisional
// composer just re-focuses it instead of spawning another session.
import { beginProvisionalSession, state } from "./state";
import { scheduleRender } from "./render";
import { resetScrollFollowing } from "./scroll";
import { closeHistory } from "./history";
import { closeModelPicker } from "./modelPicker";
import { closeSettings } from "./settingsPanel";
import { cancelEdit } from "./input";
import { inputEl } from "./dom";
import { post } from "./bridge";

export function startNewSession(): void {
  closeHistory();
  closeModelPicker();
  closeSettings();
  cancelEdit();
  // An untouched, idle session (0 messages — committed or provisional) already IS a fresh
  // composer: repeated + clicks must not stack up more empty sessions/tabs.
  if (state.messages.length === 0 && !state.running) {
    inputEl.focus();
    return;
  }
  if (beginProvisionalSession()) {
    resetScrollFollowing();
    scheduleRender();
    post({ type: "newSession" });
  }
  inputEl.focus();
}
