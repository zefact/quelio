//! 画面側から受け取る図の中身。
//!
//! 座標と大きさはすべて画面のピクセル (図の左上が原点)。
//! 色は "RRGGBB" (先頭の # は無くてもよい)

use serde::Deserialize;

/// 半透明を含む色
#[derive(Debug, Clone, Deserialize)]
pub struct Paint {
    pub rgb: String,
    /// 0 (透明) 〜 1 (不透明)
    pub alpha: f64,
}

/// 線の種類
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LineStyle {
    Solid,
    Dash,
    Dot,
}

/// 図の配色 (テーブルの見た目に使う)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    pub text: String,
    pub dim: String,
    pub node_fill: Paint,
    pub node_stroke: Paint,
    pub head_fill: Paint,
}

/// カラム行の中の1区切り (名前 / 型 / 日本語名)
#[derive(Debug, Clone, Deserialize)]
pub struct Cell {
    pub text: String,
    pub color: String,
    /// 等幅フォントで書くか (日本語名は通常のフォント)
    pub mono: bool,
}

/// テーブル1つ
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub name: String,
    pub logical: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 区切りの位置 (文字の書き始めからのピクセル)。列を縦に揃えるのに使う
    pub tabs: Vec<f64>,
    pub rows: Vec<Vec<Cell>>,
}

/// 線の端がつながる場所
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Target {
    /// カラム行 (0始まり)
    Row { index: usize },
    /// 見出し (カラムが表示されていないとき)
    Head,
    /// テーブルの外枠
    Body,
}

/// 図形の辺 (Excel の接続点の番号と同じ並び)
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Top,
    Left,
    Bottom,
    Right,
}

impl Side {
    /// 四角形の接続点の番号 (上=0, 左=1, 下=2, 右=3)
    pub fn site(self) -> u32 {
        match self {
            Side::Top => 0,
            Side::Left => 1,
            Side::Bottom => 2,
            Side::Right => 3,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Glue {
    /// tables の何番目か
    pub table: usize,
    pub target: Target,
    pub side: Side,
}

/// リレーションの線
#[derive(Debug, Clone, Deserialize)]
pub struct Edge {
    /// 図形の名前 (Excel の「選択」ウィンドウに出る)
    pub name: String,
    /// 折れ線の頂点 (始点が参照元)
    pub points: Vec<[f64; 2]>,
    pub color: Paint,
    pub dash: LineStyle,
    pub from: Option<Glue>,
    pub to: Option<Glue>,
}

/// 注釈の枠
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rounded: bool,
    /// 枠線 (None = 枠線なし)
    pub stroke: Option<Paint>,
    pub dash: LineStyle,
    pub fill: Option<Paint>,
    pub label_color: String,
    /// テーブルより前に置くか
    pub front: bool,
}

/// 文字だけの図形 (図の見出し・テキスト注釈)
#[derive(Debug, Clone, Deserialize)]
pub struct Label {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 文字の大きさ (px)
    pub size: f64,
    pub color: String,
    pub bold: bool,
    pub mono: bool,
}

/// 図全体
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErSheet {
    /// 一番外のグループの名前 (データベース名など)
    pub name: String,
    pub palette: Palette,
    /// テーブル見出しの高さ・カラム行の高さ・文字の左余白 (px)
    pub head_h: f64,
    pub row_h: f64,
    pub pad_x: f64,
    pub tables: Vec<Table>,
    pub frames: Vec<Frame>,
    pub edges: Vec<Edge>,
    /// 最前面に置く文字 (見出し・凡例・テキスト注釈)
    pub labels: Vec<Label>,
}

/// 図形の数の上限 (壊れた入力で巨大なファイルを作らないため)
const MAX_SHAPES: usize = 200_000;

impl ErSheet {
    /// 数値が有限か・図形が多すぎないかを確かめる
    pub fn validate(&self) -> Result<(), String> {
        let mut nums: Vec<f64> = vec![self.head_h, self.row_h, self.pad_x];
        let mut shapes = self.frames.len() + self.edges.len() + self.labels.len();
        for t in &self.tables {
            nums.extend([t.x, t.y, t.w, t.h]);
            nums.extend(&t.tabs);
            shapes += t.rows.len() + 3;
        }
        for f in &self.frames {
            nums.extend([f.x, f.y, f.w, f.h]);
        }
        for l in &self.labels {
            nums.extend([l.x, l.y, l.w, l.h, l.size]);
        }
        for e in &self.edges {
            nums.extend(e.points.iter().flatten());
        }
        if nums.iter().any(|v| !v.is_finite() || v.abs() > 1.0e7) {
            return Err("図の座標が正しくありません".into());
        }
        if shapes > MAX_SHAPES {
            return Err("図形が多すぎてExcelに書き出せません".into());
        }
        Ok(())
    }
}
