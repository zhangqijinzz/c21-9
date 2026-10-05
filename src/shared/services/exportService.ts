import type { WorkspaceDocument } from "../domain/types";

/** 把恢复副本内容序列化为便于用户复制保存的文本。 */
export function serializeWorkspace(workspace: WorkspaceDocument): string {
  return JSON.stringify(workspace, null, 2);
}

/**
 * 通过浏览器下载把恢复副本内容取出。失败时返回 false，
 * 调用方应提示用户改用手动复制文本的方式。
 */
export function downloadWorkspace(
  workspace: WorkspaceDocument,
  filename = "latency-lab-recovery.json",
): boolean {
  try {
    const blob = new Blob([serializeWorkspace(workspace)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}
