import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";
import type { StorageAccessReason } from "../src/shared/services/storageError";

class MemoryStorage {
  value: unknown = undefined;
  failRead = false;
  failReason: StorageAccessReason = "failure";
  failWrite = false;
  writes = 0;
  async read(): Promise<unknown> {
    if (this.failRead) throw new Error("simulated read failure");
    return this.value;
  }
  async write(value: WorkspaceDocument): Promise<void> {
    this.writes += 1;
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    this.value = structuredClone(value);
  }
}

const exampleDocument: WorkspaceDocument = {
  version: 1,
  activeProjectId: EXAMPLE_PROJECT.id,
  projects: [structuredClone(EXAMPLE_PROJECT)],
};

describe("project repository recovery", () => {
  beforeEach(() => localStorage.clear());

  it("provides a usable example only after both stores are confirmed empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 99, projects: "broken" };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.outcome).toBe("ready");
    if (loaded.outcome !== "ready") return;
    expect(loaded.source).toBe("empty");
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.document.projects[0]?.nodes.length).toBeGreaterThan(0);
  });

  it("reports genuinely empty storage as a confirmed empty state", async () => {
    const repository = new ProjectRepository(new MemoryStorage());
    const loaded = await repository.load();
    expect(loaded.outcome).toBe("ready");
    if (loaded.outcome !== "ready") return;
    expect(loaded.source).toBe("empty");
    // 确认为空后才允许写入
    await expect(repository.save(loaded.document)).resolves.toBeUndefined();
  });

  it("restores the local recovery copy when IndexedDB data is malformed", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    // 先确认数据库状态，再写入一份用于验证回退的副本
    await repository.load();
    await repository.save(exampleDocument);
    storage.value = { version: 1, projects: [{ id: 5, nodes: [] }] };
    const loaded = await repository.load();
    expect(loaded.outcome).toBe("ready");
    if (loaded.outcome !== "ready") return;
    expect(loaded.source).toBe("recovery-copy");
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(
      EXAMPLE_PROJECT.nodes.length,
    );
  });

  it("keeps readable projects while dropping malformed project rows and broken edges", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [
        {
          ...EXAMPLE_PROJECT,
          nodes: [
            { ...EXAMPLE_PROJECT.nodes[0], dependencyIds: ["missing"] },
            { damaged: true },
          ],
        },
        { id: 9, title: null },
      ],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.outcome).toBe("ready");
    if (loaded.outcome !== "ready") throw new Error("expected ready outcome");
    expect(loaded.source).toBe("database");
    expect(loaded.document.projects).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes[0]?.dependencyIds).toEqual([]);
    expect(loaded.recovered).toBe(true);
  });

  it("keeps a local recovery copy when IndexedDB saving fails", async () => {
    const storage = new MemoryStorage();
    storage.failWrite = true;
    const repository = new ProjectRepository(storage);
    await repository.load();
    await expect(repository.save(exampleDocument)).rejects.toThrow(
      "IndexedDB quota failure",
    );
    storage.failWrite = false;
    const loaded = await repository.load();
    expect(loaded.outcome).toBe("ready");
    if (loaded.outcome !== "ready") throw new Error("expected ready outcome");
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.recovered).toBe(true);
  });
});

describe("project repository read failure handling", () => {
  beforeEach(() => localStorage.clear());

  it("stays unavailable and surfaces the recovery copy when reading fails", async () => {
    const storage = new MemoryStorage();
    localStorage.setItem(
      "latency-lab.workspace.v1",
      JSON.stringify(exampleDocument),
    );
    storage.failRead = true;
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.outcome).toBe("unavailable");
    if (loaded.outcome !== "unavailable")
      throw new Error("expected unavailable outcome");
    expect(loaded.reason).toBe("failure");
    expect(loaded.recoveryDocument?.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
  });

  it("returns unavailable without a recovery document when both sources fail", async () => {
    const storage = new MemoryStorage();
    storage.failRead = true;
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.outcome).toBe("unavailable");
    if (loaded.outcome !== "unavailable")
      throw new Error("expected unavailable outcome");
    expect(loaded.recoveryDocument).toBeUndefined();
  });

  it("classifies blocked and unsupported storage errors distinctly", async () => {
    const blockedStorage = {
      async read() {
        const error = new Error("Version change blocked");
        error.name = "InvalidStateError";
        throw error;
      },
      async write() {},
    };
    const blocked = await new ProjectRepository(blockedStorage).load();
    expect(blocked.outcome).toBe("unavailable");
    if (blocked.outcome === "unavailable")
      expect(blocked.reason).toBe("blocked");

    const unsupportedStorage = {
      async read() {
        const error = new Error("denied");
        error.name = "SecurityError";
        throw error;
      },
      async write() {},
    };
    const unsupported = await new ProjectRepository(unsupportedStorage).load();
    expect(unsupported.outcome).toBe("unavailable");
    if (unsupported.outcome === "unavailable")
      expect(unsupported.reason).toBe("unsupported");
  });

  it("refuses every write while storage state has not been confirmed", async () => {
    const storage = new MemoryStorage();
    storage.failRead = true;
    const repository = new ProjectRepository(storage);
    await repository.load();
    await expect(repository.save(exampleDocument)).rejects.toThrow(/阻止写入/);
    expect(storage.writes).toBe(0);
    expect(localStorage.getItem("latency-lab.workspace.v1")).toBeNull();
  });

  it("allows saving again after a successful retry, without clobbering storage", async () => {
    const storage = new MemoryStorage();
    storage.failRead = true;
    const repository = new ProjectRepository(storage);
    const first = await repository.load();
    expect(first.outcome).toBe("unavailable");

    storage.failRead = false;
    storage.value = structuredClone(exampleDocument);
    const retried = await repository.load();
    expect(retried.outcome).toBe("ready");
    if (retried.outcome !== "ready") throw new Error("expected ready outcome");
    expect(retried.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    await expect(repository.save(retried.document)).resolves.toBeUndefined();
  });
});
