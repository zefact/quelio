import { useEffect, useMemo, useState } from "react";
import { previewChangeDatabaseOwner } from "../../api";
import { useModal } from "../../hooks/useModal";
import { SelectMenu } from "../SelectMenu";
import type { DbType } from "../../types";

interface Props {
  dbType: DbType;
  /** 所有者を変えるデータベース */
  name: string;
  /** 今の所有者 */
  current: string;
  /** 所有者に選べるロール */
  roles: string[];
  onCancel: () => void;
  /** 実行する。失敗したら例外を投げること (成功したら呼び出し側で閉じる) */
  onConfirm: (owner: string) => Promise<void>;
}

/**
 * データベースの所有者を付け替える (PostgreSQLのみ)。
 *
 * 新しい所有者を選ぶと、実行するSQLをそのまま見せる。
 * 中身は消えないので、削除のように名前を打ち込ませることはしない
 */
export function OwnerDialog({
  dbType,
  name,
  current,
  roles,
  onCancel,
  onConfirm,
}: Props) {
  const [owner, setOwner] = useState("");
  /** 実行するSQL (選ぶまでは無し) */
  const [sql, setSql] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useModal(onCancel, !busy);

  // 今の所有者は選んでも何も変わらないので、選択肢から外す
  const options = useMemo(
    () =>
      roles
        .filter((r) => r !== current)
        .map((r) => ({ value: r, label: r })),
    [roles, current]
  );

  // 選んだら、実行するSQLを組み立ててもらう (名前の不備もここで分かる)
  useEffect(() => {
    if (!owner) return;
    let alive = true;
    previewChangeDatabaseOwner(dbType, name, owner)
      .then((s) => {
        if (!alive) return;
        setSql(s);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setSql(null);
        setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [dbType, name, owner]);

  const run = async () => {
    if (!sql || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(owner);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={busy ? undefined : onCancel}>
      <div
        className="modal ddl-confirm"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            所有者を変更します
            <span className="column-modal-target mono">{name}</span>
          </span>
          <button
            className="modal-close"
            onClick={onCancel}
            disabled={busy}
            title="閉じる (Esc)"
          >
            ×
          </button>
        </div>

        <div className="column-modal-body">
          <div className="db-owner-fields">
            <div className="db-admin-opt-field">
              <span className="db-admin-opt-label">今の所有者</span>
              <span className="db-owner-current mono">{current}</span>
            </div>
            <div className="db-admin-opt-field">
              <span className="db-admin-opt-label">新しい所有者</span>
              <SelectMenu
                className="select-field mono"
                value={owner}
                options={options}
                disabled={busy || options.length === 0}
                placeholder={
                  options.length === 0 ? "選べるロールがありません" : "選んでください"
                }
                popFixed
                onChange={setOwner}
              />
            </div>
          </div>

          {sql && (
            <>
              <p className="confirm-sql-head">次のSQLを実行します</p>
              <pre className="mono confirm-sql">{sql}</pre>
            </>
          )}

          <p className="db-admin-hint">
            {/* 文の間に空白が入らないよう、1つの文字列で渡す */}
            {"変更できるのは、このデータベースの所有者で CREATEDB 権限を持つロールか、スーパーユーザーです。" +
              "選べるのは、今つないでいるロールが属しているロールだけです。"}
          </p>

          {error && (
            <div className="result-banner ng column-error">
              <span className="dot" aria-hidden />
              <strong>エラー</strong>
              <span className="result-detail">{error}</span>
            </div>
          )}
        </div>

        <div className="modal-actions column-modal-actions">
          <span className="toolbar-spacer" />
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={busy || !sql}
            onClick={() => void run()}
          >
            {busy ? (
              <>
                <span className="spinner light" /> 実行中...
              </>
            ) : (
              "変更する"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
