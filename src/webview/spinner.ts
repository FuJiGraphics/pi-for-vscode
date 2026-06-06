// "thinking" spinner data: a whimsical gerund + elapsed seconds, derived purely
// from a start time. The visual icon is pi.dev's block logo (see piMark.ts); the
// word is rendered as a pixel banner (see pixelFont.ts).

// A curated subset of Claude Code's spinner verbs.
const SPINNER_WORDS = [
  "Accomplishing", "Baking", "Brewing", "Calculating", "Cerebrating", "Churning",
  "Coalescing", "Cogitating", "Composing", "Computing", "Concocting", "Considering",
  "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Crystallizing",
  "Deciphering", "Deliberating", "Determining", "Elucidating", "Envisioning",
  "Fermenting", "Forging", "Formulating", "Generating", "Hatching", "Ideating",
  "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating", "Mulling",
  "Musing", "Noodling", "Orchestrating", "Percolating", "Pondering", "Processing",
  "Puzzling", "Reticulating", "Ruminating", "Simmering", "Sketching", "Spelunking",
  "Stewing", "Synthesizing", "Thinking", "Tinkering", "Unfurling", "Working", "Wrangling",
];

// Cheap deterministic scramble so consecutive word slots look unordered.
function scramble(n: number): number {
  let x = ((n + 1) * 2654435761) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return x;
}

export interface ThinkingLabel {
  word: string;
  seconds: number;
}

export function thinkingLabel(startedAt: number): ThinkingLabel {
  const elapsed = Math.max(0, Date.now() - startedAt);
  const word = SPINNER_WORDS[scramble(Math.floor(elapsed / 2500)) % SPINNER_WORDS.length];
  return { word, seconds: Math.floor(elapsed / 1000) };
}
