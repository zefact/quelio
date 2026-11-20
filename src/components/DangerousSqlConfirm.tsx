import type { DangerousStatement, DbType } from "../types";
import { confirmHeading, prodActionText } from "../prodConfirm";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  /** 見つかった注意が必要なSQL */
  statements: DangerousStatement[];
  /** 接続名 (どこに対して実行するのかを明示する) */
  connection: string;
  /** 対象のデータベース名 */
  database?: string;
  /** トランザクションで実行するか (OFFなら取り消せないことを伝える) */
  transaction: boolean;
  /** 接続先のDB種別 (MySQLは定義変更を取り消せないため注意を変える) */
  dbType: DbType;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 取り返しのつかないSQLを実行する前の確認。
 * どの接続先の、どのデータベースに対して、何をするのかを見せてから実行する
 */
export function DangerousSqlConfirm({
  statements,
  connection,
  database,
  transaction,
  dbType,
  onCancel,
  onConfirm,
}: Props) {
  /** 定義変更 (DDL) が含まれるか */
  const hasDdl = statements.some((s) =>
    /^(DROP|TRUNCATE|ALTER|RENAME)/.test(s.kind)
  );
  /*
   * 本番の更新が混ざっているか (Rust側が文ごとに判定した結果)。
   * 本番のときは見出しを変え、本番の1行を出す
   */
  const heading = confirmHeading(statements);
  /* MySQLはDDLを実行した時点で自動コミットされ、ROLLBACKでは戻せない */
  const note = !transaction
    ? "トランザクションがOFFなので、実行した内容は元に戻せません。"
    : hasDdl && dbType === "mysql"
      ? "トランザクションはONですが、MySQLでは定義の変更 (DROP / TRUNCATE / ALTER など) は自動で確定され、元に戻せません。"
      : "トランザクションONのため、途中でエラーになれば元に戻ります。";
  const target = database ? `${connection} / ${database}` : connection;

  return (
    <ConfirmDialog
      title={heading.title}
      target={target}
      confirmLabel="実行する"
      prodNote={
        heading.prod ? prodActionText(target, "データを変更するSQLを実行します") : undefined
      }
      // 取り返しのつかないSQLなので、本番でなくても「キャンセル」を選びやすくする
      defaultFocus="cancel"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <span className="danger-sql-lead">
        次のSQLが含まれています。{note}
      </span>
      <ul className="danger-sql-list">
        {statements.map((s, i) => (
          <li key={i}>
            <span className="danger-sql-kind">{s.kind}</span>
            <span className="danger-sql-text mono">{s.sql}</span>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
