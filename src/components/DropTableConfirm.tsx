import { useEffect, useRef, useState } from "react";
import { dropTable } from "../api";
import type { TableInfo } from "../types";
import { prodActionText } from "../prodConfirm";
import { ModalFrame } from "./ModalFrame";
import { ProdNote } from "./ProdBadge";

interface Props {
  sessionId: string;
  database?: string;
  /** 消す対象 (複数選択のときは選んだぶんすべて) */
  tables: TableInfo[];
  onClose: () => void;
  /** 1件でも消せたときに呼ばれる (一覧の再読み込み用) */
  onDropped: () => void;
  /** 本番の接続か (見出しにバッジと、本文の先頭に本番の1行を出す) */
  prod?: boolean;
}

/** ビューかどうか (見出しの言葉を変えるだけ) */
function isView(tableType: string): boolean {
  return tableType.toUpperCase().includes("VIEW");
}

/** 表示用の名前 (スキーマがあれば付ける) */
function fullName(t: TableInfo): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/**
 * テーブル削除の確認。
 *
 * 削除はデータごと消えて戻せないため、本番かどうかに関わらず確認を出す。
 * まとめて消すときは、対象を全部見せたうえで、
 * さらにチェックを1つ入れてもらう (押し間違いで何十件も消えないように)
 */
export function DropTableConfirm({
  sessionId,
  database,
  tables,
  onClose,
  onDropped,
  prod = false,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const multi = tables.length > 1;
  const kind = tables.every((t) => isView(t.tableType))
    ? "ビュー"
    : tables.some((t) => isView(t.tableType))
      ? "テーブル・ビュー"
      : "テーブル";

  const apply = async () => {
    setBusy(true);
    setError(null);
    /*
     * 1件ずつ消す。途中で失敗しても、そこまでに消えたぶんは戻せないので、
     * 残りも試したうえで「何が消えて何が残ったか」を伝える
     */
    const failed: string[] = [];
    let done = 0;
    for (const t of tables) {
      try {
        await dropTable(sessionId, database, t.schema, t.name, t.tableType);
        done += 1;
      } catch (e) {
        failed.push(`${fullName(t)}: ${e}`);
      }
    }
    if (done > 0) onDropped();
    if (failed.length === 0) {
      onClose();
      return;
    }
    setError(
      `${done}件を削除しました。${failed.length}件は削除できませんでした。\n` +
        failed.join("\n")
    );
    setBusy(false);
  };

  /** 取り消せない操作なので、開いたときのフォーカスは「キャンセル」に置く */
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  /** 本番の1行に出す「どこで」 */
  const where = database ?? "このデータベース";

  return (
    <ModalFrame
      title={`${kind}を削除します`}
      target={multi ? `${tables.length}件` : fullName(tables[0])}
      prod={prod}
      onClose={onClose}
      closable={!busy}
      className="ddl-confirm"
      footer={
        <>
          <button
            className="btn-secondary"
            onClick={onClose}
            disabled={busy}
            ref={cancelRef}
          >
            キャンセル
          </button>
          <button
            className="btn-danger"
            disabled={busy || (multi && !agreed)}
            onClick={apply}
          >
            {busy ? (
              <>
                <span className="spinner light" /> 実行中…
              </>
            ) : multi ? (
              `${tables.length}件を削除する`
            ) : (
              "削除する"
            )}
          </button>
        </>
      }
    >
      <div className="column-modal-body">
        {prod && (
          <ProdNote>
            {prodActionText(
              where,
              multi
                ? `${kind} ${tables.length}件を削除します`
                : `${kind} ${fullName(tables[0])} を削除します`
            )}
          </ProdNote>
        )}
        <p className="column-warn">
          {kind === "ビュー"
            ? "定義は失われ、元に戻せません。"
            : "データと定義は失われ、元に戻せません。"}
        </p>

        {multi && (
          <>
            <ul className="drop-table-list mono">
              {tables.map((t) => (
                <li key={fullName(t)}>{fullName(t)}</li>
              ))}
            </ul>
            <label className="switch drop-table-agree">
              <input
                type="checkbox"
                checked={agreed}
                disabled={busy}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              <span className="track" aria-hidden />
              <span className="switch-label">
                上の{tables.length}件すべてを削除します
              </span>
            </label>
          </>
        )}

        {error && (
          <div className="result-banner ng column-error">
            <span className="dot" aria-hidden />
            <strong>エラー</strong>
            <span className="result-detail">{error}</span>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
