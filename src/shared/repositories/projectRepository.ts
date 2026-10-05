import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
} from "../domain/types";
import { IndexedDbService } from "../services/indexedDbService";
import {
  classifyStorageError,
  StorageAccessError,
  type StorageAccessReason,
} from "../services/storageError";

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

function exampleWorkspace(): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: EXAMPLE_PROJECT.id,
    projects: [structuredClone(EXAMPLE_PROJECT)],
  };
}

export interface WorkspaceStorage {
  read(): Promise<unknown>;
  write(value: WorkspaceDocument): Promise<void>;
}

/**
 * 读取本地恢复副本。无法解析时返回 undefined，但不删除原始内容——
 * 它可能是用户仅剩的数据，无权在读出失败时销毁。
 */
export function readRecoveryCopy():
  { document: WorkspaceDocument; recovered: boolean } | undefined {
  let local: string | null;
  try {
    local = localStorage.getItem(FALLBACK_KEY);
  } catch {
    return undefined;
  }
  if (!local) return undefined;
  try {
    const parsed = parseWorkspace(JSON.parse(local) as unknown);
    return parsed ? { ...parsed, recovered: true } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * load 的结果：
 * - ready：已确认数据库状态（确为空、读到数据，或主存储读到损坏数据后
 *   改用恢复副本），可以安全进入可写状态。
 * - unavailable：没能确认数据库里是否存在数据，禁止写入；reason 区分
 *   unsupported/blocked/failure，recoveryDocument 携带可读的恢复副本。
 */
export type LoadOutcome =
  | {
      outcome: "ready";
      document: WorkspaceDocument;
      recovered: boolean;
      source: "database" | "recovery-copy" | "empty";
    }
  | {
      outcome: "unavailable";
      reason: StorageAccessReason;
      message: string;
      recoveryDocument?: WorkspaceDocument;
    };

export class ProjectRepository {
  /**
   * 只有主存储读取真正完成（得到明确答复）后才允许写入。
   * 读取失败保持 false，任何 save 都会被拒绝，避免示例/空白数据覆盖真实数据。
   */
  private writable = false;

  constructor(
    private readonly storage: WorkspaceStorage = new IndexedDbService(),
  ) {}

  async load(): Promise<LoadOutcome> {
    let raw: unknown;
    try {
      raw = await this.storage.read();
    } catch (error) {
      // 读取没有成功：无法确认数据库中是否有数据，绝不进入可写状态。
      const accessError: StorageAccessError = classifyStorageError(error);
      const recovery = readRecoveryCopy();
      return {
        outcome: "unavailable",
        reason: accessError.reason,
        message: accessError.message,
        ...(recovery ? { recoveryDocument: recovery.document } : {}),
      };
    }

    // 读取已完成，数据库状态确定，此后写入不会覆盖未知数据。
    this.writable = true;

    const stored = parseWorkspace(raw);
    if (stored)
      return {
        outcome: "ready",
        document: stored.document,
        recovered: stored.recovered,
        source: "database",
      };

    const recovery = readRecoveryCopy();
    if (recovery)
      return {
        outcome: "ready",
        document: recovery.document,
        recovered: true,
        source: "recovery-copy",
      };

    // 主存储与恢复副本都确认为空/不可解析：这是真正的首次使用。
    return {
      outcome: "ready",
      document: exampleWorkspace(),
      recovered: true,
      source: "empty",
    };
  }

  async save(document: WorkspaceDocument): Promise<void> {
    if (!this.writable)
      throw new StorageAccessError(
        "failure",
        "本地数据尚未确认可读，已阻止写入以免覆盖原有项目",
      );
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
