import { ElapsedTimer } from "./ElapsedTimer";
import { RevealButton } from "./RevealButton";
import { RunSplitButton, type RunSplitOption } from "./RunSplitButton";
import { SqlLibraryMenu } from "./SqlLibraryMenu";
import type { EditorOptions } from "../types";
import { MOD, SHIFT } from "../keyLabel";

/** 実行モードの選択肢 */
const RUN_MODES: readonly RunSplitOption<"all" | "selection">[] = [
  { value: "all", label: "実行 (全体)" },
  { value: "selection", label: "選択実行 (選択部分のみ)" },
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
  runMode: "all" | "selection";
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
  runMode,
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
  onChangeOptions,
}: Props) {
  return (
    <div className="query-actions">
      <RunSplitButton
        mainClass="btn-primary"
        onClick={onRun}
        disabled={running || (runMode === "all" ? !sql.trim() : !hasSelection)}
        title={
          (runMode === "selection"
            ? "選択したテキストのみ実行"
            : "エディタ全体を実行") +
          " (⌘Enter)\n選択部分だけを実行: ⌘⇧Enter"
        }
        options={RUN_MODES}
        value={runMode}
        onSelect={(runMode) => onChangeOptions({ runMode })}
        caretTitle="実行モードを切り替え"
        caretDisabled={running}
      >
        {running && runSource === "run" ? (
          <>
            <span className="spinner light" /> 実行中...
          </>
        ) : runMode === "all" ? (
          "実行"
        ) : (
          "選択実行"
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
