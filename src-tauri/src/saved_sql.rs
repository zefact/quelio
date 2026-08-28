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
    /// 保存したSQL。同じフォルダのもの同士は、この並びが表示順になる
    #[serde(default)]
    pub items: Vec<SavedSql>,
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

/// 同じ親を持つフォルダが、一覧の何番目に並んでいるか
fn sibling_slots(folders: &[String], parent: &str) -> Vec<usize> {
    folders
        .iter()
        .enumerate()
        .filter(|(_, f)| parent_of(f) == parent)
        .map(|(i, _)| i)
        .collect()
}

/// フォルダを「親の直下の index 番目」へ置き直す
fn place_folder(folders: &mut Vec<String>, path: &str, parent: &str, index: usize) {
    folders.retain(|f| f != path);
    let slots = sibling_slots(folders, parent);
    let at = match slots.get(index) {
        Some(&i) => i,
        // 兄弟より後ろ (末尾) へ
        None => slots.last().map(|&i| i + 1).unwrap_or(folders.len()),
    };
    folders.insert(at, path.to_string());
}

/// 項目を「そのフォルダの index 番目」へ置き直す
fn place_item(items: &mut Vec<SavedSql>, id: &str, folder: &str, index: usize) {
    let Some(pos) = items.iter().position(|e| e.id == id) else {
        return;
    };
    let mut entry = items.remove(pos);
    entry.folder = folder.to_string();
    let slots: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, e)| e.folder == folder)
        .map(|(i, _)| i)
        .collect();
    let at = match slots.get(index) {
        Some(&i) => i,
        None => slots.last().map(|&i| i + 1).unwrap_or(items.len()),
    };
    items.insert(at, entry);
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
    Ok(match stored {
        Some(Stored::New(s)) => s,
        // 旧形式: 項目が持っているパスからフォルダを起こす
        Some(Stored::Old(items)) => from_items(items),
        None => SavedSqlStore::default(),
    })
}

/// 旧形式 (項目だけ) からフォルダを組み立てる
fn from_items(items: Vec<SavedSql>) -> SavedSqlStore {
    let mut store = SavedSqlStore {
        folders: Vec::new(),
        items,
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

fn save_all(app: &AppHandle, store: &SavedSqlStore) -> Result<(), String> {
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
            store.items.insert(
                0,
                SavedSql {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    folder,
                    sql,
                    updated_at_ms: now_ms(),
                },
            );
        }
    }
    save_all(app, &store)?;
    Ok(store)
}

/// 削除して全体を返す
pub fn delete(app: &AppHandle, id: &str) -> Result<SavedSqlStore, String> {
    let mut store = load(app)?;
    store.items.retain(|e| e.id != id);
    save_all(app, &store)?;
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
    save_all(app, &store)?;
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
    save_all(app, &store)?;
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
    save_all(app, &store)?;
    Ok(store)
}

/// 項目を指定のフォルダの指定位置へ移す (ドラッグでの並べ替え)
pub fn move_item(
    app: &AppHandle,
    id: &str,
    folder: &str,
    index: usize,
) -> Result<SavedSqlStore, String> {
    let folder = normalize_folder(folder);
    let mut store = load(app)?;
    if !folder.is_empty() && !store.folders.iter().any(|f| f == &folder) {
        return Err("フォルダが見つかりません".into());
    }
    if !store.items.iter().any(|e| e.id == id) {
        return Err("保存SQLが見つかりません".into());
    }
    place_item(&mut store.items, id, &folder, index);
    save_all(app, &store)?;
    Ok(store)
}

/// フォルダを指定の親の指定位置へ移す (ドラッグでの並べ替え)
pub fn move_folder(
    app: &AppHandle,
    path: &str,
    parent: &str,
    index: usize,
) -> Result<SavedSqlStore, String> {
    let path = normalize_folder(path);
    let parent = normalize_folder(parent);
    let mut store = load(app)?;
    if !store.folders.iter().any(|f| f == &path) {
        return Err("フォルダが見つかりません".into());
    }
    if !parent.is_empty() && !store.folders.iter().any(|f| f == &parent) {
        return Err("移動先のフォルダが見つかりません".into());
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
    place_folder(&mut store.folders, &next, &parent, index);
    save_all(app, &store)?;
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
        SavedSqlStore {
            folders: folders.iter().map(|s| s.to_string()).collect(),
            items: items.iter().map(|(id, f)| item(id, f)).collect(),
        }
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
    fn 同じ親の中で並べ替える() {
        let mut folders = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        // c を先頭へ
        place_folder(&mut folders, "c", "", 0);
        assert_eq!(folders, vec!["c", "a", "b"]);
        // a を末尾へ (兄弟の数より大きい位置)
        place_folder(&mut folders, "a", "", 9);
        assert_eq!(folders, vec!["c", "b", "a"]);
    }

    #[test]
    fn 項目はフォルダを移りつつ位置も決まる() {
        let mut items = vec![item("a", ""), item("b", "箱"), item("c", "箱")];
        place_item(&mut items, "a", "箱", 1);
        let in_box: Vec<&str> = items
            .iter()
            .filter(|e| e.folder == "箱")
            .map(|e| e.id.as_str())
            .collect();
        assert_eq!(in_box, vec!["b", "a", "c"]);
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
