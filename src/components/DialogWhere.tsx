import { dbBadgeLabel } from "../colors";
import type { DbType } from "../types";

interface Props {
  /** 接続名 (分からなければ出さない) */
  connName?: string;
  /** データベース名 */
  database?: string | null;
  /** DB の種類 (渡すと先頭に小さなバッジを出す) */
  dbType?: DbType;
}

/**
 * ダイアログの見出しの下に出す「どの接続・どのデータベースへの操作か」の1行。
 *
 * SQLダンプの画面 (TransferDialog) の見出しと同じ形にそろえる。
 * 本番と検証で同じ名前のデータベースがあっても取り違えないよう、接続名も一緒に出す
 */
export function DialogWhere({ connName, database, dbType }: Props) {
  if (!connName && !database) return null;
  return (
    <div className="dialog-where tf-head-target">
      {dbType && (
        <span className={`db-badge mini ${dbType}`}>{dbBadgeLabel(dbType)}</span>
      )}
      {connName && <span className="mono">{connName}</span>}
      {connName && database && <span className="tf-head-sep">/</span>}
      {database && <span className="mono">{database}</span>}
    </div>
  );
}
