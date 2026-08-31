//! お試し用のサンプルSQLiteデータベース。
//!
//! 初めて起動したとき、接続情報を用意しないと何も見られないと
//! 「何ができるアプリなのか」が分からないまま終わってしまう。
//! ボタン1つで中身のあるDBを作り、テーブル・データ・ER図をすぐ触れるようにする

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Executor, SqliteConnection};
use tauri::AppHandle;

use crate::json_store;

/// 作るファイルの名前 (アプリの設定フォルダに置く)
pub const FILE_NAME: &str = "quelio_sample.db";

/// サンプルDBの中身。1要素が1文 (SQLiteは1回に1文しか実行できない)
///
/// 受注まわりの小さなスキーマにしてある。
/// 外部キーを張ってあるので、リバースすればそのままER図になる
pub fn statements() -> Vec<&'static str> {
    vec![
        "CREATE TABLE m_shops (
            shop_id    INTEGER PRIMARY KEY,
            shop_name  TEXT    NOT NULL,
            area       TEXT    NOT NULL,
            opened_on  TEXT
        )",
        "CREATE TABLE m_users (
            user_id    INTEGER PRIMARY KEY,
            name       TEXT    NOT NULL,
            kana       TEXT,
            email      TEXT    NOT NULL,
            created_at TEXT    NOT NULL
        )",
        "CREATE TABLE m_products (
            product_id   INTEGER PRIMARY KEY,
            product_name TEXT    NOT NULL,
            category     TEXT    NOT NULL,
            price        INTEGER NOT NULL
        )",
        "CREATE TABLE t_orders (
            order_id   INTEGER PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES m_users (user_id),
            shop_id    INTEGER NOT NULL REFERENCES m_shops (shop_id),
            ordered_at TEXT    NOT NULL,
            status     TEXT    NOT NULL
        )",
        "CREATE TABLE t_order_items (
            order_item_id INTEGER PRIMARY KEY,
            order_id      INTEGER NOT NULL REFERENCES t_orders (order_id),
            product_id    INTEGER NOT NULL REFERENCES m_products (product_id),
            qty           INTEGER NOT NULL,
            price         INTEGER NOT NULL
        )",
        "CREATE INDEX idx_orders_user ON t_orders (user_id)",
        "CREATE INDEX idx_order_items_order ON t_order_items (order_id)",
        "CREATE VIEW v_order_totals AS
            SELECT o.order_id,
                   u.name AS user_name,
                   s.shop_name,
                   o.ordered_at,
                   SUM(i.qty * i.price) AS total
              FROM t_orders o
              JOIN m_users u ON u.user_id = o.user_id
              JOIN m_shops s ON s.shop_id = o.shop_id
              JOIN t_order_items i ON i.order_id = o.order_id
             GROUP BY o.order_id, u.name, s.shop_name, o.ordered_at",
        "INSERT INTO m_shops (shop_id, shop_name, area, opened_on) VALUES
            (1, '渋谷店', '東京', '2019-04-01'),
            (2, '梅田店', '大阪', '2020-09-15'),
            (3, '名駅店', '愛知', '2022-03-20')",
        "INSERT INTO m_users (user_id, name, kana, email, created_at) VALUES
            (1, '山田 太郎', 'ヤマダ タロウ', 'taro@example.com', '2024-01-10 10:00:00'),
            (2, '佐藤 花子', 'サトウ ハナコ', 'hanako@example.com', '2024-02-03 14:20:00'),
            (3, '鈴木 一郎', 'スズキ イチロウ', 'ichiro@example.com', '2024-05-21 09:05:00'),
            (4, '高橋 美咲', 'タカハシ ミサキ', 'misaki@example.com', '2025-01-08 18:40:00')",
        "INSERT INTO m_products (product_id, product_name, category, price) VALUES
            (1, 'Tシャツ (白)', 'アパレル', 2980),
            (2, 'キャップ', 'アパレル', 1980),
            (3, 'トートバッグ', '雑貨', 3480),
            (4, 'ステンレスボトル', '雑貨', 2680),
            (5, 'ドリップコーヒー 10袋', '食品', 1280)",
        "INSERT INTO t_orders (order_id, user_id, shop_id, ordered_at, status) VALUES
            (1001, 1, 1, '2025-06-01 11:20:00', '出荷済'),
            (1002, 2, 2, '2025-06-03 15:45:00', '出荷済'),
            (1003, 1, 1, '2025-07-11 09:10:00', '準備中'),
            (1004, 3, 3, '2025-07-28 20:05:00', 'キャンセル'),
            (1005, 4, 2, '2025-08-09 13:30:00', '準備中')",
        "INSERT INTO t_order_items (order_item_id, order_id, product_id, qty, price) VALUES
            (1, 1001, 1, 2, 2980),
            (2, 1001, 5, 1, 1280),
            (3, 1002, 3, 1, 3480),
            (4, 1003, 2, 1, 1980),
            (5, 1003, 4, 2, 2680),
            (6, 1004, 1, 1, 2980),
            (7, 1005, 5, 3, 1280)",
    ]
}

/// サンプルDBのファイルの場所 (アプリの設定フォルダ)
pub fn file_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    json_store::config_path(app, FILE_NAME)
}

/// サンプルDBを用意してファイルのパスを返す。
///
/// すでにあれば作り直さない (触ったあとの中身を消してしまわないため)
pub async fn ensure(app: &AppHandle) -> Result<String, String> {
    let path = file_path(app)?;
    let text = path.to_string_lossy().to_string();
    if path.is_file() {
        return Ok(text);
    }
    let opts = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);
    let mut conn = opts
        .connect()
        .await
        .map_err(|e| format!("サンプルDBを作れませんでした: {e}"))?;
    if let Err(e) = fill(&mut conn).await {
        // 途中で失敗したファイルを残すと、次回「すでにある」と誤解してしまう
        let _ = conn.close().await;
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    let _ = conn.close().await;
    Ok(text)
}

/// 空のDBにテーブルとデータを入れる
async fn fill(conn: &mut SqliteConnection) -> Result<(), String> {
    for sql in statements() {
        conn.execute(sql)
            .await
            .map_err(|e| format!("サンプルDBの作成に失敗: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    async fn built() -> SqliteConnection {
        let mut conn = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true)
            .connect()
            .await
            .unwrap();
        fill(&mut conn).await.unwrap();
        conn
    }

    #[tokio::test]
    async fn 一通りのテーブルとビューができる() {
        let mut conn = built().await;
        let names: Vec<String> =
            sqlx::query("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
                .fetch_all(&mut conn)
                .await
                .unwrap()
                .into_iter()
                .map(|r| r.get::<String, _>(0))
                .collect();
        for want in [
            "m_products",
            "m_shops",
            "m_users",
            "t_order_items",
            "t_orders",
            "v_order_totals",
        ] {
            assert!(names.contains(&want.to_string()), "{want} が無い: {names:?}");
        }
    }

    #[tokio::test]
    async fn 外部キーが張られている() {
        let mut conn = built().await;
        // ER図のリバースで線が出るように、注文は利用者・店舗を参照している
        let rows = sqlx::query("PRAGMA foreign_key_list(t_orders)")
            .fetch_all(&mut conn)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    async fn 明細の合計が集計ビューと合う() {
        let mut conn = built().await;
        let total: i64 =
            sqlx::query_scalar("SELECT total FROM v_order_totals WHERE order_id = 1001")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        // Tシャツ2枚 + コーヒー1袋
        assert_eq!(total, 2980 * 2 + 1280);
    }

    #[tokio::test]
    async fn 整合しないデータは入っていない() {
        let mut conn = built().await;
        let bad = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut conn)
            .await
            .unwrap();
        assert!(bad.is_empty(), "参照先の無い行がある");
    }
}
