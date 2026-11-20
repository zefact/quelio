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
  /** コメントを日本語名と補足に分けて表示するか (設定) */
  split: boolean;
  /** 日本語名と補足の区切り文字 (設定) */
  delim: string;
  /** 定義変更 (DDL) が使えるか (Valkey以外・ビュー以外) */
  canEdit: boolean;
  dbType: DbType;
  /**
   * 本番の接続か。
   * 削除などの確認ダイアログに本番の1行を出す (確認そのものは上の画面が出す)
   */
  prod?: boolean;
  /** 確認に出すテーブル名 (スキーマがあれば付けた形) */
  tableLabel?: string;
  /** 編集状態を解除するきっかけ (テーブル切替時に変わる) */
  resetKey: string | number;
  /**
   * カラムの変更を実行する (失敗したら例外を投げる)。
   * `confirmed` は、この画面ですでに確認ダイアログを通したか
   */
  onApplyDdl: (change: ColumnChange, confirmed?: boolean) => Promise<void>;
  /** 実行せずに、生成されるSQLだけを取得する (並べ替えの確認用) */
  onPreviewDdl: (change: ColumnChange) => Promise<string[]>;
  /** カラム削除の確認を出す */
  onRequestDrop: (column: ColumnInfo) => void;
  /** インデックスの変更を実行する (失敗したら例外を投げる) */
  onApplyIndexDdl: (change: IndexChange, confirmed?: boolean) => Promise<void>;
  /** 実行せずに、インデックスを作るSQLだけを取得する */
  onPreviewIndexDdl: (change: IndexChange) => Promise<string[]>;
  /** 外部キーの変更を実行する (失敗したら例外を投げる) */
  onApplyForeignKeyDdl: (
    change: ForeignKeyChange,
    confirmed?: boolean
  ) => Promise<void>;
  /** 組み立てたSQL (CREATE INDEX 文など) をSQLエディタへ送る */
  onSendToEditor?: (sql: string) => void;
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
  prod = false,
  tableLabel = "",
  resetKey,
  onApplyDdl,
  onPreviewDdl,
  onRequestDrop,
  onApplyIndexDdl,
  onPreviewIndexDdl,
  onApplyForeignKeyDdl,
  onSendToEditor,
  types,
  collations,
}: Props) {
  return (
    <div className="structure">
      {loading ? (
        <div className="structure-loading">
          <span className="spinner accent" /> 構造を読み込み中…
        </div>
      ) : !detail ? (
        <div className="structure-loading">
          定義を取得できませんでした (再読み込みを試してください)
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
            prod={prod}
            tableLabel={tableLabel}
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
            prod={prod}
            tableLabel={tableLabel}
            resetKey={resetKey}
            onApply={onApplyIndexDdl}
            onPreview={onPreviewIndexDdl}
            onSendToEditor={onSendToEditor}
          />

          <ForeignKeyGrid
            foreignKeys={detail.foreignKeys ?? []}
            tableColumns={detail.columns}
            canEdit={canEdit}
            dbType={dbType}
            prod={prod}
            tableLabel={tableLabel}
            resetKey={resetKey}
            onApply={onApplyForeignKeyDdl}
          />
        </>
      )}
    </div>
  );
}
