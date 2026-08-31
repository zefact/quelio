import { ElapsedTimer } from "./ElapsedTimer";
import { RevealButton } from "./RevealButton";
import { RunSplitButton, type RunSplitOption } from "./RunSplitButton";
import { SqlLibraryMenu } from "./sqlLibrary/SqlLibraryMenu";
import type { EditorOptions } from "../types";
import { MOD, SHIFT } from "../keyLabel";

/**
 * ▾ から選べる実行の仕方。
 * モードの切り替えではなく、その場で実行する操作として並べる
 * (切り替え式は戻し忘れると意図しない範囲が走るため、やめた)
 */
const RUN_MENU: readonly RunSplitOption<"here" | "all">[] = [
  { value: "here", label: "実行 (選択 / カーソル位置の文)" },
  { value: "all", label: "全体を実行" },
];

/** EXPLAINの種類 */
const EXPLAIN_MODES: readonly RunSplitOption<"explain" | "analyze">[] = [
  { value: "explain", label: "EXPLAIN (実行計画のみ表示)" },
  { value: "analyze", label: "EXPLAIN ANALYZE (実際に実行して実測)" },
];

interface Props {
  sql: string;
  /** エディタで文字を選択しているか (選択実行の可否) */
  hasSelection: boolean;
  running: boolean;
  /** 直近の実行を始めたボタン (スピナーの表示先) */
  runSource: "run" | "explain";
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
  onRunAll: () => void;
  onExplain: (mode: "explain" | "analyze") => void;
  onCancel: () => void;
  onChangeSql: (sql: string) => void;
  /** SQLを整形する */
  onFormat: () => void;
  onChangeOptions: (patch: Partial<EditorOptions>) => void;
}

/** SQLエディタの下の操作列 (実行 / EXPLAIN / 履歴 / 各種スイッチ) */
export function QueryToolbar({
  sql,
  hasSelection,
  running,
  runSource,
  runStartedAt,
  explainMode,
  hasExplainModes,
  txnOn,
  captureOn,
  formatError,
  captureMsg,
  capturePath,
  onRun,
  onRunAll,
  onExplain,
  onCancel,
  onChangeSql,
  onFormat,
  onChangeOptions,
}: Props) {
  return (
    <div className="query-actions">
      <RunSplitButton
        mainClass="btn-primary"
        onClick={onRun}
        disabled={running || !sql.trim()}
        title={
          (hasSelection
            ? "選択した部分を実行"
            : "カーソルのある文を実行 (1文だけのときは全体)") +
          ` (${MOD}Enter)\n全体を実行: ${MOD}${SHIFT}Enter`
        }
        options={RUN_MENU}
        onSelect={(v) => (v === "all" ? onRunAll() : onRun())}
        caretTitle="実行の仕方を選ぶ"
        caretDisabled={running}
      >
        {running && runSource === "run" ? (
          <>
            <span className="spinner light" /> 実行中...
          </>
        ) : hasSelection ? (
          "選択を実行"
        ) : (
          "実行"
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
