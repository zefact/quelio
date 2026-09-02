import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatErrorMessage, formatSql } from "../sqlFormat";
import { MOD, SHIFT } from "../keyLabel";
import { checkDangerousSql, splitSqlStatements } from "../api";
import { captureResults } from "../capture";
import { CellDetail } from "./CellDetail";
import type { Clip } from "../cellValue";
import { clipIndex, clippedRowKeys } from "../cellValue";
import { spanAt, spansOf } from "../sqlSpans";
import { columnKinds, kindAlign, kindClass } from "../cellKind";
import { CellText } from "./CellText";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { useResizableHeight } from "../hooks/useResizableHeight";
import type {
  DangerousStatement,
  DbType,
  EditorOptions,
  QueryResult,
  StatementResult,
} from "../types";
import type { ExportFormat } from "../exportFormat";
import { isExecResult, statementLabel } from "./queryResult";
import { isPlanResult } from "./PlanView";
import { useWatchedSettings } from "../hooks/useWatchedSettings";
import { SheetTabs } from "./SheetTabs";
import type { SchemaMap } from "./sqlCompletion";
import { DangerousSqlConfirm } from "./DangerousSqlConfirm";
import type {
  GridColumn,
  GridRow,
  SortDir,
  SortState,
} from "./ResizableGrid";
import { QueryToolbar } from "./QueryToolbar";
import { QueryResultBar } from "./QueryResultBar";
import { QueryResultView } from "./QueryResultView";
import { ResultCompare, toComparePane } from "./ResultCompare";
import { ResultChart } from "./ResultChart";
import { numericColumns } from "../chart/chartData";
import { SqlEditor, SqlEditorHandle } from "./SqlEditor";
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
  connectionName: string;
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
  /** offset行目からの実行。sqlOverride指定時は選択実行、transactionでBEGIN〜COMMIT/ROLLBACKに包む */
  onRun: (
    offset: number,
    sqlOverride?: string,
    transaction?: boolean,
    explain?: "explain" | "analyze"
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
  connectionName,
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
  const { txn: txnOn, capture: captureOn, explainMode } = options;
  const editorFull = options.editorFull;
  const [sort, setSort] = useState<SortState | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
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
   * 確認して初めて実行する (goを呼ぶ)
   */
  const [danger, setDanger] = useState<{
    stmts: DangerousStatement[];
    go: () => void;
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
  /** 危険SQLの判定中か (二重実行の防止) */
  const guarding = useRef(false);
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
   * 実行前に、取り返しのつかないSQL (DROP・WHERE無しのUPDATE等) が無いか調べる。
   * 見つかったら確認ダイアログを出し、確認できたら exec を呼ぶ。
   * 調べられなかった場合は、実行を止めずにそのまま進める
   */
  const guardRun = async (text: string, proceed: () => void) => {
    // 判定の往復を待つ間はまだ running=false なので、自前で二重実行を止める
    if (guarding.current) return;
    guarding.current = true;
    try {
      const stmts = await checkDangerousSql(sessionId, text, dbType);
      if (stmts.length > 0) {
        setDanger({ stmts, go: proceed });
        return;
      }
    } catch {
      /* 判定できないときは通常どおり実行する */
    } finally {
      guarding.current = false;
    }
    proceed();
  };

  /** 実行の本体 (キャプチャ要求も記録) */
  const exec = (text?: string) => {
    captureReq.current = captureOn;
    setCaptureMsg(null);
    onRun(0, text, txnOn);
  };

  /**
   * カーソルのある文を探す。
   *
   * 区切り方は接続の方言で決まるのでバックエンドに聞く。
   * 分けられなかったときは null (呼び出し側で全体を流す)
   */
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
   * 実行 (実行ボタン / ⌘Enter)。
   *
   * 選択があればその部分、無ければカーソルのある文だけを流す。
   * 「実行対象」を切り替えてから実行する作りだと、
   * 戻し忘れて意図しない範囲が走る・無反応になる、が起きていた
   */
  const run = async () => {
    if (running) return;
    const picked = selectedText();
    if (picked?.trim()) {
      setRunSource("run");
      void guardRun(picked, () => exec(picked));
      return;
    }
    if (!sql.trim()) return;
    const stmt = await statementAtCursor();
    setRunSource("run");
    if (!stmt) {
      // 分けられない・1文だけのときは、そのまま全部流す
      void guardRun(sql, () => exec(sql));
      return;
    }
    // 何が走ったか分かるよう、実行した文を短い間だけ光らせる
    editorRef.current?.flashRange(stmt.from, stmt.to);
    // 判定に掛けた文をそのまま実行する
    // (確認している間にエディタが変わっても、別の文が走らないように)
    void guardRun(stmt.text, () => exec(stmt.text));
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

  /** EXPLAIN / EXPLAIN ANALYZE を実行 (選択があれば選択部分) */
  const runExplain = (mode: "explain" | "analyze") => {
    if (running || !sql.trim()) return;
    setRunSource("explain");
    captureReq.current = captureOn;
    setCaptureMsg(null);
    const text = selectedText();
    onRun(0, text?.trim() ? text : undefined, false, mode);
  };

/** ⌘/Ctrl+Shift+Enter: 書いてあるSQLを全部まとめて実行する */
  const runAll = () => {
    if (running || !sql.trim()) return;
    setRunSource("run");
    void guardRun(sql, () => exec(sql));
  };

  /** EXPLAIN の種類を選べるDBか (SQLiteは EXPLAIN QUERY PLAN のみ) */
  const hasExplainModes = dbType !== "sqlite";

  const active = results?.[activeIdx] ?? null;
  const result = active?.result ?? null;

  /*
   * 取っておいた結果 (ピン留め)。
   *
   * 実行のたびに結果が流れてしまうので、直す前の結果を残せるようにする。
   * 接続タブ・シートをまたいで見えてしまわないよう、どこで留めたかを持つ
   */
  const [pinned, setPinned] = useState<{
    scope: string;
    label: string;
    sql: string;
    result: QueryResult;
  } | null>(null);
  const [comparing, setComparing] = useState(false);
  /** グラフの画面を出しているか */
  const [charting, setCharting] = useState(false);
  /** 今のシートのピン留め (別のシートのものは出さない) */
  const pinHere = pinned?.scope === sheetScope ? pinned : null;
  /** 表になる結果だけ見比べられる (実行完了メッセージや実行計画は対象外) */
  const canPin =
    !!result && !isExecResult(result) && !isPlanResult(result.columns);
  const compareOn = comparing && pinHere !== null && canPin;
  /** 数値の列が1つも無い結果はグラフにできない */
  const canChart =
    canPin &&
    !!result &&
    result.rows.length > 0 &&
    numericColumns(result.columns, result.rows).length > 0;

  const pinCurrent = () => {
    if (!active || !result || !canPin) return;
    const t = new Date();
    const p2 = (v: number) => String(v).padStart(2, "0");
    setPinned({
      scope: sheetScope,
      label: `${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())} ${statementLabel(active.sql, activeIdx)}`,
      sql: active.sql,
      result,
    });
    setComparing(true);
  };

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
        onClose={sheetPane.onClose}
        onRename={sheetPane.onRename}
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
          onRun={() => void run()}
          onRunSelection={runAll}
          onSelectionChange={setHasSelection}
          onContextMenu={(x, y) => setCtxMenu({ x, y })}
        onFormat={handleFormat}
          schema={schema}
          autocomplete={autocomplete}
          autocompleteDelayMs={autocompleteDelayMs}
          // 整形の「字下げ」は、エディタのTabや改行の字下げにも使う
          indent={appSettings.sqlFormat.indent}
        />
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
        txnOn={txnOn}
        captureOn={captureOn}
        formatError={formatError}
        captureMsg={captureMsg}
        capturePath={capturePath}
        onRun={() => void run()}
        onRunAll={runAll}
        onExplain={runExplain}
        onCancel={onCancel}
        onChangeSql={onChangeSql}
        onFormat={handleFormat}
        onChangeOptions={onChangeOptions}
      />

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
          onPage={onPage}
          canPin={canPin}
          pinnedLabel={pinHere?.label ?? null}
          comparing={compareOn}
          onPin={pinCurrent}
          onUnpin={() => {
            setPinned(null);
            setComparing(false);
          }}
          onToggleCompare={() => setComparing((v) => !v)}
          canChart={canChart}
          onOpenChart={() => setCharting(true)}
        />
      )}

      {compareOn && pinHere && result ? (
        <ResultCompare
          left={toComparePane(pinHere.label, pinHere.sql, pinHere.result)}
          right={toComparePane(
            active ? statementLabel(active.sql, activeIdx) : "今の結果",
            active?.sql ?? "",
            result
          )}
        />
      ) : (
      <QueryResultView
        result={result}
        error={error}
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
      )}

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
          connection={connectionName}
          database={database}
          transaction={txnOn}
          dbType={dbType}
          onCancel={() => setDanger(null)}
          onConfirm={() => {
            const go = danger.go;
            setDanger(null);
            go();
          }}
        />
      )}
    </div>
  );
}
