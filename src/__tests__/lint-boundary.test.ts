/**
 * 린트 경계 규칙 자체의 테스트(migrate-data-and-cutover 8.6, spec "웹 앱과 분석 워커의 데이터 접근 경계").
 *
 * `npm run lint`는 규칙이 지워지거나 대상에서 빠져도 통과한다. 그래서 대표 파일 경로에 금지된 가져오기를
 * 넣은 코드를 ESLint API로 직접 검사해, 막혀야 할 곳은 실패하고 허용된 가져오기는 통과하는지 고정한다.
 * 파일은 디스크에 쓰지 않는다(`lintText`).
 *
 * 규칙 세 개: (1) src·workers·scripts 전체(테스트 포함, 예외 없음)에서 데이터베이스 드라이버·`@/lib/db` 금지,
 * (2) workers에서 데이터 포트·Next·웹 앱 모듈 금지(분석 워커는 HTTP만), (3) src/app에서 Spring 구현체 직접
 * 가져오기 금지(테스트는 구현체를 만들 수 있다).
 */
import { ESLint } from "eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const eslint = new ESLint({ cwd: root });

async function restrictedImportMessages(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(`${code}\nexport {};\n`, { filePath: path.join(root, file) });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

const DB_IMPORTS = [
  ['import Database from "better-sqlite3";', "better-sqlite3"],
  ['import mysql from "mysql2";', "mysql2"],
  ['import mysql from "mysql2/promise";', "mysql2/promise"],
  ['import mysql from "mysql";', "mysql"],
  ['import { getDb } from "@/lib/db";', "@/lib/db"],
  ['import { x } from "@/lib/db/items";', "@/lib/db/*"],
  ['import { x } from "../../lib/db";', "상대 경로 lib/db"],
] as const;

/** 규칙 (1)이 걸려야 하는 대표 파일: 화면·라우트·포트·워커·스크립트와 각 영역의 테스트 파일. */
const DB_FORBIDDEN_FILES = [
  "src/app/page.tsx",
  "src/app/items/[id]/page.tsx",
  "src/app/_components/Example.tsx",
  "src/app/_lib/example.ts",
  "src/app/api/bookmarks/toggle/route.ts",
  "src/app/api/feed/mark-read/route.ts",
  "src/app/api/photos/[itemId]/[seq]/route.ts",
  "src/app/api/health/route.ts",
  "src/lib/data-port/spring/port.ts",
  "src/lib/domain/example.ts",
  "workers/analyzer.ts",
  "workers/lib/api.ts",
  "scripts/seed/example.ts",
  "scripts/dev/example.ts",
  // 테스트 파일도 예외가 아니다.
  "src/app/__tests__/example.test.ts",
  "src/app/api/photos/[itemId]/[seq]/__tests__/route.test.ts",
  "src/lib/data-port/__tests__/example.test.ts",
  "src/__tests__/example.test.ts",
  "workers/__tests__/example.test.ts",
  "scripts/dev/__tests__/example.test.ts",
  "scripts/seed/__tests__/example.test.ts",
];

describe("린트 경계 (1): 어디서도 데이터베이스 드라이버·@/lib/db를 가져오지 않는다(테스트 포함)", () => {
  for (const file of DB_FORBIDDEN_FILES) {
    it(`${file}: 금지된 가져오기 ${DB_IMPORTS.length}종이 모두 막힌다`, async () => {
      for (const [code, label] of DB_IMPORTS) {
        const messages = await restrictedImportMessages(file, code);
        expect(messages.length, `${file} 에서 ${label} 가져오기가 막히지 않았다`).toBeGreaterThan(0);
      }
    });
  }

  it("허용된 가져오기는 통과한다(포트 인터페이스, 도메인 타입)", async () => {
    for (const file of ["src/app/page.tsx", "src/app/api/health/route.ts", "workers/analyzer.ts"]) {
      expect(await restrictedImportMessages(file, 'import { z } from "zod";\nimport type { AuctionItem } from "@/lib/domain";'), file).toEqual([]);
    }
    expect(await restrictedImportMessages("src/app/page.tsx", 'import { getDataPort } from "@/lib/data-port";')).toEqual([]);
  });
});

const WORKER_FORBIDDEN = [
  ['import { getDataPort } from "@/lib/data-port";', "@/lib/data-port"],
  ['import { createSpringPort } from "@/lib/data-port/spring/port";', "@/lib/data-port/spring/*"],
  ['import { x } from "../../src/lib/data-port";', "상대 경로 data-port"],
  ['import { NextResponse } from "next/server";', "next/server"],
  ['import Link from "next/link";', "next/link"],
  ['import next from "next";', "next"],
  ['import Page from "@/app/page";', "@/app/*"],
  ['import { GET } from "../../src/app/api/health/route";', "상대 경로 src/app"],
] as const;

describe("린트 경계 (2): 분석 워커는 데이터 포트·Next·웹 앱 모듈을 가져오지 않는다", () => {
  for (const file of ["workers/analyzer.ts", "workers/lib/api.ts", "workers/__tests__/example.test.ts"]) {
    it(`${file}: 금지된 가져오기 ${WORKER_FORBIDDEN.length}종이 모두 막힌다`, async () => {
      for (const [code, label] of WORKER_FORBIDDEN) {
        const messages = await restrictedImportMessages(file, code);
        expect(messages.length, `${file} 에서 ${label} 가져오기가 막히지 않았다`).toBeGreaterThan(0);
      }
    });
  }

  it("워커 안의 상대 경로·도메인 타입 가져오기는 통과한다", async () => {
    const code = 'import { x } from "./lib/api";\nimport { y } from "../lib/prompt";\nimport type { AuctionItem } from "@/lib/domain";';
    expect(await restrictedImportMessages("workers/analyzer.ts", code)).toEqual([]);
    expect(await restrictedImportMessages("workers/__tests__/example.test.ts", code)).toEqual([]);
  });

  it("규칙 (2)는 워커에만 걸린다: 웹 앱·스크립트는 데이터 포트와 next를 가져올 수 있다", async () => {
    const code = 'import { getDataPort } from "@/lib/data-port";\nimport { NextResponse } from "next/server";';
    expect(await restrictedImportMessages("src/app/api/health/route.ts", code)).toEqual([]);
    expect(await restrictedImportMessages("scripts/dev/example.ts", code)).toEqual([]);
  });
});

const SPRING_IMPORTS = [
  ['import { createSpringClient } from "@/lib/data-port/spring/client";', "@/lib/data-port/spring/client"],
  ['import { createSpringPort } from "@/lib/data-port/spring/port";', "@/lib/data-port/spring/port"],
  ['import { x } from "../../lib/data-port/spring/schemas";', "상대 경로 spring/schemas"],
] as const;

describe("린트 경계 (3): src/app은 Spring 구현체를 직접 가져오지 않고 포트 인터페이스만 쓴다", () => {
  for (const file of [
    "src/app/page.tsx",
    "src/app/bookmarks/page.tsx",
    "src/app/_lib/example.ts",
    "src/app/api/bookmarks/toggle/route.ts",
    "src/app/api/photos/[itemId]/[seq]/route.ts",
  ]) {
    it(`${file}: Spring 구현체 가져오기 ${SPRING_IMPORTS.length}종이 모두 막힌다`, async () => {
      for (const [code, label] of SPRING_IMPORTS) {
        const messages = await restrictedImportMessages(file, code);
        expect(messages.length, `${file} 에서 ${label} 가져오기가 막히지 않았다`).toBeGreaterThan(0);
      }
    });
  }

  it("포트 인터페이스(@/lib/data-port) 가져오기는 통과한다", async () => {
    const code = 'import { getDataPort, type DataPort } from "@/lib/data-port";';
    expect(await restrictedImportMessages("src/app/page.tsx", code)).toEqual([]);
    expect(await restrictedImportMessages("src/app/api/photos/[itemId]/[seq]/route.ts", code)).toEqual([]);
  });

  it("src/app의 테스트는 구현체를 직접 만들 수 있다(헬스체크 시간 초과 시험 등)", async () => {
    const code = 'import { createSpringPort } from "@/lib/data-port/spring/port";';
    expect(await restrictedImportMessages("src/app/api/health/__tests__/route-spring.test.ts", code)).toEqual([]);
  });

  it("src/app 밖(포트 구현체·포트 테스트)은 Spring 구현체를 가져올 수 있다", async () => {
    const code = 'import { createSpringPort } from "./spring/port";\nimport { y } from "@/lib/data-port/spring/client";';
    expect(await restrictedImportMessages("src/lib/data-port/index.ts", code)).toEqual([]);
    expect(await restrictedImportMessages("src/lib/data-port/__tests__/example.test.ts", code)).toEqual([]);
  });
});
