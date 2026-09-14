import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatErrorMessage, formatSql } from "../sqlFormat";
import { MOD, SHIFT } from "../keyLabel";
import {
  checkDangerousSql,
  countQueryRows,
  csvFromRows,
  openCsvWindow,
  saveTextAs,
  splitSqlStatements,
} from "../api";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { autoTitle } from "./sheetTitle";
import { captureResults } from "../capture";
import { CellDetail } from "./CellDetail";
import type { Clip } from "../cellValue";
import { clipIndex, clippedRowKeys } from "../cellValue";
import { spanAt, spansOf } from "../sqlSpans";
import type { SqlSpan } from "../sqlSpans";

/** 全体実行のときに渡す空の範囲 (毎回作ると帯を入れ直してしまう) */
const EMPTY_SPANS: SqlSpan[] = [];
import { columnKinds, kindAlign, kindClass } from "../cellKind";
import { CellText } from "./CellText";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { useResizableHeight } from "../hooks/useResizableHeight";
import type {
  DangerousStatement,
  DbType,
  EditorOptions,
  StatementResult,
} from "../types";
import type { ExportFormat } from "../exportFormat";
import { isExecResult, statementLabel } from "./queryResult";
import { isPlanResult } from "./PlanView";
import { useWatchedSettings } from "../hooks/useWatchedSettings";
import { SheetTabs } from "./SheetTabs";
import type { SchemaMap } from "./sqlCompletion";
import { DangerousSqlConfirm } from "./DangerousSqlConfirm";
import { afterConfirm, confirmTarget } from "./queryGuard";
import type { PendingRun } from "./queryGuard";
import { createRunGate, startRun } from "./runRequest";
import type { RunGate } from "./runRequest";
import type { RunTicket } from "../runTicket";
import type {
  GridColumn,
  GridRow,
  SortDir,
  SortState,
} from "./ResizableGrid";
import { QueryToolbar } from "./QueryToolbar";
import { QueryResultBar } from "./QueryResultBar";
import { QueryResultView } from "./QueryResultView";
import { ResultChart } from "./ResultChart";
import { numericColumns } from "../chart/chartData";
import { SqlEditor, SqlEditorHandle } from "./SqlEditor";
import { SqlFindBar } from "./SqlFindBar";
import { toInList } from "../inList";
import { SqlFunctionsDialog } from "./SqlFunctionsDialog";
import { useDismiss } from "../hooks/useDismiss";
import { useCsvExport } from "../hooks/useCsvExport";

/** セル値の比較 (数値として解釈できれば数値比較、NULLは常に末尾) */
function compareCells(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a.trim() !== "" && b.trim() !== "") {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  }
  return a.localeCompare(b, "ja");
}

/** MySQLの表形式EXPLAINの各カラムの意味 (ヘッダのツールチップに出す) */
const EXPLAIN_COL_DESC: Record<string, string> = {
  id: "SELECTの識別子。同じ番号は同じレベルで実行される",
  select_type:
    "SELECTの種類。SIMPLE=単純なSELECT / PRIMARY=外側 / SUBQUERY=サブクエリ / DERIVED=FROM句の派生表 / UNION など",
  table: "アクセスするテーブル。<derivedN>はFROM句の派生表",
  partitions: "アクセスするパーティション (パーティション未使用ならNULL)",
  type:
    "アクセス方式。良い順に const > eq_ref > ref > range > index > ALL。ALLは全件走査なので改善余地あり",
  possible_keys: "使える可能性があると判断されたインデックスの候補",
  key: "実際に使われたインデックス。NULLならインデックス未使用",
  key_len:
    "使われたインデックスのバイト長。複合インデックスのうちどこまで使えたかがわかる",
  ref: "インデックスと比較されている列や定数",
  rows: "調べる必要があると予測された行数。少ないほど良い",
  filtered: "WHERE条件で絞り込んだ後に残ると予測される行の割合(%)",
  extra:
    "追加情報。Using filesort / Using temporary が出ていたら改善余地のサイン。Using index はカバリングインデックスで良好",
};

import type { SheetPane } from "./panes";

interface Props {
  /** CSV出力で使うセッションID (タブのキー) */
  sessionId: string;
  /** 選択中のデータベース */
  database?: string;
  /** 接続先の表示名 (実行前の確認ダイアログに出す) */
  dbType: DbType;
  sql: string;
  results: StatementResult[] | null;
  error: string | null;
  running: boolean;
  /** 実行開始時刻 (epoch ms)。タブ切替をまたいで経過時間を継続するため */
  runStartedAt: number | null;
  /** 直前の実行がEXPLAIN系だったか (ヘッダの意味ツールチップ用) */
  explainKind: "explain" | "analyze" | null;
  /** カラム名 → 論理名・補足・型の説明 (ヘッダのツールチップ用) */
  columnTips: Record<string, string>;
  /** 入力補完に使うテーブル・カラム名 */
  schema?: SchemaMap;
  /** 入力補完を使うか (設定) */
  autocomplete?: boolean;
  /** 入力補完が自動で開くまでの待ち時間 (ミリ秒) */
  autocompleteDelayMs?: number;
  /** 実行設定 (トランザクション・キャプチャ等)。タブ側で保持している */
  options: EditorOptions;
  onChangeOptions: (patch: Partial<EditorOptions>) => void;
  onChangeSql: (sql: string) => void;
  /**
   * この実行の受付票を取る (押した瞬間に呼ぶ)。
   *
   * 押した時点の接続タブ・データベース・シートが入る。
   * 取り消し・確定・タブを閉じた時点でこの受付票は古くなり、
   * 遅れて届いた依頼はその先で落ちる
   */
  onAcceptRun: () => RunTicket;
  /** offset行目からの実行。sqlOverride指定時は選択実行、transactionでBEGIN〜COMMIT/ROLLBACKに包む */
  onRun: (
    offset: number,
    sqlOverride: string | undefined,
    transaction: boolean,
    explain: "explain" | "analyze" | undefined,
    ticket: RunTicket
  ) => void;
  /** 実行中SQLのキャンセル */
  onCancel: () => void;
  /** 結果タブ単位のページ送り (その文だけを再実行) */
  onPage: (index: number, offset: number) => void;
  /** サーバーサイドソートの変更 (ページング可能な結果のみ) */
  onServerSort: (
    index: number,
    orderBy: string | null,
    orderDir: "asc" | "desc"
  ) => void;
  /** SQLのシート (書きかけのSQLを複数持つ) の状態と操作 */
  sheetPane: SheetPane;
}

/** SQLエディタ(行番号付き) + 実行結果ペイン(文ごとのタブ) */
export function QueryPanel({
  sessionId,
  database,
  dbType,
  sql,
  results,
  error,
  running,
  runStartedAt,
  explainKind,
  columnTips,
  schema,
  autocomplete,
  autocompleteDelayMs,
  options,
  onChangeOptions,
  onChangeSql,
  onAcceptRun,
  onRun,
  onCancel,
  onPage,
  onServerSort,
  sheetPane,
}: Props) {
  const [editorHeight, startResize] = useResizableHeight(220, 72, 4000);
  /** エディタ側の枠 (最大化中の高さを測ってドラッグの開始値にする) */
  const sqlPaneRef = useRef<HTMLDivElement>(null);

  /**
   * 区切り線のドラッグ。
   *
   * 最大化中でも動かせるようにして、そのまま結果欄を出せるようにする
   * (押しただけでは何も変えない。実際に動かしたときだけ最大化をやめる)
   */
  const handleSplitterDown = (e: React.MouseEvent) => {
    if (!editorFull) {
      startResize(e);
      return;
    }
    const shown = sqlPaneRef.current?.getBoundingClientRect().height;
    startResize(e, {
      from: shown ? Math.round(shown) : undefined,
      onStart: () => onChangeOptions({ editorFull: false }),
    });
  };
  /*
   * 実行設定 (トランザクション・キャプチャ・実行対象・EXPLAINの種類・最大化) は
   * タブ側 (WorkTab.editorOpts) で保持する。
   * ここでローカルstateにすると、定義タブへ切り替えて戻ったときに
   * 既定値へ戻ってしまい、ONにしたつもりが効いていない事故につながるため
   */
  const { txn: txnOn, capture: captureOn, explainMode, runScope } = options;
  const editorFull = options.editorFull;
  const [sort, setSort] = useState<SortState | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  /** 関数リファレンスを出しているか */
  const [showFunctions, setShowFunctions] = useState(false);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  /** 直近に保存したファイル (「フォルダを開く」の対象) */
  /** キャプチャの保存先 (「フォルダを開く」用) */
  const [capturePath, setCapturePath] = useState<string | null>(null);
  /**
   * CSV出力 (進捗・結果メッセージ・保存先をまとめて持つ)。
   * 保存先はキャプチャとは別に持つ (取り違えると別のファイルを開いてしまう)
   */
  /**
   * このシートを見分けるキー。
   * タブを切り替えるとこの画面は一度消えるので、
   * 画面の外に置いておく状態 (CSV出力の進捗) をこのキーで結び付ける
   */
  const sheetScope = `${sessionId}:${sheetPane.activeId}`;
  const csv = useCsvExport(sheetScope);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // エディタの右クリックメニューは画面外へ出ないよう位置を補正する
  const [ctxPosRef, ctxStyle] = usePopupPosition<HTMLDivElement>(
    ctxMenu?.x ?? 0,
    ctxMenu?.y ?? 0
  );

  /**
   * 取り返しのつかないSQLが見つかったときの確認待ち。
   *
   * 再開する実行は関数ではなくデータで持つ (何を待っているかが読めるように)。
   * 段階の決め方は queryGuard.ts にある
   */
  const [danger, setDanger] = useState<{
    stmts: DangerousStatement[];
    run: PendingRun;
  } | null>(null);
  /** 全文表示中のセル (カラム名と値) */
  const [cellView, setCellView] = useState<{
    column: string;
    value: string;
    clip: Clip | null;
  } | null>(null);
  /** 直前の実行でキャプチャを要求されたか */
  const captureReq = useRef(false);
  const editorRef = useRef<SqlEditorHandle>(null);
  /**
   * エディタ内検索を開いているか。
   *
   * 開くときに、選んでいた文字を検索語として入れておく
   * (毎回打ち直さなくて済むように)
   */
  const [find, setFind] = useState<{ query: string } | null>(null);

  /**
   * 選んでいる値の並びを、IN句の中身に整える。
   *
   * 表計算やメモから貼った縦並びを、そのままIN句へ入れられる形にする
   */
  const toIn = useCallback((quote: boolean) => {
    const ed = editorRef.current;
    const picked = ed?.getSelectedText();
    if (!ed || !picked) return;
    const out = toInList(picked, { quote });
    // 値が1つも無い (空白だけを選んだ) ときは何もしない
    if (out !== "") ed.replaceSelection(out);
  }, []);

  /** エディタ内検索を開く (虫眼鏡ボタンと ⌘/Ctrl+F から) */
  const openFind = useCallback(() => {
    const picked = editorRef.current?.getSelectedText() ?? "";
    // 複数行を選んでいるときは、それを検索語にしても使い道が無いので入れない
    setFind({ query: picked.includes("\n") ? "" : picked });
  }, []);
  /**
   * 押してから実行を依頼するまでを仕切る門 (二重実行の防止)。
   *
   * 危険判定だけでなく、その手前の「文の分割」を待つ間も閉めておく。
   * Reactの状態ではなく同期的に閉まるものでないと、
   * 描き直しが済むまでの間に届いた2回目を止められない。
   *
   * この画面はタブを切り替えても作り直されないので、門は接続ごとに分ける。
   * 1つにすると、Aの準備を待っている間にBの実行まで止まってしまう
   */
  const gates = useRef(new Map<string, RunGate>());
  const gateOf = (id: string): RunGate => {
    const made = gates.current.get(id);
    if (made) return made;
    const gate = createRunGate();
    gates.current.set(id, gate);
    return gate;
  };
  /** 直近の実行を開始したボタン (スピナーの表示先を決める) */
  const [runSource, setRunSource] = useState<"run" | "explain">("run");
  /** 行番号列を表示するか (設定。実行のたびに読み直す) */
  /** 行番号列を出すか (設定。設定画面や別ウィンドウでの変更に追従する) */
  const appSettings = useWatchedSettings();
  const showRowNums = appSettings.showRowNumbers;


  // 新しい結果が来たら: ソート解除。文の構成が変わった場合のみ最後のタブへ
  // (ページ送りによる差し替えでは選択中のタブを維持する)
  const prevSig = useRef("");
  useEffect(() => {
    setSort(null);
    const sig = results?.map((s) => s.sql).join("␟") ?? "";
    if (sig !== prevSig.current) {
      prevSig.current = sig;
      setActiveIdx(results ? Math.max(0, results.length - 1) : 0);
    }
  }, [results]);

  useEffect(() => {
    setSort(null);
  }, [activeIdx]);

  /** 現在の選択テキストを取得 (なければnull) */
  const selectedText = (): string | null =>
    editorRef.current?.getSelectedText() ?? null;

  /**
   * 実行を押した時点の中身をまとめる。
   *
   * 実行設定は「押した時点」で写し取る。
   * 確認を挟むと実行までに間が空くので、そこで設定が変わっても
   * 押したときのつもりで走らせる (これまでの動きと同じ)
   */
  const pendingOf = (
    text: string,
    ticket: RunTicket,
    explain?: "explain" | "analyze"
  ): PendingRun => ({
    ticket,
    sql: text,
    // 実行計画は取り消せないものを含まないので、包まない (今までどおり)
    transaction: explain ? false : txnOn,
    capture: captureOn,
    explain,
  });

  /** 実行の本体 (キャプチャ要求も記録) */
  const exec = (run: PendingRun) => {
    captureReq.current = run.capture;
    setCaptureMsg(null);
    onRun(0, run.sql, run.transaction, run.explain, run.ticket);
  };

  /**
   * 実行を1回ぶん進める。
   *
   * 流す文を決めるところから実行を依頼するまでを門で仕切る。
   * 通常の実行・EXPLAINとも同じここを通す (同じ対象への受付を1つに保つ)。
   * 手順そのものは runRequest.ts にある
   */
  const begin = (
    pick: (ticket: RunTicket) => Promise<PendingRun | null>,
    /** 危険SQLの確認を挟むか (EXPLAINは元々挟まない) */
    guard = true
  ) =>
    void startRun(gateOf(sessionId), {
      accept: onAcceptRun,
      pick,
      check: guard
        ? (text) => checkDangerousSql(sessionId, text, dbType)
        : undefined,
      exec,
      confirm: (stmts, run) => setDanger({ stmts, run }),
    });

  /**
   * 確認の返事。
   *
   * 続けるなら、待たせていた実行をそのまま走らせる。
   * やめるなら何も走らせない (どちらも確認待ちは閉じる)
   */
  const answerDanger = (ok: boolean) => {
    const go = afterConfirm(danger?.run ?? null, ok);
    setDanger(null);
    if (go) exec(go);
  };

  /**
   * カーソルのある文を探す。
   *
   * 区切り方は接続の方言で決まるのでバックエンドに聞く。
   * 分けられなかったときは null (呼び出し側で全体を流す)
   */
  /**
   * 文ごとに分けた範囲 (エディタに帯を敷くために使う)。
   *
   * 打つたびに分け直すと重いので少し待ってから求める。
   * 実行そのものはこの値を使わず、そのつど分け直す
   * (待っている間に押されても、走る範囲がずれないようにするため)
   */
  const [spans, setSpans] = useState<SqlSpan[]>([]);
  useEffect(() => {
    // `;` が無ければ必ず1文なので、問い合わせるまでもない
    if (!sql.includes(";")) {
      setSpans([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      splitSqlStatements(sessionId, sql, dbType)
        .then((stmts) => {
          if (alive) setSpans(spansOf(sql, stmts));
        })
        .catch(() => {
          if (alive) setSpans([]);
        });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [sql, sessionId, dbType]);

  /** 実行ボタンが流す文 (何文目 / 全部で何文。対象なしは -1) */
  const [target, setTarget] = useState({ index: -1, total: 0 });

  const statementAtCursor = async () => {
    try {
      const stmts = await splitSqlStatements(sessionId, sql, dbType);
      const spans = spansOf(sql, stmts);
      // 1文しか無いなら、わざわざ光らせず全体として扱う
      if (spans.length <= 1) return null;
      return spanAt(spans, editorRef.current?.getCursor() ?? 0);
    } catch {
      return null;
    }
  };

  /**
   * 書いてあるSQLを全部まとめて実行する。
   *
   * 実行ボタンで「全体実行」を選んでいるときと、
   * 範囲の設定にかかわらず全部を流したいとき (⌘⇧Enter) の両方から呼ぶ
   */
  const runAll = () => {
    if (running || !sql.trim()) return;
    setRunSource("run");
    begin(async (ticket) => pendingOf(sql, ticket));
  };

  /**
   * 実行 (実行ボタン / ⌘Enter)。
   *
   * 流す範囲は実行ボタンの ▾ で選んだもの。
   *  - 全体実行 … 書いてあるSQLを全部
   *  - 部分実行 … 選択があればその部分、無ければカーソルのある文だけ
   *
   * どちらを選んでいるかはボタンの文字と、エディタの帯に出る
   */
  const run = () => {
    if (running) return;
    if (runScope === "all") {
      runAll();
      return;
    }
    setRunSource("run");
    begin(async (ticket) => {
      const picked = selectedText();
      if (picked?.trim()) return pendingOf(picked, ticket);
      if (!sql.trim()) return null;
      // ここで文の分割を待つ。待っている間、門は閉じたまま
      const stmt = await statementAtCursor();
      // 分けられない・1文だけのときは、そのまま全部流す
      if (!stmt) return pendingOf(sql, ticket);
      // 何が走ったか分かるよう、実行した文を短い間だけ光らせる
      editorRef.current?.flashRange(stmt.from, stmt.to);
      // 判定に掛けた文をそのまま実行する
      // (確認している間にエディタが変わっても、別の文が走らないように)
      return pendingOf(stmt.text, ticket);
    });
  };

  // 実行完了後にキャプチャを保存する
  useEffect(() => {
    if (running || !captureReq.current) return;
    captureReq.current = false;
    if (!results?.length) return;
    setCaptureMsg("キャプチャ保存中...");
    setCapturePath(null);
    captureResults(results)
      .then((paths) => {
        setCaptureMsg(`キャプチャ保存: ${paths.length}件 → ${paths[0] ?? ""}`);
        setCapturePath(paths[0] ?? null);
      })
      .catch((e) => setCaptureMsg(`キャプチャ失敗: ${e}`));
  }, [running, results]);

  // エディタの右クリックメニューは外側クリックで閉じる。
  // 他のメニューを開いたときにも閉じるよう、キャプチャ段階で
  // 自分の領域外かどうかを判定する (stopPropagationの影響を受けない)
  useDismiss(!!ctxMenu, () => setCtxMenu(null), {
    capture: true,
    ref: ctxMenuRef,
  });

  const handleFormat = () => {
    if (!sql.trim()) return;
    setFormatError(null);
    try {
      onChangeSql(formatSql(sql, dbType, appSettings.sqlFormat));
    } catch (e) {
      // 構文が不完全で整形できない場合はエラーの要点を表示する
      setFormatError(formatErrorMessage(e));
    }
  };

  /**
   * EXPLAIN / EXPLAIN ANALYZE を実行 (選択があれば選択部分)。
   *
   * 通常の実行と同じ門・同じ受付番号を通す。
   * 片方の応答待ちにもう片方が始まると、結果や説明の種類が
   * 上書きし合ってしまうため。
   * 危険SQLの確認は元々通らないので、ここでも挟まない
   */
  const runExplain = (mode: "explain" | "analyze") => {
    if (running || !sql.trim()) return;
    setRunSource("explain");
    begin(async (ticket) => {
      const text = selectedText();
      return pendingOf(text?.trim() ? text : sql, ticket, mode);
    }, false);
  };

  /** EXPLAIN の種類を選べるDBか (SQLiteは EXPLAIN QUERY PLAN のみ) */
  const hasExplainModes = dbType !== "sqlite";

  const active = results?.[activeIdx] ?? null;
  const result = active?.result ?? null;

  /** グラフの画面を出しているか */
  const [charting, setCharting] = useState(false);
  /** 表として扱える結果か (実行完了メッセージや実行計画は対象外) */
  const isTable =
    !!result && !isExecResult(result) && !isPlanResult(result.columns);
  /** 数値の列が1つも無い結果はグラフにできない */
  const canChart =
    isTable &&
    !!result &&
    result.rows.length > 0 &&
    numericColumns(result.columns, result.rows).length > 0;

  /** 表示中の結果タブをファイルへ書き出す */
  const handleExport = (format: ExportFormat) => {
    if (!active || csv.job || running) return;
    /*
     * 実行計画はSQLを流し直せない。
     * 画面が持っているのは EXPLAIN の結果なので、流し直すと
     * 元のSQLが走って「計画ではなくデータ」が出てしまう
     */
    if (explainKind) {
      void csv.savePlan(result, activeIdx);
      return;
    }
    csv.start({
      sessionId,
      database,
      sql: active.sql,
      orderBy: result?.orderBy,
      orderDir: result?.orderDir,
      // 進捗・結果はこの結果タブでのみ表示する
      index: activeIdx,
      format,
    });
  };

  /**
   * 書いてあるSQLを .sql として保存する。
   *
   * 保存先はダイアログで選んでもらう (お気に入りへの保存 ⌘S とは別物)。
   * 既定の名前はシート名から作る
   */
  const saveSqlToFile = async (sheetId?: string) => {
    const id = sheetId ?? sheetPane.activeId;
    const sheet = sheetPane.sheets.find((x) => x.id === id);
    // 表示中のシートは書きかけが props の sql に来るので、そちらを優先する
    const text = id === sheetPane.activeId ? sql : (sheet?.sql ?? "");
    if (!text.trim()) return;
    const base = (sheet?.title || autoTitle(text)).replace(/[\\/:*?"<>|]/g, "_");
    const got = await saveDialog({
      defaultPath: `${base}.sql`,
      filters: [{ name: "SQL", extensions: ["sql", "txt"] }],
      title: "SQLをファイルに保存",
    }).catch(() => null);
    if (typeof got !== "string") return;
    try {
      await saveTextAs(got, text);
      // 書き出しの知らせはキャプチャと同じ場所に出す (「表示」ボタンも付く)
      setCaptureMsg("SQLを保存しました");
      setCapturePath(got);
    } catch (e) {
      setActionError(String(e));
    }
  };

  /** 道具まわり (CSVエディタ・ファイル保存) が失敗したときの知らせ */
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * 結果をCSVエディタのタブとして開く。
   *
   * 画面は1000行ずつしか持っていないので、全件はRust側で流し直す
   * (CSV出力と同じ道を通るので、ページングのLIMITは付かない)。
   * 実行計画だけは流し直すと本体のSQLが走ってしまうので、画面の内容を渡す
   */
  const openInCsvEditor = () => {
    if (!result || isExecResult(result) || !active) return;
    const name = `結果 ${statementLabel(active.sql, activeIdx)}`;
    if (explainKind) {
      setActionError(null);
      void csvFromRows(name, result.columns, result.rows)
        .then((info) => openCsvWindow({ docId: info.docId }))
        .catch((e) => setActionError(`CSVエディタを開けませんでした: ${e}`));
      return;
    }
    void csv.openInEditor({
      sessionId,
      database,
      sql: active.sql,
      orderBy: result.orderBy,
      orderDir: result.orderDir,
      index: activeIdx,
      name,
    });
  };

  /**
   * 全部で何件あるかを数える。
   *
   * ページングでは先頭1000行しか出ないので、総数は別に数えないと分からない。
   * 数えるのは押されたときだけ (重いSQLで毎回数えると実行が遅くなるため)
   */
  const [counting, setCounting] = useState(false);
  /** 数えた結果 (どの結果タブのものかを持つ) */
  const [counted, setCounted] = useState<{
    index: number;
    total: number;
  } | null>(null);

  // 実行し直したら数え直し (前の結果の件数を出したままにしない)
  useEffect(() => setCounted(null), [results]);

  const countRows = () => {
    if (!active || counting) return;
    setCounting(true);
    setActionError(null);
    const at = activeIdx;
    void countQueryRows(sessionId, database ?? null, active.sql)
      .then((total) => setCounted({ index: at, total }))
      .catch((e) => setActionError(`件数を数えられませんでした: ${e}`))
      .finally(() => setCounting(false));
  };

  /**
   * 表示中のページの値から見分けた列の種類。
   * 結果は型を持っていないので、右寄せ・色はここから決める
   */
  const colKinds = useMemo(
    () => columnKinds(result?.rows ?? [], result?.columns.length ?? 0),
    [result]
  );

  const gridColumns: GridColumn[] = useMemo(() => {
    const cols: GridColumn[] = (result?.columns ?? []).map((name, i) => ({
      id: `c${i}`,
      label: name,
      width: Math.min(260, Math.max(90, name.length * 10 + 40)),
      minWidth: 60,
      align: kindAlign(colKinds[i] ?? "text"),
      cellClass: kindClass(colKinds[i] ?? "text"),
      // EXPLAIN結果ならカラムの意味を、通常の結果なら
      // 定義から読み取った論理名・補足をヘッダのツールチップに出す
      description: explainKind
        ? EXPLAIN_COL_DESC[name.toLowerCase()]
        : columnTips[name.toLowerCase()],
    }));
    if (showRowNums && cols.length > 0) {
      // 表示中の最大行番号に合わせて幅を決める
      const maxNum = (result?.offset ?? 0) + (result?.rows.length ?? 0);
      const width = Math.max(58, String(maxNum).length * 9 + 36);
      cols.unshift({
        id: "__row",
        label: "行",
        width,
        minWidth: 46,
        align: "right",
        cellClass: "rownum-cell",
        sortable: false,
        excludeFromCopy: true,
        description: "行番号 (取得結果の通し番号。データの値ではありません)",
      });
    }
    return cols;
  }, [result, showRowNums, explainKind, columnTips, colKinds]);

  /**
   * ヘッダのソートメニューでの選択。
   * ページング可能な結果はサーバーサイドソート(その文を再実行)、
   * それ以外は表示中の行のクライアントソート。
   */
  /*
   * 結果の表示 (QueryResultView) は React.memo で包んであるので、
   * 渡す関数は毎回作り直さない。
   * そうしないと、スプリッタのドラッグやCSVの進捗表示のたびに
   * 200行のグリッドまで描き直しになる
   */
  const selectSortRef = useRef((_id: string, _dir: SortDir) => {});
  selectSortRef.current = (id: string, dir: SortDir) => {
    if (id === "__row") return;
    if (result?.pageable) {
      const colName = result.columns[Number(id.slice(1))];
      if (!colName || running) return;
      onServerSort(activeIdx, dir ? colName : null, dir ?? "asc");
      return;
    }
    setSort(dir ? { id, dir } : null);
  };
  const selectSort = useCallback(
    (id: string, dir: SortDir) => selectSortRef.current(id, dir),
    []
  );

  /** グリッドに表示するソート状態 (サーバーソート優先) */
  const gridSort: SortState | null = useMemo(() => {
    if (result?.pageable) {
      if (!result.orderBy) return null;
      const idx = result.columns.indexOf(result.orderBy);
      if (idx < 0) return null;
      return { id: `c${idx}`, dir: result.orderDir === "desc" ? "desc" : "asc" };
    }
    return sort;
  }, [result, sort]);

  /** ソート適用済みの行 (サーバーソート時はそのまま表示) */
  const sortedRows = useMemo(() => {
    const rows = (result?.rows ?? []).map((cells, index) => ({ cells, index }));
    if (result?.pageable || !sort) return rows;
    const col = Number(sort.id.slice(1));
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort(
      (a, b) => sign * compareCells(a.cells[col], b.cells[col])
    );
  }, [result, sort]);

  /*
   * グリッドに渡す行。
   * 実行中の経過時間やCSVの進捗で再描画がかかるため、
   * メモ化しておかないと1000行ぶんの要素を毎秒何度も作り直すことになる
   */
  /** カラム番号から見出しの名前を引く (セルの全文表示に使う) */
  const columnLabel = (i: number) => result?.columns[i] ?? `列${i + 1}`;

  /** 切り詰められたセルを (行, 列) から引く */
  const clipAt = useMemo(() => clipIndex(result?.clipped), [result]);
  /** 切り詰められた値がある行 (コピーの注記に使う) */
  const clippedRows = useMemo(() => clippedRowKeys(result?.clipped), [result]);

  /*
   * コピー用の元の値。
   *
   * 以前は「画面に描いていない行はコピーできない」ため、
   * コピーの直前に1000行ぶんを一度に描き足していた (その間、画面が固まる)。
   * 表に出しているのと同じ値をここから直接渡す
   */
  const rowValueOf = useMemo(() => {
    const byKey = new Map(sortedRows.map((r) => [String(r.index), r.cells]));
    return (key: string) => {
      const cells = byKey.get(key);
      if (!cells) return undefined;
      // 行番号の列はコピー対象外なので、位置合わせの空文字を置く
      return showRowNums ? ["", ...cells] : cells;
    };
  }, [sortedRows, showRowNums]);

  const gridRows: GridRow[] = useMemo(
    () =>
      sortedRows.map((r) => {
        const cells = r.cells.map((v, i) =>
          v === null ? (
            <span className="null-cell">NULL</span>
          ) : (
            <CellText
              value={v}
              clip={clipAt(r.index, i)}
              onOpen={(value) =>
                setCellView({
                  column: columnLabel(i),
                  value,
                  clip: clipAt(r.index, i),
                })
              }
            />
          )
        );
        if (showRowNums) {
          cells.unshift(
            <span className="mono row-num">
              {(result?.offset ?? 0) + r.index + 1}
            </span>
          );
        }
        return { key: String(r.index), cells };
      }),
    // セルの中身はこの4つで決まる (表示のための関数は依存に入れない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedRows, showRowNums, result?.offset, result?.columns]
  );

  return (
    <div className={"query-panel" + (editorFull ? " editor-full" : "")}>
      <SheetTabs
        sheets={sheetPane.sheets}
        activeId={sheetPane.activeId}
        running={running}
        onSelect={sheetPane.onSelect}
        onAdd={sheetPane.onAdd}
        onCloseOthers={sheetPane.onCloseOthers}
        onCloseAll={sheetPane.onCloseAll}
        onSaveFile={(id) => void saveSqlToFile(id)}
        onClose={sheetPane.onClose}
        onRename={sheetPane.onRename}
        onFormat={handleFormat}
        onFunctions={() => setShowFunctions(true)}
        canFormat={sql.trim() !== ""}
      />

      {/* エディタ (最大化中は残りの高さいっぱいに広げる) */}
      <div
        className="sql-editor"
        ref={sqlPaneRef}
        style={editorFull ? undefined : { height: editorHeight }}
      >
        <SqlEditor
          /*
           * シート (と接続タブ) が変わったらエディタを作り直す。
           * 本文を差し替えるだけだと取り消し履歴が残り、
           * 切り替えた直後の ⌘Z で前のシートの内容が入ってしまう
           */
          key={`${sessionId}:${sheetPane.activeId}`}
          ref={editorRef}
          value={sql}
          dbType={dbType}
          placeholder="SELECT * FROM ...  (複数のSQLは ; で区切って記述できます)"
          onChange={onChangeSql}
          onRun={run}
          onRunSelection={runAll}
          onSelectionChange={setHasSelection}
          onSaveFile={() => void saveSqlToFile()}
          onFunctions={() => setShowFunctions(true)}
          onFind={openFind}
          statements={runScope === "all" ? EMPTY_SPANS : spans}
          onTarget={(index, total) =>
            setTarget((prev) =>
              prev.index === index && prev.total === total
                ? prev
                : { index, total }
            )
          }
          onContextMenu={(x, y) => setCtxMenu({ x, y })}
        onFormat={handleFormat}
          schema={schema}
          autocomplete={autocomplete}
          autocompleteDelayMs={autocompleteDelayMs}
          // 整形の「字下げ」は、エディタのTabや改行の字下げにも使う
          indent={appSettings.sqlFormat.indent}
        />
        {/* エディタの中だけを探す (⌘/Ctrl+F)。開いている間はボタンを隠す */}
        {!find && (
          <button
            className="editor-find-btn has-tooltip tooltip-left"
            data-tooltip={`エディタ内を検索・置換 (${MOD}F)`}
            aria-label="エディタ内を検索・置換"
            // 押しても入力位置 (カーソル) を失わないようにする
            onMouseDown={(e) => e.preventDefault()}
            onClick={openFind}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
            >
              <circle
                cx="11"
                cy="11"
                r="6.2"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M15.6 15.6 20 20"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}

        {find && (
          <SqlFindBar
            editor={editorRef}
            sql={sql}
            initialQuery={find.query}
            onClose={() => setFind(null)}
          />
        )}

        {/* エディタを画面いっぱいに広げる / 元に戻す (アイコンは開閉で反転) */}
        <button
          className={"editor-size-btn" + (editorFull ? " on" : "")}
          title={
            editorFull ? "結果欄を表示する" : "SQLエディタを画面いっぱいに広げる"
          }
          aria-label={
            editorFull ? "結果欄を表示する" : "SQLエディタを画面いっぱいに広げる"
          }
          // 押しても入力位置 (カーソル) を失わないようにする
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChangeOptions({ editorFull: !editorFull })}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M7 10.5 12 15.5l5-5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M6 19.5h12"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              opacity="0.55"
            />
          </svg>
        </button>
      </div>

      {/* エディタの右クリックメニュー */}
      {ctxMenu && (
        <div
          className="context-menu"
          ref={(el) => {
            ctxMenuRef.current = el;
            ctxPosRef.current = el;
          }}
          style={ctxStyle}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="context-item has-key"
            disabled={!sql.trim()}
            onClick={() => {
              setCtxMenu(null);
              handleFormat();
            }}
          >
            SQLを整形 (カンマ先頭)
            <span className="context-key">{`${MOD}${SHIFT}F`}</span>
          </button>
          <div className="context-sep" aria-hidden />
          {/*
            * 選んだ値の並びをIN句の形にする。
            * 選んでいないと何を整えるか決まらないので、そのときは押せない
            */}
          <button
            className="context-item"
            disabled={!hasSelection}
            onClick={() => {
              setCtxMenu(null);
              toIn(true);
            }}
          >
            選択をIN句の形に ('値', で囲む)
          </button>
          <button
            className="context-item"
            disabled={!hasSelection}
            onClick={() => {
              setCtxMenu(null);
              toIn(false);
            }}
          >
            選択をIN句の形に (値, のまま)
          </button>
          <div className="context-sep" aria-hidden />
          <button
            className="context-item has-key"
            onClick={() => {
              setCtxMenu(null);
              setShowFunctions(true);
            }}
          >
            関数リファレンス...
            <span className="context-key">{`${MOD}${SHIFT}H`}</span>
          </button>
          <div className="context-sep" aria-hidden />
          <button
            className="context-item has-key"
            disabled={!sql.trim()}
            onClick={() => {
              setCtxMenu(null);
              void saveSqlToFile();
            }}
          >
            SQLをファイルに保存...
            <span className="context-key">{`${MOD}${SHIFT}S`}</span>
          </button>
        </div>
      )}

      <QueryToolbar
        sql={sql}
        hasSelection={hasSelection}
        running={running}
        runSource={runSource}
        runStartedAt={runStartedAt}
        explainMode={explainMode}
        hasExplainModes={hasExplainModes}
        statementIndex={target.index}
        statementCount={target.total}
        runScope={runScope}
        txnOn={txnOn}
        captureOn={captureOn}
        formatError={formatError}
        captureMsg={captureMsg}
        capturePath={capturePath}
        onRun={run}
        onExplain={runExplain}
        onCancel={onCancel}
        onChangeSql={onChangeSql}
        onChangeOptions={onChangeOptions}
      />

      {showFunctions && (
        <SqlFunctionsDialog
          dbType={dbType}
          onInsert={(text) => {
            editorRef.current?.insertAtCursor(text);
            setShowFunctions(false);
          }}
          onClose={() => setShowFunctions(false)}
        />
      )}

      <div
        className="row-splitter"
        title="ドラッグで高さを変更"
        onMouseDown={handleSplitterDown}
      >
        <span className="grip" aria-hidden />
      </div>

      {results && results.length > 0 && (
        <QueryResultBar
          results={results}
          activeIdx={activeIdx}
          onSelectTab={setActiveIdx}
          result={result}
          running={running}
          explainKind={explainKind}
          csv={csv}
          onExport={handleExport}
          onOpenInEditor={openInCsvEditor}
          counting={counting}
          totalRows={counted?.index === activeIdx ? counted.total : null}
          onCount={countRows}
          onPage={onPage}
          canChart={canChart}
          onOpenChart={() => setCharting(true)}
        />
      )}

      <QueryResultView
        result={result}
        error={actionError ?? error}
        columns={gridColumns}
        rows={gridRows}
        rowValues={rowValueOf}
        clippedRowKeys={clippedRows}
        sort={gridSort}
        onSortSelect={selectSort}
        // 実行・結果タブの切替・シートの切替のたびに列幅を測り直す
        // (シートIDを入れないと、別シートの結果に前の幅と選択が残る)
        fitKey={`${sheetPane.activeId}:${runStartedAt ?? 0}:${activeIdx}`}
      />

      {charting && result && (
        <ResultChart
          columns={result.columns}
          rows={result.rows}
          onClose={() => setCharting(false)}
        />
      )}

      {cellView && (
        <CellDetail
          column={cellView.column}
          value={cellView.value}
          clip={cellView.clip}
          onClose={() => setCellView(null)}
        />
      )}

      {danger && (
        <DangerousSqlConfirm
          statements={danger.stmts}
          /*
           * 接続名・DB名・DB種別・トランザクションは、
           * 画面の今の値ではなく実行に使う受付票から取る。
           * 判定を待つ間に別の接続へ切り替えられても、
           * 見せている相手と実際に走る相手が食い違わない
           */
          {...confirmTarget(danger.run)}
          onCancel={() => answerDanger(false)}
          onConfirm={() => answerDanger(true)}
        />
      )}
    </div>
  );
}
