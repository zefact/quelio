import { useEffect, useState } from "react";
import {
  changeSchema,
  createDatabase,
  dropDatabase,
  listSchemas,
  systemDatabases,
} from "../../api";
import { useModal } from "../../hooks/useModal";
import { CreateForm } from "./CreateForm";
import { DropNameConfirm } from "./DropNameConfirm";
import type { DbType } from "../../types";

/** 作ったり消したりする対象の呼び方 */
export type AdminKind = "データベース" | "スキーマ";

/** 削除の確認中の対象 */
interface Pending {
  kind: AdminKind;
  name: string;
}

interface Props {
  sessionId: string;
  dbType: DbType;
  /** 今つないでいるデータベース (これは削除できない) */
  currentDb: string | null;
  databases: string[];
  onClose: () => void;
  /** データベースの一覧が変わったときに呼ばれる */
  onDatabasesChanged: (list: string[]) => void;
}

/**
 * データベースとスキーマの作成・削除。
 *
 * 作成は確認なし、削除は名前を打ち込ませる。
 * 読み取り専用の接続では画面から開けない
 */
export function DbAdminDialog({
  sessionId,
  dbType,
  currentDb,
  databases,
  onClose,
  onDatabasesChanged,
}: Props) {
  const isPg = dbType === "postgresql";
  const [pending, setPending] = useState<Pending | null>(null);
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 作成の実行中か (途中で閉じるとエラー表示ごと消えてしまう) */
  const [busy, setBusy] = useState(false);
  /**
   * サーバーが自分のために使うデータベース (mysql / sys など)。
   * MySQLの SHOW DATABASES はこれらもそのまま返してくるので、
   * 名前をバックエンドから取って削除ボタンを出さない
   * (二重管理にならないよう、判断のもとは1箇所に置く)
   */
  const [system, setSystem] = useState<Set<string>>(new Set());
  const boxRef = useModal(onClose, !pending && !busy);

  useEffect(() => {
    let alive = true;
    systemDatabases(dbType)
      .then((list) => {
        if (alive) setSystem(new Set(list.map((d) => d.toLowerCase())));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [dbType]);

  // PostgreSQLのときだけ、選択中のDBのスキーマを読む
  useEffect(() => {
    // 読み直しの間に前のDBのスキーマを出したままにしない
    setSchemas(null);
    setSchemaError(null);
    setPending(null);
    if (!isPg || !currentDb) return;
    let alive = true;
    listSchemas(sessionId, currentDb)
      .then((list) => {
        if (alive) setSchemas(list);
      })
      .catch((e) => {
        if (alive) setSchemaError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [isPg, sessionId, currentDb]);

  /** 実行結果の表示は数秒で消す */
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const runDrop = async (cascade: boolean) => {
    if (!pending) return;
    if (pending.kind === "データベース") {
      onDatabasesChanged(await dropDatabase(sessionId, pending.name));
    } else {
      if (!currentDb) throw new Error("データベースが選ばれていません");
      setSchemas(
        await changeSchema(sessionId, currentDb, pending.name, true, cascade)
      );
    }
    setNotice(`${pending.kind} ${pending.name} を削除しました`);
    setPending(null);
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={pending || busy ? undefined : onClose}
    >
      <div
        className="modal db-admin-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">データベースの管理</span>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={busy}
            title={busy ? "処理中は閉じられません" : "閉じる (Esc)"}
          >
            ×
          </button>
        </div>

        {notice && (
          <div className="result-banner ok">
            <span className="dot" aria-hidden />
            <span className="result-detail">{notice}</span>
          </div>
        )}

        <section className="db-admin-section">
          <h3 className="db-admin-title">データベース</h3>
          <CreateForm
            sessionId={sessionId}
            dbType={dbType}
            kind="データベース"
            withEncoding
            disabled={busy}
            onBusyChange={setBusy}
            onCreate={async (name, encoding, collation) => {
              onDatabasesChanged(
                await createDatabase(sessionId, name, encoding, collation)
              );
              setNotice(`データベース ${name} を作成しました`);
            }}
          />
          <h4 className="db-admin-subtitle">
            今あるデータベース
            <span className="db-admin-count">{databases.length}</span>
          </h4>
          <ul className="db-admin-list">
            {databases.map((d) => (
              <li key={d} className={d === currentDb ? "current" : undefined}>
                <span className="mono">{d}</span>
                {d === currentDb ? (
                  <span className="faint">接続中のため削除できません</span>
                ) : system.has(d.toLowerCase()) ? (
                  <span className="faint">システムのため削除できません</span>
                ) : (
                  <button
                    className="btn-ghost danger"
                    aria-label={`${d} を削除`}
                    disabled={busy}
                    onClick={() =>
                      setPending({ kind: "データベース", name: d })
                    }
                  >
                    削除
                  </button>
                )}
              </li>
            ))}
            {databases.length === 0 && (
              <li className="faint">データベースがありません</li>
            )}
          </ul>
        </section>

        {isPg && (
          <section className="db-admin-section">
            <h3 className="db-admin-title">
              スキーマ
              {currentDb && (
                <span className="column-modal-target mono">{currentDb}</span>
              )}
            </h3>
            {!currentDb ? (
              <p className="db-admin-hint">
                データベースを選ぶと、そのスキーマを操作できます
              </p>
            ) : (
              <>
                <CreateForm
                  sessionId={sessionId}
                  dbType={dbType}
                  kind="スキーマ"
                  withEncoding={false}
                  disabled={busy}
                  onBusyChange={setBusy}
                  onCreate={async (name) => {
                    setSchemas(
                      await changeSchema(
                        sessionId,
                        currentDb,
                        name,
                        false,
                        false
                      )
                    );
                    setNotice(`スキーマ ${name} を作成しました`);
                  }}
                />
                {schemaError && (
                  <div className="result-banner ng">
                    <span className="dot" aria-hidden />
                    <span className="result-detail">{schemaError}</span>
                  </div>
                )}
                <h4 className="db-admin-subtitle">
                  今あるスキーマ
                  {schemas && (
                    <span className="db-admin-count">{schemas.length}</span>
                  )}
                </h4>
                <ul className="db-admin-list">
                  {(schemas ?? []).map((sc) => (
                    <li key={sc}>
                      <span className="mono">{sc}</span>
                      <button
                        className="btn-ghost danger"
                        aria-label={`${sc} を削除`}
                        disabled={busy}
                        onClick={() =>
                          setPending({ kind: "スキーマ", name: sc })
                        }
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
              </>
            )}
          </section>
        )}

        <p className="db-admin-hint">
          作成はすぐに実行します。削除は名前を打ち込んでから実行します。
          {isPg &&
            "PostgreSQLは、他につないでいる人がいるデータベースを削除できません。public スキーマを消すと、そのデータベースはほぼ使えなくなります。"}
        </p>

        {pending && (
          <DropNameConfirm
            kind={pending.kind}
            name={pending.name}
            askCascade={pending.kind === "スキーマ"}
            onCancel={() => setPending(null)}
            onConfirm={runDrop}
          />
        )}
      </div>
    </div>
  );
}
