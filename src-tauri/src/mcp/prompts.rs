//! 定型のお願い (Prompts)。
//!
//! 「テーブル定義書を作って」「この SQL が遅い理由を調べて」は
//! 毎回同じ頼み方になる。クライアント側の定型文 (Claude Code の
//! スラッシュコマンドなど) として選べるようにしておく。
//!
//! 本文は利用者に返る文章なので日本語で書く
//! (ツールの `description` はAIが読むだけなので英語、という書き分け)

pub const UNKNOWN: &str = "そのお願いは登録されていません";

/// 足りない引数があるときの文言
fn missing(name: &str) -> String {
    format!("{name} を指定してください")
}

/// 1つぶんの定義 (AIへ渡す一覧に出す説明と、引数の名前)
pub struct Spec {
    pub name: &'static str,
    pub description: &'static str,
    /// 引数の名前と説明 (すべて必須)
    pub arguments: &'static [(&'static str, &'static str)],
}

pub const TABLE_SPEC: &str = "table_spec";
pub const EXPLAIN_SLOW_QUERY: &str = "explain_slow_query";
pub const DESCRIBE_RELATIONS: &str = "describe_relations";

/// 登録してあるお願い (この並びで一覧に出る)
pub const ALL: &[Spec] = &[
    Spec {
        name: TABLE_SPEC,
        description: "テーブル定義書 (Markdown) を作る",
        arguments: &[
            ("connection", "Quelioの接続名"),
            ("table", "テーブル名 (schema.table でも可)"),
        ],
    },
    Spec {
        name: EXPLAIN_SLOW_QUERY,
        description: "遅いSQLの理由と改善案を調べる (実行はしない)",
        arguments: &[
            ("connection", "Quelioの接続名"),
            ("sql", "調べたいSQL"),
        ],
    },
    Spec {
        name: DESCRIBE_RELATIONS,
        description: "外部キーをたどって、関係するテーブルと結合の仕方を説明する",
        arguments: &[
            ("connection", "Quelioの接続名"),
            ("table", "起点のテーブル名"),
        ],
    },
];

/// 引数を1つ取り出す (空白だけは「無い」とみなす)
fn arg(args: &[(String, String)], name: &str) -> Result<String, String> {
    args.iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| missing(name))
}

/// 名前と引数から、利用者へ返す本文を作る
pub fn body(name: &str, args: &[(String, String)]) -> Result<String, String> {
    match name {
        TABLE_SPEC => {
            let conn = arg(args, "connection")?;
            let table = arg(args, "table")?;
            Ok(format!(
                "Quelioの接続「{conn}」の {table} について、\
describe_table で定義を取り、日本語のテーブル定義書を Markdown で作ってください。\n\
- カラム一覧の表 (カラム名・論理名・型・NULL許可・既定値・備考)\n\
- 主キーとインデックス\n\
- 外部キー (参照先のテーブルとカラム)\n\
- 論理名が入っていないカラムは、その旨を書いてください (推測で埋めない)"
            ))
        }
        EXPLAIN_SLOW_QUERY => {
            let conn = arg(args, "connection")?;
            let sql = arg(args, "sql")?;
            Ok(format!(
                "Quelioの接続「{conn}」で、次のSQLが遅い理由を調べてください。\n\
explain で実行計画を取り、describe_table で対象テーブルのインデックスを確かめてから、\
遅い原因と改善案 (追加すべきインデックス・SQLの書き換え) を説明してください。\n\
**このSQLは実行しないでください** (計画を見るだけにしてください)。\n\n\
```sql\n{sql}\n```"
            ))
        }
        DESCRIBE_RELATIONS => {
            let conn = arg(args, "connection")?;
            let table = arg(args, "table")?;
            Ok(format!(
                "Quelioの接続「{conn}」の {table} を起点に、\
describe_table の外部キーをたどって、関係するテーブルと結合の仕方を説明してください。\n\
- {table} から出ている外部キー (どのテーブルの何を参照しているか)\n\
- {table} を参照している側のテーブル (search_schema で探してください)\n\
- 代表的な JOIN の書き方を1つ\n\
- 1対多・多対多のどちらかが分かるように書いてください"
            ))
        }
        _ => Err(UNKNOWN.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn 定義書のお願いは引数を埋めて返す() {
        let got = body(
            TABLE_SPEC,
            &args(&[("connection", "開発DB"), ("table", "users")]),
        )
        .expect("作れること");
        assert!(got.contains("「開発DB」"), "{got}");
        assert!(got.contains("users"), "{got}");
        assert!(got.contains("describe_table"), "{got}");
    }

    #[test]
    fn 遅いsqlのお願いは実行しないよう頼む() {
        let got = body(
            EXPLAIN_SLOW_QUERY,
            &args(&[("connection", "開発DB"), ("sql", "select * from users")]),
        )
        .expect("作れること");
        assert!(got.contains("実行しないでください"), "{got}");
        assert!(got.contains("```sql\nselect * from users\n```"), "{got}");
    }

    #[test]
    fn 関係のお願いは起点のテーブルを入れる() {
        let got = body(
            DESCRIBE_RELATIONS,
            &args(&[("connection", "開発DB"), ("table", "orders")]),
        )
        .expect("作れること");
        assert!(got.contains("orders を起点"), "{got}");
        assert!(got.contains("search_schema"), "{got}");
    }

    #[test]
    fn 知らない名前は断る() {
        assert_eq!(body("nope", &args(&[])).expect_err("断ること"), UNKNOWN);
    }

    #[test]
    fn 足りない引数は名前を言って断る() {
        for spec in ALL {
            let e = body(spec.name, &args(&[])).expect_err("断ること");
            assert_eq!(e, missing(spec.arguments[0].0), "{}", spec.name);
        }
    }

    #[test]
    fn 空白だけの引数は指定なしとして断る() {
        let e = body(
            TABLE_SPEC,
            &args(&[("connection", "  "), ("table", "users")]),
        )
        .expect_err("断ること");
        assert_eq!(e, missing("connection"));
    }

    #[test]
    fn 一覧に出す3本がそろっている() {
        let names: Vec<&str> = ALL.iter().map(|s| s.name).collect();
        assert_eq!(
            names,
            vec![TABLE_SPEC, EXPLAIN_SLOW_QUERY, DESCRIBE_RELATIONS]
        );
        // 一覧に出したものは必ず本文が作れること
        for spec in ALL {
            let filled: Vec<(String, String)> = spec
                .arguments
                .iter()
                .map(|(k, _)| ((*k).to_string(), "x".to_string()))
                .collect();
            assert!(body(spec.name, &filled).is_ok(), "{}", spec.name);
        }
    }
}
