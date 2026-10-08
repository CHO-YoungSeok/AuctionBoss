/**
 * 린트 경계 규칙 자체의 테스트(switch-web-to-data-port 7장, spec "화면 데이터 접근 경계").
 *
 * `npm run lint`는 규칙이 지워지거나 대상에서 빠져도 통과한다. 그래서 대표 파일 경로에 금지된 가져오기를
 * 넣은 코드를 ESLint API로 직접 검사해 (1) 화면·화면용 라우트·Spring 구현체는 실패하고 (2) 기존 JSON API
 * 라우트와 테스트는 통과하는지 고정한다. 파일은 디스크에 쓰지 않는다(`lintText`).
 */
import { ESLint } from "eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const eslint = new ESLint({ cwd: root });

async function restrictedImportMessages(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

const FORBIDDEN = [
  ['import { getDb } from "@/lib/db";', "@/lib/db"],
  ['import Database from "better-sqlite3";', "better-sqlite3"],
  ['import { x } from "@/lib/db/items";', "@/lib/db/*"],
  ['import { x } from "../../lib/db";', "상대 경로 lib/db"],
  ['import { x } from "@/lib/storage/photos";', "@/lib/storage/*"],
] as const;

const ENFORCED = [
  "src/app/page.tsx",
  "src/app/items/[id]/page.tsx",
  "src/app/status/page.tsx",
  "src/app/_components/Example.tsx",
  "src/app/_lib/example.ts",
  "src/app/api/bookmarks/toggle/route.ts",
  "src/app/api/feed/mark-read/route.ts",
  "src/app/api/photos/[itemId]/[seq]/route.ts",
  "src/lib/data-port/spring/port.ts",
];

describe("린트 경계: 화면 코드의 직접 데이터베이스 접근 금지", () => {
  for (const file of ENFORCED) {
    it(`${file}: 금지된 가져오기 5종이 모두 막힌다`, async () => {
      for (const [code, label] of FORBIDDEN) {
        const messages = await restrictedImportMessages(file, `${code}\nexport {};\n`);
        expect(messages.length, `${file} 에서 ${label} 가져오기가 막히지 않았다`).toBeGreaterThan(0);
      }
    });
  }

  it("기존 JSON API 라우트는 예외다(5단계까지 SQLite 직접 사용)", async () => {
    for (const file of ["src/app/api/items/route.ts", "src/app/api/items/[id]/changes/route.ts"]) {
      const messages = await restrictedImportMessages(file, 'import { getDb } from "@/lib/db";\nexport {};\n');
      expect(messages, file).toEqual([]);
    }
  });

  it("테스트 코드와 SQLite 구현체는 예외다", async () => {
    for (const file of [
      "src/app/__tests__/example.test.ts",
      "src/app/api/photos/[itemId]/[seq]/__tests__/route.test.ts",
      "src/lib/data-port/sqlite.ts",
    ]) {
      const messages = await restrictedImportMessages(file, 'import { getDb } from "@/lib/db";\nexport {};\n');
      expect(messages, file).toEqual([]);
    }
  });
});
