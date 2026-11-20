import { reconnectSession, useConnLost } from "../hooks/useConnLost";

interface Props {
  /** タブのキー (= セッションID) */
  sessionId: string;
}

/**
 * 「接続が切れました」の帯 (SQL・Valkey のセッション画面の上)。
 *
 * 操作が「接続が切れた」種類のエラーで失敗したときだけ出る。
 * 「接続し直す」で生きているか確かめ、切れていれば張り直す。
 * 成功すれば帯もタブの印も消える
 */
export function ConnLostBanner({ sessionId }: Props) {
  const lost = useConnLost(sessionId);
  if (!lost) return null;
  return (
    <div className="result-banner ng session-error conn-lost-banner" role="alert">
      <span className="dot" aria-hidden />
      <strong>接続が切れました</strong>
      <span className="result-detail" title={lost.message}>
        {lost.message}
      </span>
      <button
        className="btn-secondary has-tooltip"
        disabled={lost.checking}
        data-tooltip="接続が生きているか確かめ、切れていれば接続し直します"
        onClick={() => reconnectSession(sessionId)}
      >
        {lost.checking ? (
          <>
            <span className="spinner accent" /> 接続し直しています…
          </>
        ) : (
          "接続し直す"
        )}
      </button>
    </div>
  );
}
