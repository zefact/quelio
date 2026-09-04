import { ElapsedTimer } from "./ElapsedTimer";
import { RevealButton } from "./RevealButton";
import { RunSplitButton, type RunSplitOption } from "./RunSplitButton";
import { SqlLibraryMenu } from "./sqlLibrary/SqlLibraryMenu";
import type { EditorOptions } from "../types";
import { MOD, SHIFT } from "../keyLabel";

/**
 * 実行ボタンが流す範囲。
 *
 * 選んだ範囲は覚えておく (シートごと・アプリを閉じても残る)。
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
  { value: "analyze", label: "EXPLAIN ANALYZE (実際に実行して実測)" },
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
  /** SQLを整形する */
  onFormat: () => void;
  /** 関数リファレンスを開く */
  onFunctions: () => void;
  onChangeOptions: (patch: Partial<EditorOptions>) => void;
}

/** SQLエディタの下の操作列 (実行 / EXPLAIN / 履歴 / 各種スイッチ) */
export function QueryToolbar({
  sql,
  hasSelection,
  running,
  runSource,
  statementIndex,
  statementCount,
  runScope,
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
  onFormat,
  onFunctions,
  onChangeOptions,
}: Props) {
  return (
    <div className="query-actions">
      <RunSplitButton
        mainClass="btn-primary"
        onClick={onRun}
        disabled={running || !sql.trim()}
        title={
          `${runTitle(runScope, hasSelection, statementIndex, statementCount)}` +
          ` (${MOD}Enter)\n範囲にかかわらず全体を実行: ${MOD}${SHIFT}Enter`
        }
        options={RUN_SCOPES}
        value={runScope}
        onSelect={(runScope) => onChangeOptions({ runScope })}
        caretTitle="実行する範囲を選ぶ"
        caretDisabled={running}
      >
        {running && runSource === "run" ? (
          <>
            <span className="spinner light" /> 実行中...
          </>
        ) : (
          runLabel(runScope, hasSelection, statementIndex, statementCount)
        )}
      </RunSplitButton>

      <RunSplitButton
        wrapClass="explain-split"
        mainClass="btn-secondary explain-btn has-tooltip tooltip-left"
        caretClass="btn-secondary explain-btn"
        tooltip={
          !hasExplainModes
            ? "実行計画を表示 (SQLiteは EXPLAIN QUERY PLAN を実行します)"
            : explainMode === "explain"
              ? "実行計画を表示 (EXPLAIN)"
              : "実際に実行して計画と実測時間を表示 (EXPLAIN ANALYZE)"
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
            <span className="spinner accent" /> 実行中...
          </>
        ) : !hasExplainModes || explainMode === "explain" ? (
          "EXPLAIN"
        ) : (
          "ANALYZE"
        )}
      </RunSplitButton>

      <button
        className="btn-secondary has-tooltip tooltip-left"
        data-tooltip={`SQLを見やすく整形する (${MOD}${SHIFT}F)\nキーワードを大文字にし、カンマを行の先頭に置きます`}
        disabled={running || !sql.trim()}
        onClick={onFormat}
      >
        整形
      </button>

      <button
        className="btn-secondary has-tooltip tooltip-left tooltip-wrap"
        data-tooltip={`関数の書き方を引く (${MOD}${SHIFT}H)\n名前を覚えていなくても「切り捨て」「前ゼロ」「月末」などの言葉で探せます`}
        onClick={onFunctions}
      >
        関数
      </button>

      <SqlLibraryMenu currentSql={sql} onSelect={onChangeSql} />

      {running && (
        <button
          className="btn-secondary cancel-query-btn"
          onClick={onCancel}
          title="実行中のSQLをキャンセル"
        >
          キャンセル
        </button>
      )}

      <label
        className="switch capture-switch has-tooltip tooltip-left tooltip-wrap"
        data-tooltip={
          "ON: 実行をBEGIN〜COMMITで包み、途中でエラーになったら自動ROLLBACKで全て取り消します\nOFF: 各SQLは即時確定 (オートコミット)。エラーになっても実行済みのSQLは取り消されません"
        }
      >
        <input
          type="checkbox"
          checked={txnOn}
          disabled={running}
          onChange={(e) => onChangeOptions({ txn: e.target.checked })}
        />
        <span className="track" aria-hidden />
        <span className="switch-label">
          トランザクション
          {/* OFFのときは何が起きるかを、ツールチップを開かなくても分かるようにする */}
          {!txnOn && <span className="switch-note">オートコミット</span>}
        </span>
      </label>

      <label
        className="switch capture-switch has-tooltip tooltip-left"
        data-tooltip="実行時にSQLと全結果タブをPNGで保存 (保存先は設定で変更できます)"
      >
        <input
          type="checkbox"
          checked={captureOn}
          disabled={running}
          onChange={(e) => onChangeOptions({ capture: e.target.checked })}
        />
        <span className="track" aria-hidden />
        <span className="switch-label">キャプチャ</span>
      </label>

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
