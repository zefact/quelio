import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  APP_SETTINGS_EVENT,
  countTableRows,
  getAppSettings,
  openSchema,
  renameTable,
  schemaColumns,
  systemDatabases,
} from "../api";
import { databaseOptions } from "../dbOrder";
import { writeClipboard } from "../gridCopy";
import { parseComment } from "../comment";
import {
  closeCsvImport,
  csvImportStore,
  openCsvImport,
} from "../csvImportStore";
import { useKeyedStore } from "../hooks/useKeyedStore";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { useResizableWidth } from "../hooks/useResizableWidth";
import {
  buildCountStatement,
  buildInsertStatement,
  buildSelectStatement,
  buildTruncateStatement,
  tableNameIfNeeded,
  tableKey,
} from "../tableSql";
import type {
  AppSettings,
  TableInfo,
  WorkTab,
} from "../types";
import { activeSheetOf } from "../types";
import { EnvBand } from "./EnvBand";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconButton } from "./IconButton";
import { CloseMark } from "./CloseMark";
import { MOD } from "../keyLabel";
import {
  needsStructureConfirm,
  prodActionText,
  tableRenameWhat,
} from "../prodConfirm";
import { StatusBar } from "./StatusBar";
import type { LastRun } from "./StatusBar";
import { useTxnState } from "../hooks/useTxnState";
import { isExecResult } from "./queryResult";
import { useTabActions } from "./tabActions";
import type { SchemaMap } from "./sqlCompletion";
import { CreateTableModal } from "./createTable/CreateTableModal";
import { DropTableConfirm } from "./DropTableConfirm";
import { QueryPanel } from "./QueryPanel";
import { ProcessDialog } from "./ProcessDialog";
import { DbUsersDialog } from "./dbUsers/DbUsersDialog";
import { HelpDialog } from "./help/HelpDialog";
import { topicsFor } from "./help/helpTopics";
import { CsvImportDialog } from "./csvImport/CsvImportDialog";
import { TestDataDialog } from "./testData/TestDataDialog";
import { DbAdminDialog } from "./dbAdmin/DbAdminDialog";
import { SearchDialog } from "./search/SearchDialog";
import { RoutineDialog } from "./RoutineDialog";
import { SelectMenu } from "./SelectMenu";
import { ConnectionChip, ServerInfo } from "./SessionHeader";
import { SessionTools } from "./SessionTools";
import { PaneHead, SidePane } from "./SidePane";
import { TableList } from "./TableList";
import { TableView } from "./TableView";
import { ExportDialog, ImportDialog } from "./TransferDialog";
import { useDismiss } from "../hooks/useDismiss";
import { useMultiSelect } from "../hooks/useMultiSelect";
import { usePinnedTables } from "../hooks/usePinnedTables";
import { orderByPinned } from "../pinnedTables";
import { useToast } from "../hooks/useToast";
import { useConnLost } from "../hooks/useConnLost";
import { ConnLostBanner } from "./ConnLostBanner";

import type { SheetPane, TableDataPane } from "./panes";

interface Props {
  tab: WorkTab;
  /** データタブの状態と操作 (ここでは中身を見ず、そのまま渡す) */
  dataPane: TableDataPane;
  /** SQLのシートの状態と操作 (同上) */
  sheetPane: SheetPane;
}

/** 読み取り専用の接続で、変更する操作を押せなくしたときの理由 */
const RO_REASON = "読み取り専用の接続なので変更できません";

/** 接続済みタブの中身: 上部DBセレクタ + 左テーブル一覧 + コンテンツ領域 */
export function SessionView({ tab, dataPane, sheetPane }: Props) {
  /*
   * 「今のタブに対する操作」はContextから受け取る。
   * どれも呼び出し方は変わらないので、ここで名前を開いておく
   */
  const {
    onSelectDb,
    onOpenSettings,
    onReloadTables,
    onDatabasesChanged,
    onReloadDetail,
    onSendToEditor,
    onSelectTable,
    onToggleQuery,
    onChangeSql,
    onChangeEditorOpts,
    onAcceptRun,
    onRunQuery,
    onCancelQuery,
    onPageQuery,
    onSortQuery,
    onChangeTableTab,
  } = useTabActions();
  const [filter, setFilter] = useState("");
  // 見出しのボタン (再読み込み・新規作成・ダンプ・実行) が字を出したまま1行に収まる幅で開く
  const [paneWidth, startResize, nudgePane] = useResizableWidth(300, 170, 520);
  const [dialog, setDialog] = useState<"export" | "import" | null>(null);
  /** テーブル一覧の再読み込み中か (アイコンの回転表示用) */
  const [reloading, setReloading] = useState(false);
  /**
   * 再読み込みボタンを押した回数。
   * テーブルコメント (日本語名) だけを変えたときは一覧の並びも名前も変わらないので、
   * これを見て日本語名・カラムの一覧も取り直す
   */
  const [schemaReload, setSchemaReload] = useState(0);
  /** テーブル作成の画面を出しているか */
  const [showCreate, setShowCreate] = useState(false);
  /**
   * 作成・改名・検索の直後に選択したいテーブル (一覧に現れたら選ぶ)。
   * `db` があるときは、そのデータベースの一覧になるまで待つ
   */
  const [pendingSelect, setPendingSelect] = useState<{
    schema?: string;
    name: string;
    db?: string;
  } | null>(null);
  /** 名前を変更中のテーブル (キーと入力中の新しい名前) */
  const [renaming, setRenaming] = useState<{
    key: string;
    value: string;
  } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  /** 改名の二重実行防止 (Enterとボタンが続けて押されたときのため) */
  const renameBusy = useRef(false);
  /** 実行前に確認しているテーブル名の変更 (本番・「定義の変更も確認する」のとき) */
  const [renameAsk, setRenameAsk] = useState<{
    table: TableInfo;
    next: string;
  } | null>(null);
  /** テーブル・カラムの一覧 (入力補完と、一覧の日本語名表示に使う) */
  const [schemaMap, setSchemaMap] = useState<SchemaMap>({});
  /** アプリ設定 (コメント区切り・入力補完) */
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /** データベース管理の画面を出すか */
  const [showDbAdmin, setShowDbAdmin] = useState(false);

  /** 検索の画面を出すか */
  const [showSearch, setShowSearch] = useState(false);

  /** テストデータを作る対象のテーブル (nullなら画面を出さない) */
  const [genTarget, setGenTarget] = useState<TableInfo | null>(null);

  /*
   * CSVを取り込む対象のテーブル (nullなら取り込み画面を出さない)。
   *
   * この部品はタブごとに作り直さず使い回すので、状態は接続タブごとに
   * 画面の外 (csvImportStore) へ置く。取り込み中にタブを移っても
   * 戻ってくれば進捗と中止ボタンが出せる
   */
  const csvTarget = useKeyedStore(csvImportStore, tab.key).target;

  /** 削除の確認中のテーブル (nullなら確認していない) */
  const [dropping, setDropping] = useState<TableInfo[] | null>(null);
  /** 関数・トリガの定義を出しているか */
  const [showRoutines, setShowRoutines] = useState(false);
  /** プロセス一覧 (サーバー側の接続) を出しているか */
  const [showProcesses, setShowProcesses] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  /** ヘルプを開いているか */
  const [showHelp, setShowHelp] = useState(false);
  /** 右クリックから数えた正確な件数 (テーブルキー → 表示文字列) */
  const [counts, setCounts] = useState<Record<string, string>>({});
  /** 「コピーしました」などの一時表示 */
  const { toast, flash, clear: clearToast } = useToast(2400);

  /** テーブルの列名 (入力補完用のスキーマから借りる。無ければ空) */
  const columnsOf = (t: TableInfo): string[] =>
    schemaMap[t.name]?.columns.map((c) => c.name) ?? [];

  /** CSV取り込みの画面を閉じる (毎回作り直さないよう固定する) */
  const closeCsv = useCallback(() => closeCsvImport(tab.key), [tab.key]);

  /**
   * 右クリックメニューが効く対象。
   *
   * 選択の中を押したときは選択したぶんすべて、
   * 外を押したときは (右クリック時に選択を直しているので) その1件だけ
   */
  const menuTargets = (t: TableInfo): TableInfo[] => {
    if (multiSel.size <= 1) return [t];
    const picked = tables.filter((x) => multiSel.has(tableKey(x)));
    return picked.length > 0 ? picked : [t];
  };

  /** 複数のテーブルからSQLを組み立てて1つにまとめる */
  const joinSql = (list: TableInfo[], build: (t: TableInfo) => string): string =>
    list.map(build).join("\n\n");

  /** メニューから生成したSQLをコピーする */
  const copySql = (sql: string, label: string) => {
    setTableMenu(null);
    writeClipboard(sql)
      .then(() => flash(`${label}をコピーしました`))
      .catch(() => flash("コピーできませんでした"));
  };

  /**
   * 正確な件数を数える (大きな表では時間が掛かる)。
   *
   * 複数選んでいるときは1つずつ順に数える。
   * 同時に投げるとセッションのロックを取り合うだけなので、直列にする
   */
  const countRows = async (list: TableInfo[]) => {
    setTableMenu(null);
    if (!selectedDb) return;
    setCounts((c) => {
      const next = { ...c };
      for (const t of list) next[tableKey(t)] = "数えています…";
      return next;
    });
    let failed = 0;
    for (const t of list) {
      const key = tableKey(t);
      try {
        const n = await countTableRows(
          tab.key,
          selectedDb,
          t.schema ?? undefined,
          t.name
        );
        setCounts((c) => ({ ...c, [key]: `${n.toLocaleString()}行` }));
        // 1件だけのときは、そのまま結果を出す
        if (list.length === 1) flash(`${t.name}: ${n.toLocaleString()}行`);
      } catch (e) {
        failed += 1;
        setCounts((c) => {
          const next = { ...c };
          delete next[key];
          return next;
        });
        if (list.length === 1) flash(`数えられませんでした: ${e}`);
      }
    }
    if (list.length > 1) {
      flash(
        failed === 0
          ? `${list.length}件の件数を数えました`
          : `${list.length - failed}件を数えました (${failed}件は数えられませんでした)`
      );
    }
  };
  /** テーブル項目の右クリックメニュー */
  const [tableMenu, setTableMenu] = useState<{
    x: number;
    y: number;
    table: TableInfo;
  } | null>(null);
  // メニューが画面の外へはみ出さないように位置を補正する
  const [tableMenuRef, tableMenuStyle] = usePopupPosition<HTMLDivElement>(
    tableMenu?.x ?? 0,
    tableMenu?.y ?? 0
  );
  const { profile, databases, selectedDb, tables, loadingTables } = tab;

  /**
   * サーバーが自分のために持っているDBの名前。
   *
   * 接続先の種類だけで決まるので一度取れば足りる。
   * 取れなくても選択そのものは出せるので、失敗したら空のままにする
   */
  const [systemDbs, setSystemDbs] = useState<string[]>([]);
  useEffect(() => {
    systemDatabases(profile.dbType)
      .then(setSystemDbs)
      .catch(() => setSystemDbs([]));
  }, [profile.dbType]);

  /** データベースの選択の中身 (自分のDBが先、サーバーのDBは区切りの下) */
  const dbOptions = useMemo(
    () => databaseOptions(databases, systemDbs),
    [databases, systemDbs]
  );


  /*
   * DBを切り替えたらCSV取り込みの画面は閉じる
   * (開いたままだと、切り替えた先の同名テーブルへ入れてしまう)。
   * テーブル一覧の更新では閉じない。取り込んだ直後に一覧を取り直すため、
   * ここに tables を入れると成功の表示ごと消えてしまう
   */
  useEffect(() => {
    closeCsvImport(tab.key);
    setGenTarget(null);
  }, [selectedDb, tab.key]);

  // 接続タブを切り替えたら、開いていた画面は閉じる
  // (この部品はタブごとに作り直さず使い回すため、明示的に消す)
  useEffect(() => {
    setShowRoutines(false);
    setDialog(null);
    setTableMenu(null);
    setDropping(null);
    setGenTarget(null);
    setShowDbAdmin(false);
    setShowSearch(false);
    setPendingSelect(null);
    clearToast();
    // 名前の変更・新規作成の入力が残ると、
    // 切り替えた先の同名テーブルを触ってしまう
    setRenaming(null);
    setRenameError(null);
    setRenameAsk(null);
    setShowCreate(false);
  }, [tab.key, clearToast]);

  // 作成したテーブルが一覧に現れたら選択して定義を表示する
  useEffect(() => {
    if (!pendingSelect) return;
    /*
     * 別のDBへ切り替えている途中は、そのDBの一覧になるまで待つ。
     * 切り替え直後は前のDBの一覧がまだ残っているので、読み込み中も待つ
     */
    if (pendingSelect.db && pendingSelect.db !== selectedDb) return;
    if (pendingSelect.db && tab.loadingTables) return;
    const found = tables.find(
      (t) =>
        t.name === pendingSelect.name &&
        (pendingSelect.schema === undefined || t.schema === pendingSelect.schema)
    );
    if (found) {
      setPendingSelect(null);
      setFilter("");
      /*
       * 選択の見た目も、開いたテーブル1つに揃える。
       * 揃えないと、検索やクイックオープンで別のテーブルへ移ったあとも
       * 前に選んでいたテーブルが選択中のまま残ってしまう
       * (右クリックメニューの対象も前のままになる)
       */
      selectTable(tableKey(found));
      onSelectTable(found);
    }
    // 一覧が届いたときだけ選び直す (選択の関数は依存に入れない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, pendingSelect, selectedDb, tab.loadingTables]);

  // 設定を読む。設定モーダルでの変更 (イベント) と、
  // 別ウィンドウでの変更 (ウィンドウに戻ってきたとき) の両方で読み直す
  useEffect(() => {
    const load = () => {
      getAppSettings().then(setSettings).catch(() => {});
    };
    load();
    window.addEventListener(APP_SETTINGS_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener(APP_SETTINGS_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, []);

  const commentDelim = settings?.commentDelimiter ?? "（";

  /** テーブルの日本語名 (テーブルコメントの論理名部分)。無ければ空 */
  const logicalOf = useCallback(
    (t: TableInfo): string => {
      const qualified = t.schema ? `${t.schema}.${t.name}` : t.name;
      return schemaMap[qualified]?.logical ?? schemaMap[t.name]?.logical ?? "";
    },
    [schemaMap]
  );

  /*
   * テーブル一覧の中身 (並びと名前)。
   *
   * 再読み込みのたびに配列は作り直されるが、中身が同じなら
   * カラムを取り直す必要はない (数千テーブルだと待ち時間になる)
   */
  const tablesSig = useMemo(
    () => tables.map((t) => tableKey(t)).join("\n"),
    [tables]
  );

  // テーブル・カラムの一覧は、DBが変わったときに取り直す
  useEffect(() => {
    if (!selectedDb) {
      setSchemaMap({});
      return;
    }
    let alive = true;
    schemaColumns(tab.key, selectedDb)
      .then((list) => {
        if (!alive) return;
        setSchemaMap(
          Object.fromEntries(
            list.map((t) => [
              t.name,
              {
                logical: parseComment(t.comment ?? "", commentDelim)[0],
                columns: t.columns.map((c) => ({
                  name: c.name,
                  logical: parseComment(c.comment ?? "", commentDelim)[0],
                  dataType: c.dataType,
                  pk: c.pk ?? false,
                })),
              },
            ])
          )
        );
      })
      // 補完は補助機能なので、取れなくても黙って諦める
      .catch(() => alive && setSchemaMap({}));
    return () => {
      alive = false;
    };
    /*
     * 取り直すのは、テーブルが増減・改名されたとき (tablesSig)、
     * 定義そのものを変えたとき (schemaRev)、再読み込みボタンを押したとき (schemaReload)。
     * ほかの操作のついでに一覧を読み直しただけでは取り直さない (数千テーブルだと待ち時間になる)
     */
  }, [tab.key, selectedDb, commentDelim, tablesSig, tab.schemaRev, schemaReload]);

  // 右クリックメニューは外側クリック・リサイズで閉じる
  useDismiss(!!tableMenu, () => setTableMenu(null), { resize: true });

  /*
   * 絞り込みは物理名だけでなく論理名 (テーブルコメントの日本語名) も見る。
   * 日本語名で探せないと、一覧に日本語名が出ている意味が薄い
   */
  const filteredTables = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter(
      (t) =>
        tableKey(t).toLowerCase().includes(q) ||
        logicalOf(t).toLowerCase().includes(q)
    );
  }, [tables, filter, logicalOf]);

  const showSchema = useMemo(
    () => new Set(tables.map((t) => t.schema ?? "")).size > 1,
    [tables]
  );

  /** よく見るテーブルのピン留め (接続・DBごとに覚える) */
  const { pinned: pinnedKeys, toggleMany: togglePins } = usePinnedTables(
    profile.id,
    selectedDb
  );

  /** 複数選択 (SQLダンプ出力・まとめて削除の対象)。Shiftの範囲は表示中の並びで決まる */
  const filteredKeys = useMemo(
    () => orderByPinned(filteredTables, tableKey, pinnedKeys).map(tableKey),
    [filteredTables, pinnedKeys]
  );
  const {
    selected: multiSel,
    click: clickTable,
    rightClick: rightClickTable,
    select: selectTable,
    selectAll: selectAllTables,
    clear: clearMultiSel,
  } = useMultiSelect(filteredKeys);

  // DB切替やテーブル一覧の更新で複数選択をリセット。
  // 数えた件数も、別のDBの同名テーブルへ持ち越さないようここで消す
  useEffect(() => {
    clearMultiSel();
    setCounts({});
  }, [selectedDb, tables, clearMultiSel]);

  const selected = tables.find((t) => tableKey(t) === tab.selectedTable) ?? null;

  /** テーブル項目クリック (⌘/Ctrl: トグル, Shift: 範囲, 通常: 単一選択+構造表示) */
  const handleTableClick = useCallback(
    (e: React.MouseEvent, t: TableInfo) => {
      // ふつうのクリックのときだけ、選択に合わせて定義を出す
      if (clickTable(e, tableKey(t))) onSelectTable(t);
    },
    [clickTable, onSelectTable]
  );

  /** テーブル項目の右クリック (メニューを出す) */
  const handleTableContextMenu = useCallback(
    (e: React.MouseEvent, t: TableInfo) => {
      e.preventDefault();
      setRenameError(null);
      rightClickTable(tableKey(t));
      setTableMenu({ x: e.clientX, y: e.clientY, table: t });
    },
    [rightClickTable]
  );

  /** 名前の変更中の入力 */
  const handleRenameInput = useCallback((value: string) => {
    setRenaming((cur) => (cur ? { ...cur, value } : cur));
  }, []);

  /** 名前の変更をやめる */
  const handleRenameCancel = useCallback(() => {
    setRenaming(null);
    setRenameError(null);
  }, []);

  /** ⌘/Ctrl+A で表示中のテーブルを全選択 */
  const handlePaneKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAllTables();
    }
  };

  /**
   * テーブル一覧を取得し直す (二重実行しない)。
   * よそで書き換えたテーブルコメントも反映したいので、日本語名も取り直す
   */
  const handleReloadTables = async () => {
    if (reloading || !selectedDb) return;
    setReloading(true);
    try {
      await onReloadTables();
    } finally {
      setReloading(false);
      setSchemaReload((n) => n + 1);
    }
  };

  /**
   * テーブル名を変更する (確認を済ませたあと、または確認が要らないとき)。
   * 失敗したら例外を投げる (確認ダイアログから呼んだときは、そこに出す)
   */
  const doRenameTable = useCallback(
    async (t: TableInfo, next: string) => {
      if (!selectedDb) return;
      await renameTable(tab.key, selectedDb, t.schema, t.name, next);
      setRenaming(null);
      setRenameError(null);
      setPendingSelect({ schema: t.schema, name: next });
      await onReloadTables();
    },
    [selectedDb, tab.key, onReloadTables]
  );

  /**
   * 入力された名前でテーブル名を変更する (Enterか確定ボタンで呼ばれる)。
   *
   * 本番と、設定「定義の変更も確認する」が有効なときは、実行の前に確認を出す
   * (SQLエディタで RENAME を流すときと同じ決まり)
   */
  const handleRenameTable = useCallback(
    async (t: TableInfo) => {
      if (renameBusy.current) return;
      const next = (renaming?.value ?? "").trim();
      // 空欄や変更なしのときは、そのまま編集を閉じるだけにする
      if (!next || !selectedDb || next === t.name) {
        setRenaming(null);
        setRenameError(null);
        return;
      }
      if (
        needsStructureConfirm(
          profile.env === "prod",
          settings?.confirmAlter ?? true
        )
      ) {
        setRenameAsk({ table: t, next });
        return;
      }
      renameBusy.current = true;
      setRenameError(null);
      try {
        await doRenameTable(t, next);
      } catch (e) {
        setRenameError(String(e));
      } finally {
        renameBusy.current = false;
      }
    },
    [renaming, selectedDb, profile.env, settings?.confirmAlter, doRenameTable]
  );

  /** SQLiteはファイルベースのため、ホスト表示や外部ツール連携の扱いが変わる */
  const isSqlite = profile.dbType === "sqlite";
  /**
   * 読み取り専用の接続か。
   * 変更する操作は隠さず、押せなくして理由 (RO_REASON) を出す
   */
  const readOnly = profile.readOnly ?? false;
  /** 表示中のシート (書きかけのSQLと実行結果はシートが持つ) */
  const sheet = activeSheetOf(tab.editor);
  /** 別ウィンドウを開けなかったときの表示 (握りつぶすと無反応に見えるため) */
  const [winError, setWinError] = useState<string | null>(null);
  /**
   * × で閉じたタブのエラー。
   * エラーそのものはタブの状態なので消さず、同じ文のあいだだけ隠す
   * (次に別のエラーが出たら、また見せる)
   */
  const [hiddenError, setHiddenError] = useState<string | null>(null);
  /** 操作が「接続が切れた」エラーで失敗したか (帯は ConnLostBanner が出す) */
  const lost = useConnLost(tab.key);
  const dbFilePath = profile.database ?? "";

  /*
   * トランザクションの状態。
   * 実行が終わったとき・定義を変えたとき・DBを変えたときに読み直す
   * (これ以外で開いたり閉じたりすることはない)
   */
  const txnWatch = `${tab.editor.running}:${tab.schemaRev}:${selectedDb ?? ""}`;
  const txnCtl = useTxnState(tab.key, txnWatch, tab.connected);

  /** 直近の実行の要約 (最後の文の結果を出す) */
  const lastRun: LastRun | null = useMemo(() => {
    const last = sheet.queryResults?.[sheet.queryResults.length - 1]?.result;
    if (!last) return null;
    const affected = isExecResult(last);
    return {
      rows: affected ? (last.rowsAffected ?? 0) : last.rows.length,
      affected,
      elapsedMs: last.elapsedMs,
    };
  }, [sheet.queryResults]);

  /** SQLダンプ出力の対象テーブル (PGはスキーマも渡す) */
  const exportNames = useMemo(
    () =>
      tables
        .filter((t) => multiSel.has(tableKey(t)))
        .map((t) => ({
          schema:
            profile.dbType === "postgresql" ? (t.schema ?? undefined) : undefined,
          name: t.name,
        })),
    [tables, multiSel, profile.dbType]
  );

  return (
    <div className="session">
      {/*
        * ツールバー。
        * 環境の印は決まり (envBand.ts の isMarkedEnv) どおり、
        * 本番・ステージングは下の帯とタブ、すべての環境はステータスバーに出す。
        * ここには重ねて出さない
        */}
      <div
        className="session-toolbar"
        // ページ内検索の対象外 (接続名・DB名・サーバー情報)
        data-find-skip
      >
        <ConnectionChip profile={profile} filePath={dbFilePath} />

        {/* SQLiteは1ファイル=1DBなので選択メニューは出さない */}
        {!isSqlite && (
          <div className="db-tools">
          <div className="db-select-wrap">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <ellipse cx="12" cy="5.5" rx="8" ry="3" stroke="currentColor" strokeWidth="2" />
              <path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13" stroke="currentColor" strokeWidth="2" />
            </svg>
            <SelectMenu
              className="mono"
              value={selectedDb ?? ""}
              placeholder="データベースを選択"
              options={dbOptions}
              onChange={onSelectDb}
            />
            {/* 作成と削除の両方の入口なので、「＋」ではなく管理の絵にする */}
            <IconButton
              className="db-admin-btn"
              label={
                readOnly
                  ? `データベースの管理 — ${RO_REASON}`
                  : profile.dbType === "postgresql"
                    ? "データベースの管理 (データベース・スキーマの作成と削除)"
                    : "データベースの管理 (作成と削除)"
              }
              disabled={readOnly}
              onClick={() => setShowDbAdmin(true)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 7h10M18 7h2M4 17h4M12 17h8"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
                <circle cx="16" cy="7" r="2.2" stroke="currentColor" strokeWidth="2" />
                <circle cx="10" cy="17" r="2.2" stroke="currentColor" strokeWidth="2" />
              </svg>
            </IconButton>
            </div>
            {/*
              * ユーザーと権限は「今どのDBを見ているか」と地続きなので、
              * ツールへ入れずにデータベースの選択のすぐ隣へ置く。
              * 一覧を見るだけなら読み取り専用の接続でも使える
              */}
            {profile.dbType !== "valkey" && (
              <IconButton
                className="db-users-btn"
                label={
                  !selectedDb
                    ? "ユーザーと権限 — データベースを選んでください"
                    : readOnly
                      ? "ユーザーと権限 (一覧を見る。読み取り専用の接続なので変更はできません)"
                      : "ユーザーと権限 (一覧を見る・ユーザーの作成と削除・権限の付け外し)"
                }
                disabled={!selectedDb}
                onClick={() => setShowUsers(true)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="2" />
                  <path
                    d="M4.5 20c0-3.6 3.4-5.6 7.5-5.6s7.5 2 7.5 5.6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </IconButton>
            )}
          </div>
        )}

        <ServerInfo items={tab.serverInfo} />

        <span className="toolbar-spacer" />

        {/*
          * ときどき開くものは「ツール」にまとめる。
          * 常に使う「SQL」だけをボタンのまま残す
          */}
        <SessionTools
          selectedDb={selectedDb}
          dbType={profile.dbType}
          onSearch={() => setShowSearch(true)}
          onSchema={() => {
            if (!selectedDb) return;
            openSchema(tab.key, selectedDb, profile.name).catch((e) =>
              setWinError(`スキーマを開けませんでした: ${e}`)
            );
          }}
          onRoutines={() => setShowRoutines(true)}
          onProcesses={() => setShowProcesses(true)}
          onHelp={() => setShowHelp(true)}
          hasHelp={topicsFor(profile.dbType).length > 0}
        />
        <IconButton
          className={"sql-btn" + (tab.view === "query" ? " active" : "")}
          label={`SQLエディタ (${MOD}Enter で実行)`}
          aria-pressed={tab.view === "query"}
          onClick={onToggleQuery}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M13 19h7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          SQL
        </IconButton>
      </div>

      {/* 本番 (とステージング) は、作業中ずっと分かるように帯を出す */}
      <EnvBand env={profile.env} connection={profile.name} />

      {/* 接続が切れたときは「接続し直す」を出す (同じエラーの帯は重ねない) */}
      <ConnLostBanner sessionId={tab.key} />

      {tab.error && tab.error !== hiddenError && tab.error !== lost?.message && (
        <div className="result-banner ng session-error">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{tab.error}</span>
          <span className="toolbar-spacer" />
          <IconButton
            className="banner-close"
            label="閉じる"
            onClick={() => setHiddenError(tab.error)}
          >
            <CloseMark size={12} />
          </IconButton>
        </div>
      )}

      {winError && (
        <div className="result-banner ng session-error">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{winError}</span>
          <span className="toolbar-spacer" />
          <IconButton
            className="banner-close"
            label="閉じる"
            onClick={() => setWinError(null)}
          >
            <CloseMark size={12} />
          </IconButton>
        </div>
      )}

      {/* 本体 */}
      <div className="session-body">
        <SidePane
          width={paneWidth}
          onStartResize={startResize}
          onNudge={nudgePane}
          focusable
          onKeyDown={handlePaneKeyDown}
        >
          <PaneHead
            title="テーブル"
            count={
              selectedDb && !loadingTables
                ? multiSel.size > 1
                  ? `${multiSel.size}/${tables.length}`
                  : tables.length
                : undefined
            }
          >
            <IconButton
              className={"pane-icon-btn" + (reloading ? " spinning" : "")}
              tipLeft
              label="テーブル一覧を再読み込み"
              disabled={!selectedDb || loadingTables || reloading}
              onClick={handleReloadTables}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </IconButton>
            <IconButton
              className="pane-icon-btn"
              tipLeft
              label={
                readOnly
                  ? `テーブルを新規作成 — ${RO_REASON}`
                  : "テーブルを新規作成"
              }
              disabled={!selectedDb || loadingTables || readOnly}
              onClick={() => setShowCreate(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </IconButton>
            <span className="toolbar-spacer" />
            {/*
              * SQLダンプの書き出し・SQLファイルの実行 (Quelio自身でできるので、SQLiteでも出す)。
              * ↓↑ だけでは意味が伝わりにくいので、ファイルの絵に矢印・再生の印を重ね、短い字を添える
              */}
            <IconButton
              className="pane-icon-btn pane-icon-text"
              tipLeft
              label={
                multiSel.size === 0
                  ? `SQLダンプを書き出す — 書き出すテーブルを選んでください (${MOD}クリックで複数選択 / ${MOD}A ですべて選択)`
                  : `選択した${multiSel.size}件をSQLダンプに書き出す`
              }
              disabled={!selectedDb || multiSel.size === 0}
              onClick={() => setDialog("export")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M6 3h8l4 4v14H6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                <path d="M12 10v7m0 0l-3-3m3 3l3-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="pane-icon-label">ダンプ</span>
            </IconButton>
            <IconButton
              className="pane-icon-btn pane-icon-text"
              tipLeft
              label={
                readOnly
                  ? `SQLファイルを実行 — ${RO_REASON}`
                  : "SQLファイルを実行 (ダンプなどを流し込む)"
              }
              disabled={!selectedDb || readOnly}
              onClick={() => setDialog("import")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M6 3h8l4 4v14H6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                <path d="M10 10.5v6l5-3z" fill="currentColor" />
              </svg>
              <span className="pane-icon-label">実行</span>
            </IconButton>
          </PaneHead>
          {!selectedDb ? (
            <div className="table-pane-empty">上部からデータベースを選択</div>
          ) : loadingTables ? (
            <div className="table-pane-empty">
              <span className="spinner accent" /> 読み込み中…
            </div>
          ) : (
            <>
              <input
                className="filter-input mono"
                placeholder="絞り込み (名前・日本語名)…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <TableList
                // 接続タブ・DBごとにスクロール位置を分ける (片方の位置がもう片方に付いてこないように)
                scrollKey={`${tab.key}\u0000${selectedDb}`}
                tables={filteredTables}
                emptyLabel={tables.length === 0 ? "テーブルなし" : "該当なし"}
                selectedKey={tab.selectedTable}
                multiSel={multiSel}
                pinnedKeys={pinnedKeys}
                counts={counts}
                showSchema={showSchema}
                logicalOf={logicalOf}
                renaming={renaming}
                renameError={renameError}
                onRenameInput={handleRenameInput}
                onRenameCommit={handleRenameTable}
                onRenameCancel={handleRenameCancel}
                onItemClick={handleTableClick}
                onItemContextMenu={handleTableContextMenu}
              />
            </>
          )}
        </SidePane>

        <main className="session-content">
          {tab.view === "query" ? (
            <QueryPanel
              sessionId={tab.key}
              database={selectedDb ?? undefined}
              dbType={profile.dbType}
              prod={profile.env === "prod"}
              sql={sheet.sql}
              results={sheet.queryResults}
              error={sheet.queryError}
              running={tab.editor.running}
              runStartedAt={tab.editor.startedAt}
              explainKind={sheet.queryExplain}
              columnTips={tab.columnTips}
              columnLabels={tab.columnLabels}
              schema={schemaMap}
              autocomplete={settings?.autocompleteEnabled ?? true}
              autocompleteDelayMs={settings?.autocompleteDelayMs ?? 100}
              options={sheet.editorOpts}
              onChangeOptions={onChangeEditorOpts}
              onChangeSql={onChangeSql}
              onAcceptRun={onAcceptRun}
              onRun={onRunQuery}
              onCancel={onCancelQuery}
              onPage={onPageQuery}
              onServerSort={onSortQuery}
              sheetPane={sheetPane}
            />
          ) : selected ? (
            <TableView
              table={selected}
              sessionId={tab.key}
              database={selectedDb ?? undefined}
              dbType={profile.dbType}
              readOnly={profile.readOnly ?? false}
              prod={profile.env === "prod"}
              onReloadDetail={onReloadDetail}
              onSendToEditor={onSendToEditor}
              view={tab.tableTab}
              onChangeView={onChangeTableTab}
              detail={tab.tableDetail}
              loadingDetail={tab.loadingDetail}
              dataPane={dataPane}
            />
          ) : (
            <div className="content-placeholder dim-center">
              {selectedDb
                ? "左の一覧からテーブルを選択してください"
                : "データベースを選択するとテーブル一覧が表示されます"}
            </div>
          )}
        </main>
      </div>

      <StatusBar
        profile={profile}
        database={selectedDb}
        txn={txnCtl.txn}
        txnBusy={txnCtl.busy}
        txnError={txnCtl.error}
        onEndTxn={txnCtl.end}
        lastRun={tab.view === "query" ? lastRun : null}
      />

      {dialog === "export" && selectedDb && (
        <ExportDialog
          prod={profile.env === "prod"}
          sessionId={tab.key}
          database={selectedDb}
          connName={profile.name || profile.host}
          dbType={profile.dbType}
          tables={exportNames}
          onClose={() => setDialog(null)}
          onOpenSettings={onOpenSettings}
        />
      )}
      {dialog === "import" && selectedDb && (
        <ImportDialog
          prod={profile.env === "prod"}
          sessionId={tab.key}
          database={selectedDb}
          connName={profile.name || profile.host}
          dbType={profile.dbType}
          onClose={() => setDialog(null)}
          onOpenSettings={onOpenSettings}
          onImported={() => onSelectDb(selectedDb)}
        />
      )}

      {showRoutines && selectedDb && (
        <RoutineDialog
          sessionId={tab.key}
          database={selectedDb}
          onClose={() => setShowRoutines(false)}
        />
      )}

      {showProcesses && selectedDb && (
        <ProcessDialog
          sessionId={tab.key}
          database={selectedDb}
          readOnly={profile.readOnly ?? false}
          onClose={() => setShowProcesses(false)}
        />
      )}

      {showHelp && (
        <HelpDialog
          dbType={profile.dbType}
          onClose={() => setShowHelp(false)}
        />
      )}

      {showUsers && selectedDb && (
        <DbUsersDialog
          prod={profile.env === "prod"}
          connName={profile.name || profile.host}
          sessionId={tab.key}
          database={selectedDb}
          databases={databases}
          dbType={profile.dbType}
          onClose={() => setShowUsers(false)}
        />
      )}

      {showSearch && (
        <SearchDialog
          sessionId={tab.key}
          dbType={profile.dbType}
          database={selectedDb ?? undefined}
          onClose={() => setShowSearch(false)}
          onOpenTable={(database, schema, table) => {
            /*
             * 別のデータベースが当たったときは、そちらへ切り替えてから開く。
             * 一覧に現れたところで選ぶ仕組み (pendingSelect) に任せる
             */
            const target = database || selectedDb || "";
            setPendingSelect({
              // スキーマを持つのはPostgreSQLだけ (他は必ず空になる)
              schema:
                profile.dbType === "postgresql" && schema ? schema : undefined,
              name: table,
              db: target || undefined,
            });
            if (target && target !== selectedDb) onSelectDb(target);
          }}
        />
      )}

      {showCreate && selectedDb && (
        <CreateTableModal
          sessionId={tab.key}
          dbType={profile.dbType}
          database={selectedDb}
          // スキーマの候補は、いま見えているテーブルから拾う
          schemas={[
            ...new Set(
              tables.map((t) => t.schema ?? "").filter((sc) => sc !== "")
            ),
          ].sort()}
          defaultSchema={
            profile.dbType === "postgresql"
              ? (tables.find((t) => t.schema)?.schema ?? "public")
              : undefined
          }
          onClose={() => setShowCreate(false)}
          onCreated={(schema, name) => {
            setShowCreate(false);
            // 作ったテーブルは、一覧に現れたところで開く
            setPendingSelect({ schema, name });
            void onReloadTables();
          }}
        />
      )}

      {showDbAdmin && (
        <DbAdminDialog
          prod={profile.env === "prod"}
          connName={profile.name || profile.host}
          sessionId={tab.key}
          dbType={profile.dbType}
          currentDb={selectedDb}
          databases={databases}
          onClose={() => setShowDbAdmin(false)}
          onDatabasesChanged={onDatabasesChanged}
        />
      )}

      {csvTarget && selectedDb && (
        <CsvImportDialog
          prod={profile.env === "prod"}
          connName={profile.name || profile.host}
          sessionId={tab.key}
          database={selectedDb}
          schema={csvTarget.schema ?? undefined}
          table={csvTarget.name}
          dbType={profile.dbType}
          onClose={closeCsv}
          onImported={() => {
            void onReloadTables();
            // 取り込んだテーブルを開いていれば、表示中のデータも取り直す
            if (tab.selectedTable === tableKey(csvTarget)) dataPane.onReload();
          }}
        />
      )}

      {genTarget && selectedDb && (
        <TestDataDialog
          prod={profile.env === "prod"}
          connName={profile.name || profile.host}
          sessionId={tab.key}
          database={selectedDb}
          schema={genTarget.schema ?? undefined}
          table={genTarget.name}
          onClose={() => setGenTarget(null)}
          onGenerated={() => {
            void onReloadTables();
            // 入れたテーブルを開いていれば、表示中のデータも取り直す
            if (tab.selectedTable === tableKey(genTarget)) dataPane.onReload();
          }}
        />
      )}

      {toast &&
        createPortal(<div className="grid-toast">{toast}</div>, document.body)}

      {/* テーブル項目の右クリックメニュー */}
      {tableMenu &&
        createPortal(
          <div
            className="context-menu"
            ref={tableMenuRef}
            style={tableMenuStyle}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {(() => {
              const targets = menuTargets(tableMenu.table);
              const n = targets.length;
              const multi = n > 1;
              /** 複数選択のときだけ「選択した N 件」と書く */
              const label = (one: string, many: string) =>
                multi ? `選択した${n}件${many}` : one;
              /** 複数では意味が無い操作に添える説明 */
              const oneOnly = multi
                ? "1つのテーブルを選んでいるときだけ使えます"
                : undefined;
              return (
                <>
                  <div className={"context-head" + (multi ? "" : " mono")}>
                    {multi ? `${n}件を選択中` : tableMenu.table.name}
                  </div>
                  {(() => {
                    // 選んだものが全部ピン留め済みなら「外す」にする
                    const keys = targets.map((t) => tableKey(t));
                    const allPinned = keys.every((k) => pinnedKeys.has(k));
                    return (
                      <button
                        className="context-item"
                        onClick={() => {
                          setTableMenu(null);
                          togglePins(keys, !allPinned);
                        }}
                      >
                        {allPinned
                          ? label("ピン留めを外す", "のピン留めを外す")
                          : label("ピン留めする", "をピン留めする")}
                      </button>
                    );
                  })()}
                  <div className="context-sep" />
                  <div className="context-group">コピー</div>
                  <button
                    className="context-item"
                    onClick={() =>
                      copySql(
                        targets
                          .map((t) => tableNameIfNeeded(profile.dbType, t))
                          .join("\n"),
                        label("テーブル名", "のテーブル名")
                      )
                    }
                  >
                    {label("テーブル名をコピー", "のテーブル名をコピー")}
                  </button>
                  <button
                    className="context-item has-tooltip"
                    data-tooltip="COUNT(*) のSQLをコピーします"
                    onClick={() =>
                      copySql(
                        joinSql(targets, (t) =>
                          buildCountStatement(profile.dbType, t)
                        ),
                        label("COUNT文", "のCOUNT文")
                      )
                    }
                  >
                    {label("COUNT文をコピー", "のCOUNT文をコピー")}
                  </button>
                  <div className="context-sep" />
                  <div className="context-group">SQLをエディタへ</div>
                  <button
                    className="context-item has-tooltip"
                    data-tooltip="カラムを並べたSELECT文をSQLエディタへ入れます"
                    onClick={() => {
                      setTableMenu(null);
                      onSendToEditor(
                        joinSql(targets, (t) =>
                          buildSelectStatement(profile.dbType, t, columnsOf(t))
                        )
                      );
                    }}
                  >
                    {label("SELECT文をエディタへ", "のSELECT文をエディタへ")}
                  </button>
                  <button
                    className="context-item has-tooltip"
                    data-tooltip={
                      readOnly
                        ? RO_REASON
                        : "カラムを並べたINSERT文のひな形をSQLエディタへ入れます (値はNULL)"
                    }
                    disabled={readOnly}
                    onClick={() => {
                      setTableMenu(null);
                      onSendToEditor(
                        joinSql(targets, (t) =>
                          buildInsertStatement(profile.dbType, t, columnsOf(t))
                        )
                      );
                    }}
                  >
                    {label("INSERT文をエディタへ", "のINSERT文をエディタへ")}
                  </button>
                  <div className="context-sep" />
                  <div className="context-group">データ</div>
                  <button
                    className="context-item has-tooltip"
                    data-tooltip="一覧の行数は概算です。COUNT(*) で正確に数えます (大きな表では時間が掛かります)"
                    onClick={() => countRows(targets)}
                  >
                    {label("正確な件数を数える", "の件数を数える")}
                  </button>
                  {/*
                    * SQLダンプとテーブルの新規作成は、一覧の見出しのボタンに任せる
                    * (右クリックは「この対象への操作」だけにして短くする)
                    */}
                  <>
                      <button
                        className="context-item has-tooltip"
                        data-tooltip={
                          readOnly
                            ? RO_REASON
                            : (oneOnly ??
                              "CSV / TSVファイルの中身をこのテーブルへ追加します")
                        }
                        // 取り込み先は1つに決まっていないと選べない
                        disabled={
                          readOnly ||
                          multi ||
                          tableMenu.table.tableType.toUpperCase().includes("VIEW")
                        }
                        onClick={() => {
                          const t = tableMenu.table;
                          setTableMenu(null);
                          openCsvImport(tab.key, t);
                        }}
                      >
                        CSVを取り込む
                      </button>
                      <button
                        className="context-item has-tooltip"
                        data-tooltip={
                          readOnly
                            ? RO_REASON
                            : (oneOnly ??
                              "日本語のテストデータを作ってこのテーブルへ追加します")
                        }
                        // 入れ先は1つに決まっていないと選べない
                        disabled={
                          readOnly ||
                          multi ||
                          tableMenu.table.tableType.toUpperCase().includes("VIEW")
                        }
                        onClick={() => {
                          const t = tableMenu.table;
                          setTableMenu(null);
                          setGenTarget(t);
                        }}
                      >
                        テストデータを作成
                      </button>
                  </>
                  <div className="context-sep" />
                  {/* 読み取り専用の接続でも隠さず、押せなくして理由を出す */}
                  <>
                      <div className="context-group">テーブルの管理</div>
                      <button
                        className="context-item has-tooltip"
                        // 名前は1つずつしか付けられない
                        disabled={
                          readOnly ||
                          multi ||
                          tableMenu.table.tableType.toUpperCase().includes("VIEW")
                        }
                        data-tooltip={readOnly ? RO_REASON : oneOnly}
                        onClick={() => {
                          const t = tableMenu.table;
                          setTableMenu(null);
                          setRenaming({ key: tableKey(t), value: t.name });
                        }}
                      >
                        テーブル名を変更
                      </button>
                      <div className="context-sep" />
                      <div className="context-group danger">危険な操作</div>
                      <button
                        className="context-item danger has-tooltip"
                        data-tooltip={
                          readOnly
                            ? RO_REASON
                            : "実行はしません。エディタで内容を確かめてから実行してください"
                        }
                        disabled={readOnly}
                        onClick={() => {
                          setTableMenu(null);
                          onSendToEditor(
                            joinSql(targets, (t) =>
                              buildTruncateStatement(profile.dbType, t)
                            )
                          );
                        }}
                      >
                        {profile.dbType === "sqlite"
                          ? label(
                              "全行を削除するSQLをエディタへ",
                              "の全行を削除するSQLをエディタへ"
                            )
                          : label(
                              "空にするSQL (TRUNCATE) をエディタへ",
                              "を空にするSQLをエディタへ"
                            )}
                      </button>
                      <button
                        className="context-item danger has-tooltip"
                        data-tooltip={readOnly ? RO_REASON : undefined}
                        disabled={readOnly}
                        onClick={() => {
                          setTableMenu(null);
                          setDropping(targets);
                        }}
                      >
                        {label("テーブルを削除", "を削除")}
                      </button>
                  </>
                </>
              );
            })()}
          </div>,
          document.body
        )}

      {renameAsk && (
        <ConfirmDialog
          title="テーブル名を変更します"
          target={renameAsk.table.name}
          confirmLabel="変更する"
          tone="primary"
          prodNote={
            profile.env === "prod"
              ? prodActionText(
                  selectedDb ?? "",
                  tableRenameWhat(renameAsk.table.name, renameAsk.next)
                )
              : undefined
          }
          onCancel={() => setRenameAsk(null)}
          onConfirm={async () => {
            await doRenameTable(renameAsk.table, renameAsk.next);
            setRenameAsk(null);
          }}
        >
          {tableRenameWhat(renameAsk.table.name, renameAsk.next)}。
          このテーブルを使っているSQL・ビュー・アプリの側は、名前を書き換えるまで動かなくなります。
        </ConfirmDialog>
      )}

      {dropping && (
        <DropTableConfirm
          prod={profile.env === "prod"}
          sessionId={tab.key}
          database={selectedDb ?? undefined}
          tables={dropping}
          onClose={() => setDropping(null)}
          onDropped={() => {
            void onReloadTables();
          }}
        />
      )}
    </div>
  );
}
