/**
 * 画面のタブが持つ作業状態。
 * アプリを閉じても復元できるよう、ここの形がそのまま保存される
 */
import type { ConnectionProfile, TestResult } from "./connection";
import { emptyProfile } from "./connection";
import type { KvBrowseState, KvStatementResult } from "./kv";
import type { QueryResult, StatementResult } from "./query";
import type { TableDetail, TableInfo } from "./schema";

/** テーブル選択時の表示タブ (定義 / データ) */
export type TableTab = "definition" | "data";

/** SQLエディタの実行設定 (タブ切替で失わないようタブ側で保持する) */
export interface EditorOptions {
  /** トランザクション (BEGIN 〜 COMMIT/ROLLBACK) で実行する */
  txn: boolean;
  /** 実行後にSQLと結果のPNGを保存する */
  capture: boolean;
  /**
   * 実行ボタンが流す範囲。
   *
   * "here" … 選択があればそこ、無ければカーソルのある文だけ
   * "all"  … 書いてあるSQLを全部
   */
  runScope: "here" | "all";
  /** EXPLAINボタンのモード */
  explainMode: "explain" | "analyze";
  /** エディタを画面いっぱいに広げているか */
  editorFull: boolean;
}

export function defaultEditorOptions(): EditorOptions {
  return {
    txn: false,
    capture: false,
    runScope: "here",
    explainMode: "explain",
    editorFull: false,
  };
}

/** 接続し直したあとに戻す先 (作業状態の復元に使う) */
export interface RestoreTarget {
  /** この接続先のときだけ復元する (別の接続に変えたら捨てる) */
  profileId: string;
  db: string | null;
  table: string | null;
}

/**
 * SQLエディタの1シート (書きかけのSQLと、その実行結果)。
 *
 * 1つの接続で「検証用のSELECT」と「本命のUPDATE」を並べて持てるようにする。
 * 接続は1本なので同時には実行できず、実行中はシートを切り替えない
 */
export interface QuerySheet {
  id: string;
  /** 見出し (空ならSQLの先頭から作る) */
  title: string;
  sql: string;
  queryResults: StatementResult[] | null;
  queryError: string | null;
  queryExplain: "explain" | "analyze" | null;
  editorOpts: EditorOptions;
}

/** 空のシートを作る */
export function emptySheet(id: string): QuerySheet {
  return {
    id,
    title: "",
    sql: "",
    queryResults: null,
    queryError: null,
    queryExplain: null,
    editorOpts: defaultEditorOptions(),
  };
}

/**
 * SQLエディタまわりの状態 (WorkTab の中でひとまとまりにして持つ)。
 *
 * 表示中のシートの内容は sql / queryResults などの側にあり、
 * `sheets` の同じIDの要素は切り替えるまで古いままになる
 */
/**
 * SQLエディタの状態。
 *
 * 書きかけのSQLと実行結果は「シート」が持ち、ここでは
 * 「どのシートを開いているか」と「実行中かどうか」だけを持つ。
 * 表示中のぶんを別に持つと、シートの中身と二重管理になって
 * 切り替えのたびに写し替えが要るため
 */
export interface TabEditorState {
  running: boolean;
  /** 実行開始時刻 (epoch ms)。タブ切替で再マウントされても経過表示を続けるために持つ */
  startedAt: number | null;
  /** 全シート (必ず1枚以上ある) */
  sheets: QuerySheet[];
  /** 表示中のシートのID */
  activeSheet: string;
}

/** 表示中のシート (IDが見つからない場合は先頭のシート) */
export function activeSheetOf(e: TabEditorState): QuerySheet {
  return e.sheets.find((s) => s.id === e.activeSheet) ?? e.sheets[0];
}

/** 空のエディタ状態を作る (シート1枚から始める) */
export function emptyEditorState(): TabEditorState {
  const first = emptySheet(newSheetId());
  return {
    running: false,
    startedAt: null,
    sheets: [first],
    activeSheet: first.id,
  };
}

/** Valkey画面の状態 (WorkTab の中でひとまとまりにして持つ) */
export interface TabKvState {
  /** コンソールの実行結果 */
  results?: KvStatementResult[];
  /** コンソールのエラー表示 */
  execError?: string | null;
  /** キーブラウザの状態 (タブ切替後もそのまま戻せるように持つ) */
  browse?: KvBrowseState;
}

/** データタブの状態 (WorkTab の中でひとまとまりにして持つ) */
export interface TabTableData {
  /** 取得済みの1ページぶん (未取得はnull) */
  data: QueryResult | null;
  loading: boolean;
  error: string | null;
  /** 絞り込み条件 (WHERE句。空なら全件) */
  where: string;
}

export function emptyTableData(): TabTableData {
  return { data: null, loading: false, error: null, where: "" };
}

export interface WorkTab {
  /** タブ固有キー (バックエンドのセッションIDと同一) */
  key: string;
  /** 編集中 or 接続中のプロファイル */
  profile: ConnectionProfile;
  connected: boolean;
  databases: string[];
  /** 接続先サーバーの情報 (バージョン・文字コード等) */
  serverInfo: [string, string][];
  selectedDb: string | null;
  tables: TableInfo[];
  loadingTables: boolean;
  selectedTable: string | null;
  tableDetail: TableDetail | null;
  loadingDetail: boolean;
  /**
   * テーブルの定義が変わった回数。
   *
   * 一覧の再読み込みだけでは、カラムが変わったのか
   * 単に読み直しただけなのかが分からない。
   * DDLを流したときにここを進めて、補完やカラム説明を取り直す合図にする
   */
  schemaRev: number;
  /** テーブル画面で表示中のタブ (定義 / データ)。テーブルを切り替えても維持する */
  tableTab: TableTab;
  /** データタブの状態 (まとめて画面へ渡す) */
  tableData: TabTableData;
  /** SQL結果ヘッダ用のカラム説明 (カラム名(小文字) → 論理名・補足・型) */
  columnTips: Record<string, string>;
  /** columnTipsを読み込み済みのDB名 (未読込はnull) */
  columnTipsDb: string | null;
  /** 接続後の右ペイン表示 (構造 or SQLエディタ) */
  view: "structure" | "query";
  /** SQLエディタまわり (まとめて画面へ渡す) */
  editor: TabEditorState;
  error: string | null;
  testResult: TestResult | null;
  busy: "test" | "save" | "connect" | null;
  /** Valkey画面の状態 (タブを切り替えても保持する) */
  kv: TabKvState;
  /** 前回終了時に開いていたDB・テーブル (接続できたら戻す。復元後に消す) */
  restore?: RestoreTarget;
}

/** シートのIDを作る (タブをまたいでも衝突しない程度でよい) */
export function newSheetId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyTab(key: string): WorkTab {
  return {
    key,
    profile: emptyProfile(),
    connected: false,
    databases: [],
    serverInfo: [],
    selectedDb: null,
    tables: [],
    loadingTables: false,
    selectedTable: null,
    tableDetail: null,
    loadingDetail: false,
    schemaRev: 0,
    tableTab: "definition",
    tableData: emptyTableData(),
    kv: {},
    columnTips: {},
    columnTipsDb: null,
    view: "structure",
    editor: emptyEditorState(),
    error: null,
    testResult: null,
    busy: null,
  };
}
