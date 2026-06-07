import { APPROVAL_DECISION, type ApprovalPolicy } from "../approval/interface.ts";
import { CHAT_ROLE, type LLMProvider } from "../llm/interface.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";
import type { ApprovalRecord, Tool, ToolDraft, ToolManifest, ToolResult } from "../types.ts";
import { hashTool } from "../hash.ts";
import { normalizePermissions } from "../permissions-normalize.ts";
import { staticValidateDraft, type ValidationResult } from "./static-validator.ts";
import { atomicPrompt, compositePrompt, repairPrompt, DRAFT_SCHEMA } from "./code-gen-prompts.ts";
import { TRACE_KIND_FACTORY_REPAIR_LLM, type Tracer } from "../tracer.ts";
import { liftFromTrace, inputSchemaFromInputs, type Invocation, type LiftResult, type LiteralFallback } from "../workflow/lift.ts";
import { parameterize, type Promotion } from "../workflow/parameterize.ts";
import { validate as validateWorkflow } from "../workflow/validator.ts";
import { renderLiterate } from "../workflow/renderer.ts";
import type { Workflow } from "../workflow/types.ts";

export type CreateAtomicReq = {
  intent: string;
  rationale: string;
  existingToolsConsidered: string[];
};

export type CreateCompositeReq = {
  name: string;
  intent: string;
  plannedSteps: Array<{ tool: string; argsTemplate: string }>;
};

export type CreateWorkflowReq = {
  slice: Invocation[];
  name: string;
  intent: string;
  description: string;
  promotions?: Promotion[];
};

export type PreviewWorkflowOutcome =
  | { ok: true; workflow: Workflow; literalFallbacks: LiteralFallback[] }
  | { ok: false; reason: string };

export type FactoryOpts = {
  llm: LLMProvider;
  registry: ToolRegistry;
  sandbox: Sandbox;
  approval: ApprovalPolicy;
  tracer: Tracer;
  tombstoned: Set<string>;
  maxRepairAttempts?: number;
  approvedBy?: string;
};

export type FactoryOutcome =
  | { ok: true; tool: Tool; approval: ApprovalRecord }
  | { ok: false; reason: string };

/**
 * ToolFactory is responsible for generating, validating, repairing, and registering new tools
 * into the tool registry. It supports atomic, composite, and workflow tool creation, using
 * an LLM for code generation and repair, and supports approval and smoke-testing workflows.
 *
 * Core responsibilities:
 * - Create atomic and composite tools via LLM prompts, iteratively repairing drafts as needed.
 * - Create deterministic workflow tools by lifting from a trace of existing tool invocations.
 * - Run static validation and, if needed, smoke-test candidate tool implementations in a sandbox environment.
 * - Invoke an approval policy for review and persist tools into the registry with appropriate approval metadata.
 * - Trace tool creation activities via the provided tracer.
 *
 * Usage scenarios:
 * - Automated tool generation for user/task intent via LLM+validation loop.
 * - High-confidence workflow tool construction directly from invocation traces, bypassing code generation.
 * - Robust handling of smoke-testing failures and LLM malformation through iterative repair.
 */
export class ToolFactory {
  private readonly maxRepair: number;
  private readonly approvedBy: string;

  /**
   * @param opts Configuration and dependencies for the factory, such as
   *   LLM provider, registry, sandbox, approval policy, tracer, and other options.
   */
  constructor(private readonly opts: FactoryOpts) {
    this.maxRepair = opts.maxRepairAttempts ?? 2;
    this.approvedBy = opts.approvedBy ?? "user";
  }

  /**
   * Generates a new atomic tool (LLM/JS-based implementation) based on user intent,
   * rationale, and comparison with existing tools. Runs validation, repair, smoke-test,
   * and approval before registering in the tool registry.
   *
   * @param req Information about the atomic tool to be created.
   * @returns The outcome representing either success ({ ok: true, tool, approval }) or error information.
   */
  async createAtomic(req: CreateAtomicReq): Promise<FactoryOutcome> {
    const system = atomicPrompt({ ...req, catalog: this.opts.registry.listSync() });
    return this.createWithPrompt(system);
  }

  /**
   * Generates a new composite tool (compositional plan of other tools) using LLM guidance.
   * Goes through validation, repair, smoke-test, and approval process before registry insertion.
   *
   * @param req Information about the composite tool's name, intent, and planned steps.
   * @returns The outcome representing either success ({ ok: true, tool, approval }) or error information.
   */
  async createComposite(req: CreateCompositeReq): Promise<FactoryOutcome> {
    const system = compositePrompt({ ...req, catalog: this.opts.registry.listSync() });
    return this.createWithPrompt(system);
  }

  /**
   * Lifts a workflow from the request's slice using registered tools, returning the LiftResult.
   * Extracted to share between createWorkflow and previewWorkflow.
   */
  private async liftSlice(req: CreateWorkflowReq): Promise<LiftResult> {
    const toolsByName: Record<string, Tool> = {};
    for (const summary of this.opts.registry.listSync()) {
      const tool = await this.opts.registry.get(summary.name);
      if (tool) toolsByName[summary.name] = tool;
    }
    return liftFromTrace({
      slice: req.slice,
      name: req.name,
      description: req.description,
      goal: req.intent,
      toolsByName,
    });
  }

  /**
   * Previews a workflow lift without persisting anything to the registry.
   * Returns the workflow IR and literal fallbacks for inspection.
   *
   * @param req - The workflow creation request (same shape as createWorkflow, promotions ignored).
   * @returns The lifted workflow and literal fallbacks, or an error reason.
   */
  async previewWorkflow(req: CreateWorkflowReq): Promise<PreviewWorkflowOutcome> {
    const liftResult = await this.liftSlice(req);
    if (!liftResult.ok) return { ok: false, reason: `lift failed: ${liftResult.errors.map((e) => e.message).join("; ")}` };
    const validation = await validateWorkflow(liftResult.workflow, this.opts.registry);
    if (!validation.ok) return { ok: false, reason: `validation failed: ${validation.errors.map((e) => e.message).join("; ")}` };
    return { ok: true, workflow: liftResult.workflow, literalFallbacks: liftResult.literalFallbacks };
  }

  /**
   * Creates a workflow tool by deterministically lifting a workflow from a slice of successful tool invocations (trace).
   *
   * This method performs a structural lift from invocation history to a workflow IR (intermediate representation).
   * The workflow is built using only existing, registered tools (no LLM codegeneration).
   * After lifting, optional promotions are applied to convert literals into named workflow inputs,
   * and the inputSchema is re-derived from the resulting workflow inputs.
   * The workflow is then validated, saved to the registry, and returned.
   *
   * No smoke-testing is performed since workflow execution is deterministic over validated steps.
   *
   * @param req - The workflow creation request. It includes a trace slice (set of invocations), desired name,
   *              a user intent, a human-friendly description, and optional promotions.
   * @returns A FactoryOutcome, which is { ok: true, tool, approval } on success,
   *          or { ok: false, reason } if the lift, parameterization, or validation failed.
   */
  async createWorkflow(req: CreateWorkflowReq): Promise<FactoryOutcome> {
    const liftResult = await this.liftSlice(req);
    if (!liftResult.ok) {
      return { ok: false, reason: `lift failed: ${liftResult.errors.map((e) => e.message).join("; ")}` };
    }

    let { workflow, manifest, literalFallbacks } = liftResult;

    if (req.promotions && req.promotions.length > 0) {
      const pr = parameterize(workflow, req.promotions);
      if (!pr.ok) return { ok: false, reason: `parameterize failed: ${pr.errors.map((e) => e.message).join("; ")}` };
      workflow = pr.workflow;
      manifest = { ...manifest, inputSchema: inputSchemaFromInputs(workflow.inputs) };
    }

    // Validate the lifted workflow
    const validation = await validateWorkflow(workflow, this.opts.registry);
    if (!validation.ok) {
      return { ok: false, reason: `validation failed: ${validation.errors.map((e) => e.message).join("; ")}` };
    }

    const workflowJson = JSON.stringify(workflow, null, 2);
    const { hash: _liftHash, ...manifestSansHash } = manifest;
    const tool = this.toolFromManifestAndCode(manifestSansHash, workflowJson);

    console.log("\n--- Lifted Workflow ---");
    console.log(renderLiterate(workflow));
    const promotedKeys = new Set((req.promotions ?? []).map((p) => `${p.stepLabel}.${p.argName}`));
    const remainingFallbacks = literalFallbacks.filter((fb) => !promotedKeys.has(`${fb.stepLabel}.${fb.argName}`));
    console.log("\n--- Literal Fallbacks ---");
    if (remainingFallbacks.length === 0) {
      console.log("(none - all arguments are symrefs)");
    } else {
      for (const fb of remainingFallbacks) {
        console.log(`  ${fb.stepLabel}.${fb.argName}: ${fb.canonicalValue.slice(0, 80)}...`);
      }
    }
    console.log("");

    const approval: ApprovalRecord = {
      hash: tool.manifest.hash,
      approvedAt: new Date().toISOString(),
      approvedBy: this.approvedBy,
      alwaysApprove: false,
    };

    await this.opts.registry.save(tool, approval);
    this.opts.tracer.log("tool-created", { name: tool.manifest.name, hash: tool.manifest.hash, approvedBy: this.approvedBy });
    return { ok: true, tool, approval };
  }

  /**
   * Core workflow for LLM-based atomic/composite tool creation:
   * 1. Calls the LLM to produce a draft.
   * 2. Runs static validation; if failed, attempts repair up to maxRepair times.
   * 3. If validated, performs a smoke test in the sandbox; if failed, attempts repair up to maxRepair times.
   * 4. If both validation and smoke test succeed, runs review/approval logic and persists tool.
   * 5. Returns FactoryOutcome for either success or failure conditions.
   */
  private async createWithPrompt(systemPrompt: string): Promise<FactoryOutcome> {
    const existingNames = new Set(this.opts.registry.listSync().map((s) => s.name));
    let draft = await this.genDraft(systemPrompt);
    let validation: ValidationResult = staticValidateDraft(draft, { existingNames, tombstoned: this.opts.tombstoned });

    let attempts = 0;
    while (!validation.ok && attempts < this.maxRepair) {
      attempts++;
      draft = await this.repair(draft, validation.errors);
      validation = staticValidateDraft(draft, { existingNames, tombstoned: this.opts.tombstoned });
    }
    if (!validation.ok) {
      this.opts.tracer.log("tool-rejected", { name: draft.name, reason: `static: ${validation.errors.join("; ")}` });
      return { ok: false, reason: `static validation failed: ${validation.errors.join("; ")}` };
    }

    const smokeTool = this.draftToTool(draft);
    const smoke: ToolResult = await this.smokeTest(smokeTool, draft.smokeTestInput);

    if (!smoke.ok) {
      attempts = 0;
      while (attempts < this.maxRepair) {
        attempts++;
        draft = await this.repair(draft, [`smoke test failed: ${smoke.error.kind}: ${smoke.error.message}`]);
        const v = staticValidateDraft(draft, { existingNames, tombstoned: this.opts.tombstoned });
        if (!v.ok) continue;
        const retry = await this.smokeTest(this.draftToTool(draft), draft.smokeTestInput);
        if (retry.ok) { return this.presentAndSave(draft, retry); }
      }
      this.opts.tracer.log("tool-rejected", { name: draft.name, reason: `smoke: ${smoke.error.message}` });
      return { ok: false, reason: `smoke test failed: ${smoke.error.message}` };
    }

    return this.presentAndSave(draft, smoke);
  }

  /**
   * Runs the draft in the sandbox. For composites, we install an `onInvokeTool`
   * handler that resolves declared dependencies via the registry and executes
   * them in a fresh sandbox. During smoke test we bypass the ApprovalPolicy for
   * sub-calls because (a) each dep was already approved at its own Gate 1 and
   * (b) the composite's bubbled-up permissions are surfaced to the reviewer at
   * this draft's Gate 1 immediately after the smoke test returns.
   *
   * @param tool  The candidate tool to test
   * @param input Example input for the tool's smoke test
   * @returns The outcome of execution (ToolResult)
   */
  private async smokeTest(tool: Tool, input: unknown): Promise<ToolResult> {
    if (tool.manifest.kind === "atomic") {
      return this.opts.sandbox.execute(tool, input, "factory-smoke");
    }
    const makeInvoker = (d: number) => async (name: string, args: unknown): Promise<ToolResult> => {
      const dep = await this.opts.registry.get(name);
      if (!dep) return { ok: false, error: { kind: "unknown_tool", message: `dependency '${name}' not in registry` } };
      return this.opts.sandbox.execute(dep, args, "factory-smoke-sub", {
        onInvokeTool: makeInvoker(d + 1),
        depth: d,
      });
    };
    return this.opts.sandbox.execute(tool, input, "factory-smoke", {
      onInvokeTool: makeInvoker(1),
      depth: 0,
    });
  }

  /**
   * Runs approval/review for a validated and smoke-tested draft, applies final edits if present,
   * emits the tool to the registry, and logs creation. Returns the final FactoryOutcome.
   *
   * @param draft The draft (possibly LLM-generated/edited)
   * @param smoke The passing smoke test result
   */
  private async presentAndSave(draft: ToolDraft, smoke: ToolResult): Promise<FactoryOutcome> {
    const decision = await this.opts.approval.reviewDraft(draft, smoke);
    if (decision.decision === APPROVAL_DECISION.reject) {
      this.opts.tracer.log("tool-rejected", { name: draft.name, reason: decision.reason });
      return { ok: false, reason: decision.reason };
    }
    const finalDraft = decision.editedDraft ?? draft;
    const tool = this.draftToTool(finalDraft);
    const approval: ApprovalRecord = {
      hash: tool.manifest.hash,
      approvedAt: new Date().toISOString(),
      approvedBy: this.approvedBy,
      alwaysApprove: decision.alwaysApprove,
      ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
    };
    await this.opts.registry.save(tool, approval);
    this.opts.tracer.log("tool-created", { name: tool.manifest.name, hash: tool.manifest.hash, approvedBy: this.approvedBy });
    return { ok: true, tool, approval };
  }

  /**
   * Converts a ToolDraft (validated) into a Tool instance with manifest and hashed registry entry.
   * @param draft A validated tool draft.
   */
  private draftToTool(draft: ToolDraft): Tool {
    const manifestSansHash: Omit<ToolManifest, "hash"> = {
      name: draft.name,
      description: draft.description,
      rationale: draft.rationale,
      inputSchema: draft.inputSchema,
      outputShape: draft.outputShape,
      permissions: normalizePermissions(draft.permissions),
      dependencies: draft.dependencies,
      limits: { timeoutMs: draft.limits?.timeoutMs ?? 30000, maxOldSpaceSizeMb: draft.limits?.maxOldSpaceSizeMb ?? 256 },
      createdAt: new Date().toISOString(),
      kind: draft.kind,
    };
    return this.toolFromManifestAndCode(manifestSansHash, draft.code);
  }

  /**
   * Builds a persisted {@link Tool} with a registry hash over `code` and manifest fields (excluding hash).
   * Uses {@link hashTool} so atomic, composite, and workflow tools share one fingerprint scheme.
   * @param manifest Tool manifest data, excluding hash.
   * @param code     Tool code as a string.
   * @returns Persistable Tool instance.
   */
  private toolFromManifestAndCode(manifest: Omit<ToolManifest, "hash">, code: string): Tool {
    const hash = hashTool(code, manifest);
    return { manifest: { ...manifest, hash }, code };
  }

  /**
   * Generates a ToolDraft struct using the LLM with the provided system prompt and schema.
   * @param systemPrompt LLM system prompt tailored for this draft.
   */
  private async genDraft(systemPrompt: string): Promise<ToolDraft> {
    this.opts.tracer.log("factory-gen-draft", { phase: "start" });
    return this.opts.llm.generateStructured<ToolDraft>({
      messages: [{ role: CHAT_ROLE.system, content: systemPrompt }],
      schemaName: "ToolDraft",
      schema: DRAFT_SCHEMA,
    });
  }

  /**
   * Attempts to repair a previous ToolDraft using the LLM, given validation/smoke errors.
   * @param previous The prior draft to repair.
   * @param errors   Error strings to correct.
   */
  private async repair(previous: ToolDraft, errors: string[]): Promise<ToolDraft> {
    this.opts.tracer.log(TRACE_KIND_FACTORY_REPAIR_LLM, { phase: "start" });
    return this.opts.llm.generateStructured<ToolDraft>({
      messages: [
        { role: CHAT_ROLE.system, content: "Produce a corrected ToolDraft." },
        { role: CHAT_ROLE.user, content: repairPrompt(previous, errors) },
      ],
      schemaName: "ToolDraft",
      schema: DRAFT_SCHEMA,
    });
  }
}
