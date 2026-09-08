import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// package.json에 "type": "module"이 없어 .ts 설정은 CJS로 로드된다(vite 경고).
// 확장자를 .mts로 두면 ESM으로 로드돼 경고 없이 import.meta를 쓸 수 있다.
export default defineConfig({
  resolve: {
    // tsconfig의 "@/*" -> "./src/*" 와 같은 매핑.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // tsconfig.json의 jsx는 "preserve"다(Next.js가 SWC로 직접 JSX를 변환하므로). vite 7의
  // 기본 변환기(oxc)는 "preserve"를 처리하지 못해 그대로 두면 .tsx import가 파싱 오류로
  // 죽는다(live-data-and-reports task 4.3, `AnalysisBody` 렌더링 테스트에서 처음
  // 발견). tsconfig.json 자체는 Next 빌드에 영향을 주므로 건드리지 않고, vitest 실행
  // 시 이 설정만 오버라이드한다.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/__tests__/**/*.test.ts",
      // 워커(collector/analyzer)도 같은 러너로 돈다.
      "workers/**/*.test.ts",
    ],
  },
});
