import { beforeEach, describe, expect, it } from "vitest";
import {
  ProjectRepository,
  type LoadOutcome,
} from "../src/shared/repositories/projectRepository";
import {
  StorageBlockedError,
  StorageUnsupportedError,
} from "../src/shared/services/indexedDbService";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

class MemoryStorage {
  value: unknown = undefined;
  failWrite = false;
  readError: Error | null = null;
  async read(): Promise<unknown> {
    if (this.readError) throw this.readError;
    return this.value;
  }
  async write(value: WorkspaceDocument): Promise<void> {
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    this.value = structuredClone(value);
  }
}

function exampleDocument(): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: EXAMPLE_PROJECT.id,
    projects: [structuredClone(EXAMPLE_PROJECT)],
  };
}

function ready(outcome: LoadOutcome) {
  if (outcome.status !== "ready")
    throw new Error(`expected ready outcome, got ${outcome.status}`);
  return outcome;
}

describe("project repository recovery", () => {
  beforeEach(() => localStorage.clear());

  it("provides a usable example when both stores are empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 99, projects: "broken" };
    const loaded = ready(await new ProjectRepository(storage).load());
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.document.projects[0]?.nodes.length).toBeGreaterThan(0);
  });

  it("loads the example as a fresh workspace only when the store is confirmed empty", async () => {
    const loaded = ready(
      await new ProjectRepository(new MemoryStorage()).load(),
    );
    expect(loaded.source).toBe("fresh");
    expect(loaded.recovered).toBe(false);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
  });

  it("restores the local recovery copy when IndexedDB data is malformed", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    await repository.load();
    await repository.save(exampleDocument());
    storage.value = { version: 1, projects: [{ id: 5, nodes: [] }] };
    const loaded = ready(await repository.load());
    expect(loaded.recovered).toBe(true);
    expect(loaded.source).toBe("recovery-copy");
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
    const loaded = ready(await new ProjectRepository(storage).load());
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
    await expect(repository.save(exampleDocument())).rejects.toThrow(
      "IndexedDB quota failure",
    );
    storage.failWrite = false;
    const loaded = ready(await repository.load());
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.recovered).toBe(true);
  });
});

describe("project repository load failures", () => {
  beforeEach(() => localStorage.clear());

  it("reports a generic read failure without loading the example", async () => {
    const storage = new MemoryStorage();
    storage.readError = new Error("transient IO error");
    const outcome = await new ProjectRepository(storage).load();
    if (outcome.status !== "unreadable")
      throw new Error("expected unreadable outcome");
    expect(outcome.failure).toBe("error");
    expect(outcome.recoveryCopy).toBeNull();
  });

  it("reports a blocked database separately from missing data", async () => {
    const storage = new MemoryStorage();
    storage.readError = new StorageBlockedError();
    const outcome = await new ProjectRepository(storage).load();
    if (outcome.status !== "unreadable")
      throw new Error("expected unreadable outcome");
    expect(outcome.failure).toBe("blocked");
  });

  it("reports an unsupported browser separately", async () => {
    const storage = new MemoryStorage();
    storage.readError = new StorageUnsupportedError();
    const outcome = await new ProjectRepository(storage).load();
    if (outcome.status !== "unreadable")
      throw new Error("expected unreadable outcome");
    expect(outcome.failure).toBe("unsupported");
  });

  it("exposes the recovery copy contents when the read fails", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    await repository.load();
    await repository.save(exampleDocument());
    storage.readError = new Error("transient IO error");
    const outcome = await repository.load();
    if (outcome.status !== "unreadable")
      throw new Error("expected unreadable outcome");
    expect(outcome.recoveryCopy).not.toBeNull();
    expect(JSON.parse(outcome.recoveryCopy ?? "")).toMatchObject({
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
    });
  });

  it("recovers the real workspace when a retry succeeds after a failed read", async () => {
    const storage = new MemoryStorage();
    storage.value = exampleDocument();
    storage.readError = new StorageBlockedError();
    const repository = new ProjectRepository(storage);
    const blocked = await repository.load();
    expect(blocked.status).toBe("unreadable");
    storage.readError = null;
    const loaded = ready(await repository.load());
    expect(loaded.source).toBe("indexeddb");
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
  });

  it("refuses to save before a read has confirmed the data state", async () => {
    const repository = new ProjectRepository(new MemoryStorage());
    await expect(repository.save(exampleDocument())).rejects.toThrow(
      "尚未确认",
    );
  });

  it("keeps refusing to save after an unreadable load, so real data is never overwritten", async () => {
    const storage = new MemoryStorage();
    storage.value = exampleDocument();
    storage.readError = new Error("transient IO error");
    const repository = new ProjectRepository(storage);
    const outcome = await repository.load();
    expect(outcome.status).toBe("unreadable");
    await expect(
      repository.save({
        version: 1,
        activeProjectId: "project-latency-demo",
        projects: [{ ...structuredClone(EXAMPLE_PROJECT), title: "覆盖" }],
      }),
    ).rejects.toThrow("尚未确认");
    const untouched = storage.value as WorkspaceDocument;
    expect(untouched.projects[0]?.title).toBe(EXAMPLE_PROJECT.title);
  });
});
