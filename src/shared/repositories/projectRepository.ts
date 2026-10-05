import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
} from "../domain/types";
import {
  IndexedDbService,
  StorageBlockedError,
  StorageUnsupportedError,
} from "../services/indexedDbService";

const FALLBACK_KEY = "latency-lab.workspace.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNode(value: unknown): RequestNode | undefined {
  if (!isRecord(value)) return undefined;
  const {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds,
    timeoutMs,
    retryCount,
    failureRate,
    fallbackNodeId,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !Array.isArray(dependencyIds)
  )
    return undefined;
  if (
    !isFiniteNumber(durationMs) ||
    !isFiniteNumber(jitterMs) ||
    !isFiniteNumber(timeoutMs) ||
    !isFiniteNumber(retryCount) ||
    !isFiniteNumber(failureRate)
  )
    return undefined;
  return {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds: dependencyIds.filter(
      (id): id is string => typeof id === "string",
    ),
    timeoutMs,
    retryCount,
    failureRate,
    ...(typeof fallbackNodeId === "string" ? { fallbackNodeId } : {}),
  };
}

function parseScenario(value: unknown): ScenarioSnapshot | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.criticalPath)
  )
    return undefined;
  const { id, name, createdAt, concurrencyLimit, completionMs } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof createdAt !== "number" ||
    typeof completionMs !== "number"
  )
    return undefined;
  return {
    id,
    name,
    createdAt,
    completionMs,
    concurrencyLimit:
      typeof concurrencyLimit === "number" && concurrencyLimit > 0
        ? concurrencyLimit
        : null,
    nodes: value.nodes
      .map(parseNode)
      .filter((node): node is RequestNode => Boolean(node)),
    criticalPath: value.criticalPath.filter(
      (id): id is string => typeof id === "string",
    ),
  };
}

function parseProject(
  value: unknown,
): { project: LatencyProject; recovered: boolean } | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string"
  )
    return undefined;
  const sourceNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const parsedNodes = sourceNodes.map(parseNode);
  const nodes = parsedNodes.filter((node): node is RequestNode =>
    Boolean(node),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  let recovered =
    !Array.isArray(value.nodes) || nodes.length !== sourceNodes.length;
  const safeNodes = nodes.map((node) => {
    const dependencyIds = node.dependencyIds.filter(
      (id) => id !== node.id && nodeIds.has(id),
    );
    const validFallback =
      node.fallbackNodeId &&
      node.fallbackNodeId !== node.id &&
      nodeIds.has(node.fallbackNodeId)
        ? node.fallbackNodeId
        : undefined;
    if (
      dependencyIds.length !== node.dependencyIds.length ||
      validFallback !== node.fallbackNodeId
    )
      recovered = true;
    return {
      ...node,
      dependencyIds,
      ...(validFallback
        ? { fallbackNodeId: validFallback }
        : { fallbackNodeId: undefined }),
    };
  });
  const scenarioSource = Array.isArray(value.scenarios) ? value.scenarios : [];
  const scenarios = scenarioSource
    .map(parseScenario)
    .filter((scenario): scenario is ScenarioSnapshot => Boolean(scenario));
  if (
    !Array.isArray(value.scenarios) ||
    scenarios.length !== scenarioSource.length
  )
    recovered = true;
  const now = Date.now();
  const project: LatencyProject = {
    id: value.id,
    title: value.title,
    nodes: safeNodes,
    concurrencyLimit:
      typeof value.concurrencyLimit === "number" && value.concurrencyLimit > 0
        ? Math.floor(value.concurrencyLimit)
        : null,
    scenarios,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : now,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
  };
  return { project, recovered };
}

function parseWorkspace(
  value: unknown,
): { document: WorkspaceDocument; recovered: boolean } | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects))
    return undefined;
  const parsed = value.projects.map(parseProject);
  const projects = parsed
    .filter((entry): entry is { project: LatencyProject; recovered: boolean } =>
      Boolean(entry),
    )
    .map((entry) => entry.project);
  if (!projects.length) return undefined;
  const firstProject = projects[0];
  if (!firstProject) return undefined;
  const activeProjectId = projects.some(
    (project) => project.id === value.activeProjectId,
  )
    ? String(value.activeProjectId)
    : firstProject.id;
  const recovered =
    projects.length !== parsed.length ||
    parsed.some((entry) => entry?.recovered);
  return { document: { version: 1, activeProjectId, projects }, recovered };
}

export interface WorkspaceStorage {
  read(): Promise<unknown>;
  write(value: WorkspaceDocument): Promise<void>;
}

/** 读取未能确认数据状态的原因。 */
export type LoadFailure = "blocked" | "unsupported" | "error";

export type LoadOutcome =
  | {
      status: "ready";
      document: WorkspaceDocument;
      /** 数据被修复过，或来自恢复副本 / 示例。 */
      recovered: boolean;
      /** indexeddb：主存储；recovery-copy：本地恢复副本；fresh：确认无数据后载入示例。 */
      source: "indexeddb" | "recovery-copy" | "fresh";
    }
  | {
      status: "unreadable";
      failure: LoadFailure;
      /** 本机恢复副本的原始内容，供用户取出；没有副本时为 null。 */
      recoveryCopy: string | null;
    };

function seedExample(): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: EXAMPLE_PROJECT.id,
    projects: [structuredClone(EXAMPLE_PROJECT)],
  };
}

function readRecoveryCopyRaw(): string | null {
  try {
    return localStorage.getItem(FALLBACK_KEY);
  } catch {
    return null;
  }
}

function parseRecoveryCopy():
  { document: WorkspaceDocument; recovered: boolean } | undefined {
  const raw = readRecoveryCopyRaw();
  if (!raw) return undefined;
  try {
    const parsed = parseWorkspace(JSON.parse(raw) as unknown);
    if (parsed) return { ...parsed, recovered: true };
  } catch {
    try {
      localStorage.removeItem(FALLBACK_KEY);
    } catch {
      // 忽略清理失败
    }
  }
  return undefined;
}

export class ProjectRepository {
  /** 只有成功完成一次读取、确认过数据状态后才允许写入，避免覆盖真实数据。 */
  private readConfirmed = false;

  constructor(
    private readonly storage: WorkspaceStorage = new IndexedDbService(),
  ) {}

  async load(): Promise<LoadOutcome> {
    let stored: unknown;
    try {
      stored = await this.storage.read();
    } catch (error) {
      // 读取没有成功：数据是否存在尚未确认，不能回退到示例，也不能进入可写状态。
      const failure: LoadFailure =
        error instanceof StorageUnsupportedError
          ? "unsupported"
          : error instanceof StorageBlockedError
            ? "blocked"
            : "error";
      return {
        status: "unreadable",
        failure,
        recoveryCopy: readRecoveryCopyRaw(),
      };
    }
    this.readConfirmed = true;
    const parsed = parseWorkspace(stored);
    if (parsed) return { status: "ready", ...parsed, source: "indexeddb" };
    if (stored === undefined) {
      // 读取成功且确实没有数据：优先还原恢复副本，否则按首次使用载入示例。
      const recovery = parseRecoveryCopy();
      if (recovery)
        return { status: "ready", ...recovery, source: "recovery-copy" };
      return {
        status: "ready",
        document: seedExample(),
        recovered: false,
        source: "fresh",
      };
    }
    // 读取成功但内容损坏：用恢复副本还原；没有副本时才退回示例。
    const recovery = parseRecoveryCopy();
    if (recovery)
      return { status: "ready", ...recovery, source: "recovery-copy" };
    return {
      status: "ready",
      document: seedExample(),
      recovered: true,
      source: "fresh",
    };
  }

  async save(document: WorkspaceDocument): Promise<void> {
    if (!this.readConfirmed)
      throw new Error("本地数据状态尚未确认，已阻止写入以避免覆盖");
    let indexedDbError: unknown;
    try {
      await this.storage.write(document);
    } catch (error) {
      indexedDbError = error;
    }
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(document));
    } catch (error) {
      if (!indexedDbError) throw error;
    }
    if (indexedDbError) throw indexedDbError;
  }
}
