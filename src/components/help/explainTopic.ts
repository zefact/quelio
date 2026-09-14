/**
 * ヘルプ: 実行計画 (EXPLAIN / ANALYZE)。
 *
 * 出てくる言葉も、出る形 (表か木か) もDBごとに別物なので、
 * 共通の説明は入口だけにして、あとはDBごとに分けて書く。
 * 「言葉と意味」が並ぶところは表にする (文章で並べると読み飛ばされる)
 */
import type { HelpSection, HelpTopic } from "./helpTypes";

// ---------- MySQL / MariaDB ----------

const MYSQL: HelpSection[] = [
  {
    title: "2つのボタンの違い",
    lines: [
      "どちらも「サーバーがこのSQLをどう読むつもりか」を見るものです。違いは、実際に走らせるかどうかです。",
    ],
    table: {
      head: ["ボタン", "すること", "注意"],
      rows: [
        [
          "EXPLAIN",
          "実行せずに、立てた計画だけを見せる",
          "件数はすべて統計からの見積もり。実測ではない",
        ],
        [
          "ANALYZE",
          "実際に実行して、本当に読んだ件数を計画と並べて出す",
          "SELECT などの参照系だけ。重いSQLはそのぶん待つ",
        ],
      ],
    },
  },
  {
    title: "表の列の意味",
    lines: [
      "1行が「どの表を、どうやって読むか」です。上から順に読み、上の行の結果が下の行へ渡ります。",
    ],
    table: {
      head: ["列", "意味"],
      rows: [
        [
          "id",
          "何番目のSELECTか。同じ番号なら同じSELECTの中の話。番号が大きいものほど内側 (先に動く副問い合わせ)",
        ],
        [
          "select_type",
          "SELECTの種類。SIMPLE=副問い合わせ無し / PRIMARY=外側 / SUBQUERY / DERIVED=FROMの中 / UNION / MATERIALIZED",
        ],
        [
          "table",
          "読む表。別名を付けていれば別名。<derived2> は2番目のSELECTを一時表にしたもの",
        ],
        ["type", "どうやって行を取り出すか。計画のいちばんの見どころ (下の表)"],
        ["possible_keys", "使えそうなインデックスの候補。NULL なら候補すら無い"],
        ["key", "実際に使うインデックス。NULL なら全件読み"],
        [
          "key_len",
          "インデックスのうち何バイトぶん使えたか。複合インデックスがどこまで効いたか分かる",
        ],
        ["ref", "インデックスと突き合わせる相手。const=定数 / 表.列=その列の値"],
        ["rows", "読むと見積もった行数 (実測ではない)"],
        [
          "filtered",
          "rows のうち条件で残ると見積もった割合 (%)。rows × filtered が次の表へ渡る行数",
        ],
        ["partitions", "読むパーティション (MySQL 8)"],
        ["Extra", "上のどれにも入らない補足。ここに遅さの理由が出る (下の表)"],
      ],
    },
  },
  {
    title: "type の意味 (上ほど速い)",
    table: {
      head: ["type", "意味"],
      rows: [
        [
          "system / const",
          "1行だけに決まる。主キー・一意キーへ定数を当てたとき。いちばん速い",
        ],
        [
          "eq_ref",
          "結合の相手を主キー・一意キーで1行ずつ引く。結合では理想形",
        ],
        [
          "ref",
          "一意でないインデックスでの等値検索。複数行が返る。実用上はここまでが良い状態",
        ],
        [
          "range",
          "範囲での検索 (BETWEEN / > / IN / LIKE 'abc%')。絞れていれば十分速い",
        ],
        [
          "index_merge",
          "複数のインデックスの結果を合わせた。1本の複合インデックスにできないか検討する",
        ],
        [
          "index",
          "インデックス全体を頭から読む。全件読みより軽いが、絞れてはいない",
        ],
        [
          "ALL",
          "表を全件読む。小さい表なら問題ないが、大きい表ならインデックスを疑う所",
        ],
      ],
    },
  },
  {
    title: "Extra によく出るもの",
    table: {
      head: ["表示", "意味"],
      rows: [
        [
          "Using index",
          "表本体を読まず、インデックスだけで答えが作れた (カバリングインデックス)。速い合図",
        ],
        [
          "Using where",
          "取り出したあとに WHERE でふるいにかけた。type=ALL と一緒なら、絞り込みがインデックスまで届いていない",
        ],
        [
          "Using index condition",
          "WHERE の一部をインデックス側で判定した。表本体を読む回数が減る",
        ],
        [
          "Using filesort",
          "並べ替えを別に行った。インデックスの並び順が ORDER BY と合っていない",
        ],
        [
          "Using temporary",
          "一時表を作った。GROUP BY と ORDER BY の列が違うときなどに出る",
        ],
        [
          "Using join buffer",
          "結合相手に使えるインデックスが無く、まとめてメモリ上で突き合わせた。結合列のインデックスを疑う",
        ],
        ["Impossible WHERE", "条件が必ず偽になるので、表を読まない"],
        [
          "Select tables optimized away",
          "統計や索引だけで答えが出たので表を読まなかった (MIN/MAX や COUNT(*) など)",
        ],
        ["Using index for group-by", "GROUP BY をインデックスだけで済ませた"],
        [
          "Using MRR",
          "インデックスで見つけた位置を並べ替えてから表を読んだ (ディスクの読み方を揃えるため)",
        ],
      ],
    },
  },
  {
    title: "ANALYZE で増える列",
    lines: [
      "MariaDB では、見積もりの隣に実測が並びます (MySQL 8 の EXPLAIN ANALYZE は木の形で出ます)。",
    ],
    table: {
      head: ["列", "意味"],
      rows: [
        [
          "r_rows",
          "実際に読んだ行数。rows (見積もり) と桁が違うなら統計が古い可能性が高い",
        ],
        [
          "r_filtered",
          "実際に条件を通った割合 (%)。filtered との差が、そのまま見積もりのずれ",
        ],
      ],
    },
  },
  {
    title: "どこから見るか",
    lines: [
      "1. type が ALL か index になっている行を探します。そこが全件読みです。",
      "2. rows が大きい行を見ます。結合では、上の表の rows × filtered が下の表を引く回数になるので、上ほど影響が大きくなります。",
      "3. Extra の Using filesort / Using temporary を見ます。並べ替えとまとめ方の作り直しで消せることがあります。",
      "4. key が NULL の行は、WHERE や JOIN に使っている列にインデックスがあるかを確かめます。",
      "5. ANALYZE の r_rows が rows と桁違いなら、まず ANALYZE TABLE で統計を取り直します。",
    ],
  },
  {
    title: "よくある直し方",
    table: {
      head: ["気づいたこと", "直し方"],
      rows: [
        [
          "type が ALL",
          "WHERE と JOIN に使う列にインデックスを作る。複合は「等値で使う列 → 範囲で使う列 → 並べ替えの列」の順",
        ],
        [
          "インデックスがあるのに使われない",
          "列に関数を掛けていないか確認する。WHERE DATE(created_at)='2026-01-01' は created_at >= '2026-01-01' AND created_at < '2026-01-02' に書き換える",
        ],
        [
          "型が違うまま比べている",
          "文字列の列に数値を渡すなど。型をそろえるとインデックスが効くようになる",
        ],
        [
          "LIKE '%abc%' が遅い",
          "中間一致はインデックスが効かない。前方一致にするか、全文検索インデックスを検討する",
        ],
        [
          "Using filesort が出る",
          "ORDER BY の列を含む複合インデックスを作る。並べ替えの向き (ASC / DESC) もそろえる",
        ],
        [
          "Using index にしたい",
          "SELECT * をやめて要る列だけにすると、インデックスだけで済む形にできることがある",
        ],
        [
          "OR で全件読みになる",
          "index_merge か全件読みになりがち。UNION ALL に分けると、それぞれでインデックスが効くことがある",
        ],
      ],
    },
  },
];

// ---------- PostgreSQL ----------

const POSTGRESQL: HelpSection[] = [
  {
    title: "2つのボタンの違い",
    lines: [
      "どちらも「プランナがこのSQLをどう読むつもりか」を見るものです。違いは、実際に走らせるかどうかです。",
    ],
    table: {
      head: ["ボタン", "すること", "注意"],
      rows: [
        [
          "EXPLAIN",
          "実行せずに、選んだ計画だけを見せる",
          "出てくる数はすべて見積もり",
        ],
        [
          "ANALYZE",
          "実際に実行して、時間と本当の行数 (actual) を併記する",
          "SELECT などの参照系だけ。書き込みを含むSQLでは使えない",
        ],
      ],
    },
  },
  {
    title: "木の読み方",
    lines: [
      "行頭の -> で入れ子になっています。字下げが深いほど内側で、内側が先に動きます。",
      "内側の結果を外側が受け取り、いちばん上の行が最終結果です。読むときは下から上へたどります。",
      "例: Seq Scan on orders o  (cost=0.00..771.00 rows=50000 width=8) (actual time=0.011..4.180 rows=50000 loops=1)",
    ],
    table: {
      head: ["書かれているもの", "意味"],
      rows: [
        [
          "cost=起動..総",
          "「1ページを順に読む手間」を1とした相対値。秒ではなく、計画どうしを比べるための数",
        ],
        [
          "起動コスト",
          "最初の1行が出るまでの値。Sort のように全部そろわないと1行も返せないものは、ここが大きくなる",
        ],
        ["総コスト", "最後まで出し終わるまでの値"],
        ["rows", "そのノードから出てくると見積もった行数"],
        ["width", "1行の平均バイト数"],
        [
          "actual time=A..B",
          "実測 (ミリ秒)。A=最初の1行まで、B=最後まで。ANALYZE のときだけ出る",
        ],
        ["actual rows", "実際に出た行数。見積もりの rows と見比べる"],
        [
          "loops",
          "そのノードが動いた回数。大事: actual time と rows は「1回あたりの平均」なので、合計は time × loops",
        ],
      ],
    },
  },
  {
    title: "表の読み方 (走査)",
    table: {
      head: ["ノード", "意味"],
      rows: [
        [
          "Seq Scan",
          "表を頭から全部読む。表が小さい、または大半の行を使うなら、これが正解のこともある",
        ],
        ["Index Scan", "インデックスで絞ってから、表本体も読む"],
        [
          "Index Only Scan",
          "インデックスだけで答えが作れた。一緒に出る Heap Fetches が小さいほど良い",
        ],
        [
          "Bitmap Index Scan",
          "該当位置を先にまとめる。すぐ下に置かれ、上の Bitmap Heap Scan と対になる",
        ],
        [
          "Bitmap Heap Scan",
          "まとめた位置をもとに、表をページ順にまとめて読む。中くらいの件数で選ばれる",
        ],
        [
          "Subquery Scan / CTE Scan",
          "副問い合わせ・WITH からの読み出し",
        ],
        ["Function Scan / Values Scan", "関数・VALUES からの読み出し"],
      ],
    },
  },
  {
    title: "結合とまとめ方",
    table: {
      head: ["ノード", "意味"],
      rows: [
        [
          "Nested Loop",
          "外側の1行ごとに内側を引く。外側が少ないときに速い。内側の loops が外側の行数になる",
        ],
        [
          "Hash Join",
          "片方をハッシュ表にしてから突き合わせる。等値結合で件数が多いときに選ばれる",
        ],
        [
          "Merge Join",
          "両方を並べ替えてから突き合わせる。すでに並んでいるときに有利",
        ],
        ["HashAggregate", "GROUP BY をハッシュでまとめる。並び順は要らない"],
        [
          "GroupAggregate",
          "並んでいることが前提のまとめ方。手前に Sort が付く",
        ],
        [
          "Gather / Gather Merge",
          "並列実行のまとめ役。Workers Planned と Launched が食い違うときは同時実行の上限に当たっている",
        ],
        [
          "Materialize / Memoize",
          "内側の結果を取っておいて使い回す。Memoize は Hits / Misses で当たり具合が分かる",
        ],
        ["Append / Merge Append", "UNION ALL やパーティションを束ねる"],
      ],
    },
  },
  {
    title: "行に付いてくる言葉",
    table: {
      head: ["表示", "意味"],
      rows: [
        [
          "Filter",
          "読んだあとにかけた条件。インデックスでは絞れなかったぶん",
        ],
        [
          "Rows Removed by Filter",
          "そこで捨てた行数。大きいほど無駄に読んでいる。インデックスを足す候補",
        ],
        [
          "Index Cond",
          "インデックスの側で絞った条件。Filter より前に効くので、同じ条件ならこちらへ寄せたい",
        ],
        ["Recheck Cond / Heap Blocks", "ビットマップ走査で読み直した条件とページ数"],
        ["Sort Key", "並べ替えに使った列"],
        [
          "Sort Method",
          "quicksort / top-N heapsort はメモリ内で完了。external merge Disk ならメモリに収まらずディスクへ書き出している",
        ],
        [
          "Batches / Memory Usage",
          "ハッシュがメモリに収まったか。Batches が2以上なら溢れている",
        ],
        [
          "Buffers",
          "shared hit=キャッシュから読めた / read=ディスクから読んだ / dirtied・written=書き出した (ページ単位)",
        ],
        ["Heap Fetches", "Index Only Scan で、結局表本体を読んだ回数"],
        [
          "Planning Time / Execution Time",
          "計画を立てた時間と、実行にかかった時間",
        ],
      ],
    },
  },
  {
    title: "見積もりがずれているとき",
    table: {
      head: ["やること", "効くところ"],
      rows: [
        [
          "ANALYZE (統計を集めるコマンド)",
          "いちばん先に試す。実行計画を出す ANALYZE ボタンとは別のもの",
        ],
        [
          "CREATE STATISTICS",
          "列どうしに関係があると (都道府県と市区町村など) 見積もりが外れる。複数列の統計を足す",
        ],
        [
          "default_statistics_target",
          "上げると統計を細かく取る。上げすぎると ANALYZE と計画作りが重くなる",
        ],
        [
          "遅い値で測る",
          "偏りの大きい列では、渡す値によって最適な計画が変わる。実際に遅い値で試す",
        ],
      ],
    },
  },
  {
    title: "どこから見るか",
    lines: [
      "1. Execution Time の大半を占めているノードを探します。actual time は「最後まで」の値なので、外側との差がそのノード自身の時間です。",
      "2. Rows Removed by Filter が大きい Seq Scan は、インデックスを足す候補です。",
      "3. Sort Method が Disk、または Batches が2以上なら、メモリ不足で遅くなっています (work_mem を見直します)。",
      "4. loops の大きい Nested Loop は、1回が速くても合計では重くなります。結合の仕方そのものを疑います。",
      "5. 見積もり rows と actual rows を突き合わせ、外れている一番内側のノードから直します。",
    ],
  },
  {
    title: "自分で書くときに足せるもの",
    table: {
      head: ["書き方", "出るもの"],
      rows: [
        [
          "EXPLAIN (ANALYZE, BUFFERS)",
          "実測に加えて、キャッシュとディスクの読み書き量。遅さの原因がI/Oかを見分けられる",
        ],
        ["EXPLAIN (ANALYZE, VERBOSE)", "出力する列や、関数の呼び出し先まで"],
        [
          "EXPLAIN (ANALYZE, TIMING OFF)",
          "時間の計測をやめる。計測そのものが重い環境で、行数だけ知りたいとき",
        ],
        [
          "EXPLAIN (ANALYZE, SETTINGS)",
          "既定から変えてある設定。自分の環境だけ計画が違う理由を探すとき",
        ],
        [
          "BEGIN; … ROLLBACK;",
          "書き込みを含むSQLを実測したいときに囲む (ANALYZEボタンは参照系のみ)",
        ],
      ],
    },
  },
];

// ---------- SQLite ----------

const SQLITE: HelpSection[] = [
  {
    title: "SQLiteで出るもの",
    lines: [
      "SQLiteには実測を出す仕組み (EXPLAIN ANALYZE) が無いので、Quelioでは EXPLAIN だけを用意しています。",
      "中身は EXPLAIN QUERY PLAN の結果です。素の EXPLAIN は内部の仮想マシン命令が並ぶだけで、速さを考える材料になりません。",
      "1行が「どの表を、どうやって読むか」で、上から順に外側 → 内側です。上の行の1件ごとに、下の行が引かれます。",
    ],
  },
  {
    title: "読み方の種類",
    table: {
      head: ["表示", "意味"],
      rows: [
        [
          "SCAN 表名",
          "その表 (またはインデックス) を頭から全部読む。件数が増えるとそのまま遅くなる",
        ],
        [
          "SEARCH 表名 USING INDEX 索引名 (列=?)",
          "インデックスで絞ってから読む。絞れている合図",
        ],
        [
          "SEARCH 表名 USING INTEGER PRIMARY KEY (rowid=?)",
          "rowid で直接引く。いちばん速い形",
        ],
        [
          "USING COVERING INDEX",
          "表本体を読まず、インデックスだけで答えが作れた",
        ],
        [
          "(列=?) / (列>? AND 列<?)",
          "括弧の中は使えた条件。等値と範囲。複数並んでいれば複合インデックスがそこまで効いている",
        ],
        [
          "AUTOMATIC COVERING INDEX",
          "その場限りのインデックスを作って使った。同じSQLを繰り返すなら、本物のインデックスを作る合図",
        ],
      ],
    },
  },
  {
    title: "並べ替えとまとめ方",
    table: {
      head: ["表示", "意味"],
      rows: [
        [
          "USE TEMP B-TREE FOR ORDER BY",
          "並べ替えのために一時的な木を作った。ORDER BY に合うインデックスがあれば出なくなる",
        ],
        [
          "USE TEMP B-TREE FOR GROUP BY",
          "まとめるために作った。GROUP BY の列を先頭に持つインデックスで消せることがある",
        ],
        ["USE TEMP B-TREE FOR DISTINCT", "重複を取り除くために作った"],
      ],
    },
  },
  {
    title: "副問い合わせと結合",
    lines: [
      "結合は上の行が外側、下の行が内側です。外側で読む件数が、そのまま内側を引く回数になります。",
      "外側には件数の少ない表が来るのが望ましい形です。思ったのと逆なら、統計 (下の ANALYZE) を取り直してみてください。",
    ],
    table: {
      head: ["表示", "意味"],
      rows: [
        ["LIST SUBQUERY", "IN (...) の中身を先に作った"],
        [
          "CORRELATED SCALAR SUBQUERY",
          "外側の値を使う副問い合わせ。外側の行ごとに実行されるので、件数が多いと重い",
        ],
        ["CO-ROUTINE", "副問い合わせを、全部ためずに流しながら使った"],
        [
          "MATERIALIZE",
          "副問い合わせの結果を一時表にまとめた。何度も使われるときに選ばれる",
        ],
      ],
    },
  },
  {
    title: "ANALYZE コマンドは別物です",
    lines: [
      "SQLite の ANALYZE は、実行計画を出す命令ではありません。表とインデックスの統計を集めて sqlite_stat1 に保存する命令です。",
      "統計があると、どのインデックスを使うか・どちらを外側にするかの判断が良くなります。",
      "データを大きく入れ替えたあとに一度 ANALYZE を流しておくと、計画が安定します。",
    ],
  },
  {
    title: "よくある直し方",
    table: {
      head: ["気づいたこと", "直し方"],
      rows: [
        [
          "SCAN が出ている",
          "その表の、WHERE と JOIN に使う列にインデックスを作る",
        ],
        [
          "複合インデックスが効かない",
          "等値で使う列を先に、範囲で使う列を後ろに置く",
        ],
        [
          "インデックスがあるのに使われない",
          "列に関数を掛けていないか確認する。式のままインデックスを作る (式インデックス) 手もある",
        ],
        [
          "AUTOMATIC INDEX が出る",
          "毎回その場で作り直している。同じ形のインデックスを本物として作る",
        ],
        [
          "主キーに索引を足すか迷う",
          "INTEGER PRIMARY KEY はそれ自体が rowid なので、別に作る必要はない",
        ],
        [
          "LIKE が遅い",
          "前方一致 ('abc%') は、大文字小文字を区別する設定かつ列がTEXTのときに使える。中間一致は使えない",
        ],
      ],
    },
  },
];

export const EXPLAIN: HelpTopic = {
  id: "explain",
  label: "実行計画",
  note: "EXPLAIN と ANALYZE の読み方",
  // Valkey にはSQLの実行計画にあたるものが無いので出さない
  dbTypes: ["mysql", "postgresql", "sqlite"],
  sections: (dbType) => {
    if (dbType === "postgresql") return POSTGRESQL;
    if (dbType === "sqlite") return SQLITE;
    return MYSQL;
  },
};
