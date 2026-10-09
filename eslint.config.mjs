import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// migrate-data-and-cutover D12(8.6) 린트 경계. 예외를 두지 않는다 — 테스트 파일도 같은 규칙을 받는다
// (3번의 `src/app` 테스트 면제만 예외다. 아래 주석 참고).
//
// ESLint 평면 설정은 같은 규칙을 나중 블록이 통째로 덮어쓰므로, 영역별 규칙은 공통 금지(1)를 포함해 조합한다.

// (1) 데이터베이스 드라이버·옛 저장소 모듈은 어디서도 가져오지 않는다(src·workers·scripts 전체, 테스트 포함).
const DB_MESSAGE = "데이터베이스는 Spring 백엔드가 소유한다. 웹·워커·스크립트에서 드라이버나 옛 저장소(@/lib/db)를 가져오지 않는다.";
const dbPaths = ["better-sqlite3", "mysql2", "mysql", "@/lib/db"].map((name) => ({ name, message: DB_MESSAGE }));
const dbPatterns = [
  { group: ["@/lib/db/*", "**/lib/db", "**/lib/db/*", "mysql2/*", "mysql/*", "better-sqlite3/*"], message: DB_MESSAGE },
];

// (2) 분석 워커는 서버 API(HTTP)로만 통신한다 — 데이터 포트·Next·웹 앱 모듈을 가져오지 않는다.
const WORKER_MESSAGE = "분석 워커는 서버와 HTTP API로만 통신한다. 데이터 포트·Next·웹 앱 모듈을 가져오지 않는다.";
const workerPaths = [
  { name: "@/lib/data-port", message: WORKER_MESSAGE },
  { name: "next", message: WORKER_MESSAGE },
];
const workerPatterns = [
  { group: ["@/lib/data-port/*", "**/lib/data-port", "**/lib/data-port/*", "next/*", "@/app/*", "**/src/app/**"], message: WORKER_MESSAGE },
];

// (3) 웹 앱(src/app)은 Spring 구현체를 직접 가져오지 않고 포트 인터페이스(@/lib/data-port)만 쓴다.
//     테스트는 구현체를 직접 만들 수 있다(예: 헬스체크 시간 초과 시험). 1·2번에는 면제가 없다.
const PORT_MESSAGE = "화면·라우트는 포트 인터페이스(@/lib/data-port)만 쓴다. Spring 구현체를 직접 가져오지 않는다.";
const appPatterns = [{ group: ["@/lib/data-port/spring/*", "**/data-port/spring/*"], message: PORT_MESSAGE }];

const rule = (paths, patterns) => ({ "no-restricted-imports": ["error", { paths, patterns }] });

const eslintConfig = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    files: ["src/**/*.{ts,tsx,mts}", "workers/**/*.{ts,mts}", "scripts/**/*.{ts,mts}"],
    rules: rule(dbPaths, dbPatterns),
  },
  {
    files: ["workers/**/*.{ts,mts}"],
    rules: rule([...dbPaths, ...workerPaths], [...dbPatterns, ...workerPatterns]),
  },
  {
    files: ["src/app/**/*.{ts,tsx}"],
    ignores: ["**/__tests__/**"],
    rules: rule(dbPaths, [...dbPatterns, ...appPatterns]),
  },
];

export default eslintConfig;
