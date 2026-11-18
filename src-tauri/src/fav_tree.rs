//! CSVエディタのお気に入り (固定長の桁設定・列名の並び) を、フォルダ分けして持つための共通部分。
//!
//! どちらのお気に入りも「名前の付いたもの」を、1階層までのフォルダに分けて並べる。
//! 並べ方・保存・バックアップの選び方・取り込み方は同じなので、ここにまとめておき、
//! 中身の違い (桁設定か列名か) は `FavItem` で受け取る

use std::collections::HashSet;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// フォルダに入れて並べるお気に入り1件
pub trait FavItem: Clone + Serialize + DeserializeOwned {
    fn name(&self) -> &str;
    fn set_name(&mut self, name: String);
    /// 取り込む画面に出す大きさ (桁の数・列の数)
    fn size(&self) -> usize;
}

/**
 * 一覧に並ぶもの (フォルダか、フォルダに入っていないお気に入り)。
 *
 * 並び順はこの一覧の順そのまま。
 * フォルダの中も `items` の順そのままで、入れ子にはしない
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    bound(serialize = "T: Serialize", deserialize = "T: DeserializeOwned")
)]
pub enum FavNode<T> {
    /// フォルダ (中にお気に入りを入れる)
    Folder {
        name: String,
        #[serde(default = "Vec::new")]
        items: Vec<T>,
    },
    /// フォルダに入っていないお気に入り
    Item {
        #[serde(flatten)]
        saved: T,
    },
}

/**
 * 読み込んだJSONを、今の形の並びにする。
 *
 * 古い形 (お気に入りをただ並べただけ) も読めるようにしてある
 */
pub fn nodes_from<T: FavItem>(
    raw: serde_json::Value,
    what: &str,
) -> Result<Vec<FavNode<T>>, String> {
    match serde_json::from_value(raw.clone()) {
        Ok(nodes) => Ok(nodes),
        // 古い形はフォルダを持たないので、そのまま上に並べる
        Err(_) => {
            let old: Vec<T> =
                serde_json::from_value(raw).map_err(|e| format!("{what}を読めません: {e}"))?;
            Ok(old
                .into_iter()
                .map(|saved| FavNode::Item { saved })
                .collect())
        }
    }
}

/// その節に入っているお気に入り (フォルダなら中身、そうでなければ自分)
pub fn items_mut<T>(node: &mut FavNode<T>) -> Vec<&mut T> {
    match node {
        FavNode::Folder { items, .. } => items.iter_mut().collect(),
        FavNode::Item { saved } => vec![saved],
    }
}

/// 木を、並んでいる順のお気に入りの一覧にする
pub fn flatten<T: Clone>(nodes: &[FavNode<T>]) -> Vec<T> {
    let mut out = Vec::new();
    for node in nodes {
        match node {
            FavNode::Folder { items, .. } => out.extend(items.iter().cloned()),
            FavNode::Item { saved } => out.push(saved.clone()),
        }
    }
    out
}

/// その名前のお気に入りを探す (フォルダの中も見る)
pub fn find_item<'a, T: FavItem>(nodes: &'a mut [FavNode<T>], name: &str) -> Option<&'a mut T> {
    nodes
        .iter_mut()
        .flat_map(items_mut)
        .find(|s| s.name() == name)
}

/// お気に入りを足す (フォルダ名の指定があれば、そのフォルダの末尾へ。無ければ作る)
pub fn put_item<T>(nodes: &mut Vec<FavNode<T>>, folder: Option<&str>, saved: T) {
    let Some(name) = folder else {
        nodes.push(FavNode::Item { saved });
        return;
    };
    for node in nodes.iter_mut() {
        if let FavNode::Folder { name: n, items } = node {
            if n == name {
                items.push(saved);
                return;
            }
        }
    }
    nodes.push(FavNode::Folder {
        name: name.to_string(),
        items: vec![saved],
    });
}

/// 同じ名前のものがあればその場で差し替え、無ければフォルダに入れずに一番下へ足す
pub fn upsert<T: FavItem>(nodes: &mut Vec<FavNode<T>>, saved: T) {
    match find_item(nodes, saved.name()) {
        Some(old) => *old = saved,
        None => nodes.push(FavNode::Item { saved }),
    }
}

/// 名前を指定して消す (フォルダの中にあっても消す。フォルダそのものは残す)
pub fn remove<T: FavItem>(nodes: &mut Vec<FavNode<T>>, name: &str) {
    nodes.retain(|n| !matches!(n, FavNode::Item { saved } if saved.name() == name));
    for node in nodes.iter_mut() {
        if let FavNode::Folder { items, .. } = node {
            items.retain(|s| s.name() != name);
        }
    }
}

/**
 * 画面で組み立てた並び (並べ替え・フォルダ分けのあと) を確かめる。
 *
 * 同じ名前が2つあると選び分けられないので、そこだけ見る
 */
pub fn check_tree<T: FavItem>(nodes: &[FavNode<T>]) -> Result<(), String> {
    let mut seen = HashSet::new();
    for s in flatten(nodes) {
        if !seen.insert(s.name().to_string()) {
            return Err(format!("「{}」という名前が2つあります", s.name()));
        }
    }
    let mut folders = HashSet::new();
    for node in nodes {
        if let FavNode::Folder { name, .. } = node {
            if name.trim().is_empty() {
                return Err("フォルダの名前を入力してください".into());
            }
            if !folders.insert(name.clone()) {
                return Err(format!("「{name}」というフォルダが2つあります"));
            }
        }
    }
    Ok(())
}

// ---------- バックアップ・復元 ----------
//
// 書き出すものは選べる。取り込むときは今あるお気に入りを上書きしない。
// フォルダは入れ子にできない (1階層まで) ので、ファイルのフォルダ分けをそのまま足す。
// 名前が重なるものは「名前 (2)」のように番号を付ける (お気に入りもフォルダも)

/// 取り込む前に見せる、ファイルの中のお気に入り1つ
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// ファイルの中での名前
    pub name: String,
    /// ファイルの中で入っていたフォルダ (入っていなければ None)
    pub folder: Option<String>,
    /// 取り込むときの名前 (同じ名前があれば番号付き)
    pub save_as: String,
    /// 取り込むときのフォルダ (同じ名前のフォルダがあれば番号付き)
    pub save_folder: Option<String>,
    /// 大きさ (桁の数・列の数)
    pub columns: usize,
}

/// 取り込んだお気に入り (元の名前と、実際に付けた名前)
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub name: String,
    pub saved_as: String,
}

/// 今あるフォルダの名前
fn folder_names<T>(nodes: &[FavNode<T>]) -> HashSet<String> {
    nodes
        .iter()
        .filter_map(|n| match n {
            FavNode::Folder { name, .. } => Some(name.clone()),
            FavNode::Item { .. } => None,
        })
        .collect()
}

/// 「名前 (2)」「名前 (3)」…のうち、まだ使われていないもの (使ったことにして返す)
fn numbered(base: &str, taken: &mut HashSet<String>) -> String {
    let mut n = 2;
    loop {
        let name = format!("{base} ({n})");
        if taken.insert(name.clone()) {
            return name;
        }
        n += 1;
    }
}

/**
 * 書き出す範囲を切り出す (並び順は今のまま)。
 *
 * 選んだお気に入りと、選んだフォルダ (中身の無いフォルダを残したいとき) を入れる。
 * お気に入りの入っているフォルダは、選ばれていなくても一緒に入れる
 */
pub fn subset<T: FavItem>(
    nodes: &[FavNode<T>],
    names: &[String],
    folders: &[String],
) -> Vec<FavNode<T>> {
    let names: HashSet<&str> = names.iter().map(String::as_str).collect();
    let folders: HashSet<&str> = folders.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    for node in nodes {
        match node {
            FavNode::Item { saved } => {
                if names.contains(saved.name()) {
                    out.push(node.clone());
                }
            }
            FavNode::Folder { name, items } => {
                let picked: Vec<T> = items
                    .iter()
                    .filter(|s| names.contains(s.name()))
                    .cloned()
                    .collect();
                if !picked.is_empty() || folders.contains(name.as_str()) {
                    out.push(FavNode::Folder {
                        name: name.clone(),
                        items: picked,
                    });
                }
            }
        }
    }
    out
}

/**
 * 取り込むときの名前とフォルダを決める。
 *
 * 今あるものと重ならない名前はそのまま、重なるものには番号を付ける。
 * 番号を付けた名前は、今あるもの・ファイルの中の他のもの・先に決めた名前の
 * どれとも重ならない。ファイル全体で決めるので、一部だけを選んで取り込んでも変わらない
 */
pub fn plan<T: FavItem>(existing: &[FavNode<T>], incoming: &[FavNode<T>]) -> Vec<FileEntry> {
    let names = |nodes: &[FavNode<T>]| -> HashSet<String> {
        flatten(nodes)
            .iter()
            .map(|s| s.name().to_string())
            .collect()
    };
    let have_items = names(existing);
    let have_folders = folder_names(existing);
    let mut taken_items = have_items.clone();
    taken_items.extend(names(incoming));
    let mut taken_folders = have_folders.clone();
    taken_folders.extend(folder_names(incoming));

    let mut out = Vec::new();
    let mut entry = |s: &T, folder: Option<&str>, save_folder: Option<&str>| {
        let save_as = if have_items.contains(s.name()) {
            numbered(s.name(), &mut taken_items)
        } else {
            s.name().to_string()
        };
        out.push(FileEntry {
            name: s.name().to_string(),
            folder: folder.map(str::to_string),
            save_as,
            save_folder: save_folder.map(str::to_string),
            columns: s.size(),
        });
    };
    for node in incoming {
        match node {
            FavNode::Item { saved } => entry(saved, None, None),
            FavNode::Folder { name, items } => {
                let save_folder = if have_folders.contains(name) {
                    numbered(name, &mut taken_folders)
                } else {
                    name.clone()
                };
                for s in items {
                    entry(s, Some(name), Some(&save_folder));
                }
            }
        }
    }
    out
}

/**
 * 選んだお気に入りを取り込む (今あるものは書き換えない)。
 *
 * フォルダはいつも新しく作って末尾へ足す (同じ名前のフォルダへ混ぜない)。
 * 1つも選ばれなかったフォルダは作らない
 */
pub fn import_selected<T: FavItem>(
    nodes: &mut Vec<FavNode<T>>,
    incoming: Vec<FavNode<T>>,
    names: &[String],
) -> Vec<Imported> {
    let pick: HashSet<&str> = names.iter().map(String::as_str).collect();
    let planned = plan(nodes, &incoming);
    let rename = |name: &str| -> Option<&FileEntry> {
        planned
            .iter()
            .find(|e| e.name == name && pick.contains(name))
    };
    let mut done = Vec::new();
    for node in incoming {
        match node {
            FavNode::Item { mut saved } => {
                let Some(e) = rename(saved.name()) else {
                    continue;
                };
                done.push(Imported {
                    name: e.name.clone(),
                    saved_as: e.save_as.clone(),
                });
                saved.set_name(e.save_as.clone());
                nodes.push(FavNode::Item { saved });
            }
            FavNode::Folder { name, items } => {
                let mut kept = Vec::new();
                let mut folder = name;
                for mut s in items {
                    let Some(e) = rename(s.name()) else { continue };
                    done.push(Imported {
                        name: e.name.clone(),
                        saved_as: e.save_as.clone(),
                    });
                    if let Some(f) = &e.save_folder {
                        folder = f.clone();
                    }
                    s.set_name(e.save_as.clone());
                    kept.push(s);
                }
                if !kept.is_empty() {
                    nodes.push(FavNode::Folder {
                        name: folder,
                        items: kept,
                    });
                }
            }
        }
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 試し用のお気に入り (名前と大きさだけ)
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct Fav {
        name: String,
        size: usize,
    }

    impl FavItem for Fav {
        fn name(&self) -> &str {
            &self.name
        }
        fn set_name(&mut self, name: String) {
            self.name = name;
        }
        fn size(&self) -> usize {
            self.size
        }
    }

    fn fav(name: &str, size: usize) -> Fav {
        Fav {
            name: name.to_string(),
            size,
        }
    }

    fn sample() -> Vec<FavNode<Fav>> {
        vec![
            FavNode::Item {
                saved: fav("あ", 1),
            },
            FavNode::Folder {
                name: "受注".into(),
                items: vec![fav("い", 2), fav("う", 3)],
            },
        ]
    }

    fn names(nodes: &[FavNode<Fav>]) -> Vec<String> {
        flatten(nodes).into_iter().map(|f| f.name).collect()
    }

    #[test]
    fn 消すとフォルダの中からも消えフォルダは残る() {
        let mut nodes = sample();
        remove(&mut nodes, "い");
        remove(&mut nodes, "あ");
        assert_eq!(names(&nodes), vec!["う"]);
        assert!(matches!(&nodes[0], FavNode::Folder { name, .. } if name == "受注"));
    }

    #[test]
    fn 同じ名前はその場で差し替え_無ければ一番下へ足す() {
        let mut nodes = sample();
        upsert(&mut nodes, fav("う", 9));
        upsert(&mut nodes, fav("え", 4));
        assert_eq!(names(&nodes), vec!["あ", "い", "う", "え"]);
        assert_eq!(find_item(&mut nodes, "う").map(|f| f.size), Some(9));
        assert!(matches!(nodes[2], FavNode::Item { .. }));
    }

    #[test]
    fn 名前やフォルダが重なる並びは受け付けない() {
        assert!(check_tree(&sample()).is_ok());
        let mut dup = sample();
        dup.push(FavNode::Item {
            saved: fav("う", 1),
        });
        assert!(check_tree(&dup).is_err());
        let mut dup_folder = sample();
        dup_folder.push(FavNode::Folder {
            name: "受注".into(),
            items: vec![],
        });
        assert!(check_tree(&dup_folder).is_err());
        let blank = vec![FavNode::<Fav>::Folder {
            name: " ".into(),
            items: vec![],
        }];
        assert!(check_tree(&blank).is_err());
    }

    #[test]
    fn 書いて読み直せ_古い形の並びも読める() {
        let text = serde_json::to_value(sample()).unwrap();
        // 画面とやり取りする形: kind で見分け、お気に入りは平らに並ぶ
        assert_eq!(text[0]["kind"], "item");
        assert_eq!(text[0]["name"], "あ");
        assert_eq!(text[1]["kind"], "folder");
        let back: Vec<FavNode<Fav>> = nodes_from(text, "試し").unwrap();
        assert_eq!(names(&back), vec!["あ", "い", "う"]);
        let old = serde_json::to_value(vec![fav("か", 1)]).unwrap();
        let back: Vec<FavNode<Fav>> = nodes_from(old, "試し").unwrap();
        assert_eq!(names(&back), vec!["か"]);
        // どちらの形でもないものは読めないと言う
        assert!(nodes_from::<Fav>(serde_json::json!({"x": 1}), "試し").is_err());
    }
}
