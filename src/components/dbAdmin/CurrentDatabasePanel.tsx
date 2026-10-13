import { CreateForm } from "./CreateForm";
import type { DatabaseOwners, DbType } from "../../types";

interface Props {
  sessionId: string;
  dbType: DbType;
  /** 選択中のデータベース */
  database: string;
  /** 所有者と選べるロール (読むまでは null) */
  owners: DatabaseOwners | null;
  ownerError: string | null;
  /** サーバーが使うデータベースか (所有者は変えさせない) */
  system: boolean;
  /** このデータベースのスキーマ (読むまでは null) */
  schemas: string[] | null;
  schemaError: string | null;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  /** 所有者を変える画面を開く */
  onChangeOwner: () => void;
  /** スキーマを作る。失敗したら例外を投げること */
  onCreateSchema: (name: string) => Promise<void>;
  /** スキーマの削除の確認を開く */
  onDropSchema: (name: string) => void;
}

/**
 * 「選択中のデータベース」タブ (PostgreSQLのみ)。
 *
 * 今つないでいるデータベース1つに対する操作 (所有者の変更・スキーマの作成と削除) をまとめる。
 * このデータベース自体は、つないでいる間は削除できない
 */
export function CurrentDatabasePanel({
  sessionId,
  dbType,
  database,
  owners,
  ownerError,
  system,
  schemas,
  schemaError,
  busy,
  onBusyChange,
  onChangeOwner,
  onCreateSchema,
  onDropSchema,
}: Props) {
  const owner = owners?.databases.find((d) => d.name === database)?.owner;

  return (
    <>
      <section className="db-admin-section">
        <h3 className="db-admin-title">所有者</h3>
        {ownerError && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <span className="result-detail">
              所有者を読めませんでした: {ownerError}
            </span>
          </div>
        )}
        <div className="db-admin-current-owner">
          <span className="mono db-admin-owner" title={owner}>
            {owner ?? "…"}
          </span>
          {system ? (
            <span className="faint">システムのため変更できません</span>
          ) : (
            <button
              className="btn-ghost"
              disabled={busy || !owners || owner === undefined}
              onClick={onChangeOwner}
            >
              所有者を変更
            </button>
          )}
        </div>
      </section>

      <section className="db-admin-section">
        <h3 className="db-admin-title">
          スキーマ
          {schemas && <span className="db-admin-count">{schemas.length}</span>}
        </h3>
        <CreateForm
          sessionId={sessionId}
          dbType={dbType}
          kind="スキーマ"
          withEncoding={false}
          disabled={busy}
          onBusyChange={onBusyChange}
          onCreate={onCreateSchema}
        />
        {schemaError && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <span className="result-detail">{schemaError}</span>
          </div>
        )}
        <h4 className="db-admin-subtitle">今あるスキーマ</h4>
        <ul className="db-admin-list">
          {(schemas ?? []).map((sc) => (
            <li key={sc}>
              <span className="mono">{sc}</span>
              <button
                className="btn-ghost danger"
                aria-label={`${sc} を削除`}
                disabled={busy}
                onClick={() => onDropSchema(sc)}
              >
                削除
              </button>
            </li>
          ))}
          {schemas !== null && schemas.length === 0 && (
            <li className="faint">スキーマがありません</li>
          )}
          {schemas === null && !schemaError && (
            <li className="faint">
              <span className="spinner accent" /> 読み込み中...
            </li>
          )}
        </ul>
      </section>

      <p className="db-admin-hint">
        {"public スキーマを消すと、このデータベースはほぼ使えなくなります。" +
          "このデータベース自体は、つないでいる間は削除できません (削除は「すべてのデータベース」から、別のデータベースを選んだ状態で行います)。"}
      </p>
    </>
  );
}
