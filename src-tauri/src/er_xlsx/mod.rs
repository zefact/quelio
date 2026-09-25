//! ER図を Excel の図形として書き出す。
//!
//! PNG は「見るだけ」の絵なので、Excel 上でテーブルを動かしたり
//! 線をつなぎ替えたりできない。ここではテーブルを図形のグループ、
//! リレーションを「コネクタ」(図形にくっつく線) で描き、
//! Excel で開いたあとも手で直せる形にする。
//!
//! rust_xlsxwriter はコネクタを描けないため、xlsx の中身 (DrawingML) を
//! 自前で組み立てて zip にまとめる。
//! 配置・色・文字の並びは画面側 (src/er/exportXlsx.ts) が決めて渡す

mod connector;
mod drawing;
mod model;
mod package;
mod shape;
mod text;
mod xml;

pub use model::ErSheet;

/// 図の入った xlsx のバイト列を作る
pub fn build(sheet: &ErSheet) -> Result<Vec<u8>, String> {
    sheet.validate()?;
    let drawing = drawing::render(sheet);
    package::write(&drawing).map_err(|e| format!("Excelを組み立てられません: {e}"))
}

#[cfg(test)]
mod tests;
