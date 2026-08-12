# Quelio (クエリオ)

MySQL / PostgreSQL 対応の無料デスクトップDBクライアント。
macOS (Apple Silicon) / Windows で動作します。UIは日本語専用です。

**紹介ページ**: https://zefact.github.io/quelio/

> **ベータ版について**
> Quelioは現在ベータ版 (v0.x) です。不具合が含まれる可能性があり、
> 今後のバージョンで機能や設定ファイルの形式が変わることがあります。
> 重要なデータベースに対して使用する場合は、事前にバックアップを取ることをおすすめします。
> 不具合を見つけた場合は [Issues](../../issues) で報告いただけると助かります。

## 主な機能

- MySQL / PostgreSQL への接続 (SSH踏み台トンネル対応・鍵認証)
- 接続先のプロファイル管理 (フォルダ分け・並び替え・アイコン色)
- タブ式セッション、テーブル構造表示 (カラム / インデックス / テーブル情報)
- SQLエディタ (シンタックスハイライト・整形・複数SQL実行・1000行ページング・サーバーサイドソート)
- EXPLAIN / EXPLAIN ANALYZE の実行計画ビュー (時間バー・ボトルネック強調)
- 実行結果のキャプチャ保存 (SQL＋全行をPNG化)
- SQLコンソール (実行した全SQLの履歴)
- スキーマ一覧・定義書CSV出力、スキーマ差分ビューア (2接続の比較)
- テーブル選択式エクスポート / SQLファイルのインポート (mysqldump / pg_dump / mysql / psql 連携)

## インストール

[Releases](../../releases) から最新版をダウンロードしてください。

| OS | ファイル | 手順 |
|---|---|---|
| macOS | `Quelio_<ver>_aarch64.dmg` | dmgを開いて `Quelio.app` をApplicationsへドラッグ |
| Windows | `Quelio_<ver>_x64-setup.exe` | 実行してウィザードに従う |

Windowsで初回実行時にSmartScreenの警告が出た場合は「詳細情報」→「実行」を選択してください。

エクスポート/インポート機能を使う場合は外部ツールが必要です (設定画面で自動検出されます)。

```bash
brew install mysql-client   # mysqldump / mysql
brew install libpq          # pg_dump / psql
```

## セキュリティとプライバシー

- データは **すべてローカルに保存** されます。外部サーバーへの送信・テレメトリは一切ありません
- 接続パスワード/SSHパスフレーズは AES-256-GCM で暗号化し、鍵はOSのキーチェーン等に保存します
- SSH踏み台のホスト鍵は TOFU (初回接続時に記録) 方式で検証し、
  鍵が変わった場合は中間者攻撃の可能性があるため接続を拒否します

データの保存場所 (macOSの場合):

| 内容 | パス |
|---|---|
| 接続プロファイル・設定 | `~/Library/Application Support/jp.co.zefact.quelio/` |
| CSV / SQL / キャプチャ出力 | `~/Downloads` |

## 開発 (ソースからビルド)

Rust (stable) と Node.js 20+ が必要です。

```bash
git clone https://github.com/zefact/quelio.git
cd quelio
npm install
npm run tauri dev     # 開発起動
npm run tauri build   # 配布用ビルド
```

## ライセンス

[MIT License](./LICENSE) — © 2026 ZEFACT Co., Ltd. (株式会社ゼファクト)

本ソフトウェアは無保証で提供されます。利用によって生じたいかなる損害についても、
作者および著作権者は責任を負いません (詳細はLICENSEを参照)。
利用しているオープンソースライブラリの一覧は
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) を参照してください。

不具合報告・要望は [Issues](../../issues) へお願いします。
