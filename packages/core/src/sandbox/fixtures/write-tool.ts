import { writeFile } from "node:fs/promises";
export async function run(input: { path: string; content: string }): Promise<{ written: number }> {
  await writeFile(input.path, input.content, "utf8");
  return { written: input.content.length };
}
