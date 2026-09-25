//! ER図の一部だけの書き出しと、今ある図を書き換えない取り込み。
//!
//! ER図の画面 (図のメニュー) から使う。設定画面のバックアップ
//! (全部を書き出し、同じ名前の図は上書きして戻す) と違い、こちらは
//! - 書き出す図を選べる
//! - 取り込むときは今ある図を上書きしない (同じ名前は「名前 (2)」として足す)
//!
//! ファイルの形は設定画面のバックアップと同じ (図の名前 → 中身) なので、どちらでも読める

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use super::{load_all, write_all};

/// 取り込む前に見せる、ファイルの中の図1つ
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// ファイルの中での名前
    pub name: String,
    /// 取り込むときの名前 (同じ名前の図があれば番号付き)
    pub save_as: String,
    pub pages: usize,
    pub tables: usize,
}

/// 取り込んだ図 (元の名前と、実際に付けた名前)
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub name: String,
    pub saved_as: String,
}

/// 選んだ図だけを切り出す (名前順)
pub fn subset(all: &HashMap<String, Value>, names: &[String]) -> BTreeMap<String, Value> {
    names
        .iter()
        .filter_map(|n| all.get(n).map(|v| (n.clone(), v.clone())))
        .collect()
}

/// ファイルの中身を読む (図の名前 → 中身 のオブジェクト)。
/// 中身がオブジェクトでないものは図ではないので受け付けない
pub fn parse(text: &str) -> Result<BTreeMap<String, Value>, String> {
    let map: BTreeMap<String, Value> =
        serde_json::from_str(text).map_err(|e| format!("ER図のJSON形式が不正です: {e}"))?;
    if let Some((name, _)) = map.iter().find(|(_, v)| !v.is_object()) {
        return Err(format!(
            "ER図のファイルではありません (「{name}」の中身が不正です)"
        ));
    }
    Ok(map
        .into_iter()
        .filter(|(k, _)| !k.trim().is_empty())
        .collect())
}

/// ページ数とテーブル数 (旧形式の1ページだけの図にも対応する)
fn counts(v: &Value) -> (usize, usize) {
    let len = |x: &Value| {
        x.get("entries")
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    match v.get("pages").and_then(Value::as_array) {
        Some(pages) => (pages.len(), pages.iter().map(len).sum()),
        None => (1, len(v)),
    }
}

/// 取り込むときの名前を決める。
///
/// 今ある図と重ならない名前はそのまま。重なるものは「名前 (2)」のように番号を付ける。
/// 番号を付けた名前は、今ある図・ファイルの中の他の図・先に決めた名前のどれとも重ならない。
/// ファイル全体で決めるので、一部だけを選んで取り込んでも名前は変わらない
pub fn plan(existing: &HashSet<String>, incoming: &BTreeMap<String, Value>) -> Vec<FileEntry> {
    let mut taken: HashSet<String> = existing.clone();
    taken.extend(incoming.keys().cloned());
    incoming
        .iter()
        .map(|(name, v)| {
            let save_as = if existing.contains(name) {
                let mut n = 2;
                loop {
                    let cand = format!("{name} ({n})");
                    if !taken.contains(&cand) {
                        taken.insert(cand.clone());
                        break cand;
                    }
                    n += 1;
                }
            } else {
                name.clone()
            };
            let (pages, tables) = counts(v);
            FileEntry {
                name: name.clone(),
                save_as,
                pages,
                tables,
            }
        })
        .collect()
}

/// 選んだ図を取り込む (今ある図は書き換えない)
pub fn import_selected(
    all: &mut HashMap<String, Value>,
    mut incoming: BTreeMap<String, Value>,
    names: &[String],
) -> Vec<Imported> {
    let existing: HashSet<String> = all.keys().cloned().collect();
    let pick: HashSet<&str> = names.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    for e in plan(&existing, &incoming) {
        if !pick.contains(e.name.as_str()) {
            continue;
        }
        if let Some(v) = incoming.remove(&e.name) {
            all.insert(e.save_as.clone(), v);
            out.push(Imported {
                name: e.name,
                saved_as: e.save_as,
            });
        }
    }
    out
}

fn read_file(path: &str) -> Result<BTreeMap<String, Value>, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    parse(&text)
}

/// 選んだ図をJSONファイルへ書き出す (書き出した数を返す)
pub fn export_subset(app: &AppHandle, path: &str, names: &[String]) -> Result<usize, String> {
    let all = load_all(app)?;
    let picked = subset(&all, names);
    let text =
        serde_json::to_string_pretty(&picked).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    // テーブル定義を含むので、所有者だけが読める権限で書き出す
    crate::outfile::write(path.as_ref(), text)
        .map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(picked.len())
}

/// ファイルの中の図と、取り込むときの名前を返す
pub fn inspect_file(app: &AppHandle, path: &str) -> Result<Vec<FileEntry>, String> {
    let incoming = read_file(path)?;
    let existing: HashSet<String> = load_all(app)?.into_keys().collect();
    Ok(plan(&existing, &incoming))
}

/// ファイルから選んだ図を取り込む
pub fn import_file(app: &AppHandle, path: &str, names: &[String]) -> Result<Vec<Imported>, String> {
    let incoming = read_file(path)?;
    let mut all = load_all(app)?;
    let done = import_selected(&mut all, incoming, names);
    if !done.is_empty() {
        write_all(app, &all)?;
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file() -> BTreeMap<String, Value> {
        parse(
            &json!({
                "販売": {"pages": [{"entries": [1, 2]}, {"entries": [3]}]},
                "販売 (2)": {"pages": []},
                "旧形式": {"entries": [1, 2, 3, 4]},
            })
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn counts_pages_and_tables() {
        let p = plan(&HashSet::new(), &file());
        let get = |n: &str| p.iter().find(|e| e.name == n).unwrap();
        assert_eq!((get("販売").pages, get("販売").tables), (2, 3));
        assert_eq!((get("旧形式").pages, get("旧形式").tables), (1, 4));
    }

    #[test]
    fn same_names_get_numbers_without_hitting_other_incoming_names() {
        let existing: HashSet<String> = ["販売".to_string()].into();
        let p = plan(&existing, &file());
        let get = |n: &str| p.iter().find(|e| e.name == n).unwrap().save_as.clone();
        // 「販売 (2)」はファイルの中にあるので飛ばす
        assert_eq!(get("販売"), "販売 (3)");
        assert_eq!(get("販売 (2)"), "販売 (2)");
        assert_eq!(get("旧形式"), "旧形式");
    }

    #[test]
    fn import_never_overwrites_and_keeps_names_when_partly_selected() {
        let mut all: HashMap<String, Value> = HashMap::new();
        all.insert("販売".into(), json!({"mine": true}));
        let done = import_selected(&mut all, file(), &["販売".to_string()]);
        assert_eq!(
            done,
            vec![Imported {
                name: "販売".into(),
                saved_as: "販売 (3)".into()
            }]
        );
        assert_eq!(all["販売"], json!({"mine": true}));
        assert!(all.contains_key("販売 (3)"));
        assert!(!all.contains_key("旧形式"));
    }

    #[test]
    fn subset_and_bad_files() {
        let mut all: HashMap<String, Value> = HashMap::new();
        all.insert("a".into(), json!({}));
        all.insert("b".into(), json!({}));
        let s = subset(&all, &["b".to_string(), "zzz".to_string()]);
        assert_eq!(s.keys().collect::<Vec<_>>(), vec!["b"]);
        assert!(parse("[]").is_err());
        assert!(parse(r#"{"a": 1}"#).is_err());
        assert!(parse(r#"{" ": {}}"#).unwrap().is_empty());
    }
}
