import {
  DatabaseBackup,
  Download,
  RadioTower,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import type { LoadFailure } from "../../shared/repositories/projectRepository";

interface Props {
  failure: LoadFailure;
  hasRecoveryCopy: boolean;
  onRetry: () => void;
  onExportRecovery: () => void;
}

const failureCopy: Record<
  LoadFailure,
  { title: string; description: string; canRetry: boolean }
> = {
  blocked: {
    title: "本地数据库被其他页面占用",
    description:
      "另一个标签页或窗口正在使用本应用的数据。请关闭其他页面后重试；在确认数据状态之前，这里不会载入示例，也不会写入任何内容。",
    canRetry: true,
  },
  unsupported: {
    title: "当前浏览器不支持本地数据库",
    description:
      "此浏览器缺少 IndexedDB，无法读取或保存链路项目。你之前的项目可能仍保留在这台设备上，可以取出恢复副本内容后，换用支持的浏览器继续使用。",
    canRetry: false,
  },
  error: {
    title: "本地项目读取失败",
    description:
      "读取没有成功，你的项目是否还在尚未确认。为避免覆盖真实数据，应用已暂停写入。请重试，或先取出本机恢复副本的内容。",
    canRetry: true,
  },
};

export default function StorageFailureScreen({
  failure,
  hasRecoveryCopy,
  onRetry,
  onExportRecovery,
}: Props) {
  const copy = failureCopy[failure];
  return (
    <main className="loading-screen">
      <div className="loading-mark">
        <RadioTower size={24} />
      </div>
      <strong>LatencyLab</strong>
      <div className="storage-failure" role="alert">
        <span className="storage-failure-icon">
          {hasRecoveryCopy ? (
            <DatabaseBackup size={18} />
          ) : (
            <ShieldAlert size={18} />
          )}
        </span>
        <h1>{copy.title}</h1>
        <p>{copy.description}</p>
        <div className="storage-failure-actions">
          {copy.canRetry && (
            <button className="button button-primary" onClick={onRetry}>
              <RefreshCw size={13} /> 重新尝试
            </button>
          )}
          {hasRecoveryCopy && (
            <button className="button button-lime" onClick={onExportRecovery}>
              <Download size={13} /> 取出恢复副本内容
            </button>
          )}
        </div>
        {hasRecoveryCopy && (
          <span className="storage-failure-hint">
            检测到本机恢复副本，可导出为 JSON 文件留存。
          </span>
        )}
      </div>
    </main>
  );
}
