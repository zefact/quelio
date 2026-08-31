import { SelectMenu } from "./SelectMenu";
import { useDismiss } from "../hooks/useDismiss";
import { useRef, useState } from "react";
import type { SessionSummary } from "../types";

/** 表示設定の項目 */
const OPTIONS = [
  { key: "allCols", label: "全カラム" },
  { key: "showLogical", label: "日本語名" },
  { key: "showTypes", label: "型・サイズ" },
] as const;

export type ErOptionKey = (typeof OPTIONS)[number]["key"];

interface Props {
  /** 開いている図の名前 (未保存はnull) */
  diagName: string | null;
  /** 保存済みの図の名前一覧 */
  diagList: string[];
  onOpenDiagram: (name: string) => void;
  onNewDiagram: () => void;
  onSaveAs: () => void;
  onRename: () => void;
  onDelete: () => void;
  /** 「名前を付けて保存」を押せるか (図が空なら押せない) */
  canSaveAs: boolean;

  sessions: SessionSummary[];
  sessionId: string;
  database: string;
  /** 選んでいる接続 (未接続はundefined) */
  session: SessionSummary | undefined;
  onChangeSession: (sessionId: string) => void;
  onChangeDatabase: (database: string) => void;

  loading: boolean;
  onReverse: () => void;

  options: Record<ErOptionKey, boolean>;
  onToggleOption: (key: ErOptionKey) => void;

  onExportPng: () => void;
  /** テキスト形式の書き出し (コピー / 保存) */
  onExportText: (format: "mermaid" | "plantuml", save: boolean) => void;
  canExportPng: boolean;
  /** 右端に出す「Nテーブル / Mリレーション」 */
  meta: string;
}

/** ER図ウィンドウの上部ツールバー */
export function ErToolbar({
  diagName,
  diagList,
  onOpenDiagram,
  onNewDiagram,
  onSaveAs,
  onRename,
  onDelete,
  canSaveAs,
  sessions,
  sessionId,
  database,
  session,
  onChangeSession,
  onChangeDatabase,
  loading,
  onReverse,
  options,
  onToggleOption,
  onExportPng,
  onExportText,
  canExportPng,
  meta,
}: Props) {
  const diagMenuRef = useRef<HTMLDivElement>(null);
  const optsRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [optsOpen, setOptsOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);

  // どちらのプルダウンも外側クリックで閉じる。
  // テーブル等がmousedownをstopPropagationするため、キャプチャ段階で検知する
  useDismiss(diagOpen, () => setDiagOpen(false), {
    capture: true,
    ref: diagMenuRef,
  });
  useDismiss(optsOpen, () => setOptsOpen(false), {
    capture: true,
    ref: optsRef,
  });
  useDismiss(textOpen, () => setTextOpen(false), {
    capture: true,
    ref: textRef,
  });

  return (
    <div className="diff-toolbar" data-tauri-drag-region>
      <div className="er-opts" ref={diagMenuRef}>
        <button
          className="btn-secondary er-diag-btn"
          title={diagName ?? "未保存の図"}
          onClick={() => setDiagOpen(!diagOpen)}
        >
          <span className="er-diag-name">{diagName ?? "(未保存の図)"}</span>{" "}
          <span className="er-opts-caret">▾</span>
        </button>
        {diagOpen && (
          <div className="er-opts-pop er-diag-pop">
            {diagList.length > 0 ? (
              diagList.map((name) => (
                <button
                  key={name}
                  className={
                    "context-item" + (name === diagName ? " checked" : "")
                  }
                  onClick={() => {
                    onOpenDiagram(name);
                    setDiagOpen(false);
                  }}
                >
                  {name === diagName ? "✓ " : "　 "}
                  {name}
                </button>
              ))
            ) : (
              <div className="context-caption">保存済みの図はありません</div>
            )}
            <div className="context-sep" />
            <button
              className="context-item"
              onClick={() => {
                onNewDiagram();
                setDiagOpen(false);
              }}
            >
              新しい図
            </button>
            <button
              className="context-item"
              disabled={!canSaveAs}
              onClick={() => {
                onSaveAs();
                setDiagOpen(false);
              }}
            >
              名前を付けて保存...
            </button>
            {diagName && (
              <button
                className="context-item"
                onClick={() => {
                  onRename();
                  setDiagOpen(false);
                }}
              >
                名前を変更...
              </button>
            )}
            {diagName && (
              <button
                className="context-item danger"
                onClick={() => {
                  onDelete();
                  setDiagOpen(false);
                }}
              >
                この図を削除
              </button>
            )}
          </div>
        )}
      </div>

      <div className="diff-side-sel">
        <SelectMenu
          className="mono"
          value={sessionId}
          placeholder="接続を選択"
          options={sessions.map((s) => ({
            value: s.sessionId,
            label: s.name,
          }))}
          onChange={onChangeSession}
        />
        <SelectMenu
          className="mono"
          value={database}
          disabled={!session}
          options={(session?.databases ?? [database]).map((d) => ({
            value: d,
            label: d,
          }))}
          onChange={onChangeDatabase}
        />
      </div>

      <button
        className="btn-primary has-tooltip tooltip-left tooltip-wrap"
        data-tooltip={
          "DBからスキーマを読み込んでER図を作成/更新します\n(既存の配置は維持されます)"
        }
        disabled={loading || !sessionId}
        onClick={onReverse}
      >
        {loading ? (
          <>
            <span className="spinner light" /> リバース中...
          </>
        ) : (
          "リバース"
        )}
      </button>

      <div className="er-opts" ref={optsRef}>
        <button className="btn-secondary" onClick={() => setOptsOpen(!optsOpen)}>
          表示設定 <span className="er-opts-caret">▾</span>
        </button>
        {optsOpen && (
          <div className="er-opts-pop">
            {OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                className={"context-item" + (options[key] ? " checked" : "")}
                onClick={() => onToggleOption(key)}
              >
                {options[key] ? "✓ " : "　 "}
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className="btn-secondary"
        disabled={!canExportPng}
        onClick={onExportPng}
      >
        PNG保存
      </button>

      {/* テキスト形式。図をそのままリポジトリやWikiへ貼れるようにする */}
      <div className="er-opts" ref={textRef}>
        <button
          className="btn-secondary has-tooltip tooltip-left tooltip-wrap"
          data-tooltip={
            "Mermaid / PlantUML で書き出します\n(GitHubやNotionはMermaidをそのまま図にします)"
          }
          disabled={!canExportPng}
          onClick={() => setTextOpen(!textOpen)}
        >
          テキスト <span className="er-opts-caret">▾</span>
        </button>
        {textOpen && (
          <div className="er-opts-pop er-text-pop">
            {(
              [
                ["mermaid", "Mermaid"],
                ["plantuml", "PlantUML"],
              ] as const
            ).map(([format, label]) => (
              <div key={format} className="er-text-row">
                <span className="er-text-name">{label}</span>
                <button
                  className="context-item"
                  onClick={() => {
                    setTextOpen(false);
                    onExportText(format, false);
                  }}
                >
                  コピー
                </button>
                <button
                  className="context-item"
                  onClick={() => {
                    setTextOpen(false);
                    onExportText(format, true);
                  }}
                >
                  保存
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <span className="er-meta mono">{meta}</span>
    </div>
  );
}

