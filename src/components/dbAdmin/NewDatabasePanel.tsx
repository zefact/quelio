import { CreateForm } from "./CreateForm";
import type { DatabaseOwners, DbType } from "../../types";

interface Props {
  sessionId: string;
  dbType: DbType;
  /** 所有者に選べるロール (PostgreSQLのときだけ渡す) */
  owners?: DatabaseOwners | null;
  /** 本番の接続か (作成の確認に本番の1行を足す) */
  prod?: boolean;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  /** データベースを作る。失敗したら例外を投げること */
  onCreate: (
    name: string,
    encoding?: string,
    collation?: string,
    owner?: string
  ) => Promise<void>;
}

/**
 * 「新しいデータベース」タブ: 新しいデータベースを作成する。
 *
 * 今あるデータベースへの操作は、ほかのタブに分けてある
 */
export function NewDatabasePanel({
  sessionId,
  dbType,
  owners,
  prod,
  busy,
  onBusyChange,
  onCreate,
}: Props) {
  return (
    <section className="db-admin-section">
      <CreateForm
        sessionId={sessionId}
        dbType={dbType}
        kind="データベース"
        withEncoding
        owners={owners}
        prod={prod}
        disabled={busy}
        onBusyChange={onBusyChange}
        onCreate={onCreate}
      />
      <p className="db-admin-hint">
        「作成する」を押すと、実行するSQLを確かめてから作成します。
      </p>
    </section>
  );
}
