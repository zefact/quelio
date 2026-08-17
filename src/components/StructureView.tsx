import { parseComment } from "../comment";
import type { TableDetail } from "../types";
import { GridColumn, ResizableGrid } from "./ResizableGrid";

interface Props {
  detail: TableDetail | null;
  loading: boolean;
  /** コメントを論理名+補足に分けて表示するか (設定) */
  split: boolean;
  /** 論理名と補足の区切り文字 (設定) */
  delim: string;
}

/** "varchar(100)" → 型: varchar / サイズ: 100 に分離する */
function splitType(colType: string): { base: string; size: string } {
  const m = colType.match(/^([^(]+)\(([^)]*)\)(.*)$/);
  if (!m) return { base: colType, size: "" };
  return { base: `${m[1]}${m[3] ?? ""}`.trim(), size: m[2] };
}

/** 行番号列 (データの値と区別できるようガター表示にする) */
function rowNumCol(description: string): GridColumn {
  return {
    id: "no",
    label: "No",
    width: 52,
    minWidth: 44,
    align: "right",
    cellClass: "rownum-cell",
    description,
  };
}

/** カラムグリッドの列定義 (コメント表示モードで変わる) */
function columnCols(split: boolean): GridColumn[] {
  return [
    rowNumCol("カラムの定義順 (行番号)"),
    { id: "name", label: "フィールド", width: 190, minWidth: 90 },
    ...(split
      ? [{ id: "logical", label: "論理名", width: 160, minWidth: 80 }]
      : []),
    { id: "type", label: "型", width: 110, minWidth: 60 },
    { id: "size", label: "サイズ", width: 70, minWidth: 50, align: "right" as const },
    { id: "null", label: "NULL", width: 62, minWidth: 44, align: "center" as const },
    { id: "key", label: "キー", width: 66, minWidth: 44, align: "center" as const },
    { id: "default", label: "デフォルト", width: 140, minWidth: 60 },
    { id: "extra", label: "属性", width: 120, minWidth: 60 },
    { id: "collation", label: "照合順序", width: 150, minWidth: 60 },
    split
      ? { id: "note", label: "補足", width: 260, minWidth: 100, wrap: true }
      : { id: "comment", label: "コメント", width: 280, minWidth: 100, wrap: true },
  ];
}

const INDEX_COLS: GridColumn[] = [
  rowNumCol("インデックスの通し番号 (行番号)"),
  { id: "name", label: "名前", width: 180, minWidth: 80 },
  { id: "unique", label: "ユニーク", width: 70, minWidth: 56, align: "center" },
  { id: "columns", label: "カラム", width: 280, minWidth: 100, wrap: true },
  { id: "type", label: "種別", width: 90, minWidth: 60 },
  { id: "card", label: "カーディナリティ", width: 130, minWidth: 80, align: "right" },
];

/** 選択テーブルの構造表示 (カラム / インデックス / テーブル情報) */
export function StructureView({ detail, loading, split, delim }: Props) {
  return (
    <div className="structure">
      {loading ? (
        <div className="structure-loading">
          <span className="spinner accent" /> 構造を読み込み中...
        </div>
      ) : !detail ? null : (
        <>
          {detail.info.length > 0 && (
            <div className="info-chips">
              {detail.info.map(([label, value]) => (
                <span className="info-chip" key={label}>
                  <span className="info-chip-label">{label}</span>
                  <span className="info-chip-value mono">{value}</span>
                </span>
              ))}
            </div>
          )}

          <h3 className="structure-heading">
            カラム <span className="panel-count">{detail.columns.length}</span>
          </h3>
          <ResizableGrid
            autoFit
            columns={columnCols(split)}
            rows={detail.columns.map((c, i) => {
              const { base, size } = splitType(c.colType);
              const [logical, note] = parseComment(c.comment ?? "", delim);
              return {
                key: c.name,
                cells: [
                  <span className="mono row-num">{i + 1}</span>,
                  <span className="mono strong" title={c.name}>
                    {c.name}
                  </span>,
                  ...(split ? [<span>{logical}</span>] : []),
                  <span className="mono dim" title={base}>
                    {base}
                  </span>,
                  <span className="mono dim">{size}</span>,
                  c.nullable ? <span className="check">✓</span> : null,
                  c.key ? (
                    <span
                      className={"key-badge" + (c.key === "PRI" ? " pri" : "")}
                    >
                      {c.key}
                    </span>
                  ) : null,
                  <span
                    className="mono dim"
                    title={c.default ?? undefined}
                  >
                    {c.default === null || c.default === undefined
                      ? c.nullable
                        ? "NULL"
                        : ""
                      : c.default === ""
                        ? "''"
                        : c.default}
                  </span>,
                  <span className="dim" title={c.extra ?? undefined}>
                    {c.extra ?? ""}
                  </span>,
                  <span className="mono faint" title={c.collation ?? undefined}>
                    {c.collation ?? ""}
                  </span>,
                  <span className="comment-text">
                    {split ? note : (c.comment ?? "")}
                  </span>,
                ],
              };
            })}
          />

          <h3 className="structure-heading">
            インデックス{" "}
            <span className="panel-count">{detail.indexes.length}</span>
          </h3>
          <ResizableGrid
            autoFit
            columns={INDEX_COLS}
            emptyText="インデックスがありません"
            rows={detail.indexes.map((ix, i) => ({
              key: ix.name,
              cells: [
                <span className="mono row-num">{i + 1}</span>,
                <span className="mono strong" title={ix.name}>
                  {ix.name}
                </span>,
                ix.unique ? <span className="check">✓</span> : null,
                <span className="mono dim">{ix.columns}</span>,
                <span className="dim">{ix.indexType ?? ""}</span>,
                <span className="mono dim">
                  {ix.cardinality?.toLocaleString() ?? ""}
                </span>,
              ],
            }))}
          />
        </>
      )}
    </div>
  );
}
