import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// design.md D8: 화면 코드는 데이터 포트만 쓰고, SQLite 접근은 포트의 SQLite 구현체에만 둔다.
const restrictSqlite = {
  paths: [
    { name: "better-sqlite3", message: "화면 코드는 데이터 포트(@/lib/data-port)를 쓴다." },
    { name: "@/lib/db", message: "화면 코드는 데이터 포트(@/lib/data-port)를 쓴다." },
  ],
  patterns: [
    { group: ["@/lib/db/*", "**/lib/db", "**/lib/db/*"], message: "화면 코드는 데이터 포트(@/lib/data-port)를 쓴다." },
    { group: ["@/lib/storage/*", "**/lib/storage/*"], message: "화면 코드는 데이터 포트(@/lib/data-port)를 쓴다." },
  ],
};

// 화면용 라우트 3개: 설계상 규칙 대상이다.
const screenRoutes = [
  "src/app/api/bookmarks/toggle/**/*.{ts,tsx}",
  "src/app/api/feed/mark-read/**/*.{ts,tsx}",
  "src/app/api/photos/**/*.{ts,tsx}",
];
// 임시 예외 없음(6장에서 3개 라우트를 포트로 옮겨 비웠다).
const pendingScreenRoutes = [];
const enforcedScreenRoutes = screenRoutes.filter((r) => !pendingScreenRoutes.includes(r));

const eslintConfig = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // 화면(페이지·컴포넌트·_lib)과 Spring 구현체. 기존 JSON API 라우트(src/app/api/**)는 5단계까지 SQLite 직접 사용.
    files: ["src/app/**/*.{ts,tsx}", "src/lib/data-port/spring/**/*.{ts,tsx}"],
    ignores: ["src/app/api/**", "**/__tests__/**"],
    rules: { "no-restricted-imports": ["error", restrictSqlite] },
  },
  ...(enforcedScreenRoutes.length > 0
    ? [
        {
          // 화면용 라우트 재포함(테스트 제외).
          files: enforcedScreenRoutes,
          ignores: ["**/__tests__/**"],
          rules: { "no-restricted-imports": ["error", restrictSqlite] },
        },
      ]
    : []),
];

export default eslintConfig;
