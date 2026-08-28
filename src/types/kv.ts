/**
 * Valkey (KVモード) で扱う値。
 * SQLのDBとは形がまったく違うので分けている
 */

/** Valkeyの値ビュー1行 (1列目=field / 2列目=value) */
export interface KvRow {
  field: string;
  value: string;
}

/** Valkeyのキーに対する変更内容 */
export type KvChange =
  | { kind: "update"; key: string; kvType: string; before: KvRow; after: KvRow }
  | { kind: "insert"; key: string; kvType: string; row: KvRow }
  | { kind: "remove"; key: string; kvType: string; row: KvRow }
  | { kind: "deleteKey"; key: string }
  | { kind: "rename"; key: string; newKey: string }
  /** ttlは秒。0以下で無期限に戻す */
  | { kind: "expire"; key: string; ttl: number }
  | { kind: "createKey"; key: string; kvType: string; row: KvRow };

/** 1タブの状態。未接続なら接続選択画面、接続後はDBブラウザになる */
/** Valkeyキーブラウザの状態 (タブを切り替えても復元できるように保持する) */
export interface KvBrowseState {
  /** この内容がどのDB番号のものか (DB切替時に誤って復元しないため) */
  db: string;
  pattern: string;
  keys: KvKeyInfo[];
  /** SCANの続きを読むためのカーソル */
  cursor: string;
  done: boolean;
  dbsize: number;
  selectedKey: string | null;
}

/** キー一覧の1件 */
export interface KvKeyInfo {
  key: string;
  type: string;
  /** 残りTTL秒 (-1: 無期限 / -2: 消滅) */
  ttl: number;
}

/** SCAN 1ページぶんの結果 */
export interface KvScanResult {
  entries: KvKeyInfo[];
  /** 続きを読むカーソル ("0"で終端) */
  cursor: string;
  done: boolean;
  /** 選択中DBの総キー数 */
  dbsize: number;
}

/** キー詳細 (型・TTL・値プレビュー) */
export interface KvKeyDetail {
  key: string;
  type: string;
  ttl: number;
  memory: number | null;
  encoding: string | null;
  /** 総要素数 (stringはバイト長) */
  total: number;
  /** 値ビューの列ラベル */
  cols: [string, string];
  rows: [string, string][];
  truncated: boolean;
}

/** コマンド1つの実行結果 */
export interface KvStatementResult {
  command: string;
  /** redis-cli風の整形済み出力 */
  lines: string[];
  elapsedMs: number;
}

/** コマンド実行 (複数行) の全体結果 */
export interface KvRunOutput {
  statements: KvStatementResult[];
  error?: string;
  failedIndex?: number;
}

/** パターンに一致するキーを数えた結果 */
export interface KvCountResult {
  /** 一致したキーの数 */
  total: number;
  /** 先頭いくつかのキー名 */
  sample: string[];
  cancelled: boolean;
  /** 上限まで読んだので、まだ先がある */
  truncated: boolean;
}

/** キーの一括削除の結果 */
export interface KvDeleteResult {
  deleted: number;
  cancelled: boolean;
  truncated: boolean;
}

/** 値検索の当たり */
export interface KvSearchHit {
  key: string;
  type: string;
  /** 当たった場所 (hashのフィールド名・listの位置など) */
  field: string;
  /** 当たった値の先頭 */
  preview: string;
}

/** 値検索の結果 */
export interface KvSearchResult {
  hits: KvSearchHit[];
  /** 見に行ったキーの数 */
  scanned: number;
  cancelled: boolean;
  /** 上限に達して打ち切った */
  truncated: boolean;
}

/** 値検索の条件 */
export interface KvSearchOptions {
  /** 探す文字列 */
  needle: string;
  /** 大文字小文字を区別しない */
  ignoreCase: boolean;
  /** キー名も探す対象にする */
  includeKeys: boolean;
}
