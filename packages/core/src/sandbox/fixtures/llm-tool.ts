export async function run(input: { instructions: string; input?: unknown }): Promise<unknown> {
  const g = globalThis as unknown as { llm: (req: unknown) => Promise<unknown> };
  return g.llm({ instructions: input.instructions, input: input.input });
}
