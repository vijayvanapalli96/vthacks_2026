import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");

export class HashChainAuditLog {
  constructor(path) {
    this.path = path;
  }

  async append(type, payload) {
    await mkdir(dirname(this.path), { recursive: true });
    let previousHash = null;
    try {
      const lines = (await readFile(this.path, "utf8")).trim().split("\n").filter(Boolean);
      previousHash = lines.length ? JSON.parse(lines.at(-1)).event_hash : null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const event = { id: randomUUID(), type, payload, created_at: new Date().toISOString(), previous_hash: previousHash };
    const record = { ...event, event_hash: digest(JSON.stringify(event)) };
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }
}

export class MemoryAuditLog {
  entries = [];
  async append(type, payload) {
    const entry = { id: randomUUID(), type, payload, created_at: new Date().toISOString() };
    this.entries.push(entry);
    return entry;
  }
}
