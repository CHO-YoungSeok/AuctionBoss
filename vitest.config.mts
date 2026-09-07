import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// package.json에 "type": "module"이 없어 .ts 설정은 CJS로 로드된다(vite 경고).
// 확장자를 .mts로 두면 ESM으로 로드돼 경고 없이 import.meta를 쓸 수 있다.
export default defineConfig({
  resolve: {
    // tsconfig의 "@/*" -> "./src/*" 와 같은 매핑.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
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
