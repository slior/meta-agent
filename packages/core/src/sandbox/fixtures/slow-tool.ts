export async function run(_input: unknown): Promise<never> {
  await new Promise((r) => setTimeout(r, 10_000));
  throw new Error("should have timed out");
}
