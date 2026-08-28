import type {
  ColumnChange,
  ColumnInfo,
  DbType,
  ForeignKeyChange,
  IndexChange,
  TableDetail,
} from "../types";
import { ColumnGrid } from "./ColumnGrid";
import { ForeignKeyGrid } from "./ForeignKeyGrid";
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
  /** 実行せずに、生成されるSQLだけを取得する (並べ替えの確認用) */
  onPreviewDdl: (change: ColumnChange) => Promise<string[]>;
  /** カラム削除の確認を出す */
  onRequestDrop: (column: ColumnInfo) => void;
  /** インデックスの変更を実行する (失敗したら例外を投げる) */
  onApplyIndexDdl: (change: IndexChange) => Promise<void>;
  /** 外部キーの変更を実行する (失敗したら例外を投げる) */
  onApplyForeignKeyDdl: (change: ForeignKeyChange) => Promise<void>;
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
  onPreviewDdl,
  onRequestDrop,
  onApplyIndexDdl,
  onApplyForeignKeyDdl,
  types,
  collations,
}: Props) {
  return (
    <div className="structure">
      {loading ? (
        <div className="structure-loading">
          <span className="spinner accent" /> 構造を読み込み中...
        </div>
      ) : !detail ? (
        <div className="structure-loading">
          定義を取得できませんでした (再読込を試してください)
        </div>
      ) : (
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
            onPreview={onPreviewDdl}
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

          <ForeignKeyGrid
            foreignKeys={detail.foreignKeys ?? []}
            tableColumns={detail.columns}
            canEdit={canEdit}
            dbType={dbType}
            resetKey={resetKey}
            onApply={onApplyForeignKeyDdl}
          />
        </>
      )}
    </div>
  );
}
