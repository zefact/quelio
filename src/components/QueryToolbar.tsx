import { ElapsedTimer } from "./ElapsedTimer";
import { RevealButton } from "./RevealButton";
import { RunSplitButton, type RunSplitOption } from "./RunSplitButton";
import { SqlLibraryMenu } from "./sqlLibrary/SqlLibraryMenu";
import { ToggleButton } from "./ToggleButton";
import type { EditorOptions } from "../types";
import { MOD, SHIFT } from "../keyLabel";

/**
 * 実行ボタンが流す範囲。
 *
 * 選んだ範囲は設定として覚えておく (全タブ共通・アプリを閉じても残る)。
 * どちらを選んでいるかはボタンの文字にそのまま出るので、
 * 「戻し忘れて意図しない範囲が走る」ことにはならない
 */
const RUN_SCOPES: readonly RunSplitOption<"here" | "all">[] = [
  { value: "here", label: "部分実行 (選択 / カーソルのある文)" },
  { value: "all", label: "全体実行 (書いてあるSQL全部)" },
];

/** EXPLAINの種類 */
const EXPLAIN_MODES: readonly RunSplitOption<"explain" | "analyze">[] = [
  { value: "explain", label: "EXPLAIN (実行計画のみ表示)" },
  {
    value: "analyze",
    label: "EXPLAIN ANALYZE (SQLを実際に実行して実測。更新系は本当に書き換わります)",
  },
];

/**
 * 実行ボタンの文字。
 *
 * 「押したら何が走るか」がボタン自身から分かるようにする
 * (エディタ側では、走る文に帯を敷いて範囲そのものを見せている)
 */
function runLabel(
  scope: "here" | "all",
  hasSelection: boolean,
  index: number,
  count: number
): string {
  // どちらを選んでいるかが常に分かるよう、範囲の名前を必ず頭に出す
  if (scope === "all") return "全体実行";
  if (hasSelection) return "部分実行 (選択)";
  if (count >= 2 && index >= 0) return `部分実行 (${index + 1}/${count})`;
  return "部分実行";
}

/** 実行ボタンの説明 */
function runTitle(
  scope: "here" | "all",
  hasSelection: boolean,
  index: number,
  count: number
): string {
  if (scope === "all") return "書いてあるSQLを全部まとめて実行します";
  if (hasSelection) return "選択した部分を実行します";
  if (count >= 2 && index >= 0) {
    return `カーソルのある${index + 1}文目だけを実行します`;
  }
  return "書いてあるSQLを実行します";
}

interface Props {
  sql: string;
  /** エディタで文字を選択しているか (選択実行の可否) */
  hasSelection: boolean;
  running: boolean;
  /** 直近の実行を始めたボタン (スピナーの表示先) */
  runSource: "run" | "explain";
  /** 実行ボタンが流す文が何文目か (0始まり。選択中・1文だけのときは -1) */
  statementIndex: number;
  /** 書いてある文の数 */
  statementCount: number;
  /** 実行ボタンが流す範囲 */
  runScope: "here" | "all";
  /** 実行ボタンが流す範囲を選び直す (設定として保存する) */
  onChangeRunScope: (scope: "here" | "all") => void;
  runStartedAt: number | null;
  explainMode: "explain" | "analyze";
  /** EXPLAINの種類を選べるか (SQLiteは1種類しかない) */
  hasExplainModes: boolean;
  txnOn: boolean;
  captureOn: boolean;
  /** SQLの整形に失敗したときの理由 */
  formatError: string | null;
  /** キャプチャの結果メッセージと保存先 */
  captureMsg: string | null;
  capturePath: string | null;
  onRun: () => void;
  /** 書いてあるSQLを全部実行する (▾ と ⌘⇧Enter) */
  onExplain: (mode: "explain" | "analyze") => void;
  onCancel: () => void;
  onChangeSql: (sql: string) => void;
  onChangeOptions: (patch: Partial<EditorOptions>) => void;
}

/** SQLエディタの下の操作列 (実行 / EXPLAIN / 履歴 / トランザクションとキャプチャのスイッチ) */
export function QueryToolbar({
  sql,
  hasSelection,
  running,
  runSource,
  statementIndex,
  statementCount,
  runScope,
  onChangeRunScope,
  runStartedAt,
  explainMode,
  hasExplainModes,
  txnOn,
  captureOn,
  formatError,
  captureMsg,
  capturePath,
  onRun,
  onExplain,
  onCancel,
  onChangeSql,
  onChangeOptions,
}: Props) {
  return (
    <div className="query-actions">
      {/*
        実行中は、実行ボタンの位置に「中止」を出す
        (止めたいときに目で探さなくて済むように)
      */}
      {running ? (
        <button
          className="btn-secondary cancel-query-btn run-cancel-btn has-tooltip tooltip-left"
          onClick={onCancel}
          data-tooltip="実行中のSQLを中止します (接続は切れません)"
        >
          <span className="spinner accent" /> 中止
        </button>
      ) : (
      <RunSplitButton
        mainClass="btn-primary has-tooltip tooltip-left tooltip-wrap"
        caretClass="btn-primary"
        onClick={onRun}
        disabled={running || !sql.trim()}
        tooltip={
          `${runTitle(runScope, hasSelection, statementIndex, statementCount)}` +
          ` (${MOD}Enter)\n範囲にかかわらず全体を実行: ${MOD}${SHIFT}Enter`
        }
        options={RUN_SCOPES}
        value={runScope}
        onSelect={onChangeRunScope}
        caretTitle="実行する範囲を選ぶ"
        caretDisabled={running}
      >
        {runLabel(runScope, hasSelection, statementIndex, statementCount)}
      </RunSplitButton>
      )}

      <RunSplitButton
        wrapClass="explain-split"
        mainClass="btn-secondary explain-btn has-tooltip tooltip-left"
        caretClass="btn-secondary explain-btn"
        tooltip={
          !hasExplainModes
            ? "実行計画を表示 (SQLiteは EXPLAIN QUERY PLAN を実行します)"
            : explainMode === "explain"
              ? "実行計画を表示 (EXPLAIN)"
              : "SQLを実際に実行して、計画と実測時間を表示します (EXPLAIN ANALYZE)\n" +
                "更新系のSQLは本当に書き換わります。トランザクションのスイッチは効きません"
        }
        disabled={running || !sql.trim()}
        onClick={() => onExplain(hasExplainModes ? explainMode : "explain")}
        options={hasExplainModes ? EXPLAIN_MODES : undefined}
        value={explainMode}
        onSelect={(explainMode) => onChangeOptions({ explainMode })}
        caretTitle="EXPLAINの種類を切り替え"
        caretDisabled={running}
      >
        {running && runSource === "explain" ? (
          <>
            <span className="spinner accent" /> 実行中…
          </>
        ) : !hasExplainModes || explainMode === "explain" ? (
          "EXPLAIN"
        ) : (
          "ANALYZE"
        )}
      </RunSplitButton>

      <SqlLibraryMenu currentSql={sql} onSelect={onChangeSql} />

      <ToggleButton
        label="トランザクション"
        on={txnOn}
        disabled={running}
        onChange={(txn) => onChangeOptions({ txn })}
        wrapTip
        tooltip={
          "ON: 実行のたびに BEGIN〜COMMIT で包み、最後まで通れば自動で確定 (COMMIT) します。途中でエラーになったら自動で ROLLBACK し、すべて元に戻します (手で COMMIT する方式ではありません)\n" +
          "OFF: 各SQLはすぐに確定 (オートコミット)。エラーになっても実行済みのSQLは元に戻りません\n" +
          "EXPLAIN ANALYZE には効きません"
        }
      />

      <ToggleButton
        label="キャプチャ"
        on={captureOn}
        disabled={running}
        onChange={(capture) => onChangeOptions({ capture })}
        tooltip="ON: 実行のたびに、SQLと全結果タブをPNGで書き出します (書き出し先は設定で変えられます)"
      />

      {formatError ? (
        <span className="format-error" title={formatError}>
          {formatError}
        </span>
      ) : captureMsg ? (
        <>
          <span className="capture-msg mono" title={captureMsg}>
            {captureMsg}
          </span>
          {capturePath && <RevealButton path={capturePath} />}
        </>
      ) : null}

      {running && (
        <ElapsedTimer
          className="query-meta mono running-elapsed"
          startedAt={runStartedAt}
        />
      )}
    </div>
  );
}
