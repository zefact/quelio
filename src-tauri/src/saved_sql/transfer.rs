//! お気に入りの一部だけの書き出しと、新しいフォルダへの取り込み。
//!
//! お気に入りの画面から使う。設定画面のバックアップ (全部を書き出し、
//! 同じIDは上書きして戻す) と違い、こちらは
//! - 書き出すものを選べる
//! - 取り込むときは新しいフォルダを1つ作り、その中にだけ入れる
//!
//! 取り込みで今あるお気に入りを書き換えることは無い
//! (IDも振り直すので、同じファイルを2回取り込んでも上書きにならない)。
//! ファイルの形は設定画面のバックアップと同じなので、どちらでも読める

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::*;

/// 取り込む前に見せる、ファイルの中身の数
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub items: usize,
    pub folders: usize,
}

/// 取り込んだ結果 (実際に作ったフォルダ名と、入れた数)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedInto {
    pub folder: String,
    pub added: usize,
}

/// パスとその祖先を集める ("a/b/c" → a, a/b, a/b/c)
fn with_ancestors(path: &str, out: &mut HashSet<String>) {
    let mut cur = normalize_folder(path);
    while !cur.is_empty() {
        out.insert(cur.clone());
        cur = parent_of(&cur);
    }
}

/// 書き出す範囲を切り出す。
///
/// 選んだ項目と、選んだフォルダ (中身の無いフォルダを残したいとき) を入れる。
/// 項目の入っているフォルダは、選ばれていなくても親ごと入れる
/// (入れないと、戻したときに行き場が無くなる)。
/// 並び順は今の並びのまま
pub fn subset(store: &SavedSqlStore, ids: &[String], folders: &[String]) -> SavedSqlStore {
    let ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let items: Vec<SavedSql> = store
        .items
        .iter()
        .filter(|e| ids.contains(e.id.as_str()))
        .cloned()
        .collect();

    let mut need = HashSet::new();
    for f in folders {
        with_ancestors(f, &mut need);
    }
    for e in &items {
        with_ancestors(&e.folder, &mut need);
    }
    let mut kept: Vec<String> = store
        .folders
        .iter()
        .filter(|f| need.contains(f.as_str()))
        .cloned()
        .collect();
    // 一覧に載っていないフォルダを指す古いデータでも、行き場を作っておく
    let mut missing: Vec<String> = need.into_iter().filter(|f| !kept.contains(f)).collect();
    missing.sort();
    kept.extend(missing);

    let refs: HashSet<String> = kept
        .iter()
        .map(|f| folder_ref(f))
        .chain(items.iter().map(|e| item_ref(&e.id)))
        .collect();
    let order = store
        .order
        .iter()
        .filter(|r| refs.contains(r.as_str()))
        .cloned()
        .collect();
    let mut out = SavedSqlStore {
        folders: kept,
        items,
        order,
    };
    ensure_order(&mut out);
    out
}

/// ファイルの中身の数 (取り込む前の確認用)
pub fn summary(incoming: &SavedSqlStore) -> Summary {
    Summary {
        items: incoming.items.len(),
        folders: incoming.folders.len(),
    }
}

/// そのフォルダ名がもう使われているか (中の項目が指しているだけの古いデータも含める)
fn root_taken(store: &SavedSqlStore, name: &str) -> bool {
    store.folders.iter().any(|f| is_inside(f, name))
        || store.items.iter().any(|e| is_inside(&e.folder, name))
}

/// 取り込み先のフォルダ名を決める。
///
/// 同じ名前が既にあると、中身が混ざって「既存を壊さない」が守れなくなる。
/// 重なるときは「名前 (2)」のように番号を付けて、必ず新しいフォルダにする
pub fn unique_root(store: &SavedSqlStore, name: &str) -> Result<String, String> {
    let base = name.trim();
    if base.is_empty() {
        return Err("フォルダ名を入力してください".into());
    }
    if base.contains('/') {
        return Err("フォルダ名に「/」は使えません".into());
    }
    if !root_taken(store, base) {
        return Ok(base.to_string());
    }
    let mut n = 2;
    loop {
        let name = format!("{base} ({n})");
        if !root_taken(store, &name) {
            return Ok(name);
        }
        n += 1;
    }
}

/// 取り込んだ内容を、新しいフォルダ `root` の下へ入れる。
///
/// ファイルの中のフォルダ分けと並び順は、そのフォルダの中で保つ。
/// 項目のIDは振り直す (今あるものと重なっても上書きしない)。
/// 新しいフォルダは一覧のいちばん下に置く。返すのは入れた数
pub fn import_into(
    store: &mut SavedSqlStore,
    incoming: SavedSqlStore,
    root: &str,
    mut new_id: impl FnMut() -> String,
) -> usize {
    let under = |f: &str| {
        let f = normalize_folder(f);
        if f.is_empty() {
            root.to_string()
        } else {
            format!("{root}/{f}")
        }
    };
    let add_folder = |store: &mut SavedSqlStore, path: String| {
        if !store.folders.contains(&path) {
            ensure_ancestors(store, &path);
            store.folders.push(path);
        }
    };

    add_folder(store, root.to_string());
    for f in &incoming.folders {
        add_folder(store, under(f));
    }
    let mut ids = HashMap::new();
    let mut added = 0;
    for item in incoming.items {
        let id = new_id();
        let folder = under(&item.folder);
        add_folder(store, folder.clone());
        ids.insert(item.id.clone(), id.clone());
        store.items.push(SavedSql { id, folder, ..item });
        added += 1;
    }

    // 並び: 新しいフォルダを末尾に置き、中はファイルの並びのまま
    store.order.retain(|r| r != &folder_ref(root));
    store.order.push(folder_ref(root));
    for r in &incoming.order {
        if let Some(path) = r.strip_prefix("f:") {
            store.order.push(folder_ref(&under(path)));
        } else if let Some(id) = r.strip_prefix("i:").and_then(|old| ids.get(old)) {
            store.order.push(item_ref(id));
        }
    }
    ensure_order(store);
    added
}

/// 選んだものだけをJSONファイルへ書き出す (書き出した数を返す)
pub fn export_subset(
    app: &AppHandle,
    path: &str,
    ids: &[String],
    folders: &[String],
) -> Result<usize, String> {
    let part = subset(&load(app)?, ids, folders);
    if part.items.is_empty() && part.folders.is_empty() {
        return Err("書き出すものが選ばれていません".into());
    }
    let text =
        serde_json::to_string_pretty(&part).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(part.items.len())
}

/// ファイルを読んで、中身の数を返す (取り込む前の確認用)
pub fn inspect_file(path: &str) -> Result<Summary, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    Ok(summary(&parse(&text)?))
}

/// ファイルの中身を、新しいフォルダを作ってその中へ取り込む
pub fn import_file_into(app: &AppHandle, path: &str, name: &str) -> Result<ImportedInto, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    let incoming = parse(&text)?;
    if incoming.items.is_empty() && incoming.folders.is_empty() {
        return Err("取り込むお気に入りがありません".into());
    }
    let mut store = load(app)?;
    let folder = unique_root(&store, name)?;
    let added = import_into(&mut store, incoming, &folder, || {
        uuid::Uuid::new_v4().to_string()
    });
    save_all(app, &mut store)?;
    Ok(ImportedInto { folder, added })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, folder: &str) -> SavedSql {
        SavedSql {
            id: id.to_string(),
            name: format!("n-{id}"),
            folder: folder.to_string(),
            sql: format!("SELECT '{id}'"),
            updated_at_ms: 5,
        }
    }

    /// 集計 / 集計/月次 / 空 の3フォルダと、項目3件
    fn store() -> SavedSqlStore {
        let mut s = SavedSqlStore {
            folders: vec!["集計".into(), "集計/月次".into(), "空".into()],
            items: vec![item("a", ""), item("b", "集計"), item("c", "集計/月次")],
            order: vec![
                "i:a".into(),
                "f:集計".into(),
                "i:b".into(),
                "f:集計/月次".into(),
                "i:c".into(),
                "f:空".into(),
            ],
        };
        ensure_order(&mut s);
        s
    }

    #[test]
    fn 選んだ項目だけを書き出し_入っているフォルダは親ごと付ける() {
        let got = subset(&store(), &["c".to_string()], &[]);
        assert_eq!(got.items.len(), 1);
        assert_eq!(got.folders, vec!["集計", "集計/月次"]);
        // 並びは元のまま
        assert_eq!(got.order, vec!["f:集計", "f:集計/月次", "i:c"]);
    }

    #[test]
    fn 中身の無いフォルダも選べば書き出す() {
        let got = subset(&store(), &[], &["空".to_string()]);
        assert!(got.items.is_empty());
        assert_eq!(got.folders, vec!["空"]);
    }

    #[test]
    fn 取り込みは新しいフォルダの中にだけ入れる() {
        let mut s = store();
        let before = s.items.clone();
        let incoming = subset(&store(), &["a".into(), "c".into()], &[]);
        let mut n = 0;
        let added = import_into(&mut s, incoming, "復元", || {
            n += 1;
            format!("new{n}")
        });
        assert_eq!(added, 2);
        // 今あるものは1件も変わっていない
        assert_eq!(&s.items[..before.len()], &before[..]);
        // 取り込んだものは新しいIDで、新しいフォルダの下に入る
        let new: Vec<_> = s.items[before.len()..].iter().collect();
        assert_eq!(new[0].id, "new1");
        assert_eq!(new[0].folder, "復元");
        assert_eq!(new[1].folder, "復元/集計/月次");
        assert!(s.folders.contains(&"復元/集計".to_string()));
        // 新しいフォルダは一覧のいちばん下 (ルートの末尾)
        let roots: Vec<_> = s
            .order
            .iter()
            .filter(|r| r.as_str() == "i:a" || (r.starts_with("f:") && !r.contains('/')))
            .collect();
        assert_eq!(roots.last().unwrap().as_str(), "f:復元");
    }

    #[test]
    fn 同じファイルを2回取り込んでも上書きしない() {
        let mut s = store();
        let file = subset(&store(), &["b".into()], &[]);
        let mut n = 0;
        let mut id = || {
            n += 1;
            format!("x{n}")
        };
        let first = unique_root(&s, "復元").unwrap();
        import_into(&mut s, file.clone(), &first, &mut id);
        let second = unique_root(&s, "復元").unwrap();
        import_into(&mut s, file, &second, &mut id);
        assert_eq!(first, "復元");
        assert_eq!(second, "復元 (2)");
        assert_eq!(s.items.len(), 5);
    }

    #[test]
    fn 既にある名前には番号を付けて別のフォルダにする() {
        let s = store();
        assert_eq!(unique_root(&s, "集計").unwrap(), "集計 (2)");
        assert_eq!(unique_root(&s, " 新規 ").unwrap(), "新規");
        assert!(unique_root(&s, "").is_err());
        assert!(unique_root(&s, "a/b").is_err());
    }

    #[test]
    fn 中身の数を数える() {
        assert_eq!(summary(&store()), Summary { items: 3, folders: 3 });
    }
}
