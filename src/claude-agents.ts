import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type ToolSet = "read" | "edit" | "test";

const TOOLS: Record<ToolSet, string[]> = {
  read: ["Read", "Grep", "Glob"],
  edit: ["Read", "Grep", "Glob", "Edit", "Write"],
  test: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
};

export interface SubagentDef {
  name: string;
  description: string;
  tools: ToolSet;
  instructions: string;
  model?: string;
}

export async function writeClaudeAgents(projectDir: string, defs: SubagentDef[]): Promise<void> {
  const dir = path.join(projectDir, ".claude", "agents");
  await mkdir(dir, { recursive: true });
  await Promise.all(
    defs.map((d) =>
      writeFile(
        path.join(dir, `${d.name}.md`),
        [
          "---",
          `name: ${d.name}`,
          `description: ${d.description}`,
          `tools: ${TOOLS[d.tools].join(", ")}`,
          ...(d.model ? [`model: ${d.model}`] : []),
          "---",
          "",
          d.instructions.trim(),
          "",
        ].join("\n"),
      ),
    ),
  );
}
