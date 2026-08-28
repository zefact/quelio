// ESLintの設定 (フラット形式)。
//
// 目的は「気づきにくい間違いを機械に見てもらう」こと。
// 見た目 (整形) はPrettier等に任せる前提で、ここでは入れていない。
//
// とくに react-hooks/exhaustive-deps は、依存配列の書き漏れによる
// 「古い値を掴んだまま動く」不具合を見つけるために入れている
// (意図して外している箇所は、その行に eslint-disable コメントで理由を書く)
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Rustのコード・生成物・依存は見ない
  { ignores: ["dist", "node_modules", "src-tauri", "docs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs["recommended-latest"].rules,
      /*
       * React Compiler 前提の新しい規則は外している。
       * このアプリは「最新の値をrefに写して、ハンドラからはrefを見る」
       * 書き方を意図的に使っており (App.tsx の tabsRef など)、
       * これらの規則とは方針が合わないため。
       * フックの呼び方 (rules-of-hooks) と依存配列 (exhaustive-deps) は残す
       */
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/exhaustive-deps": "warn",
      // 使っていない変数は間違いのことが多いが、
      // `_` 始まりは「受け取るが使わない」意思表示として許す
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // テストは vitest のグローバルを使わず import しているので追加設定は不要
    files: ["**/*.test.{ts,tsx}"],
    rules: {},
  }
);
