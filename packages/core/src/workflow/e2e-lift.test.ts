/**
 * End-to-end test for workflow lift-from-trace.
 *
 * Flow: Create atomic tools → invoke them → collect trace → lift to workflow →
 *       validate lifted workflow → execute lifted workflow → compare results.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { Tracer } from "../tracer.ts";
import { WorkflowExecutor } from "./executor.ts";
import { liftFromTrace } from "./lift.ts";
import { validate } from "./validator.ts";
import { renderLiterate } from "./renderer.ts";
import { toolError } from "../errors.ts";
import type { ToolResult } from "../types.ts";
import { ARG_KIND } from "./types.ts";
import { parameterize } from "./parameterize.ts";
import { makeConsistentApproval, makeConsistentCodeTool, makeConsistentWorkflowTool } from "../testing/tool-fixtures.ts";
import type { CodeTool } from "../tool.ts";
import { TOOL_KIND } from "../types.ts";

const DOUBLE_CODE = `export async function run(input) { return input.n * 2; }`;
const DOUBLE_TOOL = makeConsistentCodeTool(
  {
    name: "double",
    description: "Doubles a number",
    rationale: "Basic math",
    inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    outputShape: { type: "number" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 64 },
    createdAt: "2026-01-01T00:00:00Z",
    kind: "atomic",
  },
  DOUBLE_CODE,
);

const ADD_CODE = `export async function run(input) { return input.a + input.b; }`;
const ADD_TOOL = makeConsistentCodeTool(
  {
    name: "add",
    description: "Adds two numbers",
    rationale: "Basic math",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    outputShape: { type: "number" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 64 },
    createdAt: "2026-01-01T00:00:00Z",
    kind: "atomic",
  },
  ADD_CODE,
);

const SQUARE_CODE = `export async function run(input) { return input.n * input.n; }`;
const SQUARE_TOOL = makeConsistentCodeTool(
  {
    name: "square",
    description: "Squares a number",
    rationale: "Basic math",
    inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    outputShape: { type: "number" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 64 },
    createdAt: "2026-01-01T00:00:00Z",
    kind: "atomic",
  },
  SQUARE_CODE,
);

function saveWithApproval(registry: Awaited<ReturnType<typeof FsToolRegistry.open>>, tool: CodeTool) {
  return registry.saveCode(tool, makeConsistentApproval(tool, { alwaysApprove: true }));
}

async function setupTestEnv() {
  const dir = await mkdtemp(join(tmpdir(), "workflow-e2e-"));
  const registry = await FsToolRegistry.open(join(dir, "tools"));
  const tracer = await Tracer.open(join(dir, "traces"), "e2e");
  const sandbox = new NodePermissionSandbox({ workspace: dir, maxDepth: 3, maxOutputBytes: 1024 * 1024 });
  return { dir, registry, tracer, sandbox };
}

test("E2E: lift trace to workflow and execute with parity", async () => {
  const { dir, registry, tracer, sandbox } = await setupTestEnv();
  try {
    // Register atomic tools
    await saveWithApproval(registry, DOUBLE_TOOL);
    await saveWithApproval(registry, ADD_TOOL);
    await saveWithApproval(registry, SQUARE_TOOL);

    // Simulate a session: invoke tools and collect results
    // Session: double(5) → add(10, 3) → square(13) = 169
    const invocations: Array<{ name: string; args: unknown; ok: boolean; value: unknown }> = [];

    // Step 1: double(5) = 10
    const result1 = await sandbox.execute(DOUBLE_TOOL, { n: 5 });
    assert.equal(result1.ok, true);
    const inv0 = { name: "double", args: { n: 5 }, ok: result1.ok, value: result1.ok ? result1.value : null };
    invocations.push(inv0);

    // Step 2: add(10, 3) = 13
    const result2 = await sandbox.execute(ADD_TOOL, { a: 10, b: 3 });
    assert.equal(result2.ok, true);
    const inv1 = { name: "add", args: { a: 10, b: 3 }, ok: result2.ok, value: result2.ok ? result2.value : null };
    invocations.push(inv1);

    // Step 3: square(13) = 169
    const result3 = await sandbox.execute(SQUARE_TOOL, { n: 13 });
    assert.equal(result3.ok, true);
    const inv2 = { name: "square", args: { n: 13 }, ok: result3.ok, value: result3.ok ? result3.value : null };
    invocations.push(inv2);

    // Store expected final result
    const expectedResult = 169;
    console.log("\n=== Original Session Results ===");
    console.log(`Step 1: double(5) = ${inv0.value}`);
    console.log(`Step 2: add(10, 3) = ${inv1.value}`);
    console.log(`Step 3: square(13) = ${inv2.value}`);
    console.log(`Final result: ${expectedResult}`);

    // Build toolsByName for lift
    const toolsByName: Record<string, CodeTool> = {
      double: DOUBLE_TOOL,
      add: ADD_TOOL,
      square: SQUARE_TOOL,
    };

    // Lift to workflow
    const liftResult = liftFromTrace({
      slice: invocations,
      name: "double-add-square",
      description: "Doubles a number, adds 3, then squares the result",
      goal: "Compute (n*2 + 3)^2",
      toolsByName,
    });

    assert.equal(liftResult.ok, true);
    if (!liftResult.ok) return;

    const { workflow, manifest, literalFallbacks } = liftResult;

    console.log("\n=== Lifted Workflow ===");
    console.log(renderLiterate(workflow));

    console.log("\n=== Literal Fallbacks ===");
    if (literalFallbacks.length === 0) {
      console.log("(none - all arguments matched)");
    } else {
      for (const fb of literalFallbacks) {
        console.log(`  ${fb.stepLabel}.${fb.argName}: ${fb.canonicalValue.slice(0, 80)}`);
      }
    }

    // Validate the workflow
    const validation = await validate(workflow, registry);
    if (!validation.ok) {
      console.log("Validation errors:", validation.errors);
      assert.fail("workflow validation failed");
    }

    // Execute the lifted workflow
    const executor = new WorkflowExecutor({ tracer });
    const dispatch = async (name: string, args: unknown): Promise<ToolResult> => {
      const tool = await registry.getCode(name);
      if (!tool) return toolError("unknown_tool", name);
      return sandbox.execute(tool, args);
    };

    const execResult = await executor.run(workflow, {}, dispatch, 0);

    console.log("\n=== Lifted Workflow Execution ===");
    console.log(`Success: ${execResult.ok}`);
    if (execResult.ok) {
      console.log(`Result: ${execResult.value}`);
    } else {
      console.log(`Error: ${execResult.error.kind} - ${execResult.error.message}`);
    }

    // Verify parity with original
    assert.equal(execResult.ok, true);
    if (execResult.ok) {
      assert.equal(execResult.value, expectedResult);
      console.log("\n✅ Parity check passed: Lifted workflow produces same result as original session");
    }

    // Verify workflow structure
    assert.equal(workflow.steps.length, 3);
    const [step0, step1, step2] = workflow.steps;
    assert.ok(step0 && step1 && step2);
    assert.equal(step0.tool, "double");
    assert.equal(step1.tool, "add");
    assert.equal(step2.tool, "square");

    const step0N = step0.arguments.n;
    const step1A = step1.arguments.a;
    const step1B = step1.arguments.b;
    const step2N = step2.arguments.n;
    assert.ok(step0N && step1A && step1B && step2N);

    // Step 2 should use symref for 'a' (from step 1)
    assert.equal(step1A.kind, ARG_KIND.symref);
    // Step 3 should use symref for 'n' (from step 2)
    assert.equal(step2N.kind, ARG_KIND.symref);
    // 'b' in step 2 and 'n' initial in step 1 should be literals
    assert.equal(step0N.kind, ARG_KIND.literal);
    assert.equal(step1B.kind, ARG_KIND.literal);

    // Save the workflow tool to registry (demonstrating persistence)
    const { hash: _drop, ...manifestSansHash } = manifest;
    const workflowTool = makeConsistentWorkflowTool({ ...manifestSansHash, kind: TOOL_KIND.WORKFLOW }, workflow);
    await registry.saveWorkflow(workflowTool, makeConsistentApproval(workflowTool, { alwaysApprove: true }));

    // Verify registry can load it back
    const loadedWf = await registry.getWorkflow("double-add-square");
    assert.ok(loadedWf);
    if (loadedWf) {
      assert.equal(loadedWf.workflow.name, "double-add-square");
      assert.equal(loadedWf.workflow.steps.length, 3);
      console.log("\n✅ Workflow saved and rehydrated successfully");
    }

    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2E: lift with dataflow dependencies", async () => {
  const { dir, registry, tracer, sandbox } = await setupTestEnv();
  try {
    // Register tools
    await saveWithApproval(registry, DOUBLE_TOOL);
    await saveWithApproval(registry, ADD_TOOL);

    // Session: double(7) → add(14, 5) = 19
    // The '14' in step 2 is the result of step 1
    const invocations = [
      { name: "double", args: { n: 7 }, ok: true as const, value: 14 },
      { name: "add", args: { a: 14, b: 5 }, ok: true as const, value: 19 },
    ];

    const toolsByName = { double: DOUBLE_TOOL, add: ADD_TOOL };

    const liftResult = liftFromTrace({
      slice: invocations,
      name: "double-then-add",
      description: "Doubles then adds",
      goal: "Compute n*2 + m",
      toolsByName,
    });

    assert.equal(liftResult.ok, true);
    if (!liftResult.ok) return;

    const { workflow } = liftResult;

    console.log("\n=== Dataflow Test ===");
    console.log(renderLiterate(workflow));

    // Verify dataflow: step 2's 'a' should be symref to step 1's binding
    const [dfStep0, dfStep1] = workflow.steps;
    assert.ok(dfStep0 && dfStep1);
    const aArg = dfStep1.arguments.a;
    assert.ok(aArg);
    assert.equal(aArg.kind, ARG_KIND.symref);
    if (aArg.kind === ARG_KIND.symref) {
      assert.equal(aArg.ref, dfStep0.resultBinding);
    }

    // Execute
    const executor = new WorkflowExecutor({ tracer });
    const dispatch = async (name: string, args: unknown): Promise<ToolResult> => {
      const tool = await registry.getCode(name);
      if (!tool) return toolError("unknown_tool", name);
      return sandbox.execute(tool, args);
    };

    const result = await executor.run(workflow, {}, dispatch, 0);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value, 19);
      console.log("✅ Dataflow works: result =", result.value);
    }

    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2E: parameterized workflow runs with caller inputs and defaults", async () => {
  const { dir, registry, tracer, sandbox } = await setupTestEnv();
  try {
    await saveWithApproval(registry, ADD_TOOL);

    const invocations = [{ name: "add", args: { a: 2, b: 3 }, ok: true as const, value: 5 }];
    const lifted = liftFromTrace({ slice: invocations, name: "add-wf", description: "", goal: "", toolsByName: { add: ADD_TOOL } });
    assert.equal(lifted.ok, true);
    if (!lifted.ok) return;

    const pr = parameterize(lifted.workflow, [
      { stepLabel: "step_0_add", argName: "a", paramName: "a", required: true },
      { stepLabel: "step_0_add", argName: "b", paramName: "b", required: false },
    ]);
    assert.equal(pr.ok, true);
    if (!pr.ok) return;
    const workflow = pr.workflow;

    const validation = await validate(workflow, registry);
    assert.equal(validation.ok, true, validation.ok ? "" : validation.errors.map((e) => e.code).join(","));

    const executor = new WorkflowExecutor({ tracer });
    const dispatch = async (name: string, args: unknown): Promise<ToolResult> => {
      const tool = await registry.getCode(name);
      if (!tool) return toolError("unknown_tool", name);
      return sandbox.execute(tool, args);
    };

    // Provide both inputs.
    const r1 = await executor.run(workflow, { a: 10, b: 20 }, dispatch, 0);
    assert.equal(r1.ok, true);
    if (r1.ok) assert.equal(r1.value, 30);

    // Omit optional b → falls back to default (3, the original literal value at lift time).
    const r2 = await executor.run(workflow, { a: 100 }, dispatch, 0);
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.value, 103);

    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
