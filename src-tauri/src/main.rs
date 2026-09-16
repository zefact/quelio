// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    /*
     * `--mcp-stdio` 付きで起動されたときは、中継役として動く。
     *
     * Claude Desktop のように「コマンドを起動して stdin/stdout で話す」形しか
     * 設定できないクライアントのための経路。
     * ウィンドウを出さないので、Tauri の初期化より手前で分ける
     */
    if std::env::args().any(|a| a == "--mcp-stdio") {
        quelio_lib::run_mcp_stdio();
        return;
    }
    quelio_lib::run()
}
