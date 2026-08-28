/**
 * 接続先の設定と、つないだ結果。
 * 保存される内容 (接続情報・フォルダ・並び順) もここ
 */

/** 対応DB種別 (sqliteはファイルベースで、databaseにファイルパスを入れる) */
export type DbType = "mysql" | "postgresql" | "sqlite" | "valkey";

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  passphrase?: string;
}

/** MySQL / PostgreSQL のTLSの使い方 */
export type SslMode = "" | "disable" | "require" | "verify-ca" | "verify-full";

/** TLSの選択肢 (値 → 画面に出す説明) */
export const SSL_MODES: [SslMode, string][] = [
  ["", "既定 (使えれば使う。証明書は検証しない)"],
  ["disable", "使わない"],
  ["require", "必須 (検証なし)"],
  ["verify-ca", "必須 + CA証明書を検証"],
  ["verify-full", "必須 + CA証明書とホスト名を検証"],
];

/** 相手が本物かを確かめない設定か (画面で注意を出すのに使う) */
export function tlsUnverified(mode: SslMode | undefined): boolean {
  return mode === "" || mode === undefined || mode === "disable" || mode === "require";
}

export interface ConnectionProfile {
  id: string;
  name: string;
  dbType: DbType;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  /** TLSで接続する (Valkey用。AWS ElastiCache等のin-transit暗号化) */
  tls?: boolean;
  /**
   * MySQL / PostgreSQL のTLSの使い方。
   * 未設定はドライバの既定 (使えれば使う・証明書は検証しない)
   */
  sslMode?: SslMode;
  /** サーバー証明書の検証に使うCA証明書 (PEM) のパス */
  caCertPath?: string;
  /** クライアント証明書 (PEM) のパス */
  clientCertPath?: string;
  /** クライアント証明書の秘密鍵 (PEM) のパス */
  clientKeyPath?: string;
  /** 読み取り専用で接続する (更新系の操作をすべて拒否する) */
  readOnly?: boolean;
  ssh?: SshConfig;
  /** 所属フォルダID (未設定ならルート直下) */
  folderId?: string;
  /** アイコン色 (#rrggbb。未設定ならDB種別ごとの既定色) */
  color?: string;
  /**
   * 保存されたパスワード・パスフレーズを復号できなかった。
   * (マスターキーが変わった等) この場合は接続できないため、入力し直してもらう
   */
  passwordLocked?: boolean;
  /**
   * パスワードが保存済みで、画面には渡されていない (伏せてある)。
   *
   * 入力欄に触るまでは空のまま保ち、この目印を付けて返すと
   * バックエンドが保存済みの値を使う
   */
  passwordSaved?: boolean;
  /** SSHのパスフレーズについて、passwordSaved と同じもの */
  passphraseSaved?: boolean;
}

export interface FolderInfo {
  id: string;
  name: string;
  collapsed: boolean;
  /** アイコン色 (#rrggbb。未設定なら既定のアンバー) */
  color?: string;
}

/** 保存される接続先一式 (配列順 = 表示順) */
export interface ConnectionStore {
  folders: FolderInfo[];
  connections: ConnectionProfile[];
  /** ルート階層の表示順 (フォルダIDとフォルダ未所属の接続IDが混在)。
   *  未設定なら「フォルダ → 接続」の順で表示する */
  rootOrder?: string[];
}

/** 並べ替え保存用エントリ */
export interface LayoutEntry {
  id: string;
  folderId?: string;
}

export interface ConnectInfo {
  databases: string[];
  currentDb?: string;
  /** サーバー情報 (ラベルと値の組) */
  serverInfo: [string, string][];
}

export const DEFAULT_PORTS: Record<DbType, number> = {
  mysql: 3306,
  postgresql: 5432,
  // SQLiteはファイルを直接開くためポートを使わない
  sqlite: 0,
  valkey: 6379,
};

export function emptyProfile(): ConnectionProfile {
  return {
    id: "",
    name: "",
    dbType: "mysql",
    host: "localhost",
    port: DEFAULT_PORTS.mysql,
    user: "",
    password: "",
    database: "",
    tls: false,
    ssh: emptySsh(),
  };
}

export function emptySsh(): SshConfig {
  return {
    enabled: false,
    host: "",
    port: 22,
    user: "",
    keyPath: "",
    passphrase: "",
  };
}

export interface TestResult {
  success: boolean;
  message: string;
  serverVersion?: string;
  elapsedMs: number;
}

/** 開いているセッションの概要 (差分ビューア用) */
export interface SessionSummary {
  sessionId: string;
  /** 接続プロファイルのID (ER図の保存キーなどに使う) */
  profileId: string;
  name: string;
  dbType: DbType;
  databases: string[];
  currentDb?: string;
}
