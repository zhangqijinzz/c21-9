/**
 * 读取/写入本地数据库失败的原因分类：
 * - unsupported：浏览器不支持 IndexedDB（或隐私模式下被禁用）
 * - blocked：数据库被其他标签页/浏览器升级流程占用，升级被阻塞
 * - failure：其他临时性失败（IO、事务中断等）
 */
export type StorageAccessReason = "unsupported" | "blocked" | "failure";

export class StorageAccessError extends Error {
  readonly reason: StorageAccessReason;

  constructor(reason: StorageAccessReason, message: string) {
    super(message);
    this.name = "StorageAccessError";
    this.reason = reason;
  }
}

const BLOCKED_PATTERNS = [
  "blocked",
  "quota",
  "being upgraded",
  "abort",
  "reset",
  "io",
];

/**
 * 把底层抛出的任意错误归类。SecurityError（隐私模式、文件协议、禁用存储）
 * 与明确缺少 indexedDB 一样视为不支持；阻塞与配额问题视为被占用；其余为临时失败。
 */
export function classifyStorageError(error: unknown): StorageAccessError {
  if (error instanceof StorageAccessError) return error;
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const haystack = `${name} ${message}`.toLowerCase();

  if (name === "SecurityError" || haystack.includes("securityerror"))
    return new StorageAccessError("unsupported", "浏览器禁用了本地数据库");
  if (BLOCKED_PATTERNS.some((word) => haystack.includes(word)))
    return new StorageAccessError(
      "blocked",
      "本地数据库被其他页面或浏览器升级占用",
    );
  return new StorageAccessError("failure", "本地数据库暂时无法访问");
}
