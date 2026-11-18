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

#[cfg(test)]
use std::collections::HashSet;

use tauri::AppHandle;

#[cfg(test)]
use super::SavedLayout;
use super::{flatten, parse, tree, write, LayoutNode};
pub use crate::fav_tree::{import_selected, plan, subset, FileEntry, Imported};

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
