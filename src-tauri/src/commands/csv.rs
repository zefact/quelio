//! CSVエディタ (別ウィンドウ) の入口。
//!
//! 中身の判断は `csv_doc` / `csv_diff` に置き、ここは受け渡しだけにする。
//! 全行はRust側が持っているので、画面へはページと要約しか返さない

use std::path::PathBuf;

use super::*;
use crate::csv_diff::{self, DiffOptions};
use crate::csv_doc::edit::{CellEdit, Edit};
use crate::csv_doc::filter::{self, ColumnFilter};
use crate::csv_doc::find::{self, FindOptions, Match};
use crate::csv_doc::order::Sort;
use crate::csv_doc::fixed::{FixedLayout, Reading, WidthUnit};
use crate::csv_doc::format::{self, Newline, Quote, Quoting};
use crate::csv_doc::{CsvDoc, CsvDocuments, CsvInfo, CsvPage, StoredDiff};

/// 画面から来るセル1つの書き換え (直前の値はRust側で読むので受け取らない)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellPatch {
    pub row: usize,
    pub col: usize,
    pub value: String,
}

/// 差分の1行を、左右の値まで入れて画面へ返す形
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPageRow {
    pub status: csv_diff::RowStatus,
    /// 左の行位置 (画面に出す行番号にも使う)
    pub left: Option<usize>,
    pub right: Option<usize>,
    pub changed: Vec<u32>,
    /// 対応付けた列の並びでの左の値 (無い列は空文字)
    pub left_cells: Vec<String>,
    pub right_cells: Vec<String>,
}

/// 差分の1ページ
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPage {
    pub offset: usize,
    pub rows: Vec<DiffPageRow>,
    pub total: usize,
}

/// CSVファイルを開く。encodingを渡すと自動判定せずにその文字コードで読む
#[tauri::command]
pub fn csv_open(
    docs: State<'_, CsvDocuments>,
    path: String,
    encoding: Option<String>,
) -> Result<CsvInfo, String> {
    let doc = CsvDoc::open(&PathBuf::from(&path), encoding.as_deref())?;
    let id = docs.insert(doc)?;
    docs.with(&id, |d| d.info(&id))
}

/**
 * 固定長として読むときの指定。
 *
 * `layout` があればそのとおりに読み、`widths` だけなら幅は指定・詰め方は中身から見分ける。
 * どちらも無ければ幅も詰め方も推測する
 */
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedSpec {
    pub unit: WidthUnit,
    pub widths: Option<Vec<usize>>,
    pub layout: Option<FixedLayout>,
}

impl FixedSpec {
    /// 読み方に直す
    fn reading(&self) -> Reading<'_> {
        match (&self.layout, &self.widths) {
            (Some(l), _) => Reading::Layout(l),
            (None, Some(w)) => Reading::Widths(w),
            (None, None) => Reading::Guess,
        }
    }
}

/// 固定長のファイルを開く
#[tauri::command]
pub fn csv_open_fixed(
    docs: State<'_, CsvDocuments>,
    path: String,
    encoding: Option<String>,
    spec: FixedSpec,
) -> Result<CsvInfo, String> {
    let doc = CsvDoc::open_fixed(
        &PathBuf::from(&path),
        encoding.as_deref(),
        spec.unit,
        spec.reading(),
    )?;
    let id = docs.insert(doc)?;
    docs.with(&id, |d| d.info(&id))
}

/**
 * 開いてあるタブの読み方を変える (固定長 ⇄ 区切り文字、桁の指定変更)。
 *
 * 読み方が変わると行の切れ方そのものが変わるので、ファイルから読み直す。
 * 編集した内容は引き継げないため、保存していない変更があるときは断る
 */
#[tauri::command]
pub fn csv_set_fixed(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    spec: Option<FixedSpec>,
) -> Result<CsvInfo, String> {
    let (path, encoding, dirty) = docs.with(&doc_id, |d| {
        (d.path.clone(), d.format.encoding.clone(), d.dirty)
    })?;
    if dirty {
        return Err("保存していない変更があります。保存してから読み方を変えてください".into());
    }
    let path = path.ok_or_else(|| {
        "ファイルから開いたタブでのみ読み方を変えられます".to_string()
    })?;
    let doc = match &spec {
        Some(sp) => {
            CsvDoc::open_fixed(&path, Some(&encoding), sp.unit, sp.reading())?
        }
        None => CsvDoc::open(&path, Some(&encoding))?,
    };
    docs.replace(&doc_id, doc)?;
    docs.with(&doc_id, |d| d.info(&doc_id))
}

/// 残してある固定長のレイアウト
#[tauri::command]
pub fn csv_layouts(app: AppHandle) -> Result<Vec<crate::csv_layouts::SavedLayout>, String> {
    crate::csv_layouts::load(&app)
}

/// 桁の並びに名前を付けて残す (同じ名前があれば上書き)
#[tauri::command]
pub fn csv_save_layout(
    app: AppHandle,
    name: String,
    layout: FixedLayout,
) -> Result<Vec<crate::csv_layouts::SavedLayout>, String> {
    crate::csv_layouts::save(&app, &name, layout)
}

/// 残してあるレイアウトを消す
#[tauri::command]
pub fn csv_delete_layout(
    app: AppHandle,
    name: String,
) -> Result<Vec<crate::csv_layouts::SavedLayout>, String> {
    crate::csv_layouts::delete(&app, &name)
}

/// 空のCSVを作る (新規作成)
#[tauri::command]
pub fn csv_new(docs: State<'_, CsvDocuments>, name: String) -> Result<CsvInfo, String> {
    let header: Vec<String> = (1..=3).map(|i| format!("列{i}")).collect();
    let rows = vec![vec![String::new(); header.len()]; 1];
    let id = docs.insert(CsvDoc::from_rows(&name, header, rows))?;
    docs.with(&id, |d| d.info(&id))
}

/// 表 (クエリ結果など) をCSVタブとして開く
#[tauri::command]
pub fn csv_from_rows(
    docs: State<'_, CsvDocuments>,
    name: String,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
) -> Result<CsvInfo, String> {
    // NULLは空欄として持つ (CSVにNULLという概念が無いため)
    let rows = rows
        .into_iter()
        .map(|r| r.into_iter().map(|v| v.unwrap_or_default()).collect())
        .collect();
    let id = docs.insert(CsvDoc::from_rows(&name, columns, rows))?;
    docs.with(&id, |d| d.info(&id))
}

/**
 * SQLの結果を全件CSVタブとして開く。
 *
 * 画面は1000行ずつしか持っていないので、そこから渡すと先頭しか開けない。
 * ここでは書き出しと同じ道 (ページングのLIMITを付けない実行) を通し、
 * 一時ファイルへ出したものを読み直してタブにする。
 * 元ファイルとは切り離した「未保存のタブ」になるので、
 * 保存するときは保存先を聞かれる
 */
/// クエリ結果をCSVタブとして開いた結果 (中止できるので、開けないこともある)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvFromQuery {
    /// 開いたタブ (中止したときは null)
    pub info: Option<CsvInfo>,
    /// 取り出した行数
    pub rows: usize,
    pub cancelled: bool,
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn csv_from_query(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    docs: State<'_, CsvDocuments>,
    session_id: String,
    database: Option<String>,
    sql: String,
    order_by: Option<String>,
    order_dir: Option<String>,
    name: String,
    job_id: String,
) -> Result<CsvFromQuery, String> {
    // 大きな結果は時間が掛かるので、進捗とキャンセルを出せるようにする
    let job = jobs.start(&job_id, &session_id);

    /*
     * 受け取った行をそのまま表にする。
     *
     * 以前はCSVに書いて一時ファイルへ落とし、それを読み直して解析していたが、
     * 同じ中身を2度作るぶん時間が掛かり、DBのデータが一時フォルダにも残っていた
     */
    let (mut sink, slot) = crate::csv_doc::sink::DocSink::new();
    let res = sessions::export_query_to_sink(
        &state,
        &qlog,
        &session_id,
        database,
        &sql,
        order_by,
        order_dir,
        sink.as_mut(),
        "CSVエディタ",
        Some(&job),
    )
    .await;
    jobs.finish(&job_id, &job);

    let (rows, cancelled) = res?;
    if cancelled {
        // 途中まで受け取ったものは開かない (歯抜けの表を渡さない)
        return Ok(CsvFromQuery {
            info: None,
            rows,
            cancelled: true,
        });
    }
    crate::export_rows::RowSink::finish(sink)?;

    let got = slot
        .lock()
        .map_err(|_| "表を受け取れません".to_string())?
        .take()
        .ok_or_else(|| "表を受け取れません".to_string())?;
    let mut doc = CsvDoc::from_rows(&name, got.header, got.rows);
    // ファイルから開いたものではないが、まだ何も直していない
    doc.dirty = false;

    let id = docs.insert(doc)?;
    let info = docs.with(&id, |d| d.info(&id))?;
    Ok(CsvFromQuery {
        info: Some(info),
        rows,
        cancelled: false,
    })
}

/// タブを閉じる (保存していない編集は捨てる。確認は画面側で済ませておくこと)
#[tauri::command]
pub fn csv_close(docs: State<'_, CsvDocuments>, doc_id: String) -> Result<(), String> {
    docs.remove(&doc_id)
}

/// 今の状態 (列・行数・未保存かどうか・取り消せる操作)
#[tauri::command]
pub fn csv_info(docs: State<'_, CsvDocuments>, doc_id: String) -> Result<CsvInfo, String> {
    docs.with(&doc_id, |d| d.info(&doc_id))
}

/**
 * 絞り込み・並べ替えの最中はできない操作を断る。
 *
 * 行を足したり消したりすると、覚えている行番号がずれる。
 * 画面のどこに足すのかも決められないので、先に外してもらう
 */
fn no_filter(d: &CsvDoc) -> Result<(), String> {
    if d.filtered() {
        return Err(
            "絞り込みや並べ替えを外してから、行を追加・削除してください".into(),
        );
    }
    Ok(())
}

/// 列ごとの絞り込みを入れ替える (空の一覧を渡すと絞り込みをやめる)
#[tauri::command]
pub fn csv_set_filters(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    filters: Vec<ColumnFilter>,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        d.set_filters(filters);
        d.info(&doc_id)
    })
}

/**
 * 並べ替えを入れ替える (`None` で元の並びに戻す)。
 *
 * ファイルの中身は動かさず、見せる順だけを変える
 */
#[tauri::command]
pub fn csv_set_sort(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    sort: Option<Sort>,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        d.set_sort(sort);
        d.info(&doc_id)
    })
}

/**
 * その列に入っている値の一覧 (絞り込みの画面で選ばせるために使う)。
 *
 * 他の列の絞り込みを掛けたあとの行から数える
 */
#[tauri::command]
pub fn csv_filter_values(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    col: usize,
) -> Result<filter::Values, String> {
    docs.with(&doc_id, |d| filter::values(&d.rows, &d.filters, col))
}

/// 1ページぶんの行
#[tauri::command]
pub fn csv_page(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    offset: usize,
    limit: usize,
) -> Result<CsvPage, String> {
    docs.with(&doc_id, |d| d.page(offset, limit))
}

/// セルを書き換える (まとめて渡すと1回の取り消しで戻る)
#[tauri::command]
pub fn csv_set_cells(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    cells: Vec<CellPatch>,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        let mut list = Vec::with_capacity(cells.len());
        for c in &cells {
            // 画面から来る行番号は、絞り込みを掛けたあとの数え方
            let row = d.real(c.row)?;
            let before = d
                .rows
                .get(row)
                .and_then(|r| r.get(c.col))
                .ok_or_else(|| "そのセルは見つかりません".to_string())?;
            // 値が変わらないものは履歴に残さない
            if *before == c.value {
                continue;
            }
            list.push(CellEdit {
                row,
                col: c.col,
                before: before.clone(),
                after: c.value.clone(),
            });
        }
        if list.is_empty() {
            return Ok(d.info(&doc_id));
        }
        d.apply(Edit::Cells(list))?;
        Ok(d.info(&doc_id))
    })?
}

/// 空の行を足す
#[tauri::command]
pub fn csv_insert_rows(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    at: usize,
    count: usize,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        d.can_reshape()?;
        no_filter(d)?;
        let e = d.sheet().insert_rows(at, count)?;
        d.apply(e)?;
        Ok(d.info(&doc_id))
    })?
}

/// 行を消す
#[tauri::command]
pub fn csv_delete_rows(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    at: usize,
    count: usize,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        d.can_reshape()?;
        no_filter(d)?;
        let e = d.sheet().delete_rows(at, count)?;
        d.apply(e)?;
        Ok(d.info(&doc_id))
    })?
}

/// 空の列を足す
#[tauri::command]
pub fn csv_insert_col(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    at: usize,
    name: String,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        d.can_reshape()?;
        let e = d.sheet().insert_col(at, &name)?;
        d.apply(e)?;
        // 列の位置がずれるので、絞り込みは落とす
        d.clear_filters();
        Ok(d.info(&doc_id))
    })?
}

/// 列を消す
#[tauri::command]
pub fn csv_delete_col(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    at: usize,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        d.can_reshape()?;
        let e = d.sheet().delete_col(at)?;
        d.apply(e)?;
        // 列の位置がずれるので、絞り込みは落とす
        d.clear_filters();
        Ok(d.info(&doc_id))
    })?
}

/// 列の名前を変える
#[tauri::command]
pub fn csv_rename_col(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    at: usize,
    name: String,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        let e = d.sheet().rename_col(at, &name)?;
        d.apply(e)?;
        Ok(d.info(&doc_id))
    })?
}

/// 探した結果 (見つかった場所と、引っかかったセルの数)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub hit: Option<Match>,
    /// 引っかかったセルの数 (「3件中1件目」の分母に使う)
    pub total: usize,
}

/// 次 (backward なら前) の一致を探す。端まで行ったら反対の端へ回る
#[tauri::command]
pub fn csv_find(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    query: String,
    options: FindOptions,
    from: Option<Match>,
    backward: bool,
) -> Result<FindResult, String> {
    docs.with(&doc_id, |d| {
        let w = d.header.len();
        let Some(m) = find::matcher(&query, &options)? else {
            return Ok(FindResult {
                hit: None,
                total: 0,
            });
        };
        Ok(FindResult {
            hit: find::find_next(d.shown(), w, &m, from, backward),
            total: find::count(d.shown(), w, &m),
        })
    })?
}

/// 見つかったものをまとめて置き換える (取り消しは1回で戻る)
#[tauri::command]
pub fn csv_replace_all(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    query: String,
    replacement: String,
    options: FindOptions,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        let w = d.header.len();
        let Some(m) = find::matcher(&query, &options)? else {
            return Ok(d.info(&doc_id));
        };
        let list = find::replace_all(d.shown(), w, &m, &replacement);
        if list.is_empty() {
            return Ok(d.info(&doc_id));
        }
        d.apply(Edit::Cells(list))?;
        Ok(d.info(&doc_id))
    })?
}

/// 1つだけ置き換えた結果
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOne {
    /// 実際に置き換えたか (今いるセルが引っかからなければ `false`)
    pub done: bool,
    pub info: CsvInfo,
}

/// 今いるセル1つだけを置き換える
#[tauri::command]
pub fn csv_replace_one(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    query: String,
    replacement: String,
    options: FindOptions,
    at: Match,
) -> Result<ReplaceOne, String> {
    docs.with_mut(&doc_id, |d| {
        let w = d.header.len();
        let done = match find::matcher(&query, &options)? {
            Some(m) => match find::replace_at(d.shown(), w, &m, at, &replacement) {
                Some(edit) => {
                    d.apply(Edit::Cells(vec![edit]))?;
                    true
                }
                None => false,
            },
            None => false,
        };
        Ok(ReplaceOne {
            done,
            info: d.info(&doc_id),
        })
    })?
}

/// 直前の操作を取り消す
#[tauri::command]
pub fn csv_undo(docs: State<'_, CsvDocuments>, doc_id: String) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        d.undo()?;
        Ok(d.info(&doc_id))
    })?
}

/// 取り消したものをやり直す
#[tauri::command]
pub fn csv_redo(docs: State<'_, CsvDocuments>, doc_id: String) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        d.redo()?;
        Ok(d.info(&doc_id))
    })?
}

/// 1行目をヘッダとして扱うかを切り替える
#[tauri::command]
pub fn csv_set_header(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    on: bool,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        d.set_has_header(on);
        d.info(&doc_id)
    })
}

/// 保存の形 (文字コード・BOM・改行・区切り・引用符) を変える。
///
/// 画面からは項目ごとに送られてくるので、引数はその数だけ並ぶ
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn csv_set_format(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    encoding: Option<String>,
    bom: Option<bool>,
    newline: Option<String>,
    delimiter: Option<String>,
    quote: Option<String>,
    quoting: Option<String>,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        if let Some(e) = encoding {
            // 知らない名前をここで弾く (保存のときに初めて失敗しないように)
            let enc = format::encoding_by_name(&e)?;
            d.format.encoding = format::encoding_label(enc);
        }
        if let Some(b) = bom {
            d.format.bom = b;
        }
        if let Some(n) = newline {
            d.format.newline =
                Newline::from_label(&n).ok_or_else(|| format!("知らない改行コードです: {n}"))?;
        }
        if let Some(s) = delimiter {
            let mut it = s.chars();
            let (Some(c), None) = (it.next(), it.next()) else {
                return Err(format!("区切り文字は1文字で指定してください: {s}"));
            };
            d.format.delimiter = c;
        }
        if let Some(q) = quote {
            d.format.quote =
                Quote::from_label(&q).ok_or_else(|| format!("知らない引用符です: {q}"))?;
        }
        if let Some(q) = quoting {
            d.format.quoting = Quoting::from_label(&q)
                .ok_or_else(|| format!("知らない引用符の付け方です: {q}"))?;
        }
        // 形を変えたら保存し直す必要がある
        d.dirty = true;
        Ok(d.info(&doc_id))
    })?
}

/// セルの位置 (端まで飛んだ先を返すのに使う)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPos {
    pub row: usize,
    pub col: usize,
}

/// 続いているデータの端まで飛んだ先を返す (表計算ソフトの Ctrl+矢印)。
///
/// `d_row` / `d_col` は進む向き (-1 / 0 / 1)。
/// 縦と横を同時には動かさない
#[tauri::command]
pub fn csv_edge(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    row: usize,
    col: usize,
    d_row: i32,
    d_col: i32,
) -> Result<CsvPos, String> {
    docs.with(&doc_id, |d| {
        let width = d.columns().len();
        let shown = d.shown();
        if shown.is_empty() || width == 0 {
            return CsvPos { row: 0, col: 0 };
        }
        let row = row.min(shown.len() - 1);
        let col = col.min(width - 1);
        // 空文字だけでなく、空白だけのセルも「入っていない」とみなす
        let has = |text: Option<&String>| text.is_some_and(|t| !t.trim().is_empty());
        if d_row != 0 {
            let to = crate::csv_doc::nav::edge(
                |i| has(shown.get(i).and_then(|r| r.get(col))),
                row,
                shown.len(),
                d_row > 0,
            );
            return CsvPos { row: to, col };
        }
        if d_col != 0 {
            let line = shown.get(row);
            let to = crate::csv_doc::nav::edge(
                |i| has(line.and_then(|r| r.get(i))),
                col,
                width,
                d_col > 0,
            );
            return CsvPos { row, col: to };
        }
        CsvPos { row, col }
    })
}

/// 画面から来る「選んでいる四角」1つ (端を含む)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvRect {
    pub top: usize,
    pub left: usize,
    pub bottom: usize,
    pub right: usize,
}

/// 選んでいる範囲の要約 (セル数・入っているセル数・合計)。
///
/// 全行はここが持っているので、画面に出ていない行を選んでいても数えられる。
///
/// 四角は複数受け取る (⌘+クリックで離れた所も選べるため)。
/// 重なった所は表計算ソフトと同じく二重に数える
#[tauri::command]
pub fn csv_summary(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    rects: Vec<CsvRect>,
) -> Result<crate::csv_doc::summary::Summary, String> {
    docs.with(&doc_id, |d| {
        let width = d.columns().len();
        let shown = d.shown();
        if shown.is_empty() || width == 0 {
            return crate::csv_doc::summary::summarize(std::iter::empty());
        }
        let last_row = shown.len() - 1;
        let last_col = width - 1;
        crate::csv_doc::summary::summarize(rects.iter().flat_map(|rect| {
            let r1 = rect.top.min(last_row);
            let r2 = rect.bottom.min(last_row);
            let c1 = rect.left.min(last_col);
            let c2 = rect.right.min(last_col);
            (r1..=r2).flat_map(move |i| {
                (c1..=c2).map(move |c| {
                    shown
                        .get(i)
                        .and_then(|row| row.get(c))
                        .map(String::as_str)
                        .unwrap_or("")
                })
            })
        }))
    })
}

/// 選んでいる範囲を、クリップボードへ渡すタブ区切りテキストにする。
///
/// 画面には見えている行しか無いので、文字を組み立てるのはここでやる。
///
/// 四角は複数受け取る (⌘+クリックで離れた所も選べるため)。
/// 選んだ位置の関係はそのまま保つので、横に並んだものは同じ行にタブで並び、
/// 間が空いていればそのぶん空の項目が入る
#[tauri::command]
pub fn csv_copy(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    rects: Vec<CsvRect>,
) -> Result<String, String> {
    use crate::csv_doc::copy;

    docs.with(&doc_id, |d| {
        let width = d.columns().len();
        let shown = d.shown();
        if shown.is_empty() || width == 0 {
            return Ok(String::new());
        }
        let last_row = shown.len() - 1;
        let last_col = width - 1;
        // 画面の指定は行数・列数より大きいことがあるので、先に丸めておく
        let rects: Vec<copy::Rect> = rects
            .iter()
            .map(|r| copy::Rect {
                top: r.top.min(last_row),
                bottom: r.bottom.min(last_row),
                left: r.left.min(last_col),
                right: r.right.min(last_col),
            })
            .collect();
        let Some(plan) = copy::plan(&rects) else {
            return Ok(String::new());
        };
        let cells = plan.cells();
        if cells > copy::MAX_CELLS {
            return Err(format!(
                "選んでいるセルが多すぎてコピーできません ({}セル)。{}セルまでです",
                cells,
                copy::MAX_CELLS
            ));
        }
        Ok(copy::to_text(&plan, &rects, |row, col| {
            shown
                .get(row)
                .and_then(|r| r.get(col))
                .map(String::as_str)
                .unwrap_or("")
        }))
    })?
}

/// 固定長のヘッダ・トレーラのレコードを書き換える。
///
/// 項目の数が少ないので、レコードを丸ごと受け取って入れ替える。
/// 取り消しも1回で戻る
#[tauri::command]
pub fn csv_set_edge(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    trailer: bool,
    cells: Vec<String>,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        let before = if trailer {
            d.tail.clone()
        } else {
            d.head.clone()
        };
        if before.is_empty() {
            return Err("このファイルにはその行がありません".to_string());
        }
        // 桁の数は変えられない (レイアウトと食い違わないように長さを揃える)
        let mut after = cells;
        after.resize(before.len(), String::new());
        if before == after {
            return Ok(d.info(&doc_id));
        }
        d.apply(Edit::EdgeRow {
            trailer,
            before,
            after,
        })?;
        Ok(d.info(&doc_id))
    })?
}

/// 貼り付けの結果 (画面の知らせに使う)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteResult {
    /// 貼り付けたあとの状態
    pub info: CsvInfo,
    /// 実際に入れた行数・列数
    pub rows: usize,
    pub cols: usize,
    /// 足りなくて増やした行数
    pub added_rows: usize,
    /// 右にはみ出して切り落とした列があったか
    pub clipped_cols: bool,
}

/// クリップボードのタブ区切りテキストを、指定のセルを左上として貼り付ける。
///
/// 下に足りなければ行を増やす (CSVは行を足せる)。
/// 右にはみ出したぶんは入れない (列の並びはファイルの形そのものなので、勝手に増やさない)。
///
/// 行の追加と値の書き換えは1つの操作にまとめてあり、取り消しは1回で戻る
#[tauri::command]
pub fn csv_paste(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    row: usize,
    col: usize,
    text: String,
) -> Result<PasteResult, String> {
    docs.with_mut(&doc_id, |d| {
        let block = crate::csv_doc::paste::parse_tsv(&text);
        let width = d.columns().len();
        let none = |d: &CsvDoc| PasteResult {
            info: d.info(&doc_id),
            rows: 0,
            cols: 0,
            added_rows: 0,
            clipped_cols: false,
        };
        if block.is_empty() || width == 0 {
            return Ok(none(d));
        }
        if col >= width {
            return Err("貼り付ける先の列がありません".into());
        }
        if row > d.shown().len() {
            return Err("貼り付ける先の行がありません".into());
        }
        let wide = block.iter().map(|r| r.len()).max().unwrap_or(0);
        let cells = block.len().saturating_mul(wide);
        if cells > crate::csv_doc::copy::MAX_CELLS {
            return Err(format!(
                "貼り付ける中身が多すぎます ({}セル)。{}セルまでです",
                cells,
                crate::csv_doc::copy::MAX_CELLS
            ));
        }
        let cols = wide.min(width - col);
        let clipped_cols = wide > cols;
        let added_rows = (row + block.len()).saturating_sub(d.shown().len());

        let mut edits: Vec<Edit> = Vec::new();
        if added_rows > 0 {
            d.can_reshape()?;
            // 絞り込み中は行を増やせない (どこへ入れるか決められないため)
            no_filter(d)?;
            let at = d.rows.len();
            edits.push(d.sheet().insert_rows(at, added_rows)?);
        }
        /*
         * 値が変わるセルだけを控える (増やした行の元の値は空欄)。
         *
         * 絞り込み中は、見えている行へ上から順に入れていく
         * (隠れている行は飛ばす)
         */
        let mut list = Vec::new();
        for (i, line) in block.iter().enumerate() {
            let r = match d.shown().real(row + i) {
                Some(r) => r,
                // 増やしたぶんは絞り込みの外にあるので、そのまま元の番号で置く
                None => row + i,
            };
            for (j, after) in line.iter().take(cols).enumerate() {
                let c = col + j;
                let before = d
                    .rows
                    .get(r)
                    .and_then(|x| x.get(c))
                    .cloned()
                    .unwrap_or_default();
                if before == *after {
                    continue;
                }
                list.push(CellEdit {
                    row: r,
                    col: c,
                    before,
                    after: after.clone(),
                });
            }
        }
        if !list.is_empty() {
            edits.push(Edit::Cells(list));
        }
        if edits.is_empty() {
            // 中身が同じなら履歴も増やさない
            return Ok(none(d));
        }
        d.apply(Edit::Group {
            label: "貼り付け",
            edits,
        })?;
        Ok(PasteResult {
            info: d.info(&doc_id),
            rows: block.len(),
            cols,
            added_rows,
            clipped_cols,
        })
    })?
}

/// CSVの1項目を、Excelに置く形へ振り分ける。
///
/// 数値として置くのは「そのまま書いても見た目が変わらない」値だけにする。
/// 前ゼロ (`007`)、`+1`、`1.50`、桁の大きなIDは文字のまま置く
/// (CSVエディタは値を勝手に変えない道具なので、書き出しでも変えない)
fn excel_cell(text: &str) -> crate::export::CsvCell {
    let mut cell = crate::export::CsvCell::text(text.to_string());
    // 書き戻して同じ文字になるものだけを数値とみなす
    let same = match text.parse::<i64>() {
        Ok(n) => n.to_string() == text,
        Err(_) => match text.parse::<f64>() {
            Ok(n) => n.is_finite() && n.to_string() == text,
            Err(_) => false,
        },
    };
    cell.numeric = same;
    cell
}

/// 開いているCSVを Excel (.xlsx) として書き出す。
///
/// 見た目はSQL結果の書き出しと同じ (見出しに色・絞り込み・見出し行の固定)
#[tauri::command]
pub fn csv_export_xlsx(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    path: String,
) -> Result<(), String> {
    use crate::export_rows::RowSink;
    let out = PathBuf::from(&path);
    docs.with(&doc_id, |d| {
        let columns = d.columns();
        let width = columns.len();
        let mut sink: Box<dyn RowSink> =
            Box::new(crate::export_sheet::SheetSink::new(&out, "CSV")?);
        sink.header(&columns)?;
        for row in &d.rows {
            let cells: Vec<Option<crate::export::CsvCell>> = (0..width)
                .map(|i| Some(excel_cell(row.get(i).map(String::as_str).unwrap_or(""))))
                .collect();
            sink.row(&cells)?;
        }
        sink.finish()
    })?
}

/// 保存する。pathを渡すと別名保存
#[tauri::command]
pub fn csv_save(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
    path: Option<String>,
) -> Result<CsvInfo, String> {
    docs.with_mut(&doc_id, |d| {
        let to = path.map(PathBuf::from);
        d.save(to.as_deref())?;
        Ok(d.info(&doc_id))
    })?
}

/// 開いたあとに外部でファイルが書き換えられていないか (上書き前の確認に使う)
#[tauri::command]
pub fn csv_changed_outside(
    docs: State<'_, CsvDocuments>,
    doc_id: String,
) -> Result<bool, String> {
    docs.with(&doc_id, |d| d.changed_outside())
}

/// 保存していないファイルの名前 (ウィンドウを閉じる前の確認に使う)
#[tauri::command]
pub fn csv_dirty_names(docs: State<'_, CsvDocuments>) -> Result<Vec<String>, String> {
    docs.dirty_names()
}

/// 突き合わせの結果のまとめ (行そのものは持たせず、ページで取りに来てもらう)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOverview {
    pub columns: Vec<csv_diff::ColumnPair>,
    pub summary: csv_diff::DiffSummary,
    /// 画面に出す行数 (一致した行も含む)
    pub total: usize,
    pub duplicate_keys: usize,
    pub column_mismatch: bool,
}

/// 2つのCSVを突き合わせる (結果はRust側に預かる)
#[tauri::command]
pub fn csv_compare(
    docs: State<'_, CsvDocuments>,
    left_id: String,
    right_id: String,
    options: DiffOptions,
) -> Result<DiffOverview, String> {
    let (lc, lr) = docs.with(&left_id, |d| (d.columns(), d.rows.clone()))?;
    let (rc, rr) = docs.with(&right_id, |d| (d.columns(), d.rows.clone()))?;
    let result = csv_diff::compare(&lc, &lr, &rc, &rr, &options)?;
    let out = DiffOverview {
        columns: result.columns.clone(),
        summary: result.summary,
        total: result.rows.len(),
        duplicate_keys: result.duplicate_keys,
        column_mismatch: result.column_mismatch,
    };
    docs.set_diff(StoredDiff {
        left_id,
        right_id,
        result,
    })?;
    Ok(out)
}

/// 突き合わせに使えそうな列を推測する
#[tauri::command]
pub fn csv_guess_key(
    docs: State<'_, CsvDocuments>,
    left_id: String,
    right_id: String,
) -> Result<Vec<String>, String> {
    let (lc, lr) = docs.with(&left_id, |d| (d.columns(), d.rows.clone()))?;
    let rc = docs.with(&right_id, |d| d.columns())?;
    Ok(csv_diff::guess_key(&lc, &lr, &rc))
}

/// 対応付けた列の並びに沿って値を並べ直す (片側に無い列は空文字)
fn pick(
    row: Option<&Vec<String>>,
    columns: &[csv_diff::ColumnPair],
    left: bool,
) -> Vec<String> {
    let Some(row) = row else {
        return Vec::new();
    };
    columns
        .iter()
        .map(|c| {
            let i = if left { c.left } else { c.right };
            i.and_then(|i| row.get(i)).cloned().unwrap_or_default()
        })
        .collect()
}

/// 直近の比較結果から、見えている範囲だけを値つきで返す
#[tauri::command]
pub fn csv_diff_page(
    docs: State<'_, CsvDocuments>,
    offset: usize,
    limit: usize,
) -> Result<DiffPage, String> {
    let (left_id, right_id, total) =
        docs.with_diff(|d| (d.left_id.clone(), d.right_id.clone(), d.result.rows.len()))?;
    if offset >= total {
        return Ok(DiffPage {
            offset,
            rows: Vec::new(),
            total,
        });
    }
    let left = docs.with(&left_id, |d| d.rows.clone())?;
    let right = docs.with(&right_id, |d| d.rows.clone())?;
    let end = offset.saturating_add(limit).min(total);
    let rows = docs.with_diff(|d| {
        d.result.rows[offset..end]
            .iter()
            .map(|r| DiffPageRow {
                status: r.status,
                left: r.left,
                right: r.right,
                changed: r.changed.clone(),
                left_cells: pick(r.left.and_then(|i| left.get(i)), &d.result.columns, true),
                right_cells: pick(r.right.and_then(|i| right.get(i)), &d.result.columns, false),
            })
            .collect()
    })?;
    Ok(DiffPage {
        offset,
        rows,
        total,
    })
}

/**
 * 次 (前) の差分がある行を探す。
 *
 * 差分の一覧を画面へ丸ごと渡さずにジャンプできるよう、
 * 探す仕事はこちらでやる
 */
#[tauri::command]
pub fn csv_diff_next(
    docs: State<'_, CsvDocuments>,
    from: usize,
    backward: bool,
) -> Result<Option<usize>, String> {
    docs.with_diff(|d| {
        let rows = &d.result.rows;
        let differs = |i: usize| rows[i].status != csv_diff::RowStatus::Same;
        if backward {
            (0..from.min(rows.len())).rev().find(|i| differs(*i))
        } else {
            ((from + 1).min(rows.len())..rows.len()).find(|i| differs(*i))
        }
    })
}
