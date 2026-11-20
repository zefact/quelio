//! 固定長の桁設定を、名前を付けてお気に入りとして保存する。
//!
//! 固定長のファイルには桁の情報が入っていないので、同じ形式のファイルを
//! 開くたびに桁を入れ直すことになる。よく使う形はここへ残して選べるようにする
//! (アプリ設定フォルダの csv_layouts.json)。
//!
//! 数が増えると探しにくいので、フォルダに分けて並べ替えられるようにしてある。
//! フォルダは1階層まで (入れ子にはしない)

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::csv_doc::fixed::FixedLayout;
use crate::fav_tree::{self, FavItem, FavNode};
use crate::json_store;

pub mod transfer;

/// 名前を付けて残した桁の並び
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedLayout {
    pub name: String,
    pub layout: FixedLayout,
    pub updated_at_ms: u64,
}

impl FavItem for SavedLayout {
    fn name(&self) -> &str {
        &self.name
    }
    fn set_name(&mut self, name: String) {
        self.name = name;
    }
    fn size(&self) -> usize {
        self.layout.columns.len()
    }
}

/**
 * 一覧に並ぶもの (フォルダか、フォルダに入っていないお気に入り)。
 *
 * 並べ方は列名のお気に入りと同じなので、共通の形 (`fav_tree`) を使う
 */
pub type LayoutNode = FavNode<SavedLayout>;

pub use fav_tree::flatten;

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    json_store::config_path(app, "csv_layouts.json")
}

/**
 * 保存されている中身を読む。
 *
 * 古い形 (お気に入りをただ並べただけ) のファイルも読めるようにしてある
 */
pub fn tree(app: &AppHandle) -> Result<Vec<LayoutNode>, String> {
    let path = store_path(app)?;
    let raw: Option<serde_json::Value> = json_store::read(&path, "固定長のレイアウト")?;
    match raw {
        Some(raw) => nodes_from(raw),
        None => Ok(Vec::new()),
    }
}

/**
 * 書き出したファイルの中身を読む (バックアップからの復元用)。
 *
 * 古い形のファイルも読めるようにしてある
 */
pub fn parse(text: &str) -> Result<Vec<LayoutNode>, String> {
    let raw: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("固定長のレイアウトのJSON形式が不正です: {e}"))?;
    nodes_from(raw)
}

/// 読み込んだJSONを、今の形の並びにする (古い形の桁設定も今の形に直す)
fn nodes_from(raw: serde_json::Value) -> Result<Vec<LayoutNode>, String> {
    let mut nodes: Vec<LayoutNode> = fav_tree::nodes_from(raw, "固定長のレイアウト")?;
    for node in &mut nodes {
        for s in fav_tree::items_mut(node) {
            s.layout = s.layout.migrated();
        }
    }
    Ok(nodes)
}

/**
 * 取り込んだお気に入りを、今の並びへ混ぜる (設定画面のバックアップからの復元)。
 *
 * 同じ名前のものは桁設定を上書きし、無いものは足す。
 * 足す先は、取り込む側で入っていたフォルダ
 * (そのフォルダが無ければ作る)。返すのは (足した数, 上書きした数)
 */
pub fn merge(app: &AppHandle, incoming: Vec<LayoutNode>) -> Result<(usize, usize), String> {
    let mut nodes = tree(app)?;
    let (added, overwritten) = merge_into(&mut nodes, incoming);
    write(app, &nodes)?;
    Ok((added, overwritten.len()))
}

/**
 * 取り込んだら何件増えて、どれが上書きされるかを数える (書き込まない)。
 *
 * 判定は `merge` と同じ `merge_into` を、読んだ中身に当てて求める。
 * 返すのは (追加数, 上書きされるお気に入りの名前)
 */
pub fn preview_merge(
    app: &AppHandle,
    incoming: Vec<LayoutNode>,
) -> Result<(usize, Vec<String>), String> {
    let mut nodes = tree(app)?;
    Ok(merge_into(&mut nodes, incoming))
}

/// 今の並びへ取り込むお気に入りを混ぜる (同じ名前は桁設定を上書き)。
/// (追加数, 上書きしたお気に入りの名前) を返す
fn merge_into(nodes: &mut Vec<LayoutNode>, incoming: Vec<LayoutNode>) -> (usize, Vec<String>) {
    let mut added = 0;
    let mut overwritten = Vec::new();
    for node in incoming {
        let (folder, items) = match node {
            LayoutNode::Folder { name, items } => (Some(name), items),
            LayoutNode::Item { saved } => (None, vec![saved]),
        };
        for saved in items {
            if let Some(old) = fav_tree::find_item(nodes, &saved.name) {
                old.layout = saved.layout;
                old.updated_at_ms = saved.updated_at_ms;
                overwritten.push(saved.name);
                continue;
            }
            fav_tree::put_item(nodes, folder.as_deref(), saved);
            added += 1;
        }
    }
    (added, overwritten)
}

/**
 * 並びをまるごと入れ替える (並べ替え・フォルダ分けのあと)。
 *
 * 画面で組み立てた形をそのまま受け取る。
 * 同じ名前が2つあると選び分けられないので、そこだけ確かめる
 */
pub fn save_tree(app: &AppHandle, nodes: Vec<LayoutNode>) -> Result<Vec<LayoutNode>, String> {
    fav_tree::check_tree(&nodes)?;
    write(app, &nodes)?;
    Ok(nodes)
}

/// 名前を付けて保存する (同じ名前があれば、その場で上書き)
pub fn save(app: &AppHandle, name: &str, layout: FixedLayout) -> Result<Vec<LayoutNode>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名前を入力してください".into());
    }
    if layout.columns.is_empty() {
        return Err("桁が設定されていません".into());
    }
    let mut nodes = tree(app)?;
    // 新しいものは、フォルダに入れずに一番下へ足す
    fav_tree::upsert(
        &mut nodes,
        SavedLayout {
            name: name.to_string(),
            layout,
            updated_at_ms: now_ms(),
        },
    );
    write(app, &nodes)?;
    Ok(nodes)
}

/// 名前を指定して削除する (フォルダの中にあっても消す)
pub fn delete(app: &AppHandle, name: &str) -> Result<Vec<LayoutNode>, String> {
    let mut nodes = tree(app)?;
    fav_tree::remove(&mut nodes, name);
    write(app, &nodes)?;
    Ok(nodes)
}

fn write(app: &AppHandle, nodes: &[LayoutNode]) -> Result<(), String> {
    let path = store_path(app)?;
    let text = serde_json::to_string_pretty(nodes)
        .map_err(|e| format!("固定長のレイアウトを組み立てられません: {e}"))?;
    json_store::write(&path, &text, "固定長のレイアウト")
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
    use crate::csv_doc::fixed::WidthUnit;
    use crate::fav_tree::{find_item, put_item};

    fn saved(name: &str) -> SavedLayout {
        SavedLayout {
            name: name.to_string(),
            layout: FixedLayout::from_widths(WidthUnit::Byte, &[1, 2]),
            updated_at_ms: 0,
        }
    }

    fn folder_names(nodes: &[LayoutNode]) -> Vec<String> {
        nodes
            .iter()
            .filter_map(|n| match n {
                LayoutNode::Folder { name, .. } => Some(name.clone()),
                LayoutNode::Item { .. } => None,
            })
            .collect()
    }

    fn nodes() -> Vec<LayoutNode> {
        vec![
            LayoutNode::Item {
                saved: saved("あ")
            },
            LayoutNode::Folder {
                name: "受注".to_string(),
                items: vec![saved("い"), saved("う")],
            },
        ]
    }

    #[test]
    fn 並んでいる順に平らにする() {
        let got: Vec<String> = flatten(&nodes()).into_iter().map(|s| s.name).collect();
        assert_eq!(got, vec!["あ", "い", "う"]);
    }

    #[test]
    fn 古い形のファイルも読める() {
        let old = serde_json::json!([
            { "name": "あ", "layout": FixedLayout::from_widths(WidthUnit::Byte, &[3]), "updatedAtMs": 1 }
        ]);
        let nodes: Vec<LayoutNode> = serde_json::from_value(old.clone())
            .or_else(|_| {
                serde_json::from_value::<Vec<SavedLayout>>(old).map(|v| {
                    v.into_iter()
                        .map(|saved| LayoutNode::Item { saved })
                        .collect()
                })
            })
            .expect("読めること");
        assert_eq!(flatten(&nodes).len(), 1);
    }

    #[test]
    fn 取り込んだものは入っていたフォルダへ足す() {
        let mut nodes = nodes();
        put_item(&mut nodes, Some("受注"), saved("え"));
        put_item(&mut nodes, Some("出荷"), saved("お"));
        put_item(&mut nodes, None, saved("か"));
        let names: Vec<String> = flatten(&nodes).into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["あ", "い", "う", "え", "お", "か"]);
        // 無かったフォルダは作られる
        assert_eq!(folder_names(&nodes), vec!["受注", "出荷"]);
    }

    #[test]
    fn 取り込みは同じ名前を上書きとして数える() {
        let mut now = nodes();
        let incoming = vec![
            LayoutNode::Item { saved: saved("う") },
            LayoutNode::Folder {
                name: "出荷".to_string(),
                items: vec![saved("え"), saved("あ")],
            },
        ];
        let (added, overwritten) = merge_into(&mut now, incoming);
        assert_eq!(added, 1);
        assert_eq!(overwritten, vec!["う", "あ"]);
        let names: Vec<String> = flatten(&now).into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["あ", "い", "う", "え"]);
    }

    #[test]
    fn 同じ名前はフォルダの中にあっても見つかる() {
        let mut nodes = nodes();
        assert!(find_item(&mut nodes, "う").is_some());
        assert!(find_item(&mut nodes, "ない").is_none());
    }

    #[test]
    fn 書き出したものを読み直せる() {
        let text = serde_json::to_string(&nodes()).unwrap();
        assert_eq!(flatten(&parse(&text).unwrap()).len(), 3);
        // 古い形 (お気に入りを並べただけ) も読める
        let old = serde_json::to_string(&vec![saved("あ")]).unwrap();
        assert_eq!(flatten(&parse(&old).unwrap()).len(), 1);
    }

    #[test]
    fn 今の形は書いて読み直せる() {
        let text = serde_json::to_string(&nodes()).unwrap();
        let back: Vec<LayoutNode> = serde_json::from_str(&text).unwrap();
        assert_eq!(flatten(&back).len(), 3);
        assert!(matches!(back[1], LayoutNode::Folder { .. }));
    }
}
