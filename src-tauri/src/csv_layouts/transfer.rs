//! 固定長のお気に入りの、一部だけの書き出しと、今あるものを書き換えない取り込み。
//!
//! CSVエディタの「固定長」のメニューから使う。設定画面のバックアップ
//! (全部を書き出し、同じ名前のものは上書きして戻す) と違い、こちらは
//! - 書き出すものを選べる
//! - 取り込むときは今あるお気に入りを上書きしない
//!
//! フォルダは入れ子にできない (1階層まで) ので、SQLのお気に入りのように
//! 「新しいフォルダを1つ作ってその中へ」とはせず、ファイルのフォルダ分けをそのまま足す。
//! 名前が重なるものは「名前 (2)」のように番号を付ける (お気に入りもフォルダも)。
//! ファイルの形は設定画面のバックアップと同じなので、どちらでも読める

use std::collections::HashSet;

use serde::Serialize;
use tauri::AppHandle;

use super::{flatten, parse, tree, write, LayoutNode, SavedLayout};

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
    /// 桁の数
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
fn folder_names(nodes: &[LayoutNode]) -> HashSet<String> {
    nodes
        .iter()
        .filter_map(|n| match n {
            LayoutNode::Folder { name, .. } => Some(name.clone()),
            LayoutNode::Item { .. } => None,
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
pub fn subset(nodes: &[LayoutNode], names: &[String], folders: &[String]) -> Vec<LayoutNode> {
    let names: HashSet<&str> = names.iter().map(String::as_str).collect();
    let folders: HashSet<&str> = folders.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    for node in nodes {
        match node {
            LayoutNode::Item { saved } => {
                if names.contains(saved.name.as_str()) {
                    out.push(node.clone());
                }
            }
            LayoutNode::Folder { name, items } => {
                let picked: Vec<SavedLayout> = items
                    .iter()
                    .filter(|s| names.contains(s.name.as_str()))
                    .cloned()
                    .collect();
                if !picked.is_empty() || folders.contains(name.as_str()) {
                    out.push(LayoutNode::Folder {
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
pub fn plan(existing: &[LayoutNode], incoming: &[LayoutNode]) -> Vec<FileEntry> {
    let have_items: HashSet<String> = flatten(existing).into_iter().map(|s| s.name).collect();
    let have_folders = folder_names(existing);
    let mut taken_items = have_items.clone();
    taken_items.extend(flatten(incoming).into_iter().map(|s| s.name));
    let mut taken_folders = have_folders.clone();
    taken_folders.extend(folder_names(incoming));

    let mut out = Vec::new();
    let mut entry = |s: &SavedLayout, folder: Option<&str>, save_folder: Option<&str>| {
        let save_as = if have_items.contains(&s.name) {
            numbered(&s.name, &mut taken_items)
        } else {
            s.name.clone()
        };
        out.push(FileEntry {
            name: s.name.clone(),
            folder: folder.map(str::to_string),
            save_as,
            save_folder: save_folder.map(str::to_string),
            columns: s.layout.columns.len(),
        });
    };
    for node in incoming {
        match node {
            LayoutNode::Item { saved } => entry(saved, None, None),
            LayoutNode::Folder { name, items } => {
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
pub fn import_selected(
    nodes: &mut Vec<LayoutNode>,
    incoming: Vec<LayoutNode>,
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
            LayoutNode::Item { mut saved } => {
                let Some(e) = rename(&saved.name) else {
                    continue;
                };
                done.push(Imported {
                    name: e.name.clone(),
                    saved_as: e.save_as.clone(),
                });
                saved.name = e.save_as.clone();
                nodes.push(LayoutNode::Item { saved });
            }
            LayoutNode::Folder { name, items } => {
                let mut kept = Vec::new();
                let mut folder = name;
                for mut s in items {
                    let Some(e) = rename(&s.name) else { continue };
                    done.push(Imported {
                        name: e.name.clone(),
                        saved_as: e.save_as.clone(),
                    });
                    if let Some(f) = &e.save_folder {
                        folder = f.clone();
                    }
                    s.name = e.save_as.clone();
                    kept.push(s);
                }
                if !kept.is_empty() {
                    nodes.push(LayoutNode::Folder {
                        name: folder,
                        items: kept,
                    });
                }
            }
        }
    }
    done
}

fn read_file(path: &str) -> Result<Vec<LayoutNode>, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    parse(&text)
}

/// 選んだお気に入りをJSONファイルへ書き出す (書き出した数を返す)
pub fn export_subset(
    app: &AppHandle,
    path: &str,
    names: &[String],
    folders: &[String],
) -> Result<usize, String> {
    let picked = subset(&tree(app)?, names, folders);
    let text =
        serde_json::to_string_pretty(&picked).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    crate::outfile::write(path.as_ref(), text)
        .map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(flatten(&picked).len())
}

/// ファイルの中のお気に入りと、取り込むときの名前を返す
pub fn inspect_file(app: &AppHandle, path: &str) -> Result<Vec<FileEntry>, String> {
    let incoming = read_file(path)?;
    Ok(plan(&tree(app)?, &incoming))
}

/// ファイルから選んだお気に入りを取り込む
pub fn import_file(app: &AppHandle, path: &str, names: &[String]) -> Result<Vec<Imported>, String> {
    let incoming = read_file(path)?;
    let mut nodes = tree(app)?;
    let done = import_selected(&mut nodes, incoming, names);
    if !done.is_empty() {
        write(app, &nodes)?;
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::csv_doc::fixed::{FixedLayout, WidthUnit};

    fn saved(name: &str) -> SavedLayout {
        SavedLayout {
            name: name.to_string(),
            layout: FixedLayout::from_widths(WidthUnit::Byte, &[1, 2, 3]),
            updated_at_ms: 0,
        }
    }

    fn item(name: &str) -> LayoutNode {
        LayoutNode::Item { saved: saved(name) }
    }

    fn folder(name: &str, items: &[&str]) -> LayoutNode {
        LayoutNode::Folder {
            name: name.to_string(),
            items: items.iter().map(|n| saved(n)).collect(),
        }
    }

    /// (フォルダ名, 中の名前) の並びにする (フォルダの外は "")
    fn shape(nodes: &[LayoutNode]) -> Vec<(String, Vec<String>)> {
        nodes
            .iter()
            .map(|n| match n {
                LayoutNode::Item { saved } => (String::new(), vec![saved.name.clone()]),
                LayoutNode::Folder { name, items } => {
                    (name.clone(), items.iter().map(|s| s.name.clone()).collect())
                }
            })
            .collect()
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn 選んだものだけを並び順のまま切り出す() {
        let nodes = vec![
            item("あ"),
            folder("受注", &["い", "う"]),
            folder("空", &[]),
            item("え"),
        ];
        let got = subset(&nodes, &s(&["う", "え"]), &s(&["空"]));
        assert_eq!(
            shape(&got),
            vec![
                ("受注".to_string(), s(&["う"])),
                ("空".to_string(), vec![]),
                (String::new(), s(&["え"])),
            ]
        );
        // 何も選ばなければ空
        assert!(subset(&nodes, &[], &[]).is_empty());
    }

    #[test]
    fn 重なる名前とフォルダには番号を付ける() {
        let existing = vec![item("売上"), folder("受注", &["明細"])];
        let incoming = vec![
            item("売上"),
            item("売上 (2)"),
            folder("受注", &["明細", "新規"]),
        ];
        let p = plan(&existing, &incoming);
        let got: Vec<(&str, &str, Option<&str>)> = p
            .iter()
            .map(|e| {
                (
                    e.name.as_str(),
                    e.save_as.as_str(),
                    e.save_folder.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                // 「売上 (2)」はファイルの中にあるので飛ばす
                ("売上", "売上 (3)", None),
                ("売上 (2)", "売上 (2)", None),
                ("明細", "明細 (2)", Some("受注 (2)")),
                ("新規", "新規", Some("受注 (2)")),
            ]
        );
        assert_eq!(p[0].columns, 3);
    }

    #[test]
    fn 取り込みは今あるものを書き換えず_選ばなかったフォルダは作らない() {
        let mut nodes = vec![item("売上"), folder("受注", &["明細"])];
        let incoming = vec![
            item("売上"),
            folder("受注", &["明細", "新規"]),
            folder("出荷", &["伝票"]),
        ];
        let done = import_selected(&mut nodes, incoming, &s(&["売上", "新規"]));
        assert_eq!(
            done,
            vec![
                Imported {
                    name: "売上".into(),
                    saved_as: "売上 (2)".into()
                },
                Imported {
                    name: "新規".into(),
                    saved_as: "新規".into()
                },
            ]
        );
        assert_eq!(
            shape(&nodes),
            vec![
                (String::new(), s(&["売上"])),
                ("受注".to_string(), s(&["明細"])),
                (String::new(), s(&["売上 (2)"])),
                ("受注 (2)".to_string(), s(&["新規"])),
            ]
        );
        // 取り込んだあとも、名前はどれも重ならない (保存できる形のまま)
        let names: Vec<String> = flatten(&nodes).into_iter().map(|x| x.name).collect();
        let uniq: HashSet<&String> = names.iter().collect();
        assert_eq!(names.len(), uniq.len());
    }

    #[test]
    fn 空のところへ取り込むと元の形のまま戻る() {
        let mut nodes = Vec::new();
        let incoming = vec![item("あ"), folder("受注", &["い", "う"])];
        import_selected(&mut nodes, incoming, &s(&["あ", "い", "う"]));
        assert_eq!(
            shape(&nodes),
            vec![
                (String::new(), s(&["あ"])),
                ("受注".to_string(), s(&["い", "う"])),
            ]
        );
    }
}
