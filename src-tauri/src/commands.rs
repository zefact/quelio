//! 画面 (フロントエンド) から呼ばれる入口。
//!
//! ここでは受け取った値をそのまま奥へ渡すだけにして、
//! 判断や手順は sessions / storage 側に置く。
//! 数が多いので、扱う対象ごとにモジュールへ分けた
//! (呼ぶ側 lib.rs から見た名前は `commands::〇〇` のまま)

use tauri::{AppHandle, Manager, State};

use crate::models::{
    ConnectInfo, ConnectionProfile, ConnectionStore, CsvExportResult, FolderInfo, LayoutEntry,
    RunOutput, SchemaEntry, SessionSummary, TableDetail, TableInfo, TestResult,
};
use crate::catalog;
use crate::csv_job::CsvJobs;
use crate::ddl;
use crate::ddl_table;
use crate::query;
use crate::query_log::{QueryLog, QueryLogEntry};
use crate::sessions::{self, CancelRegistry, Sessions};
use crate::tools::{self, JobStatus, Jobs, StartedJob, ToolSettings, ToolStatus};
use crate::{db, storage};

/// 接続先の管理と、接続そのもの。
mod connections;
pub use connections::*;

/// SQLの実行と、その周辺 (確認・パラメータ・履歴・CSV出力)
mod sql;
pub use sql::*;

/// 一覧と定義の参照 (テーブル・カラム・ルーチン・実行中の接続)
mod browse;
pub use browse::*;

/// 定義の変更 (テーブル・カラム・インデックス・外部キー) と、
mod definitions;
pub use definitions::*;

/// Valkey (KVモード) の操作
mod kv;
pub use kv::*;

/// 取り込みと書き出し、および検索。
mod transfer;
pub use transfer::*;

/// 別ウィンドウ (スキーマ・ER図・差分・コンソール) と、
mod windows;
pub use windows::*;
