import type {
  ColumnChange,
  ColumnInfo,
  DbType,
  IndexChange,
  TableDetail,
} from "../types";
import { ColumnGrid } from "./ColumnGrid";
import { IndexGrid } from "./IndexGrid";

interface Props {
  detail: TableDetail | null;
  loading: boolean;
  /** コメントを論理名+補足に分けて表示するか (設定) */
  split: boolean;
  /** 論理名と補足の区切り文字 (設定) */
  delim: string;
  /** 定義変更 (DDL) が使えるか (Valkey以外・ビュー以外) */
  canEdit: boolean;
  dbType: DbType;
  /** 編集状態を解除するきっかけ (テーブル切替時に変わる) */
  resetKey: string | number;
  /** カラムの変更を実行する (失敗したら例外を投げる) */
  onApplyDdl: (change: ColumnChange) => Promise<void>;
  /** カラム削除の確認を出す */
  onRequestDrop: (column: ColumnInfo) => void;
  /** インデックスの変更を実行する (失敗したら例外を投げる) */
  onApplyIndexDdl: (change: IndexChange) => Promise<void>;
  /** 型の選択肢 */
  types: string[];
  /** 照合順序の選択肢 */
  collations: string[];
}

/** 選択テーブルの構造表示 (カラム / インデックス / テーブル情報) */
export function StructureView({
  detail,
  loading,
  split,
  delim,
  canEdit,
  dbType,
  resetKey,
  onApplyDdl,
  onRequestDrop,
  onApplyIndexDdl,
  types,
  collations,
}: Props) {
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

          <ColumnGrid
            columns={detail.columns}
            split={split}
            delim={delim}
            canEdit={canEdit}
            dbType={dbType}
            resetKey={resetKey}
            onApply={onApplyDdl}
            onRequestDrop={onRequestDrop}
            types={types}
            collations={collations}
            tableCollation={
              detail.info.find(([label]) => label === "照合順序")?.[1] ?? ""
            }
          />

          <IndexGrid
            indexes={detail.indexes}
            tableColumns={detail.columns}
            canEdit={canEdit}
            dbType={dbType}
            resetKey={resetKey}
            onApply={onApplyIndexDdl}
          />
        </>
      )}
    </div>
  );
}
