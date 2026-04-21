#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { runRepl } from "./repl.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c", default: "./config/meta-agent.json" },
      yolo:   { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const cfg = await loadConfig(resolve(values.config!));
  if (values.yolo) cfg.yolo = true;
  await runRepl(cfg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
