import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CheckpointStore } from "./graph.js";

export class FileCheckpointStore implements CheckpointStore {
  private data: Record<string, unknown>;

  constructor(readonly file: string) {
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  }

  load(key: string): unknown {
    return this.data[key];
  }

  save(key: string, value: unknown): void {
    this.data[key] = value;
    this.flush();
  }

  clear(key: string): void {
    for (const k of Object.keys(this.data)) {
      if (k === key || k.startsWith(`${key}/`)) delete this.data[k];
    }
    this.flush();
  }

  private flush() {
    if (Object.keys(this.data).length === 0) {
      rmSync(this.file, { force: true });
      return;
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }
}
