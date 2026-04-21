export async function run(input: { x: number }): Promise<{ doubled: number }> {
  return { doubled: input.x * 2 };
}
