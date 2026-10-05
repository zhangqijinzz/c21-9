import { useState } from "react";
import {
  CloudOff,
  Copy,
  Download,
  FileJson,
  Lock,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { LoadFailure } from "./useLatencyLab";
import { serializeWorkspace } from "../../shared/services/exportService";

interface Props {
  failure: LoadFailure;
  onRetry: () => void;
  onExport: () => boolean;
}

const REASON_COPY: Record<
  LoadFailure["reason"],
  { icon: typeof Lock; title: string; body: string; retryHint: string }
> = {
  blocked: {
    icon: Lock,
    title: "本地数据库正被其他页面占用",
    body: "另一个标签页或浏览器升级流程正持有本地数据。为避免覆盖原有项目，当前不会载入示例，也不会执行任何保存。请关闭其他打开本应用的标签页后重试。",
    retryHint: "已关闭其他标签页，重新读取",
  },
  unsupported: {
    icon: CloudOff,
    title: "当前浏览器不支持本地数据库",
    body: "浏览器更新后可能暂时禁用了 IndexedDB，或当前处于隐私/无痕模式。在确认数据状态前，应用保持只读，不会写入。请使用普通窗口重新打开，或检查浏览器的站点数据设置。",
    retryHint: "重新检测本地数据库",
  },
  failure: {
    icon: TriangleAlert,
    title: "本地项目暂时读取失败",
    body: "无法确认本地是否保存过项目，因此没有载入示例，也没有进入可写状态——你原有的项目很可能仍在数据库中。请稍后重试，或先取出恢复副本备份。",
    retryHint: "重新尝试读取",
  },
};

export default function LoadBlockedScreen({
  failure,
  onRetry,
  onExport,
}: Props) {
  const copy = REASON_COPY[failure.reason];
  const Icon = copy.icon;
  const [showCopy, setShowCopy] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [copied, setCopied] = useState(false);
  const recoveryText = failure.recoveryDocument
    ? serializeWorkspace(failure.recoveryDocument)
    : "";

  const handleExport = () => {
    if (onExport()) {
      setExportError(false);
    } else {
      setExportError(true);
      setShowCopy(true);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className="blocked-screen">
      <div className="blocked-card">
        <div className="blocked-mark">
          <Icon size={24} />
        </div>
        <strong>{copy.title}</strong>
        <p>{copy.body}</p>
        {failure.recoveryDocument ? (
          <div className="blocked-recovery">
            <span>
              <FileJson size={14} />
              找到一份本地恢复副本（
              {failure.recoveryDocument.projects.length}{" "}
              个项目），建议先取出备份：
            </span>
            <div className="blocked-actions">
              <button className="button button-primary" onClick={handleExport}>
                <Download size={14} /> 下载恢复副本
              </button>
              <button
                className="button button-neutral"
                onClick={() => setShowCopy((value) => !value)}
              >
                <Copy size={14} /> {showCopy ? "收起副本内容" : "查看副本内容"}
              </button>
            </div>
            {showCopy && (
              <div className="blocked-copy-area">
                <textarea readOnly value={recoveryText} rows={8} />
                <button className="text-action" onClick={handleCopy}>
                  {copied ? "已复制 ✓" : "复制全部文本 →"}
                </button>
              </div>
            )}
            {exportError && (
              <em className="blocked-error">
                自动下载未成功，请直接在上方文本框中全选复制保存。
              </em>
            )}
          </div>
        ) : (
          <div className="blocked-recovery">
            <span>
              没有找到额外的恢复副本，原有数据应仍保留在本地数据库中。
            </span>
          </div>
        )}
        <div className="blocked-actions">
          <button className="button button-primary" onClick={onRetry}>
            <RefreshCw size={14} /> {copy.retryHint}
          </button>
        </div>
        <em className="blocked-footnote">
          在数据成功读取之前，应用不会保存任何内容，因此不会覆盖你的项目。
        </em>
      </div>
    </main>
  );
}
