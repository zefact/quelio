use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// アプリ全般の設定 (設定画面の「一般」タブ)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// カラムコメントを「論理名＋補足」に分解する際の区切り文字
    #[serde(default = "default_comment_delimiter")]
    pub comment_delimiter: String,
    /// テーブル構造ビューのコメント表示 ("comment" = そのまま / "split" = 論理名＋補足)
    #[serde(default = "default_structure_comment_mode")]
    pub structure_comment_mode: String,
    /// SQL結果に行番号を表示するか
    #[serde(default = "default_true")]
    pub show_row_numbers: bool,
    /// SQL実行のタイムアウト (秒)。0で無制限
    #[serde(default = "default_query_timeout_secs")]
    pub query_timeout_secs: u64,
    /// 各種ファイル (キャプチャ・CSV・エクスポート等) の保存先フォルダ。
    /// 空文字ならOSのダウンロードフォルダを使う
    #[serde(default)]
    pub download_dir: String,
    /// SQLエディタの入力補完を使うか
    #[serde(default = "default_true")]
    pub autocomplete_enabled: bool,
    /// 入力補完が自動で開くまでの待ち時間 (ミリ秒)。0なら自動では開かない
    #[serde(default = "default_autocomplete_delay_ms")]
    pub autocomplete_delay_ms: u64,
    /// ALTER・RENAME (定義の変更) も実行前に確認するか。
    ///
    /// マイグレーションSQLを流す使い方では毎回止まってしまうため、外せるようにする。
    /// DROP・TRUNCATE や WHERE の無い UPDATE / DELETE は、
    /// 戻せない・影響範囲が読めないので、この設定に関わらず常に確認する
    #[serde(default = "default_true")]
    pub confirm_alter: bool,
    /// 起動時に前回の書きかけSQL (SQLシートと名前) を復元するか。
    ///
    /// 既定は復元しない。接続タブは設定に関わらず毎回まっさらから始める
    /// (前回の接続先が入ったまま立ち上がると、意図しない環境へ繋いでしまうため)
    #[serde(default)]
    pub restore_sheets: bool,
    /// SQLエディタの「整形」ボタンの書式
    #[serde(default)]
    pub sql_format: SqlFormatSettings,
}

/// SQLの整形の書き方。
///
/// 値は画面側 (sql-formatter) がそのまま使う文字列なので、
/// ここでは中身を判定せず、読めない値は既定へ戻すだけにしている
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFormatSettings {
    /// カンマの位置 ("leading" = 次の行の先頭 / "trailing" = その行の末尾)
    #[serde(default = "default_comma_style")]
    pub comma_style: String,
    /// キーワードの大文字小文字 ("upper" / "lower" / "preserve")
    #[serde(default = "default_upper")]
    pub keyword_case: String,
    /// 字下げの1段ぶん ("2" / "4" / "tab")
    #[serde(default = "default_indent")]
    pub indent: String,
    /// AND・OR の位置 ("before" = 行の先頭 / "after" = 行の末尾)
    #[serde(default = "default_before")]
    pub logical_newline: String,
    /// 字下げのスタイル ("standard" / "tabularLeft" / "tabularRight")
    #[serde(default = "default_indent_style")]
    pub indent_style: String,
    /// JOIN の ON の置き方 ("same" = JOINと同じ行 / "newline" = 次の行)
    #[serde(default = "default_on_clause")]
    pub on_clause: String,
}

fn default_comma_style() -> String {
    "leading".to_string()
}

fn default_upper() -> String {
    "upper".to_string()
}

fn default_indent() -> String {
    "2".to_string()
}

fn default_before() -> String {
    "before".to_string()
}

fn default_indent_style() -> String {
    "standard".to_string()
}

fn default_on_clause() -> String {
    "newline".to_string()
}

impl Default for SqlFormatSettings {
    fn default() -> Self {
        Self {
            comma_style: default_comma_style(),
            keyword_case: default_upper(),
            indent: default_indent(),
            logical_newline: default_before(),
            indent_style: default_indent_style(),
            on_clause: default_on_clause(),
        }
    }
}

fn default_autocomplete_delay_ms() -> u64 {
    100
}

fn default_query_timeout_secs() -> u64 {
    60
}

fn default_true() -> bool {
    true
}

fn default_comment_delimiter() -> String {
    "（".to_string()
}

fn default_structure_comment_mode() -> String {
    "comment".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            comment_delimiter: default_comment_delimiter(),
            structure_comment_mode: default_structure_comment_mode(),
            show_row_numbers: true,
            query_timeout_secs: default_query_timeout_secs(),
            download_dir: String::new(),
            autocomplete_enabled: true,
            autocomplete_delay_ms: default_autocomplete_delay_ms(),
            confirm_alter: true,
            restore_sheets: false,
            sql_format: SqlFormatSettings::default(),
        }
    }
}

/// 各種ファイルの保存先フォルダを返す。
/// 設定があればそのフォルダ (無ければ作成)、空ならOSのダウンロードフォルダ
pub fn download_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let settings = load(app)?;
    let dir = settings.download_dir.trim();
    if !dir.is_empty() {
        let p = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&p)
            .map_err(|e| format!("保存先フォルダを作成できません ({}): {e}", p.display()))?;
        return Ok(p);
    }
    app.path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("保存先フォルダを取得できません: {e}"))
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    crate::json_store::config_path(app, "app_settings.json")
}

pub fn load(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    Ok(crate::json_store::read(&path, "設定")?.unwrap_or_default())
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("設定のシリアライズに失敗: {e}"))?;
    crate::json_store::write(&path, &text, "設定")
}
