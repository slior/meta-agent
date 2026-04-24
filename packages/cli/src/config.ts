import { readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";

export type Config = {
  llm: { baseURL?: string; model: string; apiKeyEnv: string };
  workspace: string;
  toolsDir: string;
  tracesDir: string;
  yolo: boolean;
  /** Set by CLI after loadConfig; not read from config JSON. */
  debug?: boolean;
  maxTurns: number;
  sandbox: { maxDepth: number; maxOutputBytes: number };
};

export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<Config>;
  const base = dirname(path);

  const llmIn = parsed.llm ?? { model: "gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY" };
  if (!llmIn.model) throw new Error("config.llm.model is required");
  if (!llmIn.apiKeyEnv) throw new Error("config.llm.apiKeyEnv is required");

  const llm: Config["llm"] = {
    model: llmIn.model,
    apiKeyEnv: llmIn.apiKeyEnv,
    ...(llmIn.baseURL !== undefined ? { baseURL: llmIn.baseURL } : {}),
  };

  return {
    llm,
    workspace: abs(parsed.workspace ?? "./workspace", base),
    toolsDir: abs(parsed.toolsDir ?? "./tools", base),
    tracesDir: abs(parsed.tracesDir ?? "./traces", base),
    yolo: parsed.yolo ?? false,
    maxTurns: parsed.maxTurns ?? 20,
    sandbox: {
      maxDepth: parsed.sandbox?.maxDepth ?? 8,
      maxOutputBytes: parsed.sandbox?.maxOutputBytes ?? 1_048_576,
    },
  };
}

function abs(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}
