/**
 * 画面いちばん下の状態表示。
 *
 * 「今どこに繋がっていて、変更が確定しているのか」を常に見えるようにする。
 * トランザクションが開いたままだと、閉じるまで他の人からは変更が見えないので、
 * ここで気づけるようにしておく
 */
import type { ConnectionProfile, TxnStatus } from "../types";
import { envColor, envLabel } from "../types";
import { badgeStyle, dbBadgeLabel, profileColor } from "../colors";

export interface LastRun {
  /** 取得した行数 (更新系は影響行数) */
  rows: number;
  /** 更新系か (文言を「行に影響」に変える) */
  affected: boolean;
  elapsedMs: number;
}

interface Props {
  profile: ConnectionProfile;
  /** 選んでいるデータベース (未選択なら null) */
  database: string | null;
  /** トランザクションの状態 (Valkeyなど無い画面は "none") */
  txn: Exclude<TxnStatus, "busy">;
  /** 確定 / 取り消し。渡さなければボタンを出さない */
  onEndTxn?: (commit: boolean) => void;
  /** 確定 / 取り消しの実行中 */
  txnBusy?: boolean;
  /** 閉じられなかったときの文言 */
  txnError?: string | null;
  /** 直近の実行の要約 (無ければ出さない) */
  lastRun?: LastRun | null;
}

export function StatusBar({
  profile,
  database,
  txn,
  onEndTxn,
  txnBusy = false,
  txnError,
  lastRun,
}: Props) {
  const open = txn === "open" || txn === "broken";
  return (
    <div className={"status-bar" + (open ? " txn-open" : "")}>
      <span className={`db-badge ${profile.dbType}`} style={badgeStyle(profileColor(profile))}>
        {dbBadgeLabel(profile.dbType)}
      </span>
      <span className="status-name" title={profile.name || "(無名)"}>
        {profile.name || "(無名)"}
      </span>
      {profile.env && (
        <span
          className="status-env"
          style={{
            color: envColor(profile.env),
            borderColor: envColor(profile.env),
          }}
        >
          {envLabel(profile.env)}
        </span>
      )}
      {database && (
        // 等幅は内側のspanにだけ掛ける。
        // 外側 (行の高さの基準) を帯と同じフォントに揃えることで、
        // 等幅フォントの高さの違いでDB名だけ下にずれるのを防ぐ
        <span className="status-db" title={database}>
          <span className="mono">{database}</span>
        </span>
      )}
      {profile.readOnly && (
        <span
          className="status-ro"
          title="読み取り専用の接続です (更新・定義の変更はできません)"
        >
          読み取り専用
        </span>
      )}

      <span className="status-spacer" />

      {txnError && <span className="status-error">{txnError}</span>}

      {open && (
        <span className="status-txn">
          <span className="status-txn-label">
            {txn === "broken"
              ? "トランザクションの後始末に失敗"
              : "トランザクション中 (未確定)"}
          </span>
          {onEndTxn && (
            <>
              {/* 後始末に失敗した接続では確定できない (取り消しだけ出す) */}
              {txn === "open" && (
                <button
                  className="status-txn-btn commit"
                  disabled={txnBusy}
                  title="COMMIT を実行して、変更を確定します"
                  onClick={() => onEndTxn(true)}
                >
                  確定
                </button>
              )}
              <button
                className="status-txn-btn"
                disabled={txnBusy}
                title="ROLLBACK を実行して、変更を取り消します"
                onClick={() => onEndTxn(false)}
              >
                取り消し
              </button>
            </>
          )}
        </span>
      )}

      {lastRun && (
        <span className="status-run mono">
          {lastRun.affected
            ? `${lastRun.rows.toLocaleString()}行に影響`
            : `${lastRun.rows.toLocaleString()}行`}
          <span className="status-run-ms">
            {lastRun.elapsedMs.toLocaleString()}ms
          </span>
        </span>
      )}
    </div>
  );
}
