# Quelio 開発者向けドキュメント (リリース手順)

利用者向けの情報は [README.md](./README.md) を参照してください。
このドキュメントは、バージョンアップとリリース作業を行う開発者向けです。

## 事前準備 (初回のみ)

GitHubリポジトリの Settings → Secrets and variables → Actions に
以下のSecretsが登録されていることを確認します。

| Secret名 | 内容 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 自動アップデート署名用の秘密鍵 (ファイルの中身全文) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 秘密鍵のパスワード (鍵をパスワード付きで作った場合) |

> **重要**: 秘密鍵は絶対にリポジトリへコミットしないこと。
> 紛失すると以後の自動アップデート配信ができなくなるため、
> パスワードマネージャ等にも控えておくこと。

## 1. バージョン番号の変更

バージョンの本体は **`src-tauri/tauri.conf.json` の `version`** です。
アプリ内のバージョン表示・インストーラのファイル名・自動アップデートの新旧判定すべてに使われます。

```jsonc
// src-tauri/tauri.conf.json
{
  "version": "1.1.0"   // ← ここを変更
}
```

- バージョンは [セマンティックバージョニング](https://semver.org/lang/ja/) に従う
  (機能追加: 1.x.0 を上げる / バグ修正のみ: 1.0.x を上げる / 互換の無い変更: 2.0.0 にする)
- 1.0.0 が正式版。`0.x` 系 (〜0.9.18) はベータ版で、アプリ内に「β」の印が出ていた
  (判定は `src/hooks/useAppVersion.ts` の `isBetaVersion`。1.0 以降は出ない)
- `package.json` と `src-tauri/Cargo.toml` の `version` はアプリの動作に影響しないが、
  揃えておくのが望ましい

## 2. リリース手順

### 2-1. CHANGELOGの整理

開発中の変更点は `CHANGELOG.md` の「未リリース」セクションに書き溜めておきます。
リリース時に、その内容を新しいバージョンの見出しへ移します。

```markdown
## [未リリース]

## [1.1.0] - 2026-08-15   ← 「未リリース」の中身をここへ移す

### 追加
- ○○機能
```

この `## [1.1.0]` セクションの内容が、そのままGitHub Releasesの説明文になります
(release.ymlがタグ名と一致するセクションを自動で抜き出します)。

### 2-2. コミットとタグ

```bash
git add -A
git commit -m "v1.1.0"
git push

git tag v1.1.0          # tauri.conf.json のバージョンと必ず一致させる (先頭にv)
git push origin v1.1.0
```

タグをpushすると GitHub Actions (`.github/workflows/release.yml`) が起動し、
macOS (Apple Silicon) と Windows のビルドが自動で走ります (15〜30分程度)。

### 2-3. ビルド結果の確認

リポジトリの **Actions** タブで「Release」ワークフローの成功を確認します。
成功すると **Releases にドラフト** が作成され、以下が添付されます。

| ファイル | 用途 |
|---|---|
| `Quelio_x.x.x_aarch64.dmg` | macOS用インストーラ (利用者がダウンロード) |
| `Quelio_x.x.x_x64-setup.exe` | Windows用セットアップ (利用者がダウンロード) |
| `Quelio_x.x.x_x64_ja-JP.msi` | Windows用MSI (社内一括配布向け) |
| `Quelio_aarch64.app.tar.gz` + `.sig` | macOS自動アップデート用 (削除しないこと) |
| `*-setup.exe.sig` など | 自動アップデートの署名 (削除しないこと) |
| `latest.json` | 自動アップデートのカタログ (削除しないこと) |

## 3. 公開手順

1. Releasesページでドラフトを開き、説明文 (CHANGELOGから転記済み) と添付ファイルを確認する
2. 可能であればdmg / setup.exeを実際にインストールして動作確認する
3. **「Publish release」を押す** — この瞬間に一般公開され、
   既存ユーザーへの自動アップデート配信も始まる

> 自動アップデートは「最新の正式リリース」(`releases/latest`) を参照するため、
> **Pre-releaseのチェックは付けない** こと (付けると更新が配信されない)。

### 公開後の確認

- `https://github.com/zefact/quelio/releases/latest/download/latest.json`
  にアクセスし、新しいバージョン番号が返ることを確認
- 旧バージョンのQuelioを起動し、更新通知バナーが出ること・更新できることを確認

## 補足

### AI連携 (MCP) の疎通確認

Quelio自身をMCPサーバーにして、AIクライアントからDBを触れるようにする機能です。
手を入れたときは、次の順に動きを確かめます。

#### 1. 接続をAIへ公開する

**設定 > AI連携** の「公開する接続」で、接続ごとに選びます
(接続の編集画面の「AIへ公開」でも同じことができます)。

| 公開レベル | 何ができるか |
|---|---|
| 公開しない (既定) | AIからは、その接続があること自体が見えません |
| 読み取りのみ | 参照だけ。更新系のSQLはQuelioが拒否します |
| 更新も許可 | 更新系のSQLは、実行のたびにQuelioの画面で許可を求めます |

環境を「本番」にした接続では「更新も許可」を選べません
(設定ファイルを手で `write` に書き換えても、実行時に読み取りへ落ちます)。

#### 2. 待受を始める

**設定 > AI連携** で「AI連携を有効にする」を入れます。
状態が「待受中」になり、エンドポイントとトークンが表示されます。

#### 3. AIクライアントへ設定を貼る

同じ画面の「AIクライアントの設定」に、**ポートとトークンを埋め込んだ設定文**が
クライアントごとに出ます。コピーして貼るだけで、書き換えは要りません。

| クライアント | 形 | 貼る場所 |
|---|---|---|
| Claude Code | `claude mcp add --transport http …` | ターミナルで1回実行 |
| Claude Desktop | `{"mcpServers":{"quelio":{"command":"…","args":["--mcp-stdio"]}}}` | `~/Library/Application Support/Claude/claude_desktop_config.json` (Windowsは `%APPDATA%\Claude\`) |
| HTTP対応クライアント (Cursor 等) | `{"mcpServers":{"quelio":{"url":"…","headers":{…}}}}` | `.cursor/mcp.json` など |

Claude Desktop がこの形だけなのは、**`claude_desktop_config.json` では
URLのサーバーを扱えない** (書いても読まれない) ためです。
そこで Quelio 自身を `--mcp-stdio` 付きで起動し、中継役にしています
(ウィンドウは出ません。詳しくは下の「設計メモ」)。

**Claude Desktop は設定を起動時にしか読みません**。貼ったあとは
⌘Q で**完全に終了してから**起動し直してください。
そのうえで、中継越しでも次がそろっていることを見ます:

- ツール (`list_connections` など) が使える
- 「+」メニューに **スキーマのリソース** が出て、`<接続名>/<DB名>/schema` を添付できる
- **`/quelio:table_spec`** などの定型のお願いがスラッシュコマンドに出る

**Cowork のチャットからは `@` にリソースが出ません** (中継されるのはツールだけ)。
Resources / Prompts の確認は Claude Code か Claude Desktop のチャットで行ってください。

Claude Code で「Quelioの接続一覧を見せて」などと頼み、`list_connections` の結果に
**名前・DB種別・環境ラベル・公開レベルだけ**が返ることを確認します。
ホスト名・利用者名・パスワード・SSHの設定が**含まれていないこと**を目で見てください
(ここが AI連携 の肝です)。「公開しない」の接続は一覧に出ません。

#### 4. 読み取りツールの確認

Claude Code から、次の順に頼んで動きを見ます。

| 頼むこと | 使われるツール | 見るところ |
|---|---|---|
| 「Quelioの◯◯にどんなテーブルがある?」 | `list_tables` | 表とビューが出る。行数の概算も付く |
| 「◯◯テーブルの定義を教えて」 | `describe_table` | カラムの型に加え、**日本語名** (コメントの論理名) が付く |
| 「"受注" を含むテーブルやカラムを探して」 | `search_schema` | 名前でもコメントでも当たる |
| 「◯◯を10件見せて」 | `run_query` | 行が返る。`truncated` で続きの有無が分かる |
| 「このSQLの実行計画は?」 | `explain` | 計画が返る (SQLは実行されない) |
| 「◯◯の status には何が入ってる?」 | `column_values` | 値と件数が多い順に返る。NULLの件数は別枠 |
| 「◯◯を10件取るSQLを書いて」 | `open_in_editor` | 新しいシートにSQLが入る。**実行されない** |

**断られることの確認** (ここが肝心):

- 「読み取りのみ」の接続で「◯◯のデータを1件更新して」→ **「AI連携からは読み取りのSQLだけ実行できます」**。
  「更新も許可」の接続では、下の「5. 更新の許可待ちの確認」の流れになります
- 「BEGIN して」→ 「トランザクションやセッション設定の操作はできません」
- 2文まとめて渡す (MySQLの `DELIMITER` で1文の中に並べたものも) → 「1つのSQLだけ実行できます」
- `SELECT setval(…)` など、SELECTの形で状態を変える関数 → 更新として扱われる (読み取りのみの接続では断られる)

**SQLコンソールの確認**: Quelioの画面でSQLコンソールを開き、
AIが実行したSQLが **`[AI] 接続名`** の行として残っていることを見てください。
接続・切断も `-- AI連携: …` の行で残ります。

**公開をやめたときの確認**: 公開レベルを「公開しない」に戻すと (再起動は不要)、
次の呼び出しが「その名前の接続は公開されていません」で断られ、
AI用の接続がその場で切れます。
「読み取りのみ」⇔「更新も許可」を切り替えた場合も、次の呼び出しで張り直します。

#### 5. 更新の許可待ちの確認 (「更新も許可」にした接続で)

公開レベルを「更新も許可」にした接続で、Claude Code に
「usersテーブルのidが1の行の名前を変えて」などと頼みます。

1. Quelioの画面に **「AIがこのSQLを実行しようとしています」** が出ます
   (Dockのバウンス / タスクバーの点滅でも知らせます。前面には出てきません)
2. 接続名・環境・データベース・**実行されるSQLの全文**・残り時間が出ます。
   `DELETE`・`DROP` など取り返しのつかないものは警告も付きます
3. **拒否** を押す → AIには「利用者が実行を拒否しました」が返り、実行されません
4. もう一度頼み、**許可して実行** を押す → 実行され、`rowsAffected` が返ります
5. 何も押さずに2分待つ → AIには「時間内に許可されなかったため実行しませんでした」

確認しておきたいこと:

- ダイアログで **Enterを押しても許可にならない** (既定は「拒否」。Escも拒否)
- **読み取りのSQLはダイアログを通らない** (そのまま実行される)
- 公開レベルを「読み取りのみ」に戻すと、更新SQLは**ダイアログを出さずに**断られる
- SQLコンソールに `-- AI連携: 更新を許可` / `更新を拒否` / `時間切れで拒否` が残り、
  許可したものは `[AI] 接続名` としてSQL自体も残る

#### 6. 門番の確認 (curl)

トークンとOriginの扱いを、実際に叩いて確かめます。
`<token>` と `<port>` は自分のものに置き換えてください。

```bash
# トークンが無い → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://127.0.0.1:<port>/mcp

# トークンが違う → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Authorization: Bearer ちがうトークン' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://127.0.0.1:<port>/mcp

# トークンは正しいが、外のページから踏まれた形 (Origin付き) → 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Authorization: Bearer <token>' \
  -H 'Origin: http://evil.example.com' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://127.0.0.1:<port>/mcp
```

上から順に `401` / `401` / `403` が返れば正しい状態です。

#### 7. 切ったら閉じることの確認

設定 > AI連携 で無効にしたあと、同じ curl が
`Failed to connect` (ポートが閉じている) になることを確認します。
有効/無効を続けて何度か切り替えても「ポートが使われている」が出ないことも
併せて見てください。

無効にすると、AIが開いていたDB接続もすべて切れます
(SQLコンソールに `-- AI連携: AI連携を止めたため切断` が残ります)。
10分放置したときも同じように切れます (`-- AI連携: しばらく使われなかったため切断`)。

#### 8. SQLを書かせるだけの確認 (`open_in_editor`)

「usersの直近10件を取るSQLを書いて」と頼みます。

1. Quelioに新しいシート (「AIの提案 1」など) ができて、SQLが入っています
2. **実行されていないこと** をSQLコンソールで確かめます
   (そのSQLの実行の記録が残っていないこと)
3. そのシートが表示され、Dockのバウンス等で知らせが来ます (前面には出ません)

確認しておきたいこと:

- その接続のタブを閉じている状態で頼むと、**通常の接続の流れで開きます**
  (「本番」の接続なら確認ダイアログが出ます。パスワード復号・SSHも普段どおり)
- 実行中のタブに対して頼むと、実行が終わってから入ります (結果の行き先を変えない)
- 利用者が手で接続中のタブがあれば、それが終わるまで待ちます (二重に繋ぎにいかない)
- **接続に失敗したとき** (パスワード誤り・本番の確認を取り消した等) は、
  預かっていたSQLをその場で捨てて「AIからのSQLを置けませんでした: 接続に失敗しました」を出します。
  **もう一度頼めば、また接続を試みます** (失敗した接続が二度と試されない状態にならないこと)
- AIが `database` を指定してきたときは、その**DBに切り替えてから**置き、
  シートの冒頭に `-- 対象DB: shop` が入ります。
  そのタブで選べないDB名なら切り替えず `(このタブでは選べませんでした)` と書き添えます
- 「公開しない」にした接続の名前で頼むと「その名前の接続は公開されていません」で断られます
- パスワードを預けていない (鍵の要る) 接続でも **置くことはできます**
  (DBに触らないため。実行は利用者がパスワードを入れてから)

#### 9. 列の値の分布の確認 (`column_values`)

「◯◯テーブルの status にどんな値が入ってる?」と頼みます。

- 値と件数が多い順に返り、NULLは `nullCount` に分かれています
- 存在しない列名を指定させると「◯◯ に ✕✕ という列はありません」で断られます
- SQLコンソールに `[AI] 接続名` として、組み立てられた
  `SELECT ... GROUP BY ... LIMIT` が残っています

#### 10. スキーマ資料の確認 (Resources)

Claude Code なら `/mcp` からリソースを、Claude Desktop なら添付から選べます。

- 公開中の接続ごとに「◯◯ のスキーマ」が並びます (`quelio://<接続名>/<DB名>/schema`)
- **既定のデータベースを決めていない接続は一覧に出ません**
  (どのDBを指すか決められないため)。雛形 `quelio://{connection}/{database}/schema` で指せます
- SQLiteはファイル1つなので、DB名は `main` 固定で出ます (読むときは無視されます)
- 添付すると、論理名つきのテーブル定義がMarkdownで入ります
- テーブルが多いDBでは末尾に「… 残り N テーブルは省略」が付きます
- DBを省いた `quelio://<接続名>/schema` は「データベースを指定してください」で断られます

**公開設定を変えたときの通知**: クライアントを繋いだまま、Quelioで
接続の公開レベル (または名前) を変えると `notifications/resources/list_changed` が飛びます。
Claude Code のログ (`claude --debug` 等) で受け取りを確認できます。
Claude Desktop では、別の接続を「読み取りのみ」にしてから
「+」メニューを開き直すと、新しいリソースが並ぶことで確かめられます
(中継が上流の知らせをそのまま流しています)。

#### 11. 定型のお願いの確認 (Prompts)

Claude Code で `/quelio:table_spec` のように出ます
(表示の形はクライアント次第です。一覧は `/mcp` から見られます)。

- `table_spec` (接続名・テーブル名) → 日本語のテーブル定義書
- `explain_slow_query` (接続名・SQL) → 遅い理由と改善案。**SQLは実行しない**
- `describe_relations` (接続名・テーブル名) → 関係するテーブルと結合の仕方

引数を空にすると「◯◯ を指定してください」で断られます。

### AI連携 (MCP) の設計メモ

#### 3つの原則

1. **接続情報・パスワード・SSHトンネルをAI側に一切渡さない** (AIが知るのは「接続名」だけ)
2. **既存の安全装置をそのまま通す** (読み取り専用判定・危険SQL判定・タイムアウト・SQLコンソールへの記録)
3. **更新系はQuelioの画面で人が許可する** (許可されるまでAI側は待つ)

#### モジュール構成 (`src-tauri/src/mcp/`)

| ファイル | 役割 |
|---|---|
| `mod.rs` | 待受の起動/停止・状態・ポート検証。`McpServer` state |
| `auth.rs` | トークン (`mcp_token.json`)・Bearer検証・Origin検証・axumミドルウェア |
| `views.rs` | AIへ渡す型 (`Ai*`)。**秘密情報を持てない型** を別に用意する |
| `session.rs` | 接続名の解決・AI用セッション (遅延接続・アイドル切断・張り直し) |
| `catalog.rs` | 一覧・定義の参照 (既存 `sessions::*` の薄い包み) |
| `query.rs` | SQLの見分け (`classify_sql`) と実行・許可待ちへの受け渡し |
| `rows.rs` | 結果の並べ方 (JSON / Markdown / CSV)。トークンを節約する返し方 |
| `values.rs` | 列の値の分布 (`column_values`)。SQLは `ddl::quote` で組み立てる |
| `editor.rs` | AIのSQLをエディタへ置くだけの道 (`open_in_editor`)。DBに触らない |
| `resources.rs` | スキーマ資料 (`quelio://…/schema`) のURIとMarkdown組み立て |
| `prompts.rs` | 定型のお願い3本。本文は利用者に返るので日本語 |
| `approval.rs` | 更新の許可待ち (`oneshot` + 120秒で拒否) |
| `endpoint.rs` | 待受の在処 (`mcp_endpoint.json`)。中継がポートを知るため |
| `bridge.rs` | `--mcp-stdio` の中継 (stdio ⇄ HTTP)。ツール定義を持たず丸ごと転送 |
| `server.rs` | ツールの定義 (rmcp の `#[tool]`)。中身は上の各モジュールを呼ぶだけ |

#### 安全境界

| 境界 | やっていること |
|---|---|
| ネットワーク | `127.0.0.1` 固定でバインド。`0.0.0.0` にする設定は作らない |
| 認証 | 32バイトのトークン必須。比較は最後まで行う (合っている文字数を時間から漏らさない) |
| DNSリバインディング | `Origin` が付いていれば手元 (localhost / 127.0.0.1 / ::1) 以外を403。rmcp側の `allowed_hosts` も併用 |
| 公開情報 | `ConnectionProfile` を serialize せず、`AiConnection` (名前・種別・環境・公開レベルのみ) を返す。テストで秘密情報がキー名としても出ないことを見ている |
| 公開レベル | `ai_access` は既定 `none`。**呼ばれるたびに読み直す** (公開をやめた直後の呼び出しを通さない) |
| 本番の3重ガード | UIで選べない / 保存時に `validate_ai_access` / 実行時に `effective_access` |
| 読み取り判定 | `classify_sql` (1文のみ・トランザクションと設定変更は常に拒否・副作用のある関数は更新扱い)。さらに「読み取りのみ」の接続は **読み取り専用で張り**、読み取りと判定したSQLは **読み取り専用のトランザクションの中で流す** (判定をすり抜けても、利用者が作った関数の中の更新でも、DB側で止まる) |
| 更新の許可 | `approval::request` でフロントへ出し、`oneshot` で待つ。120秒で拒否。ウィンドウが無くても時間切れで拒否に倒れる |
| 実行しない道 | `open_in_editor` はDBに触らない (AI用セッションも張らない)。**「ついでに実行する」選択肢を作らない**。SQLの長さ上限だけ置く (64KB) |
| 組み立てるSQL | `column_values` のSQLは `ddl::quote` / `quote_table` で組み立てる。テーブル名・カラム名を文字列連結で埋めない。列の綴りは `describe_table` で確かめたものを使う |
| 資料の大きさ | スキーマ資料は 200KB で打ち切り、省略した数を書き添える (AIの入力を1つの資料で埋めない) |
| 記録 | AI用プロファイルの名前に `[AI] ` を前置し、既存の `conn_label` 経由で接続・SQL・切断のすべてに乗せる。許可/拒否/時間切れも1行ずつ |

#### `--mcp-stdio` の中継

- `main.rs` の最初で引数を見て分岐する。**Tauri を一切初期化しない** (ウィンドウ・プラグイン・メニューを通らない)
- **stdout には JSON-RPC 以外を1バイトも書かない**。知らせごとは stderr へ
- ポートは `mcp_endpoint.json` から、トークンは `mcp_token.json` から読む。
  設定フォルダは `dirs::config_dir()` + `identifier` (`jp.co.zefact.quelio`) で求める
  (`json_store::config_path` と同じ場所になることをテストで確かめている)
- ツール定義は持たず、`list_tools` / `call_tool` を上流の peer へそのまま流す
  (アプリ側でツールが増えたら自動的に見える)。`call_tool_once` を使うのは、
  MRTR (入力が要る返し) を中継が飲み込まないようにするため
- Resources / Prompts も同じく丸ごと転送する
  (`list_resources` / `list_resource_templates` / `read_resource_once` /
  `list_prompts` / `get_prompt_once`)。上流からの
  `notifications/*/list_changed` も、下流の peer へそのまま流す
- **ツール以外の口 (resources / prompts / 通知) を足したら、`bridge.rs` の転送も足すこと**。
  中継は上流の capabilities をそのまま名乗るので、転送を忘れると
  「名乗るのに応えない」状態になり、クライアントは空だと思い込む
  (実際にこれで、Claude Desktop だけ Resources / Prompts が出ない状態になった)
- 繋げないときは JSON-RPC のエラー (`-32000`) を1行返して終了する (固まらせない)

#### 今後の候補

- Valkey の公開 (第1弾はSQLを書くDBのみ)
- リモート (LAN・インターネット) からの接続と OAuth — 現状は意図的に塞いでいる
- 複数トークン (クライアントごとに分ける) / 操作履歴のCSV出力

### 紹介ページ (GitHub Pages) の更新

`docs/` 配下を変更して main にpushするだけで、数分後に
https://zefact.github.io/quelio/ に自動反映されます。リリース作業とは独立しています。

### CSP (Content Security Policy)

`src-tauri/tauri.conf.json` の `app.security` に設定しています。
JSONにコメントを書けないため、意図をここに残します。

| 指定 | 理由 |
|---|---|
| `script-src 'self'` | インラインスクリプトも `eval` も使っていない (ビルド成果物で確認済み)。Tauri自身のスクリプトはビルド時にnonce/hashが自動で足される |
| `style-src 'self' 'unsafe-inline'` | Reactの `style={{...}}` とCodeMirrorが実行時に `<style>` を作るため、インラインを許可せざるを得ない |
| `img-src 'self' data:` | セレクトボックスの矢印などをCSS内のdata URIで持っているため |
| `connect-src 'self' ipc: http://ipc.localhost` | 画面からの通信はTauriのIPCだけ (fetch / XHR / WebSocket は未使用)。`http://ipc.localhost` はWindows向け |
| `object-src 'none'` / `frame-src 'none'` / `form-action 'none'` | いずれも使っていないので塞ぐ |

`devCsp` は開発サーバー (Vite) 用に緩めてあります
(HMRのインラインスクリプトと `ws://localhost:1420` を通すため)。

**画面に何か足すときの注意**: 外部のCDNやフォント、`fetch` での外部通信を
足す場合はここも一緒に変えないと、本番ビルドでだけ動かなくなります。
`npm run tauri dev` では `devCsp` が使われるので気づけません。

### リリースをやり直したいとき

ビルドに失敗した・内容を差し替えたい場合:

```bash
# ドラフトのReleaseをGitHub上で削除してから
git tag -d v1.1.0
git push origin :refs/tags/v1.1.0
# 修正をcommit後、再度タグを打つ
git tag v1.1.0
git push origin v1.1.0
```

公開済みのリリースは削除せず、修正版 (例: v0.2.1) を新たに出すこと。
