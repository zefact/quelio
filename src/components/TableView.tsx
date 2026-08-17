import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getAppSettings } from "../api";
import { buildColumnTips } from "../columnTips";
import { parseComment } from "../comment";
import type {
  AppSettings,
  QueryResult,
  TableDetail,
  TableInfo,
  TableTab,
} from "../types";
import { StructureView } from "./StructureView";
import { TableDataView } from "./TableDataView";

interface Props {
  table: TableInfo;
  /** 表示中のタブ (定義 / データ) */
  view: TableTab;
  onChangeView: (view: TableTab) => void;
  // ---- 定義タブ ----
  detail: TableDetail | null;
  loadingDetail: boolean;
  // ---- データタブ ----
  data: QueryResult | null;
  loadingData: boolean;
  dataError: string | null;
  where: string;
  onChangeWhere: (where: string) => void;
  onApplyWhere: () => void;
  onReloadData: () => void;
  onPageData: (offset: number) => void;
  onSortData: (orderBy: string | null, orderDir: "asc" | "desc") => void;
}

function typeChip(t: string): string {
  if (t.includes("VIEW")) return "view";
  return "table";
}

/** 定義タブのアイコン (行が並んだ一覧) */
function DefIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 6h16M4 12h16M4 18h10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** データタブのアイコン (表) */
function DataIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M3 9h18M9 9v11" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

const TABS: [TableTab, string, () => ReactNode][] = [
  ["definition", "定義", DefIcon],
  ["data", "データ", DataIcon],
];

/** 選択テーブルの表示。ヘッダ + 「定義 / データ」タブの切り替えを担う */
export function TableView({
  table,
  view,
  onChangeView,
  detail,
  loadingDetail,
  data,
  loadingData,
  dataError,
  where,
  onChangeWhere,
  onApplyWhere,
  onReloadData,
  onPageData,
  onSortData,
}: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // 設定 (表示モード・区切り文字・行番号) はテーブル切替のたびに読み直す
  useEffect(() => {
    getAppSettings().then(setSettings).catch(() => {});
  }, [table]);

  const split = settings?.structureCommentMode === "split";
  const delim = settings?.commentDelimiter ?? "（";

  /** データタブのヘッダに出すカラム説明 (論理名・補足・型) */
  const columnTips = useMemo(
    () => buildColumnTips(detail?.columns ?? [], delim),
    [detail, delim]
  );

  /** テーブルコメントの論理名 (split時に英字テーブル名の横へ出す) */
  const tableComment =
    detail?.info.find(([label]) => label === "コメント")?.[1] ?? "";
  const tableLogical = split ? parseComment(tableComment, delim)[0] : "";

  return (
    <div className="table-view">
      <div className="content-table-head">
        <span className={`type-chip ${typeChip(table.tableType)}`}>
          {table.tableType}
        </span>
        <h2 className="mono">
          {table.schema ? `${table.schema}.` : ""}
          {table.name}
        </h2>
        {tableLogical && (
          <span className="table-logical" title={tableComment}>
            {tableLogical}
          </span>
        )}
      </div>

      <div className="table-tabs" role="tablist">
        {TABS.map(([v, label, Icon]) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            className={"table-tab" + (view === v ? " active" : "")}
            onClick={() => onChangeView(v)}
          >
            <Icon />
            {label}
          </button>
        ))}
      </div>

      <div className={"table-view-body" + (view === "data" ? " fill" : "")}>
        {view === "definition" ? (
          <StructureView
            detail={detail}
            loading={loadingDetail}
            split={split}
            delim={delim}
          />
        ) : (
          <TableDataView
            data={data}
            loading={loadingData}
            error={dataError}
            where={where}
            showRowNumbers={settings?.showRowNumbers ?? true}
            columnTips={columnTips}
            onChangeWhere={onChangeWhere}
            onApplyWhere={onApplyWhere}
            onReload={onReloadData}
            onPage={onPageData}
            onSort={onSortData}
          />
        )}
      </div>
    </div>
  );
}
