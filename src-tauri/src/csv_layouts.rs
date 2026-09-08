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
use crate::json_store;

/// 名前を付けて残した桁の並び
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedLayout {
    pub name: String,
    pub layout: FixedLayout,
    pub updated_at_ms: u64,
}

/**
 * 一覧に並ぶもの (フォルダか、フォルダに入っていないお気に入り)。
 *
 * 並び順はこの一覧の順そのまま。
 * フォルダの中も `items` の順そのままで、入れ子にはしない
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LayoutNode {
    /// フォルダ (中にお気に入りを入れる)
    Folder {
        name: String,
        #[serde(default)]
        items: Vec<SavedLayout>,
    },
    /// フォルダに入っていないお気に入り
    Item {
        #[serde(flatten)]
        saved: SavedLayout,
    },
}

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

/// 読み込んだJSONを、今の形の並びにする
fn nodes_from(raw: serde_json::Value) -> Result<Vec<LayoutNode>, String> {
    let mut nodes: Vec<LayoutNode> = match serde_json::from_value(raw.clone()) {
        Ok(nodes) => nodes,
        // 古い形はフォルダを持たないので、そのまま上に並べる
        Err(_) => {
            let old: Vec<SavedLayout> = serde_json::from_value(raw)
                .map_err(|e| format!("固定長のレイアウトを読めません: {e}"))?;
            old.into_iter()
                .map(|saved| LayoutNode::Item { saved })
                .collect()
        }
    };
    // 古い形の桁設定は、今の形に直して渡す
    for node in &mut nodes {
        for s in items_mut(node) {
            s.layout = s.layout.migrated();
        }
    }
    Ok(nodes)
}

/**
 * 取り込んだお気に入りを、今の並びへ混ぜる。
 *
 * 同じ名前のものは桁設定を上書きし、無いものは足す。
 * 足す先は、取り込む側で入っていたフォルダ
 * (そのフォルダが無ければ作る)。返すのは (足した数, 上書きした数)
 */
pub fn merge(app: &AppHandle, incoming: Vec<LayoutNode>) -> Result<(usize, usize), String> {
    let mut nodes = tree(app)?;
    let mut added = 0;
    let mut updated = 0;
    for node in incoming {
        let (folder, items) = match node {
            LayoutNode::Folder { name, items } => (Some(name), items),
            LayoutNode::Item { saved } => (None, vec![saved]),
        };
        for saved in items {
            if let Some(old) = find_item(&mut nodes, &saved.name) {
                old.layout = saved.layout;
                old.updated_at_ms = saved.updated_at_ms;
                updated += 1;
                continue;
            }
            put_item(&mut nodes, folder.as_deref(), saved);
            added += 1;
        }
    }
    write(app, &nodes)?;
    Ok((added, updated))
}

/// その名前のお気に入りを探す (フォルダの中も見る)
fn find_item<'a>(nodes: &'a mut [LayoutNode], name: &str) -> Option<&'a mut SavedLayout> {
    nodes
        .iter_mut()
        .flat_map(items_mut)
        .find(|s| s.name == name)
}

/// お気に入りを足す (フォルダ名の指定があれば、そのフォルダの末尾へ)
fn put_item(nodes: &mut Vec<LayoutNode>, folder: Option<&str>, saved: SavedLayout) {
    let Some(name) = folder else {
        nodes.push(LayoutNode::Item { saved });
        return;
    };
    for node in nodes.iter_mut() {
        if let LayoutNode::Folder { name: n, items } = node {
            if n == name {
                items.push(saved);
                return;
            }
        }
    }
    // 同じ名前のフォルダが無ければ作る
    nodes.push(LayoutNode::Folder {
        name: name.to_string(),
        items: vec![saved],
    });
}

/// その節に入っているお気に入り (フォルダなら中身、そうでなければ自分)
fn items_mut(node: &mut LayoutNode) -> Vec<&mut SavedLayout> {
    match node {
        LayoutNode::Folder { items, .. } => items.iter_mut().collect(),
        LayoutNode::Item { saved } => vec![saved],
    }
}

/// 木を、並んでいる順のお気に入りの一覧にする
pub fn flatten(nodes: &[LayoutNode]) -> Vec<SavedLayout> {
    let mut out = Vec::new();
    for node in nodes {
        match node {
            LayoutNode::Folder { items, .. } => out.extend(items.iter().cloned()),
            LayoutNode::Item { saved } => out.push(saved.clone()),
        }
    }
    out
}

/**
 * 並びをまるごと入れ替える (並べ替え・フォルダ分けのあと)。
 *
 * 画面で組み立てた形をそのまま受け取る。
 * 同じ名前が2つあると選び分けられないので、そこだけ確かめる
 */
pub fn save_tree(app: &AppHandle, nodes: Vec<LayoutNode>) -> Result<Vec<LayoutNode>, String> {
    let mut seen = std::collections::HashSet::new();
    for s in flatten(&nodes) {
        if !seen.insert(s.name.clone()) {
            return Err(format!("「{}」という名前が2つあります", s.name));
        }
    }
    let mut folders = std::collections::HashSet::new();
    for node in &nodes {
        if let LayoutNode::Folder { name, .. } = node {
            if name.trim().is_empty() {
                return Err("フォルダの名前を入力してください".into());
            }
            if !folders.insert(name.clone()) {
                return Err(format!("「{name}」というフォルダが2つあります"));
            }
        }
    }
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
    let now = now_ms();
    let mut done = false;
    for node in &mut nodes {
        for s in items_mut(node) {
            if s.name == name {
                s.layout = layout.clone();
                s.updated_at_ms = now;
                done = true;
            }
        }
    }
    if !done {
        // 新しいものは、フォルダに入れずに一番下へ足す
        nodes.push(LayoutNode::Item {
            saved: SavedLayout {
                name: name.to_string(),
                layout,
                updated_at_ms: now,
            },
        });
    }
    write(app, &nodes)?;
    Ok(nodes)
}

/// 名前を指定して削除する (フォルダの中にあっても消す)
pub fn delete(app: &AppHandle, name: &str) -> Result<Vec<LayoutNode>, String> {
    let mut nodes = tree(app)?;
    nodes.retain(|n| !matches!(n, LayoutNode::Item { saved } if saved.name == name));
    for node in &mut nodes {
        if let LayoutNode::Folder { items, .. } = node {
            items.retain(|s| s.name != name);
        }
    }
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
            LayoutNode::Item { saved: saved("あ") },
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
                serde_json::from_value::<Vec<SavedLayout>>(old)
                    .map(|v| v.into_iter().map(|saved| LayoutNode::Item { saved }).collect())
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
