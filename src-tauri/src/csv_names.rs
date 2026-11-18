//! 見出しの無いCSVに付ける列名を、名前を付けてお気に入りとして保存する。
//!
//! 見出しの行が無いCSVは、開くたびに「1」「2」… の列になる。
//! 固定長の桁設定と同じように、よく使う列名の並びをここへ残して、
//! 別のファイルにも選ぶだけで当てられるようにする (アプリ設定フォルダの csv_names.json)。
//!
//! フォルダ分け・並べ替え・バックアップと復元も固定長のお気に入りと同じで、
//! 並べ方の決まりは共通の `fav_tree` にある

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::fav_tree::{self, FavItem, FavNode, FileEntry, Imported};
use crate::json_store;

/// 名前を付けて残した列名の並び
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameSet {
    pub name: String,
    /// 左の列から順の名前 (名前を付けていない列は空)
    pub columns: Vec<String>,
    pub updated_at_ms: u64,
}

impl FavItem for NameSet {
    fn name(&self) -> &str {
        &self.name
    }
    fn set_name(&mut self, name: String) {
        self.name = name;
    }
    fn size(&self) -> usize {
        self.columns.len()
    }
}

/// 一覧に並ぶもの (フォルダか、フォルダに入っていないお気に入り)
pub type NameNode = FavNode<NameSet>;

const WHAT: &str = "CSVの列名のお気に入り";

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    json_store::config_path(app, "csv_names.json")
}

/**
 * 保存されている並び (フォルダ分けと並び順のまま)。
 *
 * はじめはフォルダの無い形 (並びをただ並べただけ) で保存していたので、それも読む
 */
pub fn tree(app: &AppHandle) -> Result<Vec<NameNode>, String> {
    match json_store::read::<serde_json::Value>(&store_path(app)?, WHAT)? {
        Some(raw) => fav_tree::nodes_from(raw, WHAT),
        None => Ok(Vec::new()),
    }
}

/// 列名の並びに名前を付けて残す (同じ名前があれば、並びの場所はそのままで上書き)
pub fn save(app: &AppHandle, name: &str, columns: Vec<String>) -> Result<Vec<NameNode>, String> {
    let set = name_set(name, columns, now_ms())?;
    let mut nodes = tree(app)?;
    fav_tree::upsert(&mut nodes, set);
    write(app, &nodes)?;
    Ok(nodes)
}

/// 残してある並びを消す (フォルダの中にあっても消す)
pub fn delete(app: &AppHandle, name: &str) -> Result<Vec<NameNode>, String> {
    let mut nodes = tree(app)?;
    fav_tree::remove(&mut nodes, name);
    write(app, &nodes)?;
    Ok(nodes)
}

/// 並べ替えやフォルダ分けの結果を、そのまま入れ替えて残す
pub fn save_tree(app: &AppHandle, nodes: Vec<NameNode>) -> Result<Vec<NameNode>, String> {
    fav_tree::check_tree(&nodes)?;
    write(app, &nodes)?;
    Ok(nodes)
}

/// 選んだお気に入りをJSONファイルへ書き出す (書き出した数を返す)
pub fn export_subset(
    app: &AppHandle,
    path: &str,
    names: &[String],
    folders: &[String],
) -> Result<usize, String> {
    let picked = fav_tree::subset(&tree(app)?, names, folders);
    let text =
        serde_json::to_string_pretty(&picked).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    crate::outfile::write(path.as_ref(), text)
        .map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(fav_tree::flatten(&picked).len())
}

/// ファイルの中のお気に入りと、取り込むときの名前を返す
pub fn inspect_file(app: &AppHandle, path: &str) -> Result<Vec<FileEntry>, String> {
    let incoming = read_file(path)?;
    Ok(fav_tree::plan(&tree(app)?, &incoming))
}

/// ファイルから選んだお気に入りを取り込む (今あるものは上書きしない)
pub fn import_file(app: &AppHandle, path: &str, names: &[String]) -> Result<Vec<Imported>, String> {
    let incoming = read_file(path)?;
    let mut nodes = tree(app)?;
    let done = fav_tree::import_selected(&mut nodes, incoming, names);
    if !done.is_empty() {
        write(app, &nodes)?;
    }
    Ok(done)
}

fn read_file(path: &str) -> Result<Vec<NameNode>, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    parse(&text)
}

/// 書き出したファイルの中身を読む (古い形も読める)
fn parse(text: &str) -> Result<Vec<NameNode>, String> {
    let raw: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("{WHAT}のJSON形式が不正です: {e}"))?;
    fav_tree::nodes_from(raw, WHAT)
}

/**
 * 保存する1件を作る。
 *
 * 名前の前後の空白は落とす。末尾の名前の無い列は持たない
 * (列数の違うファイルにも当てやすくする)。途中の空きは位置を保つために残す
 */
fn name_set(name: &str, columns: Vec<String>, at: u64) -> Result<NameSet, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("お気に入りの名前を入れてください".into());
    }
    let mut columns: Vec<String> = columns.into_iter().map(|c| c.trim().to_string()).collect();
    while columns.last().is_some_and(|c| c.is_empty()) {
        columns.pop();
    }
    if columns.is_empty() {
        return Err("列に名前が1つも付いていません".into());
    }
    Ok(NameSet {
        name: name.to_string(),
        columns,
        updated_at_ms: at,
    })
}

fn write(app: &AppHandle, nodes: &[NameNode]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(nodes)
        .map_err(|e| format!("{WHAT}を組み立てられません: {e}"))?;
    json_store::write(&store_path(app)?, &text, WHAT)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn set(name: &str, cols: &[&str]) -> NameSet {
        NameSet {
            name: name.to_string(),
            columns: s(cols),
            updated_at_ms: 0,
        }
    }

    fn names(nodes: &[NameNode]) -> Vec<String> {
        fav_tree::flatten(nodes)
            .into_iter()
            .map(|x| x.name)
            .collect()
    }

    #[test]
    fn 保存するときは名前を整え末尾の空きを落とす() {
        let got = name_set(" 売上 ", s(&["日付", "", "金額", "", ""]), 1).unwrap();
        assert_eq!(got.name, "売上");
        // 途中の空きは位置を保つために残し、末尾の空きだけ落とす
        assert_eq!(got.columns, s(&["日付", "", "金額"]));
    }

    #[test]
    fn 名前の無いものと列名の無いものは保存しない() {
        assert!(name_set("", s(&["a"]), 1).is_err());
        assert!(name_set("x", s(&["", ""]), 1).is_err());
    }

    #[test]
    fn 同じ名前はフォルダの中にあってもその場で上書きする() {
        let mut nodes: Vec<NameNode> = vec![
            NameNode::Item {
                saved: set("顧客", &["ID"]),
            },
            NameNode::Folder {
                name: "月次".into(),
                items: vec![set("売上", &["日付", "金額"])],
            },
        ];
        fav_tree::upsert(&mut nodes, set("売上", &["日付", "店", "金額"]));
        fav_tree::upsert(&mut nodes, set("新規", &["a"]));
        assert_eq!(names(&nodes), s(&["顧客", "売上", "新規"]));
        let NameNode::Folder { items, .. } = &nodes[1] else {
            panic!("フォルダのまま");
        };
        assert_eq!(items[0].columns, s(&["日付", "店", "金額"]));
    }

    #[test]
    fn はじめの形のファイル_フォルダ無しの並び_も読める() {
        let old =
            serde_json::to_string(&vec![set("売上", &["日付"]), set("顧客", &["ID"])]).unwrap();
        let nodes = parse(&old).unwrap();
        assert_eq!(names(&nodes), s(&["売上", "顧客"]));
        assert!(nodes.iter().all(|n| matches!(n, NameNode::Item { .. })));
    }

    #[test]
    fn 書き出したものを読み直せる() {
        let nodes: Vec<NameNode> = vec![
            NameNode::Item {
                saved: set("顧客", &["ID", "氏名"]),
            },
            NameNode::Folder {
                name: "月次".into(),
                items: vec![set("売上", &["日付", "", "金額"])],
            },
        ];
        let text = serde_json::to_string(&nodes).unwrap();
        let back = parse(&text).unwrap();
        assert_eq!(names(&back), s(&["顧客", "売上"]));
        assert!(matches!(back[1], NameNode::Folder { .. }));
        // 取り込む画面には列の数を出す
        let p = fav_tree::plan(&[], &back);
        assert_eq!(p[1].columns, 3);
    }
}
