import { useEffect, useState } from "react";
import "./App.css";
import {
  addSqlHistory,
  cancelQuery,
  connectSession,
  createFolder,
  deleteConnection,
  deleteFolder,
  disconnectSession,
  listConnections,
  listTables,
  openConsole,
  openDiff,
  runQuery,
  saveConnection,
  tableDetail,
  testConnection,
  updateLayout,
} from "./api";
import { ConnectionPicker } from "./components/ConnectionPicker";
import { KvSessionView } from "./components/KvSessionView";
import { SessionView } from "./components/SessionView";
import { TabBar } from "./components/TabBar";
import { SettingsModal } from "./components/SettingsModal";
import { UpdateBanner } from "./components/UpdateBanner";
import type {
  ConnectionProfile,
  ConnectionStore,
  FolderInfo,
  LayoutEntry,
  TableInfo,
  WorkTab,
} from "./types";
import { emptyProfile, emptyTab } from "./types";

let tabSeq = 1;
function newTabKey(): string {
  return `tab-${tabSeq++}-${Math.random().toString(36).slice(2, 8)}`;
}

function App() {
  const [store, setStore] = useState<ConnectionStore>({
    folders: [],
    connections: [],
  });
  const [tabs, setTabs] = useState<WorkTab[]>(() => [emptyTab("tab-0")]);
  const [activeKey, setActiveKey] = useState("tab-0");
  const [showSettings, setShowSettings] = useState(false);

  const reload = async () => {
    try {
      setStore(await listConnections());
    } catch {
      /* 起動直後の読込失敗は個別タブで表示されるため無視 */
    }
  };

  // ---------- フォルダ・並べ替え ----------

  const handleCreateFolder = async (): Promise<FolderInfo | null> => {
    try {
      const folder = await createFolder("新しいフォルダ");
      await reload();
      return folder;
    } catch {
      return null;
    }
  };

  const handleDeleteFolder = async (id: string) => {
    try {
      await deleteFolder(id);
      await reload();
    } catch {
      /* 無視 */
    }
  };

  /** 接続のアイコン色を変更 */
  const handleSetConnColor = async (id: string, color: string | undefined) => {
    const conn = store.connections.find((c) => c.id === id);
    if (!conn) return;
    try {
      await saveConnection({ ...conn, color });
      await reload();
    } catch {
      /* 無視 */
    }
  };

  /** フォルダ構成・並び順の変更を保存 (楽観的更新) */
  const handleLayout = async (folders: FolderInfo[], order: LayoutEntry[]) => {
    setStore((s) => {
      const byId = new Map(s.connections.map((c) => [c.id, c]));
      const ordered: ConnectionProfile[] = [];
      for (const e of order) {
        const conn = byId.get(e.id);
        if (conn) {
          ordered.push({ ...conn, folderId: e.folderId });
          byId.delete(e.id);
        }
      }
      ordered.push(...byId.values());
      return { folders, connections: ordered };
    });
    try {
      await updateLayout(folders, order);
    } catch {
      await reload();
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const updateTab = (key: string, patch: Partial<WorkTab>) => {
    setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  };

  const addTab = () => {
    const key = newTabKey();
    setTabs((ts) => [...ts, emptyTab(key)]);
    setActiveKey(key);
  };

  /** タブを閉じる。最後の1枚を閉じたら新しい空タブを作る */
  const closeTab = async (key: string) => {
    const tab = tabs.find((t) => t.key === key);
    if (tab?.connected) {
      try {
        await disconnectSession(key);
      } catch {
        /* 無視 */
      }
    }
    setTabs((ts) => {
      const rest = ts.filter((t) => t.key !== key);
      if (rest.length === 0) {
        const nk = newTabKey();
        setActiveKey(nk);
        return [emptyTab(nk)];
      }
      setActiveKey((cur) => {
        if (cur !== key) return cur;
        const idx = ts.findIndex((t) => t.key === key);
        const neighbor = rest[Math.min(idx, rest.length - 1)];
        return neighbor.key;
      });
      return rest;
    });
  };

  // ---------- 未接続タブ(接続選択)の操作 ----------

  const handleSave = async (key: string): Promise<ConnectionProfile | null> => {
    const tab = tabs.find((t) => t.key === key);
    if (!tab) return null;
    updateTab(key, { busy: "save", error: null });
    try {
      const saved = await saveConnection(tab.profile);
      updateTab(key, { profile: saved, busy: null });
      await reload();
      return saved;
    } catch (e) {
      updateTab(key, { error: String(e), busy: null });
      return null;
    }
  };

  const handleDelete = async (key: string) => {
    const tab = tabs.find((t) => t.key === key);
    if (!tab?.profile.id) return;
    try {
      await deleteConnection(tab.profile.id);
      updateTab(key, {
        profile: emptyProfile(),
        testResult: null,
        error: null,
      });
      await reload();
    } catch (e) {
      updateTab(key, { error: String(e) });
    }
  };

  const handleTest = async (key: string) => {
    const tab = tabs.find((t) => t.key === key);
    if (!tab) return;
    updateTab(key, { busy: "test", testResult: null, error: null });
    try {
      const result = await testConnection(tab.profile);
      updateTab(key, { testResult: result, busy: null });
    } catch (e) {
      updateTab(key, { error: String(e), busy: null });
    }
  };

  /** 接続してこのタブをセッション画面に切り替える */
  const handleConnect = async (key: string, profile: ConnectionProfile) => {
    updateTab(key, {
      busy: "connect",
      error: null,
      testResult: null,
      profile: structuredClone(profile),
    });
    try {
      // 未保存の変更があれば保存してから接続
      const saved = await saveConnection(profile);
      await reload();
      const info = await connectSession(key, saved);
      const selectedDb = info.currentDb ?? null;
      updateTab(key, {
        profile: saved,
        connected: true,
        databases: info.databases,
        serverInfo: info.serverInfo ?? [],
        selectedDb,
        tables: [],
        selectedTable: null,
        loadingTables: saved.dbType !== "valkey" && selectedDb !== null,
        busy: null,
      });
      // Valkeyはテーブルの概念が無いため一覧取得しない
      if (selectedDb && saved.dbType !== "valkey") {
        await loadTables(key, selectedDb);
      }
    } catch (e) {
      updateTab(key, { error: String(e), busy: null });
    }
  };

  // ---------- 接続済みタブの操作 ----------

  const loadTables = async (key: string, database: string) => {
    // ValkeyはDB番号の切替のみ (キー一覧はKvSessionView側でSCANする)
    const tab = tabs.find((tb) => tb.key === key);
    if (tab?.profile.dbType === "valkey") {
      updateTab(key, { selectedDb: database, error: null });
      return;
    }
    updateTab(key, {
      selectedDb: database,
      loadingTables: true,
      selectedTable: null,
      tableDetail: null,
      error: null,
    });
    try {
      const tables = await listTables(key, database);
      updateTab(key, { tables, loadingTables: false });
    } catch (e) {
      updateTab(key, { tables: [], loadingTables: false, error: String(e) });
    }
  };

  /** テーブル選択 → 構造を読み込む */
  const handleSelectTable = async (key: string, t: TableInfo) => {
    const tab = tabs.find((tb) => tb.key === key);
    if (!tab?.selectedDb) return;
    updateTab(key, {
      selectedTable: `${t.schema ?? ""}.${t.name}`,
      tableDetail: null,
      loadingDetail: true,
      view: "structure",
      error: null,
    });
    try {
      const detail = await tableDetail(key, tab.selectedDb, t.schema, t.name);
      updateTab(key, { tableDetail: detail, loadingDetail: false });
    } catch (e) {
      updateTab(key, { loadingDetail: false, error: String(e) });
    }
  };

  /** SQLを実行する (sqlOverrideは選択実行用、offsetはページング用、transactionでBEGIN〜COMMIT/ROLLBACKに包む) */
  const handleRunQuery = async (
    key: string,
    offset = 0,
    sqlOverride?: string,
    transaction = false,
    explain?: "explain" | "analyze"
  ) => {
    const tab = tabs.find((t) => t.key === key);
    const sql = (sqlOverride ?? tab?.sql ?? "").trim();
    if (!tab || !sql) return;
    // 実行履歴に記録する (失敗しても実行は続ける)
    addSqlHistory(sql).catch(() => {});
    // 前回の実行結果はクリアしてから実行する
    updateTab(key, {
      runningQuery: true,
      runStartedAt: Date.now(),
      queryError: null,
      queryResults: null,
      queryExplain: explain ?? null,
    });
    try {
      const out = await runQuery(
        key,
        tab.selectedDb ?? undefined,
        sql,
        offset,
        undefined,
        undefined,
        transaction,
        explain
      );
      updateTab(key, {
        queryResults: out.statements.length > 0 ? out.statements : null,
        queryError: out.error ?? null,
        runningQuery: false,
      });
    } catch (e) {
      updateTab(key, {
        queryResults: null,
        queryError: String(e),
        runningQuery: false,
      });
    }
  };

  /** 実行中のSQLをキャンセルする */
  const handleCancelQuery = (key: string) => {
    cancelQuery(key).catch(() => {});
  };

  /** 文単位の再実行 (ページ送り・サーバーサイドソート共通) */
  const rerunStatement = async (
    key: string,
    index: number,
    offset: number,
    orderBy: string | undefined,
    orderDir: string | undefined
  ) => {
    const tab = tabs.find((t) => t.key === key);
    const stmt = tab?.queryResults?.[index];
    if (!tab || !stmt) return;
    updateTab(key, {
      runningQuery: true,
      runStartedAt: Date.now(),
      queryError: null,
    });
    try {
      const out = await runQuery(
        key,
        tab.selectedDb ?? undefined,
        stmt.sql,
        offset,
        orderBy,
        orderDir
      );
      const fresh = out.statements[0];
      if (out.error || !fresh) {
        updateTab(key, {
          queryError: out.error ?? "実行に失敗しました",
          runningQuery: false,
        });
        return;
      }
      updateTab(key, {
        queryResults: (tab.queryResults ?? []).map((s, i) =>
          i === index ? { sql: stmt.sql, result: fresh.result } : s
        ),
        runningQuery: false,
      });
    } catch (e) {
      updateTab(key, { queryError: String(e), runningQuery: false });
    }
  };

  /** 結果タブ単位のページ送り (現在のソートを維持) */
  const handlePageQuery = (key: string, index: number, offset: number) => {
    const stmt = tabs.find((t) => t.key === key)?.queryResults?.[index];
    return rerunStatement(
      key,
      index,
      offset,
      stmt?.result.orderBy,
      stmt?.result.orderDir
    );
  };

  /** サーバーサイドソートの変更 (先頭ページから取得し直す) */
  const handleSortQuery = (
    key: string,
    index: number,
    orderBy: string | null,
    orderDir: "asc" | "desc"
  ) => {
    return rerunStatement(key, index, 0, orderBy ?? undefined, orderDir);
  };

  const activeTab = tabs.find((t) => t.key === activeKey) ?? tabs[0];

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeKey={activeTab.key}
        onActivate={setActiveKey}
        onClose={closeTab}
        onAdd={addTab}
        onOpenConsole={() => openConsole().catch(() => {})}
        onOpenDiff={() => openDiff().catch(() => {})}
        onOpenSettings={() => setShowSettings(true)}
      />

      <UpdateBanner />

      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}

      <div className="workspace">
        {activeTab.connected && activeTab.profile.dbType === "valkey" ? (
          <KvSessionView
            tab={activeTab}
            onSelectDb={(db) => loadTables(activeTab.key, db)}
            onChangeSql={(sql) => updateTab(activeTab.key, { sql })}
            onSetConsole={(open) =>
              updateTab(activeTab.key, {
                view: open ? "query" : "structure",
              })
            }
            onKvOutput={(kvResults, kvExecError) =>
              updateTab(activeTab.key, { kvResults, kvExecError })
            }
          />
        ) : activeTab.connected ? (
          <SessionView
            tab={activeTab}
            onSelectDb={(db) => loadTables(activeTab.key, db)}
            onSelectTable={(t) => handleSelectTable(activeTab.key, t)}
            onToggleQuery={() =>
              updateTab(activeTab.key, {
                view: activeTab.view === "query" ? "structure" : "query",
              })
            }
            onChangeSql={(sql) => updateTab(activeTab.key, { sql })}
            onCancelQuery={() => handleCancelQuery(activeTab.key)}
            onRunQuery={(offset, sqlOverride, transaction, explain) =>
              handleRunQuery(
                activeTab.key,
                offset,
                sqlOverride,
                transaction,
                explain
              )
            }
            onPageQuery={(index, offset) =>
              handlePageQuery(activeTab.key, index, offset)
            }
            onSortQuery={(index, orderBy, orderDir) =>
              handleSortQuery(activeTab.key, index, orderBy, orderDir)
            }
          />
        ) : (
          <ConnectionPicker
            tab={activeTab}
            store={store}
            onCreateFolder={handleCreateFolder}
            onDeleteFolder={handleDeleteFolder}
            onLayout={handleLayout}
            onSetConnColor={handleSetConnColor}
            onChangeProfile={(p) => updateTab(activeTab.key, { profile: p })}
            onSelectFavorite={(p) =>
              updateTab(activeTab.key, {
                profile: structuredClone(p),
                testResult: null,
                error: null,
              })
            }
            onNewFavorite={() =>
              updateTab(activeTab.key, {
                profile: emptyProfile(),
                testResult: null,
                error: null,
              })
            }
            onSave={() => handleSave(activeTab.key)}
            onDelete={() => handleDelete(activeTab.key)}
            onTest={() => handleTest(activeTab.key)}
            onConnect={(p) => handleConnect(activeTab.key, p)}
          />
        )}
      </div>
    </div>
  );
}

export default App;
