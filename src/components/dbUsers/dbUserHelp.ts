/**
 * ユーザーと権限のヘルプに出す文言。
 *
 * MySQL と PostgreSQL は、同じ「ユーザー」「権限」という言葉でも
 * 指しているものが違う。両方をここに書いておき、
 * **つないでいる側だけ**を画面に出す
 * (使っていないほうの決まりを並べても、読む手間が増えるだけなので)。
 *
 * 権限の意味は、権限を選ぶときの吹き出しからも使う
 */
import type { DbGrantScope } from "../../types";

/** 説明1つ (何について / その中身) */
export interface HelpRow {
  about: string;
  text: string;
}

/** 両方ぶんを持っておき、出すときに片方だけ取り出す */
interface BothRow {
  about: string;
  mysql: string;
  pg: string;
}

/** そのDBの決まり */
const RULES: BothRow[] = [
  {
    about: "1人の決まり方",
    mysql:
      "名前 + 接続元ホストで1人です。app@% と app@localhost は別人で、権限も別々に付きます。% はどこからでも、localhost はサーバー上からだけを表します",
    pg: "名前だけで決まります。どこから繋いでよいかは、サーバーの設定ファイル (pg_hba.conf) 側で決めるため、この画面では扱えません",
  },
  {
    about: "ユーザーとグループ",
    mysql:
      "ユーザーとロールは別のものです (ロールが使えるのは MySQL 8.0 / MariaDB 10.0.5 以降)",
    pg: "どちらもロールで、区別はありません。ログインできるロールがユーザーに当たり、ログインできないロールは権限をまとめるグループとして使えます",
  },
  {
    about: "権限の段",
    mysql:
      "サーバー全体 → データベース → テーブル → 列 の順に細かくなります。上の段で付けた権限は、その下すべてに効きます",
    pg: "データベース → スキーマ → テーブル → 列 の順に細かくなります。サーバー全体にあたる権限は、ロールの属性 (ロール作成可・DB作成可など) で決めます",
  },
  {
    about: "テーブルを読ませるには",
    mysql:
      "そのテーブル (またはデータベース) に SELECT を付ければ読めます",
    pg: "テーブルの SELECT だけでは足りません。入れ物であるスキーマの USAGE と、データベースの CONNECT も要ります",
  },
  {
    about: "見える範囲",
    mysql:
      "どのデータベースに対する権限も、今どこへ繋いでいるかに関わらず見えますし、付けられます",
    pg: "スキーマから下 (スキーマ・テーブル・列) は、今つないでいるデータベースのぶんだけです。ほかのデータベースのぶんは、そちらへ接続すると見られます",
  },
  {
    about: "入れないようにする",
    mysql:
      "アカウントに錠を掛けます (ACCOUNT LOCK)。権限はそのまま残るので、あとから戻せます",
    pg: "ログインの属性を外します (NOLOGIN)。権限と持ち物はそのまま残るので、あとから戻せます",
  },
  {
    about: "削除",
    mysql:
      "そのまま消せます。与えていた権限も一緒に消えますが、データそのものは残ります",
    pg: "権限か持ち物が1つでも残っていると消せません。この画面では先に片付けてから消しますが、効くのは今つないでいるデータベースのぶんだけです。ほかのデータベースにも残っている場合は、そちらへ接続してからもう一度消してください",
  },
  {
    about: "取り消し",
    mysql:
      "作成や権限の変更は、その場で確定します。あとから戻せないので、実行する前のSQLを確かめてください",
    pg: "ひとまとまりとして扱われるため、途中で失敗すれば元に戻ります",
  },
  {
    about: "有効期限",
    mysql:
      "期限そのものはありません (パスワードを期限切れにする指定はあります)",
    pg: "日付を決められます (VALID UNTIL)。その日を過ぎるとログインできなくなります",
  },
];

/** つないでいるDBの決まりだけを取り出す */
export function rules(pg: boolean): HelpRow[] {
  return RULES.map((r) => ({ about: r.about, text: pg ? r.pg : r.mysql }));
}

/** この画面での扱い (DBの決まりではなく、Quelio側の約束) */
export function screenNotes(pg: boolean): string[] {
  const common = [
    "一覧と権限の表示は読むだけなので、読み取り専用の接続でも使えます",
    "サーバーが用意したユーザーと、今つないでいる自分自身は変更できません (直す手立てまで一緒に失わないため)",
    "変更する前に、実行するSQLをそのまま出します。パスワードは記録に残さないよう伏せますが、サーバーへはそのまま送られます",
    "列に付いた権限と「今後作る物の既定」は、表示だけで付け外しはできません",
  ];
  return pg
    ? common
    : [
        ...common,
        "存在しないデータベースにも権限を付けられてしまうため、対象は一覧から選ぶようにしています",
      ];
}

/**
 * DBによって意味が違う権限。
 *
 * 同じ `USAGE` でも、MySQL は「権限が無い」という印で、
 * PostgreSQL は「その入れ物を使ってよい」という本物の権限。
 * 取り違えると読み方をまるごと間違えるので、DBごとに分けて持つ
 */
const BY_DB: Record<string, { mysql: string; pg: string }> = {
  USAGE: {
    mysql:
      "権限が無いことを表す印。アカウントがあることだけを示すもので、外せません",
    pg: "その入れ物の中身を使えるようにする (中を見る許しではない)",
  },
};

/** 権限の名前とその意味 */
const NOTES: Record<string, string> = {
  "ALL PRIVILEGES": "その範囲でできることを全部",
  SELECT: "行を読む",
  INSERT: "行を足す",
  UPDATE: "行を書き換える",
  DELETE: "行を消す",
  TRUNCATE: "テーブルの中身を一気に空にする",
  CREATE: "作る (データベース・テーブルなど)",
  DROP: "消す (テーブル・データベースなど)",
  ALTER: "定義を変える",
  INDEX: "索引を作る・消す",
  REFERENCES: "外部キーの参照先にする",
  TRIGGER: "トリガを作る・消す",
  "CREATE VIEW": "ビューを作る",
  "SHOW VIEW": "ビューの定義を見る",
  "CREATE ROUTINE": "関数・手続きを作る",
  "ALTER ROUTINE": "関数・手続きを変える・消す",
  EXECUTE: "関数・手続きを実行する",
  EVENT: "イベント (定時実行) を扱う",
  "CREATE TEMPORARY TABLES": "一時テーブルを作る",
  "LOCK TABLES": "テーブルに鍵を掛ける",
  RELOAD: "設定や権限を読み直す (FLUSH)",
  PROCESS: "ほかの接続と実行中のSQLを見る",
  "SHOW DATABASES": "データベースの一覧を見る",
  "REPLICATION CLIENT": "複製の状態を見る",
  "REPLICATION SLAVE": "複製を受け取る",
  "CREATE USER": "ユーザーを作る・変える・消す",
  CONNECT: "そのデータベースへ接続する",
  TEMPORARY: "一時テーブルを作る",
};

/** その権限の意味 (分からないものは空) */
export function noteFor(privilege: string, pg = false): string {
  const name = privilege.toUpperCase();
  const both = BY_DB[name];
  if (both) return pg ? both.pg : both.mysql;
  return NOTES[name] ?? "";
}

/**
 * 一覧には出てくるが、この画面からは付け外しできない権限。
 *
 * MySQL の `USAGE` は、サーバー全体の権限が何も無いときに必ず出てくる。
 * 説明が無いと「見慣れない権限が付いている」と読めてしまうので、
 * ヘルプにも載せておく
 */
export function readOnlyPrivileges(pg: boolean): string[] {
  return pg ? [] : ["USAGE"];
}

/** 権限の範囲を、画面に出す言い方にする */
export const SCOPE_HELP: Record<DbGrantScope, string> = {
  server: "サーバー全体に効きます",
  database: "そのデータベースの中すべてに効きます",
  schema: "そのスキーマの中すべてに効きます",
  table: "そのテーブルだけに効きます",
  column: "その列だけに効きます",
  default: "これから作る物に、自動で付く権限です",
};
