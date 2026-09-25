import { useEffect, useRef } from "react";
import { useModal } from "../hooks/useModal";
import type { AiApproval } from "../aiApproval";
import { envColor, envLabel } from "../types";
import type { ConnectionEnv } from "../types";
import { writeClipboard } from "../gridCopy";
import { imeBusy } from "../ime";

interface Props {
  item: AiApproval;
  /** 「拒否」または Esc / 背景クリック */
  onDeny: () => void;
  onAllow: () => void;
}

/**
 * AIが更新系のSQLを実行しようとしたときの許可ダイアログ。
 *
 * 通してしまったときの損が大きいので、ふつうの確認ダイアログとは作法を変える:
 * - 既定のフォーカスは「拒否」。Esc も拒否
 * - **Enterでは許可できない** (打鍵の流れで通ってしまうのを防ぐ)
 * - 実行されるSQLを全文そのまま出す (省略しない)
 * - 残り時間を出す。答えなければ時間切れで拒否になる
 */
export function AiApprovalDialog({ item, onDeny, onAllow }: Props) {
  // Escで閉じる (= 拒否) は共通の作法に乗せる
  const boxRef = useModal<HTMLDivElement>(onDeny);
  const denyRef = useRef<HTMLButtonElement>(null);

  // 開いたら「拒否」に合わせる (何も考えずEnterを押しても通らない)
  useEffect(() => {
    denyRef.current?.focus();
  }, [item.requestId]);

  const env = (item.env ?? undefined) as ConnectionEnv | undefined;
  const isProd = item.env === "prod";

  return (
    <div className="modal-overlay" onMouseDown={onDeny}>
      <div
        className="modal ai-approval"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // 日本語入力の変換中のキーは拾わない
          if (imeBusy(e)) return;
          // Enterで「許可」に流れないよう、ここで止める
          if (e.key === "Enter") e.preventDefault();
        }}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            AIがこのSQLを実行しようとしています
            <span className="column-modal-target mono">{item.connection}</span>
          </span>
          <span className="ai-approval-left">残り {item.remainingSecs} 秒</span>
        </div>

        <div className="column-modal-body">
          <div className={"ai-approval-target" + (isProd ? " prod" : "")}>
            <span className="ai-approval-conn">{item.connection}</span>
            {env && (
              <span className="env-badge" style={{ background: envColor(env) }}>
                {envLabel(env)}
              </span>
            )}
            {item.database && (
              <span className="ai-approval-db mono">{item.database}</span>
            )}
          </div>

          {isProd && (
            <div className="result-banner ng column-error">
              <span className="dot" aria-hidden />
              <strong>本番環境です</strong>
              <span className="result-detail">
                本来AIからの更新は許可できない設定です。心当たりが無ければ拒否してください。
              </span>
            </div>
          )}

          {item.dangerous.length > 0 && (
            <div className="column-warn">
              <span className="danger-sql-lead">
                取り返しのつかない操作が含まれています。
              </span>
              <ul className="danger-sql-list">
                {item.dangerous.map((d, i) => (
                  <li key={i}>
                    <span className="danger-sql-kind">{d.kind}</span>
                    <span className="danger-sql-text mono">{d.sql}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="ai-approval-sql-head">
            <span className="field-label">実行されるSQL</span>
            <button
              className="btn-ghost"
              onClick={() => void writeClipboard(item.sql)}
            >
              コピー
            </button>
          </div>
          <pre className="ai-approval-sql mono">{item.sql}</pre>

          <span className="field-note">
            許可するとそのまま実行されます。答えないまま時間が過ぎると、
            実行せずに終わります。
          </span>
        </div>

        <div className="modal-actions column-modal-actions">
          <span className="toolbar-spacer" />
          <button className="btn-secondary" ref={denyRef} onClick={onDeny}>
            拒否
          </button>
          <button className="btn-danger" onClick={onAllow}>
            許可して実行
          </button>
        </div>
      </div>
    </div>
  );
}
