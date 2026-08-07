# サードパーティライセンス / Third-Party Notices

Quelio は以下のオープンソースソフトウェアを利用しています。
各ライブラリの著作権は、それぞれの著作権者に帰属します。

Quelio uses the following open-source software. Each library is
copyrighted by its respective authors and distributed under its own license.

## フロントエンド (npm)

| ライブラリ | ライセンス | URL |
|---|---|---|
| React / React DOM | MIT | https://github.com/facebook/react |
| CodeMirror 6 (@codemirror/*) | MIT | https://github.com/codemirror/dev |
| @lezer/highlight | MIT | https://github.com/lezer-parser/highlight |
| sql-formatter | MIT | https://github.com/sql-formatter-org/sql-formatter |
| @tauri-apps/api, plugin-dialog, plugin-opener | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |
| Vite | MIT | https://github.com/vitejs/vite |
| TypeScript | Apache-2.0 | https://github.com/microsoft/TypeScript |

## バックエンド (Rust crates)

| クレート | ライセンス | URL |
|---|---|---|
| Tauri (tauri, tauri-build, plugins) | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |
| sqlx | MIT / Apache-2.0 | https://github.com/launchbadge/sqlx |
| russh | Apache-2.0 | https://github.com/Eugeny/russh |
| tokio | MIT | https://github.com/tokio-rs/tokio |
| serde / serde_json | MIT / Apache-2.0 | https://github.com/serde-rs/serde |
| aes-gcm | MIT / Apache-2.0 | https://github.com/RustCrypto/AEADs |
| keyring | MIT / Apache-2.0 | https://github.com/open-source-cooperative/keyring-rs |
| chrono | MIT / Apache-2.0 | https://github.com/chronotope/chrono |
| uuid | MIT / Apache-2.0 | https://github.com/uuid-rs/uuid |
| rust_decimal | MIT | https://github.com/paupino/rust-decimal |
| base64 | MIT / Apache-2.0 | https://github.com/marshallpierce/rust-base64 |

上記の直接依存のほか、それぞれが依存するライブラリ (推移的依存) も
MIT / Apache-2.0 / BSD 等の寛容なライセンスで配布されています。
各ライセンスの全文は上記URLのリポジトリに含まれています。
