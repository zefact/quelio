import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  trustSshHost,
  updateLayout,
  getTxnState,
} from "./api";
import { listen } from "@tauri-apps/api/event";
import { AboutDialog } from "./components/AboutDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
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
  activeSheetOf,
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
import { tabsReducer } from "./tabsReducer";
import {
  TabActionsProvider,
  useStableActions,
} from "./components/tabActions";
import { parseUnknownHost, stripHostMark } from "./sshTrust";
import {
  loadWorkspace,
  MAX_SHEETS,
  storeWorkspace,
  toSaved,
  toTab,
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
  /*
   * タブの状態は reducer にまとめてある (遷移は tabsReducer.ts)。
   * 呼び出し側は今までどおり updateTab / patch* を使う
   */
  const [tabs, dispatch] = useReducer(tabsReducer, undefined, () => [
    emptyTab("tab-0"),
  ]);
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
  /**
   * SSH踏み台の初回接続。
   * ホスト鍵を見せて確認してもらい、承諾されたら記録して接続し直す
   */
  const [sshTrust, setSshTrust] = useState<{
    key: string;
    profile: ConnectionProfile;
    host: string;
    port: number;
    fingerprint: string;
    message: string;
    /** 確認のあとに行うこと (接続 / 接続テスト) */
    then: "connect" | "test";
  } | null>(null);
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
  /**
   * 取得ごとの通し番号 (「タブ:用途」ごとに数える)。
   *
   * 同じ場所へ続けて問い合わせると、先に投げたほうが後で返ることがある。
   * 投げたときの番号が最新でなくなっていたら、その結果は捨てる
   * (捨てないと、新しい内容を古い内容で上書きしてしまう)
   */
  const reqSeq = useRef(new Map<string, number>());

  /**
   * スキーマの控えを捨てる (定義を変えたあとに呼ぶ)。
   *
   * 残したままにすると、SQLパラメータの型推測と結果ヘッダのカラム説明が
   * 変更前の定義のままになる
   */
  const dropSchemaCache = (key: string) => {
    for (const k of [...schemaCache.current.keys()]) {
      if (k.startsWith(`${key}:`)) schemaCache.current.delete(k);
    }
  };

  /** 新しい番号を発行する */
  const startReq = (scope: string) => {
    const n = (reqSeq.current.get(scope) ?? 0) + 1;
    reqSeq.current.set(scope, n);
    return n;
  };

  /** 発行した番号がまだ最新か (古ければ結果を捨てる) */
  const isLatestReq = (scope: string, n: number) =>
    reqSeq.current.get(scope) === n;

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
       * 前回の書きかけSQL (シート) を戻すかどうかは設定で決める (既定は戻さない)。
       * 接続タブは戻さないので、起動時はいつも接続先を選ぶところから始まる。
       * 戻さない設定でも、書きかけSQLを消さないよう読み込みだけは行い、
       * 自動保存を止めないようにする
       */
      const restoreSheets = await getAppSettings()
        .then((s) => s.restoreSheets)
        .catch(() => false);
      const saved = await loadWorkspace();
      // 読めなかった場合は、空の状態で上書きしないよう保存も止める。
      // 黙って止めると「保存されない」ことに気づけないので画面にも出す
      if (!saved.ok) {
        setWinError(
          "前回の書きかけSQLを読めませんでした。" +
            "書きかけのSQLを失わないよう、この起動では保存しません " +
            "(設定フォルダの workspace.json を消すと次回から保存します)"
        );
        return;
      }
      // 中身が壊れていると組み立てで落ちることがある。
      // そのまま抜けると自動保存が止まったままになるので、ここで受け止める
      let built: WorkTab | null;
      try {
        built = saved.data ? toTab(saved.data, newTabKey()) : null;
      } catch {
        setWinError(
          "前回の書きかけSQLが壊れていました。" +
            "書きかけのSQLを失わないよう、この起動では保存しません " +
            "(設定フォルダの workspace.json を消すと次回から保存します)"
        );
        return;
      }
      if (built && restoreSheets) {
        dispatch({ type: "replace", tabs: [built] });
        setActiveKey(built.key);
      }
      restored.current = true;
    })();
  }, []);

  /*
   * ウィンドウを閉じるときの確認。
   *
   * 切断するとサーバー側でトランザクションが巻き戻るため、
   * 未確定の変更が残っていたら一度止めて知らせる。
   *
   * この listener を付けた時点で、閉じる操作はアプリ側の責任になる
   * (Tauri は「止められなかったとき」に destroy を呼ぶだけ)。
   * そのため必ず自分で止めてから、閉じると決めたときに destroy を呼ぶ。
   * 途中で何かに失敗しても閉じられるよう、判定は try で包む
   */
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void win
      .onCloseRequested(async (e) => {
        e.preventDefault();
        try {
          const names: string[] = [];
          for (const t of tabsRef.current) {
            if (!t.connected) continue;
            if (await hasOpenTxn(t.key)) {
              names.push(t.profile.name || t.profile.host);
            }
          }
          if (names.length > 0) {
            setCloseWarn({ kind: "window", names });
            return;
          }
        } catch {
          /* 読めなかった場合は止めない */
        }
        await closeWindow();
      })
      .then((f) => {
        if (disposed) f();
        else {
          unlisten = f;
          unlistenClose.current = f;
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
      unlistenClose.current = null;
    };
    // 一度だけ登録する (中で見ているのは ref なので古くならない)
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
      } else if (mod && !e.altKey && !e.shiftKey && key === "w") {
        e.preventDefault();
        void requestCloseTab(activeKey);
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
    // 中で呼ぶのは常に最新のタブなので、ハンドラは依存に入れない
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
  const patchEditor = (key: string, patch: Partial<TabEditorState>) =>
    dispatch({ type: "patchEditor", key, patch });

  /** 実行設定 (トランザクション等) だけを更新する */
  const patchEditorOpts = (key: string, patch: Partial<EditorOptions>) =>
    dispatch({ type: "patchEditorOpts", key, patch });

  const updateTab = (key: string, patch: Partial<WorkTab>) =>
    dispatch({ type: "patchTab", key, patch });

  /** Valkey画面の状態だけを部分更新する */
  const patchKv = (key: string, patch: Partial<TabKvState>) =>
    dispatch({ type: "patchKv", key, patch });

  /** データタブの状態だけを部分更新する */
  const patchData = (key: string, patch: Partial<TabTableData>) =>
    dispatch({ type: "patchData", key, patch });

  /** 表示中のシートの中身 (書きかけのSQL・実行結果) を差し替える */
  const patchSheet = (key: string, patch: Partial<QuerySheet>) =>
    dispatch({ type: "patchSheet", key, patch });

  /**
   * シートの並びを差し替える。
   * 実行中は結果の行き先が変わってしまうので、シート操作は受け付けない
   */
  const updateSheets = (
    key: string,
    fn: (e: TabEditorState) => Partial<TabEditorState> | null
  ) => dispatch({ type: "editSheets", key, edit: fn });

  /** シートを切り替える (中身はシートが持っているので、開く先を変えるだけ) */
  const switchSheet = (key: string, id: string) => {
    updateSheets(key, (e) =>
      e.activeSheet === id || !e.sheets.some((s) => s.id === id)
        ? null
        : { activeSheet: id }
    );
  };

  /** シートを増やす (空のシートを開く) */
  const addSheet = (key: string) => {
    updateSheets(key, (e) => {
      // 保存できる枚数を超えないようにする (画面の「＋」も同じ上限で止める)
      if (e.sheets.length >= MAX_SHEETS) return null;
      const fresh = {
        ...emptySheet(newSheetId()),
        // 実行設定 (トランザクション等) は今のシートの設定を引き継ぐ
        editorOpts: { ...activeSheetOf(e).editorOpts },
      };
      return { sheets: [...e.sheets, fresh], activeSheet: fresh.id };
    });
  };

  /** シートを閉じる (最後の1枚は閉じない) */
  const closeSheet = (key: string, id: string) => {
    updateSheets(key, (e) => {
      if (e.sheets.length <= 1) return null;
      const at = e.sheets.findIndex((s) => s.id === id);
      if (at === -1) return null;
      const rest = e.sheets.filter((s) => s.id !== id);
      // 閉じたのが表示中でなければ、表示はそのまま
      if (id !== e.activeSheet) return { sheets: rest };
      return {
        sheets: rest,
        activeSheet: rest[Math.min(at, rest.length - 1)].id,
      };
    });
  };

  /** シートに名前を付ける (空なら自動の見出しに戻る) */
  const renameSheet = (key: string, id: string, title: string) =>
    dispatch({
      type: "editSheets",
      key,
      edit: (e) => ({
        sheets: e.sheets.map((s) => (s.id === id ? { ...s, title } : s)),
      }),
    });

  const addTab = () => {
    const key = newTabKey();
    dispatch({ type: "add", tab: emptyTab(key) });
    setActiveKey(key);
  };

  /**
   * 閉じる前に確認するもの。
   * トランザクションが開いたままだと、切断した時点でサーバー側で
   * 巻き戻される (＝変更が消える) ので、その前に気づけるようにする
   */
  const [closeWarn, setCloseWarn] = useState<
    | { kind: "tab"; key: string; name: string }
    | { kind: "window"; names: string[] }
    | null
  >(null);
  /** 閉じる確認の解除 (閉じると決めたら、まずこれを外す) */
  const unlistenClose = useRef<(() => void) | null>(null);

  /**
   * ウィンドウを閉じる。
   *
   * onCloseRequested を付けている間は、閉じるのはアプリ側の仕事になる
   * (Tauri は「止められなかったとき」に destroy を呼ぶだけ)。
   * 先に listener を外しておけば、以降の close は素通しで閉じるので、
   * destroy が使えない場合でも閉じられなくなることはない
   */
  const closeWindow = async () => {
    unlistenClose.current?.();
    unlistenClose.current = null;
    const win = getCurrentWindow();
    try {
      await win.destroy();
    } catch {
      await win.close().catch(() => {});
    }
  };

  /** そのタブに未確定のトランザクションが残っているか (読めなければ false) */
  const hasOpenTxn = async (key: string): Promise<boolean> => {
    try {
      const s = await getTxnState(key);
      return s === "open" || s === "broken";
    } catch {
      return false;
    }
  };

  /** タブを閉じる。未確定の変更が残っていれば先に確認する */
  const requestCloseTab = async (key: string) => {
    const tab = tabOf(key);
    if (tab?.connected && (await hasOpenTxn(key))) {
      setCloseWarn({
        kind: "tab",
        key,
        name: tab.profile.name || tab.profile.host,
      });
      return;
    }
    await closeTab(key);
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
    const list = tabsRef.current;
    const rest = list.filter((t) => t.key !== key);
    // 最後の1枚を閉じたときは、空のタブを1つ作って置き換える
    if (rest.length === 0) {
      const nk = newTabKey();
      dispatch({ type: "replace", tabs: [emptyTab(nk)] });
      setActiveKey(nk);
      return;
    }
    // 閉じたのが表示中のタブなら、隣のタブへ移る
    const idx = list.findIndex((t) => t.key === key);
    const neighbor = rest[Math.min(idx, rest.length - 1)];
    setActiveKey((cur) => (cur === key ? neighbor.key : cur));
    dispatch({ type: "close", key });
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
      // 初回接続 (ホスト鍵が未記録) は、確認してもらってからやり直す
      const unknown = parseUnknownHost(result.message);
      if (unknown) {
        setSshTrust({ ...unknown, key, profile: tab.profile, then: "test" });
        updateTab(key, { busy: null, testResult: null });
        return;
      }
      updateTab(key, { testResult: result, busy: null });
    } catch (e) {
      updateTab(key, { error: stripHostMark(String(e)), busy: null });
    }
  };

  /** 接続してこのタブをセッション画面に切り替える */
  /** 本番へ繋ぐ前の確認 (押した時点の接続先を覚えておく) */
  const [prodConfirm, setProdConfirm] = useState<{
    key: string;
    profile: ConnectionProfile;
  } | null>(null);

  /**
   * 接続する。環境が「本番」の接続先は一度確認してから繋ぐ。
   * (SSHホスト鍵の確認からのやり直しは、確認済みなので直接 handleConnect を呼ぶ)
   */
  const requestConnect = async (key: string, profile: ConnectionProfile) => {
    if (profile.env === "prod") {
      setProdConfirm({ key, profile });
      return;
    }
    await handleConnect(key, profile);
  };

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
      // 初回接続 (ホスト鍵が未記録) は、確認してもらってからやり直す
      const unknown = parseUnknownHost(String(e));
      if (unknown) {
        setSshTrust({ ...unknown, key, profile, then: "connect" });
        updateTab(key, { busy: null, error: null });
        return;
      }
      updateTab(key, { error: String(e), busy: null });
    }
  };

  // ---------- 接続済みタブの操作 ----------

  const loadTables = async (key: string, database: string) => {
    // ValkeyはDB番号の切替のみ (キー一覧はKvSessionView側でSCANする)
    // 常に最新のタブを見る (作った直後のタブは state にまだ載っていない)
    const tab = tabOf(key);
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
    const tab = tabOf(key);
    if (!tab?.selectedDb || tab.profile.dbType === "valkey") return;
    // テーブルが増減している = 定義が変わっているので、控えは捨てる
    dropSchemaCache(key);
    try {
      const tables = await listTables(key, tab.selectedDb);
      const stillExists =
        tab.selectedTable !== null &&
        tables.some((t) => tableKey(t) === tab.selectedTable);
      updateTab(key, {
        tables,
        error: null,
        // カラム説明も作り直す (次にSQLを実行したときに読み直す)
        columnTips: {},
        columnTipsDb: null,
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
    // 定義が変わっているので、スキーマの控えとカラム説明を作り直す
    dropSchemaCache(key);
    updateTab(key, {
      loadingDetail: true,
      error: null,
      columnTips: {},
      columnTipsDb: null,
      // 入力補完のカラム一覧も取り直す (テーブル名が同じままでも中身が変わる)
      schemaRev: tab.schemaRev + 1,
    });
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
    // 常に最新のタブを見る (作った直後のタブは state にまだ載っていない)
    const tab = tabOf(key);
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
    // 復元は一覧が届いたときだけ試す (選択の関数は毎回作り直される)
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
    const scope = `${key}:data`;
    const seq = startReq(scope);
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
      // 後から投げたぶんが先に表示されているなら、この結果はもう古い
      if (!isLatestReq(scope, seq)) return;
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
      if (!isLatestReq(scope, seq)) return;
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
    const sql = (
      sqlOverride ??
      (tab ? activeSheetOf(tab.editor).sql : "")
    ).trim();
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
    patchEditor(key, { running: true, startedAt: Date.now() });
    patchSheet(key, {
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
      patchEditor(key, { running: false });
      patchSheet(key, {
        queryResults: out.statements.length > 0 ? out.statements : null,
        queryError: out.error ?? null,
      });
      // ヘッダのツールチップ用にカラム説明を用意しておく (失敗しても実行結果には影響しない)
      if (tab.selectedDb) ensureColumnTips(key, tab.selectedDb);
    } catch (e) {
      patchEditor(key, { running: false });
      patchSheet(key, { queryResults: null, queryError: String(e) });
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
    if (!tab) return;
    const stmt = activeSheetOf(tab.editor).queryResults?.[index];
    if (!stmt) return;
    const scope = `${key}:editor`;
    const seq = startReq(scope);
    patchEditor(key, { running: true, startedAt: Date.now() });
    patchSheet(key, { queryError: null });
    try {
      const out = await runQuery(
        key,
        tab.selectedDb ?? undefined,
        stmt.sql,
        offset,
        orderBy,
        orderDir
      );
      // 後から投げたぶんが先に表示されているなら、この結果はもう古い
      if (!isLatestReq(scope, seq)) return;
      const fresh = out.statements[0];
      if (out.error || !fresh) {
        patchEditor(key, { running: false });
        patchSheet(key, { queryError: out.error ?? "実行に失敗しました" });
        return;
      }
      // 結果は今の内容に当てる (待っている間に他の文が入れ替わっていることがある)
      const shown = tabOf(key);
      patchEditor(key, { running: false });
      patchSheet(key, {
        queryResults: (
          (shown && activeSheetOf(shown.editor).queryResults) ??
          []
        ).map((st, i) =>
          i === index ? { sql: stmt.sql, result: fresh.result } : st
        ),
      });
    } catch (e) {
      if (!isLatestReq(scope, seq)) return;
      patchEditor(key, { running: false });
      patchSheet(key, { queryError: String(e) });
    }
  };

  /** 結果タブ単位のページ送り (現在のソートを維持) */
  const handlePageQuery = (key: string, index: number, offset: number) => {
    const shown = tabOf(key);
    const stmt =
      shown && activeSheetOf(shown.editor).queryResults?.[index];
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
    // 中の関数は tabsRef 経由で最新を見るので、依存はこの2つでよい
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
    // 同上 (シートの操作も最新のタブに対して行う)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeKeyNow, activeTab.editor.sheets, activeTab.editor.activeSheet]
  );

  /*
   * 表示中のタブに対する操作。
   * SessionViewへは props ではなく Context で渡す (数が多いため)。
   * 渡す関数の同一性は useStableActions で保つ
   * (毎回作り直すと、受け取り側の memo が効かなくなる)
   */
  const tabActions = useStableActions({
    onSelectDb: (db) => loadTables(activeTab.key, db),
    onOpenSettings: () => setShowSettings(true),
    onReloadTables: () => reloadTables(activeTab.key),
    onDatabasesChanged: (list) => {
      /*
       * 選んでいたDBが消えていたら、テーブル一覧まで一緒に片付ける
       * (無くなったDBを選んだまま操作させない)
       */
      const gone =
        activeTab.selectedDb !== null && !list.includes(activeTab.selectedDb);
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
    },
    onReloadDetail: () => reloadTableDetail(activeTab.key),
    onSendToEditor: (sql) => {
      patchSheet(activeTab.key, { sql });
      updateTab(activeTab.key, { view: "query" });
    },
    onSelectTable: (t) => handleSelectTable(activeTab.key, t),
    onToggleQuery: () =>
      updateTab(activeTab.key, {
        view: activeTab.view === "query" ? "structure" : "query",
      }),
    onChangeSql: (sql) => patchSheet(activeTab.key, { sql }),
    onChangeEditorOpts: (patch) => patchEditorOpts(activeTab.key, patch),
    onCancelQuery: () => handleCancelQuery(activeTab.key),
    onRunQuery: (offset, sqlOverride, transaction, explain) =>
      handleRunQuery(activeTab.key, offset, sqlOverride, transaction, explain),
    onPageQuery: (index, offset) =>
      handlePageQuery(activeTab.key, index, offset),
    onSortQuery: (index, orderBy, orderDir) =>
      handleSortQuery(activeTab.key, index, orderBy, orderDir),
    onChangeTableTab: (v) => handleChangeTableTab(activeTab.key, v),
  });

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeKey={activeTab.key}
        onActivate={setActiveKey}
        onClose={(key) => void requestCloseTab(key)}
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
            dispatch({ type: "add", tab });
            setActiveKey(key);
            void requestConnect(key, p);
          }}
          onClose={() => setQuickOpen(false)}
        />
      )}

      {showShortcuts && (
        <ShortcutHelp onClose={() => setShowShortcuts(false)} />
      )}

      {prodConfirm && (
        <ConfirmDialog
          title="本番環境へ接続します"
          target={prodConfirm.profile.name || prodConfirm.profile.host}
          confirmLabel="接続する"
          onCancel={() => setProdConfirm(null)}
          onConfirm={async () => {
            const req = prodConfirm;
            setProdConfirm(null);
            await handleConnect(req.key, req.profile);
          }}
        >
          この接続先は環境が「本番」に設定されています。
          {prodConfirm.profile.readOnly
            ? "読み取り専用なので、変更する操作はすべて拒否されます。"
            : "更新も実行できる設定です。流すSQLを確かめてから接続してください。"}
        </ConfirmDialog>
      )}

      {closeWarn && (
        <ConfirmDialog
          title="未確定の変更が残っています"
          target={
            closeWarn.kind === "tab"
              ? closeWarn.name
              : closeWarn.names.join(" / ")
          }
          confirmLabel={
            closeWarn.kind === "tab" ? "取り消して閉じる" : "取り消して終了"
          }
          onCancel={() => setCloseWarn(null)}
          onConfirm={async () => {
            const w = closeWarn;
            setCloseWarn(null);
            if (w.kind === "tab") {
              await closeTab(w.key);
              return;
            }
            await closeWindow();
          }}
        >
          {closeWarn.kind === "tab"
            ? "このタブではトランザクションが開いたままです。"
            : "トランザクションが開いたままの接続があります。"}
          このまま閉じると接続が切れ、確定していない変更はサーバー側で
          取り消されます。残したい場合は、いったん中止して画面下の
          「確定」を押してください。
        </ConfirmDialog>
      )}

      {sshTrust && (
        <ConfirmDialog
          title="SSH踏み台への初回接続です"
          target={`${sshTrust.host}:${sshTrust.port}`}
          confirmLabel="信頼して接続"
          onConfirm={async () => {
            await trustSshHost(
              sshTrust.host,
              sshTrust.port,
              sshTrust.fingerprint
            );
            const req = sshTrust;
            setSshTrust(null);
            if (req.then === "connect") {
              await handleConnect(req.key, req.profile);
            } else {
              await handleTest(req.key);
            }
          }}
          onCancel={() => setSshTrust(null)}
        >
          <p>
            このサーバーのホスト鍵を初めて見ました。
            管理者から知らされている値と同じかどうかを確認してください。
          </p>
          <pre className="mono confirm-sql">{sshTrust.fingerprint}</pre>
          <p>
            違う値のときは、通信が第三者に中継されている可能性があります。
            一度記録すると、次からは鍵が変わった時点で接続を止めます。
          </p>
        </ConfirmDialog>
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
            onChangeSql={(sql) => patchSheet(activeTab.key, { sql })}
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
          <TabActionsProvider value={tabActions}>
            <SessionView
              tab={activeTab}
              dataPane={dataPane}
              sheetPane={sheetPane}
            />
          </TabActionsProvider>
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
            onConnect={(p) => requestConnect(activeTab.key, p)}
          />
        )}
      </div>
    </div>
  );
}

export default App;
