import { CreateForm } from "./CreateForm";
import type { DatabaseOwners, DbType } from "../../types";

interface Props {
  sessionId: string;
  dbType: DbType;
  /** 所有者に選べるロール (PostgreSQLのときだけ渡す) */
  owners?: DatabaseOwners | null;
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
 * 「新規作成」タブ: 新しいデータベースを作る。
 *
 * 今あるデータベースへの操作は、ほかのタブに分けてある
 */
export function NewDatabasePanel({
  sessionId,
  dbType,
  owners,
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
        disabled={busy}
        onBusyChange={onBusyChange}
        onCreate={onCreate}
      />
      <p className="db-admin-hint">
        「作成」を押すと、実行するSQLを確かめてから作ります。
      </p>
    </section>
  );
}
