import { execFile } from "node:child_process";
import type { PiRuntime } from "./piResolver";

export interface PiModel {
  provider: string;
  /** Bare model id, e.g. "gpt-5.5". */
  model: string;
  /** Qualified id passed back to pi via --model, e.g. "openai-codex/gpt-5.5". */
  id: string;
  /** Whether pi reports the model supports a thinking level. */
  thinking: boolean;
}

// Provider slug → API-key env var, per `pi --help`. Used for BYOK: setting one of
// these (then restarting pi) makes that provider's models appear in --list-models.
export const PROVIDER_ENV_VARS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  kimi: "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  zai: "ZAI_API_KEY",
};

// `pi --list-models` prints fixed-width columns:
//   provider  model  context  max-out  thinking  images
// (header row, then one flat row per model; 2-space gutters; empty result is the
// single line `No models matching "<query>"`). Split on runs of 2+ spaces — cell
// values are hyphenated, never internally space-separated.
export function parseListModels(stdout: string): PiModel[] {
  return stdout
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0)
    .filter((line) => !/^No models matching/i.test(line))
    .filter((line) => !/^provider\s+model\b/i.test(line))
    .map((line) => line.trim().split(/ {2,}/))
    .filter((cols) => cols.length >= 2 && cols[0] && cols[1])
    .map((cols) => ({
      provider: cols[0],
      model: cols[1],
      id: `${cols[0]}/${cols[1]}`,
      thinking: (cols[4] ?? "").toLowerCase() === "yes",
    }));
}

// Runs `pi --list-models` using the same launch recipe the broker uses (executable
// vs node-script), with BYOK keys injected so authed providers show up. Resolves to
// [] on any failure so the picker degrades gracefully.
export function listPiModels(
  runtime: PiRuntime,
  options: { cwd?: string; secrets?: Record<string, string>; timeoutMs?: number } = {},
): Promise<PiModel[]> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let command: string;
  let args: string[];
  if (runtime.launchKind === "node-script") {
    command = runtime.nodePath ?? process.execPath;
    args = [runtime.piEntry, "--list-models"];
    if (runtime.runAsNode) env.ELECTRON_RUN_AS_NODE = "1";
    else delete env.ELECTRON_RUN_AS_NODE;
  } else {
    command = runtime.piEntry;
    args = ["--list-models"];
    delete env.ELECTRON_RUN_AS_NODE;
  }
  for (const [name, value] of Object.entries(options.secrets ?? {})) {
    if (value) env[name] = value;
  }

  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, env, encoding: "utf8", timeout: options.timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve([]);
          return;
        }
        // pi prints the --list-models table to stderr (stdout is empty) when stdio
        // is piped/non-TTY, so parse both streams.
        resolve(parseListModels(`${stdout ?? ""}\n${stderr ?? ""}`));
      },
    );
  });
}
