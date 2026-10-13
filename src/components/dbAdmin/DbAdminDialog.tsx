import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  changeDatabaseOwner,
  changeSchema,
  createDatabase,
  databaseOwners,
  dropDatabase,
  listSchemas,
  systemDatabases,
} from "../../api";
import { useModal } from "../../hooks/useModal";
import { AllDatabasesPanel } from "./AllDatabasesPanel";
import { CurrentDatabasePanel } from "./CurrentDatabasePanel";
import { DropNameConfirm } from "./DropNameConfirm";
import { NewDatabasePanel } from "./NewDatabasePanel";
import { OwnerDialog } from "./OwnerDialog";
import type { DatabaseOwners, DbType } from "../../types";

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
 * データベースとスキーマの作成・変更・削除。
 *
 * 何に対する操作かでタブを分ける (同じ並びに置くと、どれが何の操作か分かりにくい)。
 * - 新規作成: 新しいデータベースを作る
 * - 選択中のデータベース: つないでいるデータベース1つ (所有者・スキーマ。PostgreSQLのみ)
 * - すべてのデータベース: サーバーにあるもの全部 (所有者の変更・削除)
 * 作成は実行するSQLを見せてから、削除は名前を打ち込ませてから実行する。
 * PostgreSQLは、作るときに所有者を選べ、あとから付け替えられる。
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
  /** データベースの所有者と、選べるロール (PostgreSQLのみ。読むまでは null) */
  const [owners, setOwners] = useState<DatabaseOwners | null>(null);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  /** 所有者を変えようとしているデータベース */
  const [changing, setChanging] = useState<string | null>(null);
  /** 出している面 */
  const [picked, setPicked] = useState<"new" | "current" | "all">("new");
  /*
   * 「選択中のデータベース」でできるのは所有者とスキーマなので、PostgreSQLだけ。
   * データベースを選んでいなければ出さない (出していたなら新規作成へ戻す)
   */
  const hasCurrent = isPg && !!currentDb;
  const view = picked === "current" && !hasCurrent ? "new" : picked;
  const boxRef = useModal(onClose, !pending && !busy && !changing);

  /** データベース名から所有者を引く */
  const ownerOf = useMemo(
    () => new Map((owners?.databases ?? []).map((d) => [d.name, d.owner])),
    [owners]
  );

  // 所有者は一覧が変わるたびに読み直す (作成・削除のあと)
  useEffect(() => {
    if (!isPg) return;
    let alive = true;
    databaseOwners(sessionId)
      .then((o) => {
        if (!alive) return;
        setOwners(o);
        setOwnerError(null);
      })
      .catch((e) => {
        if (alive) setOwnerError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [isPg, sessionId, databases]);

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
      onMouseDown={pending || busy || changing ? undefined : onClose}
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

        {/*
          何に対する操作かで面を分ける。
          切り替えても書きかけの名前が消えないよう、面は隠すだけにする
        */}
        <div className="result-tabs db-admin-tabs" role="tablist">
          <Tab on={view === "new"} onClick={() => setPicked("new")}>
            新規作成
          </Tab>
          {hasCurrent && (
            <Tab on={view === "current"} onClick={() => setPicked("current")}>
              選択中のデータベース
              <span className="mono db-admin-tab-db">{currentDb}</span>
            </Tab>
          )}
          <Tab on={view === "all"} onClick={() => setPicked("all")}>
            すべてのデータベース
          </Tab>
        </div>

        <div hidden={view !== "new"}>
          <NewDatabasePanel
            sessionId={sessionId}
            dbType={dbType}
            owners={isPg ? owners : undefined}
            busy={busy}
            onBusyChange={setBusy}
            onCreate={async (name, encoding, collation, owner) => {
              onDatabasesChanged(
                await createDatabase(sessionId, name, encoding, collation, owner)
              );
              setNotice(`データベース ${name} を作成しました`);
            }}
          />
        </div>

        {hasCurrent && currentDb && (
          <div hidden={view !== "current"}>
            <CurrentDatabasePanel
              sessionId={sessionId}
              dbType={dbType}
              database={currentDb}
              owners={owners}
              ownerError={ownerError}
              system={system.has(currentDb.toLowerCase())}
              schemas={schemas}
              schemaError={schemaError}
              busy={busy}
              onBusyChange={setBusy}
              onChangeOwner={() => setChanging(currentDb)}
              onCreateSchema={async (name) => {
                setSchemas(
                  await changeSchema(sessionId, currentDb, name, false, false)
                );
                setNotice(`スキーマ ${name} を作成しました`);
              }}
              onDropSchema={(name) => setPending({ kind: "スキーマ", name })}
            />
          </div>
        )}

        <div hidden={view !== "all"}>
          <AllDatabasesPanel
            isPg={isPg}
            databases={databases}
            currentDb={currentDb}
            owners={owners}
            ownerError={ownerError}
            system={system}
            busy={busy}
            onChangeOwner={setChanging}
            onDrop={(name) => setPending({ kind: "データベース", name })}
          />
        </div>

        {changing && owners && (
          <OwnerDialog
            dbType={dbType}
            name={changing}
            current={ownerOf.get(changing) ?? ""}
            roles={owners.roles}
            onCancel={() => setChanging(null)}
            onConfirm={async (owner) => {
              setOwners(await changeDatabaseOwner(sessionId, changing, owner));
              setNotice(`データベース ${changing} の所有者を ${owner} に変更しました`);
              setChanging(null);
            }}
          />
        )}

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


/** 面を切り替えるタブ1つ */
function Tab({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={"result-tab" + (on ? " active" : "")}
      role="tab"
      aria-selected={on}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
