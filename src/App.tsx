import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  addSqlHistory,
  cancelQuery,
  connectSession,
  createFolder,
  deleteConnection,
  deleteFolder,
  disconnectSession,
  getAppSettings,
  getSqlParams,
  listConnections,
  listTables,
  openConsole,
  openDiff,
  runQuery,
  saveConnection,
  saveSqlParams,
  schemaSnapshot,
  tableDetail,
  testConnection,
  updateLayout,
} from "./api";
import { listen } from "@tauri-apps/api/event";
import { AboutDialog } from "./components/AboutDialog";
import { ConnectionPicker } from "./components/ConnectionPicker";
import { QuickOpen } from "./components/QuickOpen";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { KvSessionView } from "./components/KvSessionView";
import { SessionView } from "./components/SessionView";
import { TabBar } from "./components/TabBar";
import { SettingsModal } from "./components/SettingsModal";
import { SqlParamModal } from "./components/SqlParamModal";
import { UpdateBanner } from "./components/UpdateBanner";
import {
  extractParams,
  guessParamColumn,
  isNumericType,
} from "./sqlParams";
import type { ParamKind, ParamValue } from "./sqlParams";
import { buildSchemaTips } from "./columnTips";
import { buildTableSelect, tableKey } from "./tableSql";
import type {
  ConnectionProfile,
  ConnectionStore,
  EditorOptions,
  FolderInfo,
  LayoutEntry,
  QuerySheet,
  SchemaEntry,
  TableInfo,
  TableTab,
  WorkTab,
} from "./types";
import type { SheetPane, TableDataPane } from "./components/panes";
import {
  emptyProfile,
  emptySheet,
  emptyTab,
  emptyTableData,
  newSheetId,
  type TabEditorState,
  type TabKvState,
  type TabTableData,
} from "./types";
import { emitAppEvent, SAVE_SQL_EVENT } from "./appEvents";
import {
  loadWorkspace,
  MAX_SHEETS,
  storeWorkspace,
  toSaved,
  toTabs,
} from "./workspace";

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
  /*
   * 最新のタブ一覧。
   * 画面へ渡すハンドラを毎回作り直さずに済ませるため、
   * ハンドラの中からは state ではなくこちらを見る
   * (state を直接見ると、作った時点の内容に固定されてしまう)
   */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /** キーからタブを取り出す (常に最新の状態) */
  const tabOf = (key: string) => tabsRef.current.find((t) => t.key === key);
  const [activeKey, setActiveKey] = useState("tab-0");
  const [showSettings, setShowSettings] = useState(false);
  // macOSのメニュー「Quelioについて」から開く (Windowsは︙メニューから)
  const [showAbout, setShowAbout] = useState(false);
  /** 別ウィンドウを開けなかったときの表示 (握りつぶすと無反応に見えるため) */
  const [winError, setWinError] = useState<string | null>(null);
  /** 接続先のクイックオープン (⌘K) を出しているか */
  const [quickOpen, setQuickOpen] = useState(false);
  /** ショートカット一覧 (⌘/) を出しているか */
  const [showShortcuts, setShowShortcuts] = useState(false);
  /** SQLパラメータ入力モーダルの状態 (実行を保留した内容) */
  const [paramReq, setParamReq] = useState<{
    key: string;
    /** 値を保存する単位 (接続プロファイルID) */
    scope: string;
    offset: number;
    sql: string;
    params: string[];
    initial: Record<string, ParamValue>;
    transaction: boolean;
    explain?: "explain" | "analyze";
  } | null>(null);
  /** パラメータ型推測用のスキーマキャッシュ (セッション:DB → スキーマ) */
  const schemaCache = useRef(new Map<string, SchemaEntry[]>());

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

  /** フォルダ削除 (失敗は呼び出し元の確認ダイアログに出す) */
  const handleDeleteFolder = async (id: string) => {
    await deleteFolder(id);
    await reload();
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
  const handleLayout = async (
    folders: FolderInfo[],
    order: LayoutEntry[],
    rootOrder?: string[]
  ) => {
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
      return {
        folders,
        connections: ordered,
        rootOrder: rootOrder ?? s.rootOrder,
      };
    });
    try {
      await updateLayout(folders, order, rootOrder);
    } catch {
      await reload();
    }
  };

  /** 前回の作業状態を復元し終えたか (終わるまで保存しない) */
  const restored = useRef(false);

  useEffect(() => {
    (async () => {
      let loaded: ConnectionStore;
      try {
        loaded = await listConnections();
      } catch {
        // 接続先を読めないまま復元すると、接続先なしの状態で
        // 上書き保存してしまうため、この起動では復元も保存もしない
        return;
      }
      setStore(loaded);
      /*
       * 前回のタブを戻すかどうかは設定で決める (既定は戻さない)。
       * 戻さない場合も、書きかけSQLを消さないよう読み込みだけは行い、
       * 自動保存を止めないようにする
       */
      const restoreTabs = await getAppSettings()
        .then((s) => s.restoreTabs)
        .catch(() => false);
      // 前回開いていたタブと書きかけSQLを戻す (接続はしない)
      const saved = await loadWorkspace();
      // 読めなかった場合は、空の状態で上書きしないよう保存も止める。
      // 黙って止めると「保存されない」ことに気づけないので画面にも出す
      if (!saved.ok) {
        setWinError(
          "前回の作業状態を読めませんでした。" +
            "書きかけのSQLを失わないよう、この起動では保存しません " +
            "(設定フォルダの workspace.json を消すと次回から保存します)"
        );
        return;
      }
      // 中身が壊れていると組み立てで落ちることがある。
      // そのまま抜けると自動保存が止まったままになるので、ここで受け止める
      let built: { tabs: WorkTab[]; activeKey: string } | null = null;
      try {
        built = saved.data ? toTabs(saved.data, loaded, newTabKey) : null;
      } catch {
        setWinError(
          "前回の作業状態が壊れていました。" +
            "書きかけのSQLを失わないよう、この起動では保存しません " +
            "(設定フォルダの workspace.json を消すと次回から保存します)"
        );
        return;
      }
      if (built && restoreTabs) {
        setTabs(built.tabs);
        setActiveKey(built.activeKey);
      }
      restored.current = true;
    })();
  }, []);

  // タブと書きかけSQLを自動保存する (変化が止まってから書く)
  const savedText = useRef("");
  useEffect(() => {
    if (!restored.current) return;
    const data = toSaved(tabs, activeKey);
    const text = JSON.stringify(data);
    if (text === savedText.current) return;
    const timer = window.setTimeout(() => {
      // 書けたことを確認してから「保存済み」とみなす
      storeWorkspace(data).then((ok) => {
        if (ok) savedText.current = text;
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [tabs, activeKey]);

  /*
   * タブ操作のショートカット。
   * ⌘T 新しいタブ / ⌘W 閉じる / ⌘1〜9 切替 / ⌃Tab 次へ /
   * ⌘K 接続先を探して開く / ⌘/ ショートカット一覧 / ⌘S SQLをお気に入りへ
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      // ブラウザの保存ダイアログはモーダル表示中でも出させない
      // (日本語入力の変換中でも出てしまうので、ここは先に止める)
      if (mod && !e.altKey && !e.shiftKey && key === "s") e.preventDefault();
      // 変換中のキーはアプリの操作としては扱わない
      if (e.isComposing) return;
      // ⌘/ は開閉のトグルなので、出ている間も受け取る
      if (mod && e.key === "/" && showShortcuts) {
        e.preventDefault();
        setShowShortcuts(false);
        return;
      }
      // モーダル(転送・設定・確認など)が出ている間は、
      // 裏のタブを閉じたり切り替えたりしない
      if (document.querySelector(".modal-overlay")) return;
      if (mod && !e.shiftKey && key === "t") {
        e.preventDefault();
        addTab();
      } else if (mod && key === "w") {
        e.preventDefault();
        closeTab(activeKey);
      } else if (mod && !e.shiftKey && key === "k") {
        e.preventDefault();
        setQuickOpen(true);
      } else if (mod && e.key === "/") {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      } else if (mod && !e.altKey && !e.shiftKey && key === "s") {
        // SQLエディタを開いていれば、お気に入りへの保存ダイアログを出す
        // (既定の動作は上で止めてある)
        emitAppEvent(SAVE_SQL_EVENT);
      } else if (mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (tabs[idx]) {
          e.preventDefault();
          setActiveKey(tabs[idx].key);
        }
      } else if (e.ctrlKey && e.key === "Tab" && tabs.length > 1) {
        e.preventDefault();
        const cur = tabs.findIndex((t) => t.key === activeKey);
        const next = e.shiftKey
          ? (cur - 1 + tabs.length) % tabs.length
          : (cur + 1) % tabs.length;
        setActiveKey(tabs[next].key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeKey, showShortcuts]);

  // ネイティブメニューからの「Quelioについて」
  useEffect(() => {
    const un = listen("show-about", () => setShowAbout(true));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  /** SQLエディタまわりの状態だけを部分更新する */
  const patchEditor = (key: string, patch: Partial<TabEditorState>) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.key === key ? { ...t, editor: { ...t.editor, ...patch } } : t
      )
    );
  };

  /** 実行設定 (トランザクション等) だけを更新する */
  const patchEditorOpts = (key: string, patch: Partial<EditorOptions>) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.key === key
          ? {
              ...t,
              editor: {
                ...t.editor,
                editorOpts: { ...t.editor.editorOpts, ...patch },
              },
            }
          : t
      )
    );
  };

  const updateTab = (key: string, patch: Partial<WorkTab>) => {
    setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  };

  /** Valkey画面の状態だけを部分更新する */
  const patchKv = (key: string, patch: Partial<TabKvState>) => {
    setTabs((ts) =>
      ts.map((t) => (t.key === key ? { ...t, kv: { ...t.kv, ...patch } } : t))
    );
  };

  /** データタブの状態だけを部分更新する */
  const patchData = (key: string, patch: Partial<TabTableData>) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.key === key ? { ...t, tableData: { ...t.tableData, ...patch } } : t
      )
    );
  };

  /** 表示中のシートの内容を取り出す (しまうとき用) */
  const currentSheet = (e: TabEditorState): QuerySheet => ({
    id: e.activeSheet,
    title: e.sheets.find((s) => s.id === e.activeSheet)?.title ?? "",
    sql: e.sql,
    queryResults: e.queryResults,
    queryError: e.queryError,
    queryExplain: e.queryExplain,
    editorOpts: e.editorOpts,
  });

  /** シートの内容を表示中の側へ出す */
  const showSheet = (sheet: QuerySheet): Partial<TabEditorState> => ({
    activeSheet: sheet.id,
    sql: sheet.sql,
    queryResults: sheet.queryResults,
    queryError: sheet.queryError,
    queryExplain: sheet.queryExplain,
    editorOpts: sheet.editorOpts,
  });

  /** 表示中のシートを一覧へ書き戻す (まだ一覧に無ければ足す) */
  const storeSheet = (e: TabEditorState): QuerySheet[] => {
    const stored = currentSheet(e);
    return e.sheets.some((s) => s.id === e.activeSheet)
      ? e.sheets.map((s) => (s.id === e.activeSheet ? stored : s))
      : [...e.sheets, stored];
  };

  /**
   * エディタの状態を差し替える。
   * 実行中は結果の行き先が変わってしまうので、シート操作は受け付けない
   */
  const updateSheets = (
    key: string,
    fn: (e: TabEditorState) => Partial<TabEditorState> | null
  ) => {
    setTabs((ts) =>
      ts.map((t) => {
        if (t.key !== key || t.editor.running) return t;
        const patch = fn(t.editor);
        return patch ? { ...t, editor: { ...t.editor, ...patch } } : t;
      })
    );
  };

  /** シートを切り替える (今の内容をしまってから、選んだシートを出す) */
  const switchSheet = (key: string, id: string) => {
    updateSheets(key, (e) => {
      if (e.activeSheet === id) return null;
      const target = e.sheets.find((s) => s.id === id);
      if (!target) return null;
      return { sheets: storeSheet(e), ...showSheet(target) };
    });
  };

  /** シートを増やす (今の内容はしまい、空のシートを開く) */
  const addSheet = (key: string) => {
    updateSheets(key, (e) => {
      // 保存できる枚数を超えないようにする (画面の「＋」も同じ上限で止める)
      const list = storeSheet(e);
      if (list.length >= MAX_SHEETS) return null;
      const fresh = emptySheet(newSheetId());
      return {
        sheets: [...list, fresh],
        ...showSheet(fresh),
        // 実行設定 (トランザクション等) は今のシートの設定を引き継ぐ
        editorOpts: { ...e.editorOpts },
      };
    });
  };

  /** シートを閉じる (最後の1枚は閉じない) */
  const closeSheet = (key: string, id: string) => {
    updateSheets(key, (e) => {
      const list = storeSheet(e);
      if (list.length <= 1) return null;
      const at = list.findIndex((s) => s.id === id);
      if (at === -1) return null;
      const rest = list.filter((s) => s.id !== id);
      // 閉じたのが表示中でなければ、表示はそのまま
      if (id !== e.activeSheet) return { sheets: rest };
      return { sheets: rest, ...showSheet(rest[Math.min(at, rest.length - 1)]) };
    });
  };

  /** シートに名前を付ける (空なら自動の見出しに戻る) */
  const renameSheet = (key: string, id: string, title: string) => {
    setTabs((ts) =>
      ts.map((t) => {
        if (t.key !== key) return t;
        // 一覧にまだ無い (最初のシート) 場合はここで足してから付ける
        const e = t.editor;
        const list = e.sheets.some((s) => s.id === e.activeSheet)
          ? e.sheets
          : [...e.sheets, currentSheet(e)];
        return {
          ...t,
          editor: {
            ...e,
            sheets: list.map((s) => (s.id === id ? { ...s, title } : s)),
          },
        };
      })
    );
  };

  const addTab = () => {
    const key = newTabKey();
    setTabs((ts) => [...ts, emptyTab(key)]);
    setActiveKey(key);
  };

  /** タブを閉じる。最後の1枚を閉じたら新しい空タブを作る */
  const closeTab = async (key: string) => {
    const tab = tabOf(key);
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
    const tab = tabOf(key);
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

  /** 接続先の削除 (失敗は呼び出し元の確認ダイアログに出す) */
  const handleDelete = async (key: string) => {
    const tab = tabOf(key);
    if (!tab?.profile.id) return;
    await deleteConnection(tab.profile.id);
    updateTab(key, {
      profile: emptyProfile(),
      testResult: null,
      error: null,
    });
    await reload();
  };

  const handleTest = async (key: string) => {
    const tab = tabOf(key);
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
      /*
       * 接続では保存しない (保存は「保存」ボタンを押したときだけ)。
       * 読み取り専用に切り替えて一度だけ繋ぐ、といった使い方で
       * 設定が書き換わってしまわないようにする
       */
      const info = await connectSession(key, profile);
      const selectedDb = info.currentDb ?? null;
      updateTab(key, {
        connected: true,
        databases: info.databases,
        serverInfo: info.serverInfo ?? [],
        selectedDb,
        tables: [],
        selectedTable: null,
        loadingTables: profile.dbType !== "valkey" && selectedDb !== null,
        busy: null,
      });
      // Valkeyはテーブルの概念が無いため一覧取得しない
      if (selectedDb && profile.dbType !== "valkey") {
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
      // カラム説明はDB単位のため作り直す
      columnTips: {},
      columnTipsDb: null,
      error: null,
    });
    try {
      const tables = await listTables(key, database);
      updateTab(key, { tables, loadingTables: false });
    } catch (e) {
      updateTab(key, { tables: [], loadingTables: false, error: String(e) });
    }
  };

  /**
   * テーブル一覧だけを取得し直す (再読み込みボタン)。
   * 選択中のテーブルや表示中の内容は、一覧に残っている限り維持する
   */
  const reloadTables = async (key: string) => {
    const tab = tabs.find((tb) => tb.key === key);
    if (!tab?.selectedDb || tab.profile.dbType === "valkey") return;
    try {
      const tables = await listTables(key, tab.selectedDb);
      const stillExists =
        tab.selectedTable !== null &&
        tables.some((t) => tableKey(t) === tab.selectedTable);
      updateTab(key, {
        tables,
        error: null,
        // 消えたテーブルを選んだままにしない
        ...(stillExists
          ? {}
          : {
              selectedTable: null,
              tableDetail: null,
              tableData: emptyTableData(),
            }),
      });
    } catch (e) {
      updateTab(key, { error: String(e) });
    }
  };

  /** 選択中テーブルの定義を取得し直す (カラム変更後などに使う) */
  const reloadTableDetail = async (key: string) => {
    const tab = tabOf(key);
    const table = tab?.tables.find((t) => tableKey(t) === tab.selectedTable);
    if (!tab?.selectedDb || !table) return;
    updateTab(key, { loadingDetail: true, error: null });
    try {
      const detail = await tableDetail(
        key,
        tab.selectedDb,
        table.schema,
        table.name
      );
      updateTab(key, { tableDetail: detail, loadingDetail: false });
    } catch (e) {
      updateTab(key, { loadingDetail: false, error: String(e) });
    }
  };

  /** テーブル選択 → 構造を読み込む (データタブを開いていればデータも取得する) */
  const handleSelectTable = async (key: string, t: TableInfo) => {
    const tab = tabs.find((tb) => tb.key === key);
    if (!tab?.selectedDb) return;
    updateTab(key, {
      selectedTable: tableKey(t),
      tableDetail: null,
      loadingDetail: true,
      // データは対象テーブルが変わるため破棄する (絞り込み条件も引き継がない)
      tableData: emptyTableData(),
      view: "structure",
      error: null,
    });
    if (tab.tableTab === "data") {
      loadTableData(key, t, "", 0);
    }
    try {
      const detail = await tableDetail(key, tab.selectedDb, t.schema, t.name);
      updateTab(key, { tableDetail: detail, loadingDetail: false });
    } catch (e) {
      updateTab(key, { loadingDetail: false, error: String(e) });
    }
  };

  /*
   * 復元待ちのタブが接続できたら、前回のDB・テーブルまで戻す。
   * 接続 → DB切替 → 一覧取得 と段階を踏むので、
   * タブの状態が進むたびにこの効果が呼ばれ、次の一手だけを進める
   */
  useEffect(() => {
    const tab = tabs.find((t) => t.restore && t.connected);
    if (!tab?.restore) return;
    const { profileId, db, table } = tab.restore;
    const giveUp = () => updateTab(tab.key, { restore: undefined });

    // 別の接続先につなぎ直した場合は復元しない
    if (tab.profile.id !== profileId) return giveUp();
    // 接続直後の一覧取得が終わるまで待つ (二重に取りに行かないため)
    if (tab.busy || tab.loadingTables) return;

    // 1. DBを戻す (消えていたら諦めてそのまま使う)
    if (db && tab.selectedDb !== db) {
      if (!tab.databases.includes(db)) return giveUp();
      loadTables(tab.key, db);
      return;
    }
    // 2. テーブルを戻す (消えていたら諦める)
    const target = table
      ? tab.tables.find((t) => tableKey(t) === table)
      : undefined;
    if (!target) return giveUp();
    // handleSelectTableは表示を「定義」側に戻すので、開いていた表示に直す
    const view = tab.view;
    handleSelectTable(tab.key, target);
    updateTab(tab.key, { restore: undefined, view });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  // ---------- データタブ ----------

  /** 選択中のテーブル情報を取り出す */
  const currentTable = (key: string): TableInfo | null => {
    const tab = tabOf(key);
    if (!tab) return null;
    return tab.tables.find((t) => tableKey(t) === tab.selectedTable) ?? null;
  };

  /** テーブルのデータを1ページぶん取得する (SQL実行と同じページング機構を使う) */
  const loadTableData = async (
    key: string,
    table: TableInfo,
    where: string,
    offset: number,
    orderBy?: string,
    orderDir?: string
  ) => {
    const tab = tabOf(key);
    if (!tab?.selectedDb) return;
    patchData(key, { loading: true, error: null });
    try {
      const out = await runQuery(
        key,
        tab.selectedDb,
        buildTableSelect(tab.profile.dbType, table, where),
        offset,
        orderBy,
        orderDir
      );
      const first = out.statements[0];
      if (out.error || !first) {
        patchData(key, {
          loading: false,
          error: out.error ?? "データを取得できませんでした",
        });
        return;
      }
      patchData(key, { data: first.result, loading: false, error: null });
    } catch (e) {
      patchData(key, { loading: false, error: String(e) });
    }
  };

  /** 定義 / データ タブの切替 (データは初めて開いたときに取得する) */
  const handleChangeTableTab = (key: string, view: TableTab) => {
    const tab = tabOf(key);
    updateTab(key, { tableTab: view });
    if (view !== "data" || !tab) return;
    if (tab.tableData.data || tab.tableData.loading) return;
    const table = currentTable(key);
    if (table) loadTableData(key, table, tab.tableData.where, 0);
  };

  /** データタブの再取得 (offsetとソートの扱いを呼び出し元で指定する) */
  const reloadTableData = (
    key: string,
    offset: number | "keep",
    order?: { by: string | null; dir: "asc" | "desc" }
  ) => {
    const tab = tabOf(key);
    const table = currentTable(key);
    if (!tab || !table) return;
    const cur = tab.tableData.data;
    const by = order ? (order.by ?? undefined) : cur?.orderBy;
    const dir = order ? order.dir : cur?.orderDir;
    return loadTableData(
      key,
      table,
      tab.tableData.where,
      offset === "keep" ? (cur?.offset ?? 0) : offset,
      by,
      dir
    );
  };

  /** SQLを実行する (sqlOverrideは選択実行用、offsetはページング用、transactionでBEGIN〜COMMIT/ROLLBACKに包む) */
  const handleRunQuery = async (
    key: string,
    offset = 0,
    sqlOverride?: string,
    transaction = false,
    explain?: "explain" | "analyze"
  ) => {
    const tab = tabOf(key);
    const sql = (sqlOverride ?? tab?.editor.sql ?? "").trim();
    if (!tab || !sql) return;
    // パラメータ (:name / @name) があれば入力モーダルを出してから実行する
    const params = extractParams(sql);
    if (params.length > 0) {
      // 保存値は接続ごとに分ける (開発DBの値が本番接続の初期値に出ないように)
      const scope = tab.profile.id;
      const saved = await getSqlParams(scope).catch(
        () => ({}) as Record<string, { value: string; kind: string }>
      );
      const initial: Record<string, ParamValue> = {};
      for (const p of params) {
        const s = saved[p];
        // 型は「明示的に選ばれた保存値」を優先し、無ければスキーマから推測する
        const kind =
          s && s.kind && s.kind !== "auto"
            ? (s.kind as ParamKind)
            : await inferParamKind(key, tab.selectedDb, sql, p);
        initial[p] = { value: s?.value ?? "", kind };
      }
      setParamReq({
        key,
        offset,
        sql,
        params,
        initial,
        transaction,
        explain,
        scope,
      });
      return;
    }
    await execRunQuery(key, offset, sql, transaction, explain);
  };

  /**
   * パラメータの埋め込み型をスキーマから推測する。
   * SQL中の「カラム 演算子 :param」からカラム名を取り、
   * 接続中DBのカラム定義が数値型なら number、文字列型等なら string を返す
   */
  const inferParamKind = async (
    key: string,
    db: string | null,
    sql: string,
    name: string
  ): Promise<ParamKind> => {
    if (!db) return "auto";
    const col = guessParamColumn(sql, name);
    if (!col) return "auto";
    const cacheKey = `${key}:${db}`;
    let entries = schemaCache.current.get(cacheKey);
    if (!entries) {
      entries = await schemaSnapshot(key, db).catch(() => [] as SchemaEntry[]);
      schemaCache.current.set(cacheKey, entries);
    }
    const lc = col.toLowerCase();
    const types = entries.flatMap((e) =>
      e.detail.columns
        .filter((c) => c.name.toLowerCase() === lc)
        .map((c) => c.colType)
    );
    if (types.length === 0) return "auto";
    return types.every(isNumericType) ? "number" : "string";
  };

  /** パラメータモーダルの実行確定: 値を保存して埋め込み実行する */
  const handleParamSubmit = async (values: Record<string, ParamValue>) => {
    const req = paramReq;
    if (!req) return;
    setParamReq(null);
    saveSqlParams(req.scope, values).catch(() => {});
    /*
     * 値はプレースホルダのままバックエンドへ渡す。
     * 文の分割・読み取り専用・危険なSQLの判定を済ませてから埋め込むので、
     * 値が「何が実行されるか」を左右できない
     */
    await execRunQuery(
      req.key,
      req.offset,
      req.sql,
      req.transaction,
      req.explain,
      values
    );
  };

  const execRunQuery = async (
    key: string,
    offset: number,
    sql: string,
    transaction: boolean,
    explain?: "explain" | "analyze",
    /** :name に入れる値 (埋め込みはバックエンドで行う) */
    params?: Record<string, ParamValue>
  ) => {
    const tab = tabOf(key);
    if (!tab) return;
    // 実行履歴に記録する (失敗しても実行は続ける)
    addSqlHistory(sql).catch(() => {});
    // 前回の実行結果はクリアしてから実行する
    patchEditor(key, {
      running: true,
      startedAt: Date.now(),
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
        explain,
        params
      );
      patchEditor(key, {
        queryResults: out.statements.length > 0 ? out.statements : null,
        queryError: out.error ?? null,
        running: false,
      });
      // ヘッダのツールチップ用にカラム説明を用意しておく (失敗しても実行結果には影響しない)
      if (tab.selectedDb) ensureColumnTips(key, tab.selectedDb);
    } catch (e) {
      patchEditor(key, {
        queryResults: null,
        queryError: String(e),
        running: false,
      });
    }
  };

  /**
   * SQL結果のヘッダに出すカラム説明 (論理名・補足) を読み込む。
   * DB全体のスキーマが要るため、SQLを実行した時点で1回だけ取得する
   */
  const ensureColumnTips = async (key: string, db: string) => {
    const tab = tabOf(key);
    if (!tab || tab.columnTipsDb === db) return;
    const cacheKey = `${key}:${db}`;
    let entries = schemaCache.current.get(cacheKey);
    if (!entries) {
      entries = await schemaSnapshot(key, db).catch(() => [] as SchemaEntry[]);
      schemaCache.current.set(cacheKey, entries);
    }
    const settings = await getAppSettings().catch(() => null);
    updateTab(key, {
      columnTips: buildSchemaTips(entries, settings?.commentDelimiter ?? "（"),
      columnTipsDb: db,
    });
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
    const tab = tabOf(key);
    const stmt = tab?.editor.queryResults?.[index];
    if (!tab || !stmt) return;
    patchEditor(key, {
      running: true,
      startedAt: Date.now(),
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
        patchEditor(key, {
          queryError: out.error ?? "実行に失敗しました",
          running: false,
        });
        return;
      }
      patchEditor(key, {
        queryResults: (tab.editor.queryResults ?? []).map((s, i) =>
          i === index ? { sql: stmt.sql, result: fresh.result } : s
        ),
        running: false,
      });
    } catch (e) {
      patchEditor(key, { queryError: String(e), running: false });
    }
  };

  /** 結果タブ単位のページ送り (現在のソートを維持) */
  const handlePageQuery = (key: string, index: number, offset: number) => {
    const stmt = tabOf(key)?.editor.queryResults?.[index];
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
  const activeKeyNow = activeTab.key;

  /*
   * データタブ・シートの受け渡しはまとめてメモ化する。
   * 中の関数は tabsRef から最新のタブを見るので、
   * 作り直さなくても古い内容を掴むことはない。
   * これで、無関係な再描画 (SQL入力など) でグリッドが描き直されなくなる
   */
  const dataPane: TableDataPane = useMemo(
    () => ({
      ...activeTab.tableData,
      onChangeWhere: (where) => patchData(activeKeyNow, { where }),
      onApplyWhere: () => reloadTableData(activeKeyNow, 0),
      onReload: () => reloadTableData(activeKeyNow, "keep"),
      onPage: (offset) => reloadTableData(activeKeyNow, offset),
      onSort: (by, dir) => reloadTableData(activeKeyNow, 0, { by, dir }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeKeyNow, activeTab.tableData]
  );

  const sheetPane: SheetPane = useMemo(
    () => ({
      sheets: activeTab.editor.sheets,
      activeId: activeTab.editor.activeSheet,
      onSelect: (id) => switchSheet(activeKeyNow, id),
      onAdd: () => addSheet(activeKeyNow),
      onClose: (id) => closeSheet(activeKeyNow, id),
      onRename: (id, title) => renameSheet(activeKeyNow, id, title),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeKeyNow, activeTab.editor.sheets, activeTab.editor.activeSheet]
  );

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeKey={activeTab.key}
        onActivate={setActiveKey}
        onClose={closeTab}
        onAdd={addTab}
        onOpenConsole={() =>
          openConsole().catch((e) =>
            setWinError(`コンソールを開けませんでした: ${e}`)
          )
        }
        onOpenDiff={() =>
          openDiff().catch((e) =>
            setWinError(`スキーマ差分を開けませんでした: ${e}`)
          )
        }
        onOpenSettings={() => setShowSettings(true)}
      />

      {winError && (
        <div className="result-banner ng app-error">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{winError}</span>
          <span className="toolbar-spacer" />
          <button className="btn-ghost" onClick={() => setWinError(null)}>
            閉じる
          </button>
        </div>
      )}

      <UpdateBanner />

      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}

      {quickOpen && (
        <QuickOpen
          connections={store.connections}
          folders={store.folders}
          onOpen={(p) => {
            // 新しいタブで開く (今のタブの作業は残す)
            const key = newTabKey();
            const tab = emptyTab(key);
            tab.profile = structuredClone(p);
            setTabs((ts) => [...ts, tab]);
            setActiveKey(key);
            void handleConnect(key, p);
          }}
          onClose={() => setQuickOpen(false)}
        />
      )}

      {showShortcuts && (
        <ShortcutHelp onClose={() => setShowShortcuts(false)} />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onImported={() => reload()}
        />
      )}

      {paramReq && (
        <SqlParamModal
          params={paramReq.params}
          initial={paramReq.initial}
          sql={paramReq.sql}
          sessionId={paramReq.key}
          dbType={tabOf(paramReq.key)?.profile.dbType ?? "mysql"}
          onCancel={() => setParamReq(null)}
          onSubmit={handleParamSubmit}
        />
      )}

      <div className="workspace">
        {activeTab.connected && activeTab.profile.dbType === "valkey" ? (
          <KvSessionView
            tab={activeTab}
            onSelectDb={(db) => loadTables(activeTab.key, db)}
            onChangeSql={(sql) => patchEditor(activeTab.key, { sql })}
            onSetConsole={(open) =>
              updateTab(activeTab.key, {
                view: open ? "query" : "structure",
              })
            }
            onKvOutput={(results, execError) =>
              patchKv(activeTab.key, { results, execError })
            }
            onKvBrowse={(browse) => patchKv(activeTab.key, { browse })
            }
          />
        ) : activeTab.connected ? (
          <SessionView
            tab={activeTab}
            onSelectDb={(db) => loadTables(activeTab.key, db)}
            onOpenSettings={() => setShowSettings(true)}
            onReloadTables={() => reloadTables(activeTab.key)}
            onDatabasesChanged={(list) => {
              /*
               * 選んでいたDBが消えていたら、テーブル一覧まで一緒に片付ける
               * (無くなったDBを選んだまま操作させない)
               */
              const gone =
                activeTab.selectedDb !== null &&
                !list.includes(activeTab.selectedDb);
              updateTab(activeTab.key, {
                databases: list,
                ...(gone
                  ? {
                      selectedDb: null,
                      tables: [],
                      selectedTable: null,
                      tableDetail: null,
                      tableData: emptyTableData(),
                      columnTips: {},
                      columnTipsDb: null,
                    }
                  : {}),
              });
            }}
            onReloadDetail={() => reloadTableDetail(activeTab.key)}
            onSendToEditor={(sql) => {
              patchEditor(activeTab.key, { sql });
              updateTab(activeTab.key, { view: "query" });
            }}
            onSelectTable={(t) => handleSelectTable(activeTab.key, t)}
            onToggleQuery={() =>
              updateTab(activeTab.key, {
                view: activeTab.view === "query" ? "structure" : "query",
              })
            }
            onChangeSql={(sql) => patchEditor(activeTab.key, { sql })}
            onChangeEditorOpts={(patch) => patchEditorOpts(activeTab.key, patch)}
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
            onChangeTableTab={(v) => handleChangeTableTab(activeTab.key, v)}
            dataPane={dataPane}
            sheetPane={sheetPane}
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
