//! 保存SQL (お気に入り) の管理 (アプリ設定フォルダの saved_sql.json)
//!
//! フォルダは「項目が持っているパス」から組み立てるのではなく、
//! 一覧として別に持つ。
//! そうしないと空のフォルダを作れず、
//! 「先にフォルダを作ってから入れる」ができない。
//!
//! 並び順はこのファイルに並んでいる順そのままで、
//! 画面のドラッグで入れ替える (名前順に並べ替えたりはしない)

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::json_store;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSql {
    pub id: String,
    pub name: String,
    /// フォルダパス。空文字=ルート、階層は "/" 区切り (例: "集計/月次")
    #[serde(default)]
    pub folder: String,
    pub sql: String,
    pub updated_at_ms: u64,
}

/// 保存されている全体 (フォルダの一覧と、項目の一覧)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSqlStore {
    /// フォルダのパス一覧。同じ親を持つもの同士は、この並びが表示順になる
    #[serde(default)]
    pub folders: Vec<String>,
    /// 保存したSQL
    #[serde(default)]
    pub items: Vec<SavedSql>,
    /// 表示順。フォルダと項目を混ぜた1本の並びで持つ。
    ///
    /// 中身は "f:<フォルダのパス>" と "i:<項目のID>"。
    /// 同じ親を持つもの同士は、この並びがそのまま表示順になる
    /// (フォルダを項目の下に置く、といった並べ方ができる)。
    /// 古いファイルには無いので、その場合は読み込み時に組み立てる
    #[serde(default)]
    pub order: Vec<String>,
}

/// 表示順に並べる要素の呼び名
fn folder_ref(path: &str) -> String {
    format!("f:{path}")
}

fn item_ref(id: &str) -> String {
    format!("i:{id}")
}

/// 読み込み時だけ使う形。
/// 旧形式 (項目の配列そのまま) のファイルも読めるようにする
#[derive(Deserialize)]
#[serde(untagged)]
enum Stored {
    New(SavedSqlStore),
    Old(Vec<SavedSql>),
}

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    json_store::config_path(app, "saved_sql.json")
}

/// フォルダパスを整える (前後の空白と空の区切りを落とす)
fn normalize_folder(folder: &str) -> String {
    folder
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// 1つ上のフォルダ (ルート直下なら空文字)
fn parent_of(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

/// 末尾の名前
fn name_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// `path` が `of` 自身か、その下にあるか
fn is_inside(path: &str, of: &str) -> bool {
    if of.is_empty() {
        return true;
    }
    path == of || path.starts_with(&format!("{of}/"))
}

/// 親フォルダをたどって、無ければ作る (末尾の path 自身は作らない)
fn ensure_ancestors(store: &mut SavedSqlStore, path: &str) {
    let mut cur = String::new();
    for part in path.split('/') {
        if part.is_empty() {
            continue;
        }
        cur = if cur.is_empty() {
            part.to_string()
        } else {
            format!("{cur}/{part}")
        };
        if cur != path && !store.folders.iter().any(|f| f == &cur) {
            store.folders.push(cur.clone());
        }
    }
}

/// 表示順を実体に合わせて整える。
///
/// 消えたものを落とし、まだ載っていないものを後ろへ足す。
/// 表示順を持たない古いファイルは、ここで
/// 「フォルダが先、その後ろに項目」という今までの見え方になる
fn ensure_order(store: &mut SavedSqlStore) {
    let all: Vec<String> = store
        .folders
        .iter()
        .map(|f| folder_ref(f))
        .chain(store.items.iter().map(|e| item_ref(&e.id)))
        .collect();
    let known: std::collections::HashSet<&str> = all.iter().map(String::as_str).collect();
    let mut seen = std::collections::HashSet::new();
    let mut next: Vec<String> = store
        .order
        .iter()
        .filter(|r| known.contains(r.as_str()) && seen.insert(r.as_str().to_string()))
        .cloned()
        .collect();
    next.extend(all.into_iter().filter(|r| !seen.contains(r.as_str())));
    store.order = next;
}

/// 表示順の中で `node` を `before` の直前へ動かす (before が無ければ末尾へ)。
///
/// 並びは1本だが、表示は親ごとに絞り込んで作るので、
/// 兄弟でないものを跨いでいても順序は正しく決まる
fn place_node(order: &mut Vec<String>, node: &str, before: Option<&str>) {
    order.retain(|r| r != node);
    let at = before
        .and_then(|b| order.iter().position(|r| r == b))
        .unwrap_or(order.len());
    order.insert(at, node.to_string());
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 保存されている内容を読む (旧形式のファイルはここで新しい形へ直す)
pub fn load(app: &AppHandle) -> Result<SavedSqlStore, String> {
    let path = store_path(app)?;
    let stored: Option<Stored> = json_store::read(&path, "保存SQL")?;
    let mut store = match stored {
        Some(Stored::New(s)) => s,
        // 旧形式: 項目が持っているパスからフォルダを起こす
        Some(Stored::Old(items)) => from_items(items),
        None => SavedSqlStore::default(),
    };
    ensure_order(&mut store);
    Ok(store)
}

/// 旧形式 (項目だけ) からフォルダを組み立てる
fn from_items(items: Vec<SavedSql>) -> SavedSqlStore {
    let mut store = SavedSqlStore {
        folders: Vec::new(),
        items,
        order: Vec::new(),
    };
    let paths: Vec<String> = store
        .items
        .iter()
        .map(|e| e.folder.clone())
        .filter(|f| !f.is_empty())
        .collect();
    for p in paths {
        ensure_ancestors(&mut store, &p);
        if !store.folders.iter().any(|f| f == &p) {
            store.folders.push(p);
        }
    }
    // 旧版は名前順に出していたので、その並びを引き継ぐ
    store.folders.sort();
    store
}

/// 書き出す。表示順は書く直前に必ず整えるので、
/// 追加・削除のたびに呼び出し側が気にしなくてよい
fn save_all(app: &AppHandle, store: &mut SavedSqlStore) -> Result<(), String> {
    ensure_order(store);
    let path = store_path(app)?;
    let text = serde_json::to_string_pretty(store)
        .map_err(|e| format!("保存SQLのシリアライズに失敗: {e}"))?;
    json_store::write(&path, &text, "保存SQL")
}

/// 追加または更新して全体を返す (idが未指定なら新規採番)
pub fn upsert(
    app: &AppHandle,
    id: Option<String>,
    name: String,
    folder: String,
    sql: String,
) -> Result<SavedSqlStore, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名前を入力してください".into());
    }
    if sql.trim().is_empty() {
        return Err("保存するSQLがありません".into());
    }
    let folder = normalize_folder(&folder);
    let mut store = load(app)?;
    // 画面から消えたフォルダを指されても迷子にしない
    if !folder.is_empty() && !store.folders.iter().any(|f| f == &folder) {
        ensure_ancestors(&mut store, &folder);
        store.folders.push(folder.clone());
    }

    match id.filter(|s| !s.is_empty()) {
        Some(id) => {
            let entry = store
                .items
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or("保存SQLが見つかりません")?;
            entry.name = name;
            entry.folder = folder;
            entry.sql = sql;
            entry.updated_at_ms = now_ms();
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            // 新しく保存したものは、そのフォルダの先頭に出す
            store.order.insert(0, item_ref(&id));
            store.items.insert(
                0,
                SavedSql {
                    id,
                    name,
                    folder,
                    sql,
                    updated_at_ms: now_ms(),
                },
            );
        }
    }
    save_all(app, &mut store)?;
    Ok(store)
}

/// 削除して全体を返す
pub fn delete(app: &AppHandle, id: &str) -> Result<SavedSqlStore, String> {
    let mut store = load(app)?;
    store.items.retain(|e| e.id != id);
    save_all(app, &mut store)?;
    Ok(store)
}

/// フォルダを作る (親も無ければ一緒に作る)
pub fn create_folder(app: &AppHandle, path: &str) -> Result<SavedSqlStore, String> {
    let path = normalize_folder(path);
    if path.is_empty() {
        return Err("フォルダ名を入力してください".into());
    }
    let mut store = load(app)?;
    if store.folders.iter().any(|f| f == &path) {
        return Err("同じ名前のフォルダがあります".into());
    }
    ensure_ancestors(&mut store, &path);
    store.folders.push(path);
    save_all(app, &mut store)?;
    Ok(store)
}

/// フォルダの名前を変える (中のフォルダ・項目のパスも付け替える)
pub fn rename_folder(app: &AppHandle, path: &str, name: &str) -> Result<SavedSqlStore, String> {
    let path = normalize_folder(path);
    let name = normalize_folder(name);
    if name.is_empty() {
        return Err("フォルダ名を入力してください".into());
    }
    if name.contains('/') {
        return Err("フォルダ名に「/」は使えません".into());
    }
    let mut store = load(app)?;
    if !store.folders.iter().any(|f| f == &path) {
        return Err("フォルダが見つかりません".into());
    }
    let parent = parent_of(&path);
    let next = if parent.is_empty() {
        name
    } else {
        format!("{parent}/{name}")
    };
    if next == path {
        return Ok(store);
    }
    if store.folders.iter().any(|f| f == &next) {
        return Err("同じ名前のフォルダがあります".into());
    }
    retarget(&mut store, &path, &next);
    save_all(app, &mut store)?;
    Ok(store)
}

/// フォルダ (と中のフォルダ・項目) のパスを付け替える
fn retarget(store: &mut SavedSqlStore, from: &str, to: &str) {
    for f in store.folders.iter_mut() {
        if is_inside(f, from) {
            *f = format!("{to}{}", &f[from.len()..]);
        }
    }
    for e in store.items.iter_mut() {
        if is_inside(&e.folder, from) {
            e.folder = format!("{to}{}", &e.folder[from.len()..]);
        }
    }
    // 表示順もフォルダのパスで覚えているので、一緒に付け替える
    for r in store.order.iter_mut() {
        if let Some(path) = r.strip_prefix("f:") {
            if is_inside(path, from) {
                *r = folder_ref(&format!("{to}{}", &path[from.len()..]));
            }
        }
    }
}

/// フォルダを中身ごと削除して全体を返す
pub fn delete_folder(app: &AppHandle, path: &str) -> Result<SavedSqlStore, String> {
    let path = normalize_folder(path);
    if path.is_empty() {
        return Err("フォルダが見つかりません".into());
    }
    let mut store = load(app)?;
    store.folders.retain(|f| !is_inside(f, &path));
    store.items.retain(|e| !is_inside(&e.folder, &path));
    save_all(app, &mut store)?;
    Ok(store)
}

/// ドラッグでの移動。
///
/// `node` は "f:<パス>" か "i:<ID>"、`before` は
/// 「この要素の直前へ入れる」という指定 (None なら末尾)。
/// 位置を番号で渡すと「自分を除いた何番目か」を画面と保存側の
/// 両方で数える必要があり、食い違いやすかったのでこの形にしている
pub fn move_node(
    app: &AppHandle,
    node: &str,
    parent: &str,
    before: Option<String>,
) -> Result<SavedSqlStore, String> {
    let parent = normalize_folder(parent);
    let mut store = load(app)?;
    if !parent.is_empty() && !store.folders.iter().any(|f| f == &parent) {
        return Err("移動先のフォルダが見つかりません".into());
    }
    let before = before.filter(|b| b != node);

    if let Some(id) = node.strip_prefix("i:") {
        let entry = store
            .items
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or("保存SQLが見つかりません")?;
        entry.folder = parent;
        place_node(&mut store.order, node, before.as_deref());
        save_all(app, &mut store)?;
        return Ok(store);
    }

    let path = node
        .strip_prefix("f:")
        .map(normalize_folder)
        .ok_or("移動できない種類です")?;
    if !store.folders.iter().any(|f| f == &path) {
        return Err("フォルダが見つかりません".into());
    }
    // 自分自身の中へは入れられない (行き先が無くなる)
    if is_inside(&parent, &path) {
        return Err("フォルダを自分自身の中へは移動できません".into());
    }
    let next = if parent.is_empty() {
        name_of(&path).to_string()
    } else {
        format!("{parent}/{}", name_of(&path))
    };
    if next != path && store.folders.iter().any(|f| f == &next) {
        return Err("移動先に同じ名前のフォルダがあります".into());
    }
    if next != path {
        retarget(&mut store, &path, &next);
    }
    place_node(&mut store.order, &folder_ref(&next), before.as_deref());
    save_all(app, &mut store)?;
    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, folder: &str) -> SavedSql {
        SavedSql {
            id: id.to_string(),
            name: id.to_string(),
            folder: folder.to_string(),
            sql: "SELECT 1".to_string(),
            updated_at_ms: 0,
        }
    }

    fn store(folders: &[&str], items: &[(&str, &str)]) -> SavedSqlStore {
        let mut s = SavedSqlStore {
            folders: folders.iter().map(|s| s.to_string()).collect(),
            items: items.iter().map(|(id, f)| item(id, f)).collect(),
            order: Vec::new(),
        };
        ensure_order(&mut s);
        s
    }

    /// 表示順のうち、その親を持つものだけを並び順のまま取り出す (画面と同じ見え方)
    fn children(s: &SavedSqlStore, parent: &str) -> Vec<String> {
        s.order
            .iter()
            .filter(|r| match r.strip_prefix("f:") {
                Some(p) => parent_of(p) == parent,
                None => s
                    .items
                    .iter()
                    .any(|e| item_ref(&e.id) == **r && e.folder == parent),
            })
            .cloned()
            .collect()
    }

    #[test]
    fn 旧形式からフォルダを起こす() {
        let s = from_items(vec![item("a", "集計/月次"), item("b", "")]);
        // 親も作られる (空のフォルダとして残せるようにするため)
        assert_eq!(s.folders, vec!["集計", "集計/月次"]);
        assert_eq!(s.items.len(), 2);
    }

    #[test]
    fn フォルダは中身ごと消える() {
        let mut s = store(&["集計", "集計/月次", "他"], &[("a", "集計/月次"), ("b", "他")]);
        s.folders.retain(|f| !is_inside(f, "集計"));
        s.items.retain(|e| !is_inside(&e.folder, "集計"));
        assert_eq!(s.folders, vec!["他"]);
        assert_eq!(s.items.len(), 1);
    }

    #[test]
    fn 名前を変えると中身のパスも付け替わる() {
        let mut s = store(&["集計", "集計/月次"], &[("a", "集計/月次")]);
        retarget(&mut s, "集計", "レポート");
        assert_eq!(s.folders, vec!["レポート", "レポート/月次"]);
        assert_eq!(s.items[0].folder, "レポート/月次");
    }

    #[test]
    fn 表示順が無いファイルは従来の見え方になる() {
        // フォルダが先、その後ろに項目
        let s = store(&["箱"], &[("a", ""), ("b", "箱")]);
        assert_eq!(s.order, vec!["f:箱", "i:a", "i:b"]);
    }

    #[test]
    fn 表示順は実体に合わせて整えられる() {
        let mut s = store(&["箱"], &[("a", "")]);
        // 消えたもの・重複・知らないものが混ざっていても直る
        s.order = vec![
            "i:a".into(),
            "i:a".into(),
            "f:無い".into(),
            "i:消えた".into(),
        ];
        ensure_order(&mut s);
        assert_eq!(s.order, vec!["i:a", "f:箱"]);
    }

    #[test]
    fn フォルダと項目を混ぜて並べられる() {
        let mut s = store(&["箱", "他"], &[("a", ""), ("b", "")]);
        assert_eq!(children(&s, ""), vec!["f:箱", "f:他", "i:a", "i:b"]);
        // 「他」を項目 a の後ろ (= b の直前) へ
        place_node(&mut s.order, "f:他", Some("i:b"));
        assert_eq!(children(&s, ""), vec!["f:箱", "i:a", "f:他", "i:b"]);
        // 「箱」を末尾へ
        place_node(&mut s.order, "f:箱", None);
        assert_eq!(children(&s, ""), vec!["i:a", "f:他", "i:b", "f:箱"]);
    }

    #[test]
    fn 兄弟でないものを跨いでも順序は正しい() {
        // 「箱」の中の項目が間に挟まっていても、ルートの並びは変わらない
        let mut s = store(&["箱"], &[("a", ""), ("in", "箱"), ("b", "")]);
        place_node(&mut s.order, "i:b", Some("i:a"));
        // 箱の中の項目が間に挟まっていても、ルートの並びは b → a になる
        assert_eq!(children(&s, ""), vec!["f:箱", "i:b", "i:a"]);
        assert_eq!(children(&s, "箱"), vec!["i:in"]);
    }

    #[test]
    fn 名前を変えると表示順の呼び名も付け替わる() {
        let mut s = store(&["集計", "集計/月次"], &[("a", "集計/月次")]);
        retarget(&mut s, "集計", "レポート");
        assert_eq!(children(&s, ""), vec!["f:レポート"]);
        assert_eq!(children(&s, "レポート"), vec!["f:レポート/月次"]);
    }

    #[test]
    fn 自分の中へは移動できない() {
        // 「集計」を「集計/月次」の中へ入れると、行き先ごと消えてしまう
        assert!(is_inside("集計/月次", "集計"));
        assert!(!is_inside("集計", "集計/月次"));
    }

    #[test]
    fn パスの前後の空白と空の区切りは落とす() {
        assert_eq!(normalize_folder(" 集計 // 月次 / "), "集計/月次");
        assert_eq!(normalize_folder("  "), "");
    }
}
