#!/usr/bin/env node
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "./config.ts";
import { runRepl } from "./repl.ts";

async function main() {
  loadDotenv({ path: resolve(process.cwd(), ".env") });

  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c", default: "./config/meta-agent.json" },
      yolo:   { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const configPath = resolve(values.config!);
  loadDotenv({ path: resolve(dirname(configPath), ".env") });

  const cfg = await loadConfig(configPath);
  if (values.yolo) cfg.yolo = true;
  await runRepl(cfg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
