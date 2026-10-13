import type { DatabaseOwners } from "../../types";

interface Props {
  isPg: boolean;
  databases: string[];
  /** 選択中のデータベース (これは削除できない) */
  currentDb: string | null;
  /** 所有者と選べるロール (PostgreSQLのみ。読むまでは null) */
  owners: DatabaseOwners | null;
  ownerError: string | null;
  /** サーバーが使うデータベース (小文字)。変更も削除もさせない */
  system: Set<string>;
  busy: boolean;
  /** 所有者を変える画面を開く */
  onChangeOwner: (name: string) => void;
  /** 削除の確認を開く */
  onDrop: (name: string) => void;
}

/**
 * 「すべてのデータベース」タブ。
 *
 * サーバーにあるデータベースを表にして、行ごとに所有者の変更 (PostgreSQLのみ) と削除を置く
 */
export function AllDatabasesPanel({
  isPg,
  databases,
  currentDb,
  owners,
  ownerError,
  system,
  busy,
  onChangeOwner,
  onDrop,
}: Props) {
  const ownerOf = new Map(
    (owners?.databases ?? []).map((d) => [d.name, d.owner])
  );
  // 所有者の列は PostgreSQL のときだけ (MySQLのデータベースには所有者が無い)
  const grid = isPg ? "db-admin-table" : "db-admin-table no-owner";

  return (
    <section className="db-admin-section">
      {ownerError && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <span className="result-detail">
            所有者を読めませんでした: {ownerError}
          </span>
        </div>
      )}

      <div className={grid + " db-admin-table-head"} aria-hidden>
        <span>
          データベース
          <span className="db-admin-count">{databases.length}</span>
        </span>
        {isPg && <span>所有者</span>}
        <span />
      </div>
      <ul className={grid + " db-admin-list"}>
        {databases.map((d) => {
          const isSystem = system.has(d.toLowerCase());
          const owner = ownerOf.get(d);
          return (
            <li key={d} className={d === currentDb ? "current" : undefined}>
              <span className="mono" title={d}>
                {d}
                {d === currentDb && (
                  <span className="db-admin-selected">選択中</span>
                )}
              </span>
              {isPg && (
                <span className="mono db-admin-owner" title={owner}>
                  {owner ?? "…"}
                </span>
              )}
              <span className="db-admin-actions">
                {isSystem ? (
                  <span className="faint">
                    {isPg
                      ? "システムのため変更・削除できません"
                      : "システムのため削除できません"}
                  </span>
                ) : (
                  <>
                    {isPg && (
                      <button
                        className="btn-ghost"
                        disabled={busy || !owners || owner === undefined}
                        aria-label={`${d} の所有者を変更`}
                        onClick={() => onChangeOwner(d)}
                      >
                        所有者を変更
                      </button>
                    )}
                    {d === currentDb ? (
                      <span
                        className="faint"
                        title="別のデータベースを選ぶと削除できます"
                      >
                        選択中のため削除不可
                      </span>
                    ) : (
                      <button
                        className="btn-ghost danger"
                        aria-label={`${d} を削除`}
                        disabled={busy}
                        onClick={() => onDrop(d)}
                      >
                        削除
                      </button>
                    )}
                  </>
                )}
              </span>
            </li>
          );
        })}
        {databases.length === 0 && (
          <li className="faint">データベースがありません</li>
        )}
      </ul>

      <p className="db-admin-hint">
        {"削除は名前を打ち込んでから実行します。" +
          (isPg
            ? "他につないでいる人がいるデータベースは削除できません。" +
              "所有者を変更できるのは、そのデータベースの所有者で CREATEDB 権限を持つロールか、スーパーユーザーです。"
            : "")}
      </p>
    </section>
  );
}
