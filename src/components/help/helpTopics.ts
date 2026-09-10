/**
 * ヘルプに出す話題。
 *
 * 画面 (HelpDialog) とは分けてあるので、話題を足すのはこのファイルだけで済む。
 * つないでいるDBによって中身が変わるものは、DBの種類を受け取って組み立てる
 */
import type { DbType } from "../../types";

/** 見出しと中身のひとまとまり */
export interface HelpSection {
  title: string;
  lines: string[];
}

/** 左の一覧に並ぶ話題1つ */
export interface HelpTopic {
  /** 覚えておく目印 */
  id: string;
  /** 一覧に出す名前 */
  label: string;
  /** 一覧の名前の下に出す一言 */
  note: string;
  /** この話が当てはまるDB (空なら、どのDBでも出す) */
  dbTypes?: DbType[];
  /** 右に出す中身 */
  sections: (dbType: DbType) => HelpSection[];
}

// ---------- 照合順序 ----------

/**
 * 照合順序そのものの説明。
 *
 * 「同じとみなす」の話は、大文字小文字を選べる MySQL のときだけ出す
 * (PostgreSQL はいつも区別するので、選べない話を書いても迷わせるだけ)
 */
function common(pg: boolean): HelpSection {
  return {
    title: "照合順序とは",
    lines: pg
      ? [
          "文字を「どの順に並べるか」の決まりです。",
          "並び替え (ORDER BY)、大小の比較 (< や BETWEEN)、インデックスの並び順が、この設定で決まります。",
        ]
      : [
          "文字を「同じとみなすか」「どの順に並べるか」の決まりです。",
          "効くのは、並び替え (ORDER BY)、一致の判定 (= / LIKE / IN)、まとめ方 (DISTINCT / GROUP BY)、重複の判定 (UNIQUE)、そしてインデックスの並び順です。",
          "例えば大文字小文字を区別しない設定では、WHERE name = 'ABC' が abc にも当たります。SELECT DISTINCT でも abc と ABC は1つにまとまり、UNIQUE 制約は2つ目を重複として弾きます。",
        ],
  };
}

const MYSQL: HelpSection[] = [
  {
    title: "文字コードに属します",
    lines: [
      "照合順序は文字コード (CHARACTER SET) ごとに決まっているので、先に文字コードを選びます。utf8mb4 を選べば utf8mb4_ で始まるものだけが使えます。",
      "utf8 (utf8mb3) は絵文字や一部の漢字が入らないので、新しく作るときは utf8mb4 を選びます。",
    ],
  },
  {
    title: "名前の読み方",
    lines: [
      "utf8mb4_ja_0900_as_cs のように「文字コード_規則や言語_属性」でできています。",
      "0900 は Unicode 9.0.0 の並び順の規則という意味で、MySQL 8 から使えます。ja が付くものは日本語向けに調整されたものです。",
      "_ci … 大文字と小文字を区別しない (case insensitive)",
      "_cs … 大文字と小文字を区別する (case sensitive)",
      "_ai … 濁点やアクセントを区別しない (accent insensitive) / _as … 区別する",
      "_bin … バイト列そのままで比べる (何も同じとみなさない)",
      "属性が書いていないもの (utf8mb4_unicode_ci など) は、_ai_ci と同じ扱いです。",
    ],
  },
  {
    title: "よく使うもの",
    lines: [
      "utf8mb4_0900_ai_ci … MySQL 8 の既定。大小もアクセントも区別せず、速い",
      "utf8mb4_ja_0900_as_cs … 日本語向け。濁点も大小も区別する",
      "utf8mb4_bin … 打ったとおりに一致させたいとき (ID・コード・パスワードのハッシュなど)",
      "utf8mb4_general_ci … MariaDB や MySQL 5.7 でよく使われるもの。英字の大小だけを同じとみなす",
      "utf8mb4_unicode_ci … こちらも 5.7 系でよく使われるもの。Unicode の規則で、濁点や全角半角まで同じとみなす",
    ],
  },
  {
    title: "日本語での落とし穴",
    lines: [
      "_ai_ci のもの (utf8mb4_0900_ai_ci / utf8mb4_unicode_ci など) は、次をすべて「同じ文字」として扱います。",
      "は と ば / ア と ｱ (全角と半角) / あ と ア (ひらがなとカタカナ) / a と ａ",
      "そのため「ハト」で探すと「バド」や「ﾊﾄ」も当たり、UNIQUE 制約では「はと」と「ハト」を別々に登録できません。",
      "区別したいときは utf8mb4_ja_0900_as_cs (日本語向け) か utf8mb4_bin を選びます。",
      "utf8mb4_general_ci は、英字の大小だけを同じとみなし、濁点・全角半角・ひらがなカタカナは区別します。",
    ],
  },
  {
    title: "並び順の例",
    lines: [
      "a / A / B / b を並べ替えると、次のように変わります。",
      "_ci のもの … a A B b (大小を無視するので、a と A が隣り合う)",
      "utf8mb4_bin … A B a b (文字の番号順なので、大文字がすべて先に来る)",
    ],
  },
  {
    title: "どこで決まるか",
    lines: [
      "サーバー → データベース → テーブル → 列 の順に引き継ぎます。途中で指定すれば、そこから下が変わります。",
      "列に何も指定していなければ、テーブルの照合順序が使われます。テーブルを作ったあとにデータベースの照合順序を変えても、すでにある列は変わりません。",
      "テーブルの定義画面では、列ごとに照合順序を選べます。",
    ],
  },
  {
    title: "気をつけること",
    lines: [
      "違う照合順序の列どうしを比べると「Illegal mix of collations」で止まることがあります。同じ系統でそろえておくのが安全です。",
      "あとから変えられますが、その列を使っているインデックスは作り直しになります。大きなテーブルでは時間がかかります。",
      "大小を区別しない設定は探すのが楽な代わりに、「ID」と「id」を別のものとして持てなくなります。コードや識別子の列だけ utf8mb4_bin にする、という使い分けもできます。",
    ],
  },
];

const POSTGRESQL: HelpSection[] = [
  {
    title: "OSのロケールを指定します",
    lines: [
      "PostgreSQL の照合順序は LC_COLLATE (並び順) で決めます。選べるのは、サーバーのOSに入っているロケールだけです。",
      "この一覧はつないでいるサーバーに聞いたものなので、ここに無いものは指定できません (例えば ja_JP.utf8 が入っていないサーバーでは選べません)。",
      "文字の種類の扱い (LC_CTYPE) はここでは指定せず、テンプレートのものを引き継ぎます。",
      "指定するとテンプレートを template0 に切り替えて作ります (template1 と違うロケールでは作れないため)。",
    ],
  },
  {
    title: "よく使うもの",
    lines: [
      "C / POSIX … 文字の番号順で並べます。速く、どの環境でも同じ結果になります。日本語は辞書順にはなりません",
      "C.utf8 … C とほぼ同じ (文字の扱いだけ UTF-8)",
      "ja_JP.utf8 … 日本語の辞書順。OSに入っている場合だけ選べます",
    ],
  },
  {
    title: "並び順の例",
    lines: [
      "C で a / A / B / b を並べ替えると A B a b になります。文字の番号順なので、大文字がすべて先に来ます。",
      "C で A / あ / ア / 亜 を並べ替えると A あ ア 亜 になります。Unicode の番号順であって、五十音順や画数順ではありません。",
      "日本語を辞書順にしたいときは ja_JP.utf8 のようなロケールを選びます (サーバーのOSに入っていれば)。",
    ],
  },
  {
    title: "大文字小文字は必ず区別します",
    lines: [
      "MySQL と違い、PostgreSQL の比較はいつも大文字小文字を区別します。'abc' = 'ABC' は偽です。",
      "区別せずに探したいときは ILIKE、lower() での比較、citext 型などを使います。",
      "並び順を決めるロケールを変えても、= の判定が大文字小文字を無視するようにはなりません。",
    ],
  },
  {
    title: "速さとインデックス",
    lines: [
      "C は比較の決まりが単純なので、ロケールを使うものより速く並べ替えられます。",
      "C 以外のロケールのデータベースでは、LIKE 'abc%' の前方一致にふつうのインデックスが使われません。使わせたいときは text_pattern_ops を付けたインデックスを別に作ります。",
    ],
  },
  {
    title: "気をつけること",
    lines: [
      "データベースの照合順序は、作ったあとから変えられません。変えるには作り直してデータを移します。",
      '列や比較のたびに COLLATE "C" のように切り替えることはできます。',
      '例: ORDER BY name COLLATE "C"',
      "OS の libc を更新すると並び順が変わることがあり、そのままだとインデックスとずれます (REINDEX が要ります)。",
      "PostgreSQL 15 以降は ICU も使えますが、この画面では扱いません。",
    ],
  },
];

const COLLATION: HelpTopic = {
  id: "collation",
  label: "照合順序",
  note: "並び順と、同じとみなす文字",
  // SQLite は型の一部、Valkey には無い考え方なので出さない
  dbTypes: ["mysql", "postgresql"],
  sections: (dbType) => {
    const pg = dbType === "postgresql";
    return [common(pg), ...(pg ? POSTGRESQL : MYSQL)];
  },
};

/** 出せる話題 (増やすときはここに足す) */
const TOPICS: HelpTopic[] = [COLLATION];

/** そのDBで出せる話題だけを返す */
export function topicsFor(dbType: DbType): HelpTopic[] {
  return TOPICS.filter((t) => !t.dbTypes || t.dbTypes.includes(dbType));
}
