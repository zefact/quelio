import { useMemo, useState } from "react";
import { listSessions, schemaSnapshot } from "../api";
import { buildMigration } from "../schemaAlter";
import { isCancelled, LoadingWithCancel } from "./LoadingWithCancel";
import { SqlTextDialog } from "./SqlTextDialog";
import { usePolling } from "../hooks/usePolling";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { SelectMenu } from "./SelectMenu";
import {
  computeDiff,
  diffCounts,
  diffItemsOf,
  itemsToShow,
  type ItemDiff,
  type ItemKind,
  type TableDiff,
} from "../schemaDiff";
import type { SchemaEntry, SessionSummary } from "../types";

/** 片側の選択 (セッション×DB) */
interface SideSel {
  sessionId: string;
  database: string;
}

/** 共通prefix/suffixを除いた差異部分を求める */
function splitDiff(a: string, b: string): [string, string, string] {
  const aa = [...a];
  const bb = [...b];
  let p = 0;
  while (p < aa.length && p < bb.length && aa[p] === bb[p]) p++;
  let s = 0;
  while (
    s < aa.length - p &&
    s < bb.length - p &&
    aa[aa.length - 1 - s] === bb[bb.length - 1 - s]
  )
    s++;
  return [
    aa.slice(0, p).join(""),
    aa.slice(p, aa.length - s).join(""),
    aa.slice(aa.length - s).join(""),
  ];
}

/** スペースを可視化 (半角→␣ / 全角→□) */
function visualizeWs(s: string): string {
  // 全角スペースは見た目で分からないので、エスケープで書く
  return s.replace(/ /g, "␣").replace(/\u3000/g, "□");
}

/** 差異部分のUnicodeコードポイント一覧 */
function codePoints(s: string): string {
  return [...s]
    .map((c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"))
    .join(" ");
}

/** 相手側との差異部分をハイライトして描画 */
function DiffValue({ value, other }: { value?: string; other?: string }) {
  const v = value ?? "";
  const o = other ?? "";
  if (v === "" || v === o) return <>{v || "—"}</>;
  const [prefix, mid, suffix] = splitDiff(v, o);
  if (mid === "") {
    // この側には無い文字が相手側にある (挿入位置を示す)
    return (
      <>
        {prefix}
        <span className="char-diff empty-mark" title="この位置に相手側のみ文字があります">
          ‸
        </span>
        {suffix}
      </>
    );
  }
  return (
    <>
      {prefix}
      <span className="char-diff" title={`差異部分: "${mid}" (${codePoints(mid)})`}>
        {visualizeWs(mid)}
      </span>
      {suffix}
    </>
  );
}

/**
 * カラム・インデックスの行に出す中身 (その側の型や対象カラム)。
 *
 * 無い側は「—」。差異ありの行は、違っている項目を下の行に並べるので空にする
 */
function itemCell(it: ItemDiff, side: "left" | "right"): string {
  if (it.status === "changed") return "";
  const value = side === "left" ? it.left : it.right;
  return value === undefined ? "—" : value || "あり";
}

const STATUS_LABEL: Record<TableDiff["status"], string> = {
  added: "右のみ",
  removed: "左のみ",
  changed: "差異あり",
  same: "一致",
};

/** スキーマ差分ウィンドウ */
export function DiffWindow() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [left, setLeft] = useState<SideSel>({ sessionId: "", database: "" });
  const [right, setRight] = useState<SideSel>({ sessionId: "", database: "" });
  const [diff, setDiff] = useState<TableDiff[] | null>(null);
  const [activeView, setActiveView] = useState<"tables" | "columns" | "indexes">(
    "tables"
  );
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [loading, setLoading] = useState(false);
  /** 比較に使った定義そのもの (ALTER文の組み立て用) */
  const [snapshots, setSnapshots] = useState<{
    left: SchemaEntry[];
    right: SchemaEntry[];
  } | null>(null);
  /** 組み立てたALTER文 (nullなら出していない) */
  const [migration, setMigration] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 項目カラムの幅 (ヘッダのハンドルでドラッグ変更)
  const [labelWidth, startLabelResize] = useResizableWidth(220, 120, 600);

  const refreshSessions = async () => {
    try {
      // Valkeyはスキーマの概念が無いため差分の対象から除外する
      setSessions(
        (await listSessions()).filter((s) => s.dbType !== "valkey")
      );
    } catch {
      /* 無視 */
    }
  };

  // ウィンドウが隠れている間は止める
  usePolling(refreshSessions, 3000);

  /**
   * 選択を変えたら、前回の比較で取った定義は捨てる。
   * 古い定義に新しい方言を当ててALTER文を作ってしまわないようにする
   */
  const changeSide = (setSide: (s: SideSel) => void) => (sel: SideSel) => {
    setSnapshots(null);
    setMigration(null);
    setSide(sel);
  };

  const sideSelector = (
    side: SideSel,
    setSideRaw: (s: SideSel) => void,
    placeholder: string
  ) => {
    const setSide = changeSide(setSideRaw);
    const session = sessions.find((s) => s.sessionId === side.sessionId);
    return (
      <div className="diff-side-sel">
        <SelectMenu
          className="mono"
          value={side.sessionId}
          placeholder={placeholder}
          options={sessions.map((s) => ({
            value: s.sessionId,
            label: s.name,
          }))}
          onChange={(v) => {
            const s = sessions.find((x) => x.sessionId === v);
            setSide({
              sessionId: v,
              database: s?.currentDb ?? s?.databases[0] ?? "",
            });
          }}
        />
        <SelectMenu
          className="mono"
          value={side.database}
          placeholder="データベース"
          disabled={!session}
          options={(session?.databases ?? []).map((d) => ({
            value: d,
            label: d,
          }))}
          onChange={(v) => setSide({ ...side, database: v })}
        />
      </div>
    );
  };

  const handleCompare = async () => {
    if (!left.sessionId || !left.database || !right.sessionId || !right.database)
      return;
    setLoading(true);
    setError(null);
    setDiff(null);
    setSnapshots(null);
    setMigration(null);
    try {
      const [l, r] = await Promise.all([
        schemaSnapshot(left.sessionId, left.database),
        schemaSnapshot(right.sessionId, right.database),
      ]);
      setDiff(computeDiff(l, r));
      // ALTER文の組み立てには、差分ではなく元の定義そのものが要る
      setSnapshots({ left: l, right: r });
      setActiveView("tables");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const visible = useMemo(
    () => (diff ?? []).filter((t) => !onlyDiff || t.status !== "same"),
    [diff, onlyDiff]
  );

  const diffCount = useMemo(
    () => (diff ?? []).filter((t) => t.status !== "same").length,
    [diff]
  );

  /** タブごとの件数 (差異の数。「差異のみ表示」を外しても変えない) */
  const counts = useMemo(() => diffCounts(diff ?? []), [diff]);

  /**
   * カラム・インデックスのタブに出すテーブルと、その中身。
   * 「差異のみ表示」のときは差異のあるものだけ、外したときは一致も含めて全部
   */
  const itemTables = (kind: ItemKind) =>
    (diff ?? [])
      .map((t) => ({ t, items: itemsToShow(t, kind, onlyDiff) }))
      .filter((x) => x.items.length > 0);
  const columnTables = useMemo(
    () => itemTables("columns"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diff, onlyDiff]
  );
  const indexTables = useMemo(
    () => itemTables("indexes"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diff, onlyDiff]
  );

  /**
   * テーブルのタブの見出しに出す「カラム差異 N件」。
   * 数えるのは差異だけ (一致しているものは数えない)。押すとそのタブへ移る
   * (テーブルの属性に差が無いと下に何も出ないので、どこが違うかをここからたどれるように)
   */
  const inlineCount = (t: TableDiff, kind: ItemKind, label: string) => {
    const n = diffItemsOf(t, kind).length;
    if (n === 0) return null;
    return (
      <button
        type="button"
        className="diff-inline-link"
        title={`${kind === "columns" ? "カラム" : "インデックス"}のタブで見る`}
        onClick={() => setActiveView(kind)}
      >
        {label} {n}件
      </button>
    );
  };

  /**
   * カラム・インデックスのタブの、テーブル1つぶん。
   * 見出しには差異の件数を出す (差異が無ければ「一致」)
   */
  const renderItemTable = (
    t: TableDiff,
    kind: ItemKind,
    title: string,
    items: ItemDiff[]
  ) => {
    const n = diffItemsOf(t, kind).length;
    // 片方にしか無いテーブルは、その旨を出す (中身は1件ずつの差異としては数えない)
    const whole = t.status === "added" || t.status === "removed";
    const status = whole ? t.status : n > 0 ? "changed" : "same";
    return (
      <div className="diff-table" key={t.key}>
        <div className={`diff-table-head ${status}`}>
          <span className="mono diff-table-name">{t.key}</span>
          <span className={`diff-status ${status}`}>
            {whole ? STATUS_LABEL[t.status] : n > 0 ? `${n}件` : "一致"}
          </span>
        </div>
        {renderItemDiffs(title, items)}
      </div>
    );
  };

  const renderItemDiffs = (title: string, items: ItemDiff[]) =>
    items.length > 0 && (
      <>
        <div className="diff-subhead">{title}</div>
        {items.map((it) => (
          <div key={title + it.name}>
            <div className={`diff-row diff-item-row ${it.status}`}>
              <span className="diff-label mono">{it.name}</span>
              <span className={`diff-cell mono ${it.status === "added" ? "empty" : ""}`}>
                {itemCell(it, "left")}
              </span>
              <span className={`diff-cell mono ${it.status === "removed" ? "empty" : ""}`}>
                {itemCell(it, "right")}
              </span>
            </div>
            {it.fields.map((f) => (
              <div className="diff-row changed" key={it.name + f.label}>
                <span className="diff-label">
                  <span className="diff-field-owner mono">{it.name}</span> {f.label}
                </span>
                <span className="diff-cell mono left">
                  <DiffValue value={f.left} other={f.right} />
                </span>
                <span className="diff-cell mono right">
                  <DiffValue value={f.right} other={f.left} />
                </span>
              </div>
            ))}
          </div>
        ))}
      </>
    );

  return (
    <div
      className="diff-window"
      style={{ "--diff-label-w": `${labelWidth}px` } as React.CSSProperties}
    >
      <div className="diff-toolbar" data-tauri-drag-region>
        {sideSelector(left, setLeft, "左: 接続を選択")}
        <span className="diff-vs">⇄</span>
        {sideSelector(right, setRight, "右: 接続を選択")}
        <button
          className="btn-primary diff-compare"
          onClick={handleCompare}
          disabled={
            loading ||
            !left.sessionId ||
            !left.database ||
            !right.sessionId ||
            !right.database
          }
        >
          {loading ? (
            <>
              <span className="spinner light" /> 比較中...
            </>
          ) : (
            "比較"
          )}
        </button>

        <button
          className="btn-secondary"
          title="左を右に合わせるSQLを組み立てます (実行はしません)"
          disabled={!snapshots}
          onClick={() => {
            if (!snapshots) return;
            const dbType = sessions.find(
              (s) => s.sessionId === left.sessionId
            )?.dbType;
            if (!dbType) {
              setError(
                "左の接続が見つかりません (閉じられた可能性があります)。比較し直してください"
              );
              return;
            }
            const rightDbType = sessions.find(
              (s) => s.sessionId === right.sessionId
            )?.dbType;
            setMigration(
              buildMigration(dbType, snapshots.left, snapshots.right, rightDbType)
            );
          }}
        >
          ALTER文を作る
        </button>

        <label className="switch diff-only">
          <input
            type="checkbox"
            checked={onlyDiff}
            onChange={(e) => setOnlyDiff(e.target.checked)}
          />
          <span className="track" aria-hidden />
          <span className="switch-label">差異のみ表示</span>
        </label>
      </div>

      {sessions.length === 0 && (
        <div className="content-placeholder dim-center">
          比較するにはメインウィンドウでDBに接続してください
        </div>
      )}

      {error && (
        <div
          className={`result-banner ${isCancelled(error) ? "ok" : "ng"} diff-error`}
        >
          <span className="dot" aria-hidden />
          <strong>{isCancelled(error) ? "中止" : "エラー"}</strong>
          <span className="result-detail">{error}</span>
        </div>
      )}

      {migration !== null && (
        <SqlTextDialog
          title="ALTER文"
          target={`${left.database} ← ${right.database}`}
          text={migration}
          onClose={() => setMigration(null)}
        />
      )}

      {loading && (
        <LoadingWithCancel
          label="スキーマを読み込み中..."
          sessionIds={[left.sessionId, right.sessionId]}
          dbTypes={[left.sessionId, right.sessionId].map(
            (id) => sessions.find((s) => s.sessionId === id)?.dbType
          )}
        />
      )}

      {!diff && !loading && !error && (
        <div className="content-placeholder dim-center">
          左右に接続とデータベースを選んで「比較」を押してください
        </div>
      )}

      {diff && (
        <div className="diff-body">
          <div className="diff-tabs-row">
            <div className="result-tabs diff-view-tabs">
              {(
                [
                  ["tables", "テーブル", counts.tables],
                  ["columns", "カラム", counts.columns],
                  ["indexes", "インデックス", counts.indexes],
                ] as const
              ).map(([view, label, count]) => (
                <button
                  key={view}
                  className={
                    "result-tab" + (activeView === view ? " active" : "")
                  }
                  onClick={() => setActiveView(view)}
                >
                  {label} ({count})
                </button>
              ))}
            </div>
            <span className="diff-summary mono">
              {diff.length}テーブル中 {diffCount}件に差異
            </span>
          </div>

          <div className="diff-head diff-row">
            <span className="diff-label">
              項目
              <span
                className="diff-label-resizer"
                onMouseDown={startLabelResize}
              />
            </span>
            <span className="diff-cell">左: {left.database}</span>
            <span className="diff-cell">右: {right.database}</span>
          </div>

          <div className="diff-list">
            {/* ---- テーブルタブ ---- */}
            {activeView === "tables" && (
              <>
                {visible.length === 0 && (
                  <div className="content-placeholder dim-center">
                    {diffCount === 0
                      ? "差異はありません 🎉"
                      : "表示対象がありません"}
                  </div>
                )}
                {visible.map((t) => (
                  <div className="diff-table" key={t.key}>
                    <div className={`diff-table-head ${t.status}`}>
                      <span className="mono diff-table-name">{t.key}</span>
                      <span className="diff-inline-counts">
                        {inlineCount(t, "columns", "カラム差異")}
                        {inlineCount(t, "indexes", "インデックス差異")}
                      </span>
                      <span className={`diff-status ${t.status}`}>
                        {STATUS_LABEL[t.status]}
                      </span>
                    </div>
                    {t.status === "added" && (
                      <div className="diff-row added">
                        <span className="diff-label">テーブル</span>
                        <span className="diff-cell mono empty">—</span>
                        <span className="diff-cell mono">あり</span>
                      </div>
                    )}
                    {t.status === "removed" && (
                      <div className="diff-row removed">
                        <span className="diff-label">テーブル</span>
                        <span className="diff-cell mono">あり</span>
                        <span className="diff-cell mono empty">—</span>
                      </div>
                    )}
                    {t.attrs.map((f) => (
                      <div className="diff-row changed" key={f.label}>
                        <span className="diff-label">{f.label}</span>
                        <span className="diff-cell mono left">
                          <DiffValue value={f.left} other={f.right} />
                        </span>
                        <span className="diff-cell mono right">
                          <DiffValue value={f.right} other={f.left} />
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}

            {/* ---- カラムタブ ---- */}
            {activeView === "columns" && (
              <>
                {columnTables.length === 0 && (
                  <div className="content-placeholder dim-center">
                    {onlyDiff ? "カラムの差異はありません" : "カラムはありません"}
                  </div>
                )}
                {columnTables.map(({ t, items }) =>
                  renderItemTable(t, "columns", "カラム", items)
                )}
              </>
            )}

            {/* ---- インデックスタブ ---- */}
            {activeView === "indexes" && (
              <>
                {indexTables.length === 0 && (
                  <div className="content-placeholder dim-center">
                    {onlyDiff
                      ? "インデックスの差異はありません"
                      : "インデックスはありません"}
                  </div>
                )}
                {indexTables.map(({ t, items }) =>
                  renderItemTable(t, "indexes", "インデックス", items)
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
