//! query の判定・分割まわりのテスト。
//!
//! 下位モジュールにまたがって確かめるものが多いので、1か所にまとめている

use super::*;

#[test]
fn 行ロックを取るselectは読み取り専用で通さない() {
    for sql in [
        "SELECT * FROM t FOR UPDATE",
        "select * from t for update",
        "SELECT * FROM t\n  FOR   UPDATE",
        "SELECT * FROM t FOR NO KEY UPDATE",
        "SELECT * FROM t FOR SHARE",
        "SELECT * FROM t LOCK IN SHARE MODE",
        "WITH x AS (SELECT 1) SELECT * FROM t FOR UPDATE",
        "SELECT * FROM (SELECT * FROM t FOR UPDATE) s",
        "SELECT GET_LOCK('x', -1)",
        "SELECT pg_advisory_lock(1)",
        "SELECT pg_advisory_lock_shared(1)",
        "SELECT pg_try_advisory_xact_lock(1)",
    ] {
        assert!(!is_read_only(Dialect::of(DbType::Postgresql), sql), "{sql}");
        assert!(!is_read_only(Dialect::of(DbType::Mysql), sql), "{sql}");
    }
}

#[test]
fn 普通のselectは読み取り専用で通る() {
    for sql in [
        "SELECT * FROM t",
        "SELECT 'for update' AS memo FROM t",
        "SELECT forupdate FROM t",
        "SELECT * FROM t WHERE name = 'lock in share mode'",
        // 同じ名前の列・テーブルは関数呼び出しではないので通す
        "SELECT get_lock FROM t",
        // 解放する関数はロックを取らない
        "SELECT pg_advisory_unlock_all()",
        "SELECT * FROM pg_advisory_lock_log",
    ] {
        assert!(is_read_only(Dialect::of(DbType::Postgresql), sql), "{sql}");
    }
}

#[test]
fn postgresqlのドル引用符は分割しない() {
    let sql = "CREATE FUNCTION f() RETURNS int AS $$\nBEGIN\n  SELECT 1;\n  RETURN 2;\nEND;\n$$ LANGUAGE plpgsql;\nSELECT 3;";
    let stmts = split_statements(Dialect::of(DbType::Postgresql), sql);
    assert_eq!(stmts.len(), 2, "{stmts:?}");
    assert!(stmts[0].contains("RETURN 2"));
    assert_eq!(stmts[1], "SELECT 3");
}

#[test]
fn ドル引用符はタグ付きも扱える() {
    let sql = "DO $body$ BEGIN; PERFORM 1; END $body$; SELECT 1;";
    let stmts = split_statements(Dialect::of(DbType::Postgresql), sql);
    assert_eq!(stmts.len(), 2, "{stmts:?}");
}

#[test]
fn postgresqlのシャープはコメントではない() {
    let sql = "SELECT data #> '{a}' FROM t; SELECT 1";
    let stmts = split_statements(Dialect::of(DbType::Postgresql), sql);
    assert_eq!(stmts.len(), 2, "{stmts:?}");
    assert!(stmts[0].contains("#>"));
}

#[test]
fn mysqlのシャープはコメント() {
    let sql = "SELECT 1 # これはコメント; ここも\nUNION SELECT 2; SELECT 3";
    let stmts = split_statements(Dialect::of(DbType::Mysql), sql);
    assert_eq!(stmts.len(), 2, "{stmts:?}");
    assert!(stmts[0].contains("UNION"));
}

#[test]
fn no_backslash_escapesのmysqlは文を見落とさない() {
    // sql_mode に NO_BACKSLASH_ESCAPES があると \ はただの文字になり、
    // ' はそこで閉じる。既定の方言のままだと1文に見えてしまう
    let sql = r"SELECT 'a\'; DELETE FROM t; -- '";
    let mut d = Dialect::MYSQL;
    assert_eq!(split_statements(d, sql).len(), 1);
    assert!(is_read_only(d, sql));

    d.backslash_escape = false;
    // ' がそこで閉じるので DELETE が別の文として現れる
    // (末尾に残る "-- '" はコメントだけなので文にはならない)
    let stmts = split_statements(d, sql);
    assert_eq!(stmts.len(), 2, "{stmts:?}");
    assert_eq!(stmts[1], "DELETE FROM t");
    assert!(!is_read_only(d, &stmts[1]));
    // WHERE の無い DELETE として確認ダイアログの対象になる
    assert_eq!(dangerous_statements(d, sql).len(), 1);
}

#[test]
fn standard_conforming_strings_offのpostgresqlは文を切りすぎない() {
    // off のときは \ がエスケープになるため ' は閉じない
    let sql = r"SELECT 'a\'; DELETE FROM t; -- '";
    let d = Dialect::POSTGRESQL;
    assert_eq!(split_statements(d, sql).len(), 2);

    let mut off = Dialect::POSTGRESQL;
    off.backslash_escape = true;
    assert_eq!(split_statements(off, sql).len(), 1);
    assert!(is_read_only(off, sql));
}

#[test]
fn postgresqlのe文字列はバックスラッシュを解釈する() {
    // E'…' は standard_conforming_strings が on でもエスケープが効くため、
    // ここで閉じたと見なすと2文目を見落とす
    let sql = r"SELECT E'a\'; DELETE FROM t; -- '";
    let d = Dialect::POSTGRESQL;
    assert_eq!(split_statements(d, sql).len(), 1);
    assert!(is_read_only(d, sql));
    assert!(dangerous_statements(d, sql).is_empty());

    // 識別子の末尾の e は前置きではない (列名 note のあとの文字列など)
    let sql = r"SELECT note'a\'; DELETE FROM t; -- '";
    assert_eq!(split_statements(d, sql).len(), 2);
}

#[test]
fn ansi_quotesのダブルクォートは識別子() {
    // ANSI_QUOTES では " は識別子の引用符。中の \ はエスケープにならないので
    // "a\" はそこで閉じ、DELETE が別の文になる
    let sql = r#"SELECT 1 AS "a\" ; DELETE FROM t; -- ""#;
    let mut d = Dialect::MYSQL;
    assert_eq!(split_statements(d, sql).len(), 1);

    d.ansi_quotes = true;
    let stmts = split_statements(d, sql);
    assert_eq!(stmts.len(), 2, "{stmts:?}");
    assert_eq!(stmts[1], "DELETE FROM t");
    assert_eq!(dangerous_statements(d, sql).len(), 1);
}

#[test]
fn mysqlのハイフン2つは直後に空白が要る() {
    // MySQLの 1--2 は引き算であってコメントではない
    let sql = "SELECT 1--2;DELETE FROM t";
    assert_eq!(split_statements(Dialect::MYSQL, sql).len(), 2);
    assert_eq!(dangerous_statements(Dialect::MYSQL, sql).len(), 1);
    // 空白があれば従来どおりコメント
    assert_eq!(
        split_statements(Dialect::MYSQL, "SELECT 1-- 2;DELETE FROM t").len(),
        1
    );
    // PostgreSQL・SQLiteは空白が要らない
    assert_eq!(split_statements(Dialect::POSTGRESQL, sql).len(), 1);
}

#[test]
fn 引用符を2つ重ねると閉じない() {
    let d = Dialect::POSTGRESQL;
    // E'a''b\'; …' は全体で1つの文字列
    let sql = r"SELECT E'a''b\'; DELETE FROM t; -- '";
    assert_eq!(split_statements(d, sql).len(), 1);
    assert!(is_read_only(d, sql));
    // 普通の文字列でも '' は閉じない
    assert_eq!(split_statements(d, "SELECT 'a''b;c'").len(), 1);
    // キーワード探索でも文字列の中身は見ない
    assert!(is_read_only(
        d,
        r"WITH x AS (SELECT E'a''b\'; DELETE FROM t; -- ') SELECT 1"
    ));
}

#[test]
fn ドル記号を含む識別子は引用符ではない() {
    let d = Dialect::POSTGRESQL;
    // report$2024$q1 は名前であってドル引用符ではない
    let sql = "SELECT id FROM report$2024$q1; DROP TABLE t";
    let stmts = split_statements(d, sql);
    assert_eq!(stmts.len(), 2, "{stmts:?}");
    assert!(split_sql(d, sql).unterminated.is_none());
    assert_eq!(dangerous_statements(d, sql).len(), 1);
}

#[test]
fn 区切りが分からないsqlは確認の対象にする() {
    let d = Dialect::POSTGRESQL;
    let found = dangerous_statements(d, "SELECT 'abc");
    assert_eq!(found.len(), 1);
    assert!(found[0].kind.contains("区切り"));
}

#[test]
fn 行ロックの説明は参照系のsqlにだけ使う() {
    let d = Dialect::POSTGRESQL;
    assert!(locks_rows(d, "SELECT * FROM t FOR UPDATE"));
    // UPDATE は「データは変わりません」ではないので行ロックの説明にしない
    assert!(!locks_rows(
        d,
        "UPDATE t SET x = 1 WHERE id IN (SELECT id FROM u FOR UPDATE)"
    ));
}

#[test]
fn トランザクションの開始と終了を見分ける() {
    let d = Dialect::POSTGRESQL;
    let pg = |sql| txn_effect(DbType::Postgresql, d, sql);
    assert_eq!(pg("BEGIN"), Some(true));
    assert_eq!(pg("begin transaction"), Some(true));
    assert_eq!(pg("START TRANSACTION"), Some(true));
    assert_eq!(pg("COMMIT"), Some(false));
    assert_eq!(pg("END"), Some(false));
    assert_eq!(pg("ROLLBACK"), Some(false));
    // AND CHAIN は続けて新しいトランザクションを開く
    assert_eq!(pg("COMMIT AND CHAIN"), Some(true));
    assert_eq!(pg("COMMIT AND NO CHAIN"), Some(false));
    // SAVEPOINT へのロールバックは終わらせない
    assert_eq!(pg("ROLLBACK TO SAVEPOINT s1"), None);
    assert_eq!(pg("SAVEPOINT s1"), None);
    // 普通のSQLは関係なし。文字列の中の COMMIT にも反応しない
    assert_eq!(pg("SELECT 1"), None);
    assert_eq!(pg("SELECT 'COMMIT'"), None);
    // 先頭のコメントは読み飛ばす
    assert_eq!(pg("-- メモ\nCOMMIT"), Some(false));
    // PL/pgSQL の BEGIN は関数の本体であってトランザクションではない
    assert_eq!(pg("DO $$ BEGIN PERFORM 1; END $$"), None);
}

#[test]
fn mysqlの暗黙のトランザクションを見分ける() {
    let d = Dialect::MYSQL;
    let my = |sql| txn_effect(DbType::Mysql, d, sql);
    // autocommit を切ると、以降が暗黙のトランザクションになる
    assert_eq!(my("SET autocommit = 0"), Some(true));
    assert_eq!(my("SET @@session.autocommit=OFF"), Some(true));
    assert_eq!(my("SET autocommit = 1"), Some(false));
    assert_eq!(my("SET SESSION autocommit = ON"), Some(false));
    // DDLなどは暗黙コミットするのでトランザクションは終わる
    assert_eq!(my("CREATE TABLE t (a INT)"), Some(false));
    assert_eq!(my("TRUNCATE TABLE t"), Some(false));
    assert_eq!(my("LOCK TABLES t WRITE"), Some(false));
    // レプリケーションの START はトランザクションではない
    assert_eq!(my("START REPLICA"), None);
    assert_eq!(my("START SLAVE"), None);
    // 他のDBでは暗黙コミットしないので落とさない
    assert_eq!(
        txn_effect(
            DbType::Postgresql,
            Dialect::POSTGRESQL,
            "CREATE TABLE t (a INT)"
        ),
        None
    );
    assert_eq!(
        txn_effect(
            DbType::Postgresql,
            Dialect::POSTGRESQL,
            "SET autocommit = 0"
        ),
        None
    );
}

fn pv(value: &str, kind: &str) -> ParamValue {
    ParamValue {
        value: value.to_string(),
        kind: kind.to_string(),
    }
}

fn vals(pairs: &[(&str, &str, &str)]) -> std::collections::HashMap<String, ParamValue> {
    pairs
        .iter()
        .map(|(n, v, k)| (n.to_string(), pv(v, k)))
        .collect()
}

#[test]
fn パラメータを値に置き換える() {
    let d = Dialect::POSTGRESQL;
    let v = vals(&[("a", "1", "auto"), ("b", "x", "auto")]);
    assert_eq!(
        substitute_params(d, "SELECT * FROM t WHERE a = :a AND b = :b", &v),
        "SELECT * FROM t WHERE a = 1 AND b = 'x'"
    );
    // 同じ名前は何度でも
    assert_eq!(substitute_params(d, "SELECT :a, :a", &v), "SELECT 1, 1");
    // @ でも書ける
    assert_eq!(substitute_params(d, "SELECT @a", &v), "SELECT 1");
}

#[test]
fn 文字列とコメントの中は置き換えない() {
    let d = Dialect::POSTGRESQL;
    let v = vals(&[("a", "x", "auto")]);
    assert_eq!(
        substitute_params(d, "SELECT ':a' AS memo, :a FROM t -- :a", &v),
        "SELECT ':a' AS memo, 'x' FROM t -- :a"
    );
    // PostgreSQLのキャストとMySQLのシステム変数は名前ではない
    assert_eq!(
        substitute_params(d, "SELECT :a::text", &v),
        "SELECT 'x'::text"
    );
    assert_eq!(
        substitute_params(Dialect::MYSQL, "SELECT @@version, @a", &v),
        "SELECT @@version, 'x'"
    );
    // 値が無いパラメータはそのまま残す (SQLエラーになって気づける)
    assert_eq!(substitute_params(d, "SELECT :zzz", &v), "SELECT :zzz");
}

#[test]
fn 値は実行される文を増やせない() {
    /*
     * 埋め込みの前に分割と読み取り専用の判定を済ませる、という順番の要。
     * 値に `; DELETE …` を入れても、判定の対象は :a のままなので
     * 「1文のSELECT」として扱われる
     */
    let d = Dialect::POSTGRESQL;
    let sql = "SELECT * FROM t WHERE a = :a";
    assert_eq!(split_statements(d, sql).len(), 1);
    assert!(is_read_only(d, sql));
    assert!(dangerous_statements(d, sql).is_empty());

    // 値を入れても、閉じた文字列の中に収まる
    let v = vals(&[("a", "x'; DELETE FROM t; --", "auto")]);
    let filled = substitute_params(d, sql, &v);
    assert_eq!(filled, "SELECT * FROM t WHERE a = 'x''; DELETE FROM t; --'");
    assert_eq!(split_statements(d, &filled).len(), 1);
    assert!(is_read_only(d, &filled));
}

#[test]
fn バックスラッシュは方言に合わせて重ねる() {
    let v = vals(&[("p", r"C:\temp\", "string")]);
    // MySQLの既定。重ねないと末尾の \ が ' を打ち消して文字列が閉じない
    let mut mysql = Dialect::MYSQL;
    mysql.backslash_escape = true;
    assert_eq!(
        substitute_params(mysql, "SELECT :p", &v),
        r"SELECT 'C:\\temp\\'"
    );
    // PostgreSQL・SQLiteでは \ はただの文字なので、重ねると値が変わってしまう
    assert_eq!(
        substitute_params(Dialect::POSTGRESQL, "SELECT :p", &v),
        r"SELECT 'C:\temp\'"
    );
    // 重ねた結果でも文はひとつのまま
    let escape = vals(&[("p", r"x\' OR 1=1 -- ", "string")]);
    let filled = substitute_params(mysql, "SELECT * FROM t WHERE a = :p", &escape);
    assert_eq!(split_statements(mysql, &filled).len(), 1);
    assert!(is_read_only(mysql, &filled));
}

#[test]
fn 埋め込み方を種類で選ぶ() {
    let d = Dialect::POSTGRESQL;
    assert_eq!(format_param(d, &pv("42", "auto")), "42");
    assert_eq!(format_param(d, &pv("-3.5", "auto")), "-3.5");
    assert_eq!(format_param(d, &pv("null", "auto")), "NULL");
    assert_eq!(format_param(d, &pv("NULL", "auto")), "NULL");
    assert_eq!(format_param(d, &pv("abc", "auto")), "'abc'");
    assert_eq!(format_param(d, &pv("", "auto")), "''");
    // 数値に見えない形は文字列として囲む
    assert_eq!(format_param(d, &pv("1.2.3", "auto")), "'1.2.3'");
    assert_eq!(format_param(d, &pv("1.", "auto")), "'1.'");
    assert_eq!(format_param(d, &pv("-", "auto")), "'-'");
    // 種類を選んだとき
    assert_eq!(format_param(d, &pv("42", "string")), "'42'");
    assert_eq!(format_param(d, &pv("", "number")), "NULL");
    assert_eq!(format_param(d, &pv("1+1", "raw")), "1+1");
    // 未知の種類は安全側 (文字列) に倒す
    assert_eq!(format_param(d, &pv("1+1", "なにか")), "'1+1'");
}

#[test]
fn 引用済みに見えても中身は文字列として扱う() {
    let d = Dialect::POSTGRESQL;
    // そのまま通していた頃は `'' OR 1=1 --'` が条件として効いてしまった
    assert_eq!(
        format_param(d, &pv("'' OR 1=1 --'", "auto")),
        "''' OR 1=1 --'"
    );
    assert_eq!(format_param(d, &pv("'a' || 'b'", "auto")), "'a'' || ''b'");
    // 書いたとおりの値になる (中身の '' は ' へ戻してから囲み直す)
    assert_eq!(format_param(d, &pv("'abc'", "auto")), "'abc'");
    assert_eq!(format_param(d, &pv("'a''b'", "auto")), "'a''b'");
}

#[test]
fn 切り詰めた位置を構造で返す() {
    // 上限以下ならそのまま
    let (text, clip) = clip_cell("あいう".to_string(), 5);
    assert_eq!(text, "あいう");
    assert!(clip.is_none());

    // 上限ちょうども切り詰めない
    let (_, clip) = clip_cell("あ".repeat(5), 5);
    assert!(clip.is_none());

    /*
     * 切り詰めたときは、注記付きの文字列と位置の両方を返す。
     * 画面側は「… (全N文字)」を読み戻さずに済む
     */
    let (text, clip) = clip_cell("あ".repeat(12), 5);
    let clip = clip.expect("切り詰めたら位置が返る");
    assert_eq!(clip.head, 5);
    assert_eq!(clip.total, 12);
    assert_eq!(text, format!("{}… (全12文字)", "あ".repeat(5)));
    // head は注記を除いた先頭の文字数
    assert_eq!(
        text.chars().take(clip.head).collect::<String>(),
        "あ".repeat(5)
    );

    // 値がたまたま注記と同じ形で終わっていても、切り詰めとは扱わない
    let (_, clip) = clip_cell("短い… (全5000文字)".to_string(), 1000);
    assert!(clip.is_none());
}

#[test]
fn 定義の変更だけを見分ける() {
    let d = Dialect::MYSQL;
    // 設定で確認を省ける対象 (データは消えない)
    for sql in ["ALTER TABLE t ADD COLUMN c int", "RENAME TABLE a TO b"] {
        let found = dangerous_statements(d, sql);
        assert_eq!(found.len(), 1, "{sql}");
        assert!(found[0].definition_change, "{sql}");
    }
    // 戻せない・影響範囲が読めないものは常に確認する
    for sql in [
        "DROP TABLE t",
        "TRUNCATE TABLE t",
        "DELETE FROM t",
        "UPDATE t SET a = 1",
        "SELECT 'abc",
    ] {
        let found = dangerous_statements(d, sql);
        assert_eq!(found.len(), 1, "{sql}");
        assert!(!found[0].definition_change, "{sql}");
    }
}

#[test]
fn バイナリ形式で送れない型を見分ける() {
    assert!(pg_needs_text_format(
        "DBエラー: error returned from database: no binary output function available for type aclitem"
    ));
    // 別のエラーでやり直すと、無駄に2回実行することになる
    assert!(!pg_needs_text_format(
        "DBエラー: relation \"t\" does not exist"
    ));
    assert!(!pg_needs_text_format("実行を中止しました"));
    assert!(!pg_needs_text_format("クエリがタイムアウトしました"));
}

#[test]
fn トランザクション中はテキスト形式でやり直さない() {
    /*
     * PostgreSQLは1度エラーになるとトランザクション全体が中断状態になり、
     * やり直しても必ず失敗する (本来のエラーも見えなくなる)
     */
    assert!(matches!(
        SqlMode::for_read_only(true, false),
        SqlMode::Prepared { retry_text: true }
    ));
    assert!(matches!(
        SqlMode::for_read_only(true, true),
        SqlMode::Prepared { retry_text: false }
    ));
    // 書き込みできる接続は今までどおりそのまま送る
    assert_eq!(SqlMode::for_read_only(false, false), SqlMode::Raw);
    assert_eq!(SqlMode::for_read_only(false, true), SqlMode::Raw);
}

#[test]
fn 方言が変わりうる文を見分ける() {
    assert!(changes_dialect(
        Dialect::POSTGRESQL,
        "SET sql_mode = 'NO_BACKSLASH_ESCAPES'"
    ));
    assert!(changes_dialect(
        Dialect::POSTGRESQL,
        "set standard_conforming_strings = off"
    ));
    assert!(changes_dialect(Dialect::POSTGRESQL, "RESET ALL"));
    assert!(changes_dialect(Dialect::POSTGRESQL, "DISCARD ALL"));
    // 先頭のコメントは読み飛ばす
    assert!(changes_dialect(Dialect::POSTGRESQL, "-- メモ\nSET x = 1"));
    // set_config は SELECT の形でセッション設定を変える
    assert!(changes_dialect(
        Dialect::POSTGRESQL,
        "SELECT set_config('standard_conforming_strings', 'off', false)"
    ));
    // 普通のSQLは聞き直さない (毎回問い合わせると遅くなる)
    assert!(!changes_dialect(Dialect::POSTGRESQL, "SELECT 1"));
    assert!(!changes_dialect(
        Dialect::POSTGRESQL,
        "SELECT 'SET sql_mode'"
    ));
    assert!(!changes_dialect(Dialect::POSTGRESQL, "UPDATE t SET a = 1"));
}

#[test]
fn sqliteのsavepointはトランザクションを開く() {
    let d = Dialect::SQLITE;
    assert_eq!(txn_effect(DbType::Sqlite, d, "SAVEPOINT s1"), Some(true));
    // COMMIT で抜けられる (SAVEPOINTで始めたトランザクションも閉じられる)
    assert_eq!(txn_effect(DbType::Sqlite, d, "COMMIT"), Some(false));
    // RELEASE は最外かどうかが分からないので「開いたまま」と思っておく
    assert_eq!(txn_effect(DbType::Sqlite, d, "RELEASE s1"), None);
}

#[test]
fn 分割とキーワード探索は同じ見方をする() {
    // (SQL, 文の数, リテラルの外に残るセミコロンの数)
    let cases: &[(&str, usize, usize)] = &[
        ("SELECT 'a;b'", 1, 0),
        ("SELECT 'a;b'; DROP TABLE t", 2, 1),
        ("SELECT 1 -- ;メモ\n; DROP TABLE t", 2, 1),
        ("SELECT 1 /* ; */; DROP TABLE t", 2, 1),
        ("SELECT $$a;b$$; DROP TABLE t", 2, 1),
        ("SELECT \"a;b\"; DROP TABLE t", 2, 1),
    ];
    let d = Dialect::POSTGRESQL;
    for (sql, stmts, semis) in cases {
        let got = split_statements(d, sql);
        assert_eq!(got.len(), *stmts, "{sql} -> {got:?}");
        let body = strip_literals(d, sql);
        /*
         * 走査は1か所なので、文の切れ目とキーワード探索の見え方はずれない。
         * ずれると「1文に見えるのに2文が実行される」ことになる
         */
        assert_eq!(body.matches(';').count(), *semis, "{sql} -> {body:?}");
        // 引用符やコメントの中身は残さない
        assert!(!body.contains("a;b"), "{sql} -> {body:?}");
    }
}

#[test]
fn mysqlの実行可能コメントは中身を読む() {
    let d = Dialect::MYSQL;
    // MySQLは実行可能コメントの中身を実行する。
    // コメントとして読み飛ばすと、読み取り専用の判定も
    // 危険なSQLの確認もすり抜けてしまう
    let sql = "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */";
    assert!(!is_read_only(d, sql), "読み取り専用で通してはいけない");
    // 他のDBでは本当にただのコメントなので、通ってよい
    assert!(is_read_only(Dialect::POSTGRESQL, sql));

    // コメントの中だけに書かれた破壊的なSQLも確認の対象にする
    let sql = "/*!50000 DROP TABLE t */";
    assert_eq!(dangerous_statements(d, sql).len(), 1);
    assert!(!is_read_only(d, sql));
    assert!(dangerous_statements(Dialect::POSTGRESQL, sql).is_empty());

    // 送る形は変えない (目印ごとサーバーへ渡す)
    assert_eq!(split_statements(d, sql), vec![sql]);

    // 最適化ヒント (/*+ … *​/) も中身が読める形にする
    assert!(!is_read_only(d, "SELECT 1 /*+ INTO OUTFILE 'x' */"));
}

#[test]
fn postgresqlのブロックコメントは入れ子にできる() {
    let d = Dialect::POSTGRESQL;
    // PostgreSQLは入れ子にできるので、内側の *​/ では閉じない
    let sql = "/* メモ /* 内側 */ */ SELECT 1";
    let stmts = split_statements(d, sql);
    assert_eq!(stmts.len(), 1, "{stmts:?}");
    assert!(is_read_only(d, sql));
    // MySQL・SQLiteは入れ子にならない (最初の *​/ で閉じる)
    assert_eq!(
        split_statements(Dialect::MYSQL, "/* a /* b */ SELECT 1").len(),
        1
    );
}

#[test]
fn コメントだけの入力は文にしない() {
    let d = Dialect::POSTGRESQL;
    // 「実行するSQLがありません」と言えるよう、文としては数えない
    assert!(split_statements(d, "-- メモ").is_empty());
    assert!(split_statements(d, "/* メモ */").is_empty());
    assert!(split_statements(d, "  ;  ; ").is_empty());
    assert!(split_statements(d, "").is_empty());
    // 中身があれば当然数える
    assert_eq!(split_statements(d, "-- メモ\nSELECT 1").len(), 1);
}

#[test]
fn ドル記号と数字は位置パラメータ() {
    let d = Dialect::POSTGRESQL;
    // $1 $2 は引用符ではない (閉じ忘れ扱いにすると正当なSQLを断ってしまう)
    let sql = "SELECT $1$2 FROM t";
    assert!(split_sql(d, sql).unterminated.is_none());
    assert_eq!(split_statements(d, sql).len(), 1);
    // 文字始まりのタグは今までどおり引用符
    assert!(split_sql(d, "SELECT $tag$a;b").unterminated.is_some());
}

#[test]
fn 閉じ忘れを見つける() {
    let d = Dialect::POSTGRESQL;
    assert!(split_sql(d, "SELECT 1").unterminated.is_none());
    // 行コメントは改行が無いまま終わっても普通
    assert!(split_sql(d, "SELECT 1 -- メモ").unterminated.is_none());
    assert!(split_sql(d, "SELECT 'abc").unterminated.is_some());
    assert!(split_sql(d, "SELECT \"abc").unterminated.is_some());
    assert!(split_sql(d, "SELECT 1 /* メモ").unterminated.is_some());
    assert!(split_sql(d, "SELECT $$abc").unterminated.is_some());
    assert!(split_sql(Dialect::MYSQL, "SELECT `abc")
        .unterminated
        .is_some());
}

#[test]
fn バックスラッシュの扱いはdbで変わる() {
    // MySQLは \\' が「'」なので文字列が続く → 1文
    let sql = "SELECT 'a\\'; SELECT 2";
    assert_eq!(split_statements(Dialect::of(DbType::Mysql), sql).len(), 1);
    // PostgreSQLは \\ をエスケープ扱いしないので、'a\\' で閉じる → 2文
    assert_eq!(
        split_statements(Dialect::of(DbType::Postgresql), sql).len(),
        2
    );
}

#[test]
fn 文字列とコメントの中のセミコロンは区切らない() {
    let sql = "SELECT ';' AS a; -- ; コメント\nSELECT /* ; */ 2;";
    let stmts = split_statements(Dialect::of(DbType::Sqlite), sql);
    assert_eq!(stmts.len(), 2, "{stmts:?}");
}

#[test]
fn ドル引用符の中の危険なsqlも見つける() {
    // 関数定義の中のDROPは1文として扱われる (分割で壊れない)
    let sql = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN DROP TABLE t; END $$ LANGUAGE plpgsql;";
    let stmts = split_statements(Dialect::of(DbType::Postgresql), sql);
    assert_eq!(stmts.len(), 1, "{stmts:?}");
}
#[test]
fn postgresqlの演算子で危険判定が外れない() {
    // #> 以降がコメント扱いされると DELETE を見落とす
    let sql =
        "WITH x AS (SELECT data #> '{a}' FROM t) DELETE FROM u WHERE id IN (SELECT id FROM x)";
    assert!(!is_analyzable(Dialect::of(DbType::Postgresql), sql));
    assert!(!is_read_only(Dialect::of(DbType::Postgresql), sql));
    assert_eq!(
        dangerous_statements(Dialect::of(DbType::Postgresql), sql).len(),
        1
    );
}

#[test]
fn postgresqlのjsonb演算子でwhereを見失わない() {
    let sql = "UPDATE t SET j = j #- '{a}' WHERE id = 1";
    assert!(dangerous_statements(Dialect::of(DbType::Postgresql), sql).is_empty());
    // MySQLでは # から行末までコメントなので、WHEREが消えて確認対象になる
    assert_eq!(
        dangerous_statements(Dialect::of(DbType::Mysql), sql).len(),
        1
    );
}

#[test]
fn 括弧で指定したexplain_analyzeも確認対象() {
    let sql = "EXPLAIN (ANALYZE) DELETE FROM t";
    assert_eq!(
        dangerous_statements(Dialect::of(DbType::Postgresql), sql).len(),
        1
    );
    assert!(!is_analyzable(Dialect::of(DbType::Postgresql), sql));
}

#[test]
fn ドル引用符の中身はキーワード探索から外す() {
    let sql = "SELECT $$ DELETE FROM t $$ AS s";
    assert!(is_read_only(Dialect::of(DbType::Postgresql), sql));
    assert!(is_analyzable(Dialect::of(DbType::Postgresql), sql));
}

#[test]
fn 常に真の条件は全行の更新として確認する() {
    let d = Dialect::of(DbType::Postgresql);
    for sql in [
        "UPDATE t SET a = 1 WHERE 1=1",
        "UPDATE t SET a = 1 WHERE TRUE",
        "DELETE FROM t WHERE 1 = 1",
        "DELETE FROM t WHERE id = id",
        // 返り値の指定が続いても条件だけを見る
        "DELETE FROM t WHERE 1=1 RETURNING id",
    ] {
        assert_eq!(dangerous_statements(d, sql).len(), 1, "{sql}");
    }
}

#[test]
fn 普通の条件は確認しない() {
    let d = Dialect::of(DbType::Postgresql);
    for sql in [
        "UPDATE t SET a = 1 WHERE id = 1",
        "DELETE FROM t WHERE id = 1",
        "DELETE FROM t WHERE name = 'x'",
        // 括弧の中の 1=1 は対象の絞り込みではない
        "UPDATE t SET a = 1 WHERE id IN (SELECT id FROM u WHERE 1=1)",
    ] {
        assert!(dangerous_statements(d, sql).is_empty(), "{sql}");
    }
}

// ---------- ページングの組み立て ----------

fn pg() -> Dialect {
    Dialect::of(DbType::Postgresql)
}

#[test]
fn 末尾が行コメントでも件数指定が効く() {
    // 同じ行に足すと LIMIT ごとコメントに飲まれ、OFFSETも効かなくなる
    let p = plan(pg(), "SELECT * FROM t -- メモ", 100, None, false);
    assert!(p.pageable);
    let last = p.sql.lines().last().unwrap();
    assert!(last.starts_with("LIMIT "), "{}", p.sql);
    assert!(last.ends_with("OFFSET 100"), "{}", p.sql);
}

#[test]
fn 末尾が行コメントでもソートの包みが壊れない() {
    let p = plan(
        pg(),
        "SELECT * FROM t -- メモ",
        0,
        Some(("a", "asc")),
        false,
    );
    // 閉じ括弧がコメント行と同じ行に来ると構文エラーになる
    assert!(p.sql.contains("\n) AS q ORDER BY \"a\" asc"), "{}", p.sql);
    let out = plan_export(pg(), "SELECT * FROM t -- メモ", Some(("a", "asc")), false);
    assert!(out.contains("\n) AS q ORDER BY \"a\" asc"), "{out}");
}

#[test]
fn 件数を数えるSQLは元のSQLを包む() {
    let out = plan_count(pg(), "SELECT * FROM t WHERE a = 1").unwrap();
    assert!(out.starts_with("SELECT COUNT(*) FROM ("), "{out}");
    assert!(out.contains("SELECT * FROM t WHERE a = 1"), "{out}");
    assert!(out.ends_with("\n) AS q"), "{out}");
}

#[test]
fn 件数を数えるSQLは末尾のセミコロンを外す() {
    let out = plan_count(pg(), "SELECT * FROM t;").unwrap();
    assert!(!out.contains(";"), "{out}");
}

#[test]
fn 末尾が行コメントでも件数の包みが壊れない() {
    let out = plan_count(pg(), "SELECT * FROM t -- メモ").unwrap();
    // 閉じ括弧がコメント行と同じ行に来ると構文エラーになる
    assert!(out.ends_with("\n) AS q"), "{out}");
}

#[test]
fn 数えられないSQLはNone() {
    // LIMIT付きは絞る意図があるので数えない
    assert!(plan_count(pg(), "SELECT * FROM t LIMIT 10").is_none());
    // 更新系も数えない
    assert!(plan_count(pg(), "UPDATE t SET a = 1").is_none());
}

#[test]
fn 名前に含むだけならページングする() {
    let p = plan(pg(), "SELECT * FROM rate_limits", 0, None, false);
    assert!(p.pageable, "{}", p.sql);
}

#[test]
fn 文字列の中の指定では止めない() {
    let p = plan(pg(), "SELECT 'LIMIT' AS s FROM t", 0, None, false);
    assert!(p.pageable, "{}", p.sql);
}

#[test]
fn 件数を絞る句が既にあれば足さない() {
    let p = plan(pg(), "SELECT * FROM t LIMIT 10", 0, None, false);
    assert!(!p.pageable);
    assert_eq!(p.sql, "SELECT * FROM t LIMIT 10");
}

#[test]
fn 標準の件数指定にも足さない() {
    // LIMIT を足すと構文エラーになる書き方
    let p = plan(
        pg(),
        "SELECT * FROM t ORDER BY id FETCH FIRST 10 ROWS ONLY",
        0,
        None,
        false,
    );
    assert!(!p.pageable, "{}", p.sql);
}
