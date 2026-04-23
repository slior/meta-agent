import type { ApprovalPolicy } from "../approval/interface.ts";
import { CHAT_ROLE, type LLMProvider } from "../llm/interface.ts";
import type { Sandbox } from "../sandbox/interface.ts";
import type { ToolRegistry } from "../registry/interface.ts";
import type { ApprovalRecord, Tool, ToolDraft, ToolManifest, ToolResult } from "../types.ts";
import { hashTool } from "../hash.ts";
import { normalizePermissions } from "../permissions-normalize.ts";
import { staticValidateDraft, type ValidationResult } from "./static-validator.ts";
import { atomicPrompt, compositePrompt, reactivePrompt, repairPrompt, DRAFT_SCHEMA } from "./code-gen-prompts.ts";
import type { Tracer } from "../tracer.ts";

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

export type CreateReactiveReq = {
  name: string;
  intent: string;
  sliceDescription: string;
};

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

export class ToolFactory {
  private readonly maxRepair: number;
  private readonly approvedBy: string;

  constructor(private readonly opts: FactoryOpts) {
    this.maxRepair = opts.maxRepairAttempts ?? 2;
    this.approvedBy = opts.approvedBy ?? "user";
  }

  async createAtomic(req: CreateAtomicReq): Promise<FactoryOutcome> {
    const system = atomicPrompt({ ...req, catalog: this.opts.registry.listSync() });
    return this.createWithPrompt(system);
  }

  async createComposite(req: CreateCompositeReq): Promise<FactoryOutcome> {
    const system = compositePrompt({ ...req, catalog: this.opts.registry.listSync() });
    return this.createWithPrompt(system);
  }

  async createReactive(req: CreateReactiveReq): Promise<FactoryOutcome> {
    const system = reactivePrompt({ ...req, catalog: this.opts.registry.listSync() });
    return this.createWithPrompt(system);
  }

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

  private async presentAndSave(draft: ToolDraft, smoke: ToolResult): Promise<FactoryOutcome> {
    const decision = await this.opts.approval.reviewDraft(draft, smoke);
    if (decision.decision === "reject") {
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
    const hash = hashTool(draft.code, manifestSansHash);
    return { manifest: { ...manifestSansHash, hash }, code: draft.code };
  }

  private async genDraft(systemPrompt: string): Promise<ToolDraft> {
    this.opts.tracer.log("factory-gen-draft", { phase: "start" });
    return this.opts.llm.generateStructured<ToolDraft>({
      messages: [{ role: CHAT_ROLE.system, content: systemPrompt }],
      schemaName: "ToolDraft",
      schema: DRAFT_SCHEMA,
    });
  }

  private async repair(previous: ToolDraft, errors: string[]): Promise<ToolDraft> {
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
