/**
 * DBのユーザーと権限の型 (バックエンドの catalog::users と対)。
 *
 * PostgreSQL には「ユーザー」と「グループ」の区別が無く、
 * ログインできるロールがユーザーに当たる。
 * MySQL は「名前 + 接続元ホスト」の2つ組で1人になる。
 * その違いを吸収した形をここで受け取る
 */

/** ユーザー1人 (PostgreSQL ではロール1つ) */
export interface DbUser {
  name: string;
  /** 接続元ホスト (MySQLのみ。PostgreSQLでは空) */
  host: string;
  /** 権限を引くときの呼び名 (MySQLは `'名前'@'ホスト'`、PostgreSQLは名前) */
  key: string;
  /** ログインできるか (できないものはグループ用のロール) */
  canLogin: boolean;
  /** 何でもできる管理者か */
  superuser: boolean;
  /** サーバーが用意したもの (触ってはいけない) */
  system: boolean;
  /** 今この画面がつないでいるユーザーか */
  isSelf: boolean;
  /** 画面に出す短い印 */
  badges: string[];
  /** 所属しているロール */
  memberOf: string[];
  /** 同時接続の上限 (無制限なら空) */
  connLimit: string;
  /** 有効期限 (無ければ空) */
  expires: string;
  /** 認証の方式 (MySQLのplugin) */
  auth: string;
}

/** 権限が効く範囲 */
export type DbGrantScope =
  | "server"
  | "database"
  | "schema"
  | "table"
  | "column"
  | "default";

/** 権限1つ */
export interface DbGrant {
  scope: DbGrantScope;
  /** 対象の名前 (`*.*` や `db.表.列` など) */
  target: string;
  /** 権限の名前 (SELECT など) */
  privilege: string;
  /** 他人に渡せるか */
  grantable: boolean;
}

/** 一覧の取得結果 */
export interface DbUsersInfo {
  users: DbUser[];
  /** 今つないでいるユーザーの呼び名 */
  current: string;
  /** 全部は見られなかったときの理由 (見えたときは空) */
  note: string;
  /** この接続でユーザーを作ったり変えたりできるか */
  canManage: boolean;
  /** できないとき、その理由 (できるときは空) */
  manageNote: string;
}

/** 権限を付け外しするときに指定する範囲 (バックエンドの dbuser::Scope と対) */
export type DbGrantTarget = "server" | "database" | "schema" | "table";

/** ユーザーの指定 (MySQLは接続元ホストまで含めて1人) */
export interface DbUserRef {
  name: string;
  /** 接続元ホスト (MySQLのみ。PostgreSQLでは空) */
  host: string;
}

/** 新しく作るユーザーの中身 */
export interface NewDbUser {
  name: string;
  host: string;
  password: string;
  /** ログインできるようにするか (PostgreSQLのみ) */
  canLogin: boolean;
  /** ロールを作れるようにするか (PostgreSQLのみ) */
  createRole: boolean;
  /** データベースを作れるようにするか (PostgreSQLのみ) */
  createDb: boolean;
  /** 同時接続の上限 (空なら決めない) */
  connLimit: string;
  /** 有効期限 (`2027-01-01` の形。空なら決めない) */
  expires: string;
}

/** 権限を1つ付ける / 外すときの指定 */
export interface DbGrantSpec {
  scope: DbGrantTarget;
  /** 対象 (`db` / `スキーマ.表` など。サーバー全体なら空) */
  target: string;
  privileges: string[];
  /** 他人へ渡せるようにするか */
  grantable: boolean;
}

/** 範囲ごとに選べる権限の名前 */
export interface DbPrivilegeChoices {
  server: string[];
  database: string[];
  schema: string[];
  table: string[];
}

/**
 * ユーザーに対する変更1つぶん (バックエンドの dbuser::UserChange と対)。
 *
 * 「実行せずにSQLだけ見る」と「実行する」で同じ形を使う。
 * 確認で見せたSQLと、実際に流すSQLがずれないようにするため
 */
export type DbUserChange =
  | { kind: "create"; spec: NewDbUser }
  | { kind: "password"; user: DbUserRef; password: string }
  | { kind: "rename"; user: DbUserRef; name: string }
  | { kind: "lock"; user: DbUserRef; locked: boolean }
  | { kind: "drop"; user: DbUserRef; cleanup: boolean }
  | { kind: "grant"; user: DbUserRef; spec: DbGrantSpec; add: boolean }
  | { kind: "role"; user: DbUserRef; role: string; add: boolean };
