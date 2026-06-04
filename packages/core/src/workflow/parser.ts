import Ajv, { type ErrorObject } from "ajv";
import { WORKFLOW_SCHEMA } from "./schema.ts";
import type { Workflow } from "./types.ts";

export type ParseError = {
  pointer: string;
  message: string;
};

export type ParseResult =
  | { ok: true; workflow: Workflow }
  | { ok: false; errors: ParseError[] };

const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(WORKFLOW_SCHEMA);

export function parseWorkflow(input: unknown): ParseResult {
  if (validate(input)) {
    return { ok: true, workflow: input as Workflow };
  }
  return { ok: false, errors: (validate.errors ?? []).map(toParseError) };
}

function toParseError(e: ErrorObject): ParseError {
  return {
    pointer: e.instancePath || "/",
    message: `${e.message ?? "invalid"}${e.params ? " " + JSON.stringify(e.params) : ""}`,
  };
}
