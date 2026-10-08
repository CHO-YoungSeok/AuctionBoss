import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as yaml from "js-yaml";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const load = (p: string): Any => yaml.load(read(p));

const compose = load("docker-compose.yml");
const k8sWeb = load("k8s/deployment.yaml");
const k8sAnalyzer = load("k8s/deployment-analyzer.yaml");

function envNames(env: Any): string[] {
  if (Array.isArray(env)) {
    return env.map((e: Any) => (typeof e === "string" ? e.split("=")[0] : e.name));
  }
  return Object.keys(env ?? {});
}
function envValue(env: Any, name: string): string | undefined {
  if (Array.isArray(env)) {
    for (const e of env) {
      if (typeof e === "string") {
        if (e.startsWith(name + "=")) return e.slice(name.length + 1);
      } else if (e.name === name) return e.value;
    }
    return undefined;
  }
  return env?.[name];
}
const containers = (d: Any): Any[] => d.spec.template.spec.containers;

describe("analyzer가 읽는 서버 주소 변수", () => {
  const apiSrc = read("workers/lib/api.ts");
  it("analyzer 소스가 AUCTIONBOSS_API_BASE를 읽고 기본값은 localhost", () => {
    expect(read("workers/analyzer.ts")).toContain("process.env.AUCTIONBOSS_API_BASE");
    expect(apiSrc).toMatch(/DEFAULT_API_BASE\s*=\s*"http:\/\/localhost/);
  });

  it("compose analyzer", () => {
    const env = compose.services.analyzer.environment;
    const names = envNames(env);
    expect(names).toContain("AUCTIONBOSS_API_BASE");
    expect(names).not.toContain("BASE_URL");
    const v = envValue(env, "AUCTIONBOSS_API_BASE")!;
    expect(v).toBe("http://web:3000");
    expect(v).not.toMatch(/localhost|127\.0\.0\.1/);
    expect(names).toContain("ANTHROPIC_API_KEY");
    expect(envValue(env, "ANTHROPIC_API_KEY")).toBe("${ANTHROPIC_API_KEY:-}");
    expect(envValue(env, "AUCTIONBOSS_ANALYZE_MODEL")).toBe("${AUCTIONBOSS_ANALYZE_MODEL:-}");
  });

  it("K8s analyzer", () => {
    const env = containers(k8sAnalyzer)[0].env;
    const names = envNames(env);
    expect(names).toContain("AUCTIONBOSS_API_BASE");
    expect(names).not.toContain("BASE_URL");
    expect(envValue(env, "AUCTIONBOSS_API_BASE")).not.toMatch(/localhost|127\.0\.0\.1/);
    // 운영 분석 워커는 Spring이 아니라 Next 서비스를 본다(add-spring-write-api: 운영 경로 유지).
    expect(envValue(env, "AUCTIONBOSS_API_BASE")).toBe("http://auctionboss-service:3000");
  });
});

describe("compose", () => {
  it("web 헬스체크는 curl 없이 node로 /api/health를 확인", () => {
    const test: string[] = compose.services.web.healthcheck.test;
    expect(test[0]).toBe("CMD");
    expect(test[1]).toBe("node");
    expect(test.join(" ")).not.toContain("curl");
    expect(test.join(" ")).toContain("/api/health");
    expect(test.join(" ")).toContain("r.status===200");
    expect(compose.services.web.healthcheck.start_period).toBeTruthy();
  });

  it("photos 서비스는 web과 같은 데이터 볼륨, npm run photos", () => {
    const { web, photos, collector } = compose.services;
    expect(photos.command).toBe("npm run photos");
    const vol = (s: Any) => s.volumes.find((v: string) => v.endsWith(":/app/data"));
    expect(vol(photos)).toBeTruthy();
    expect(vol(photos)).toBe(vol(web));
    expect(envNames(photos.environment)).toContain("AUCTIONBOSS_DB");
    for (const s of [collector, photos]) {
      expect(s.depends_on.web.condition).toBe("service_healthy");
    }
  });
});

describe("K8s", () => {
  it("photos 컨테이너는 web과 같은 PVC 볼륨을 같은 경로에 마운트", () => {
    const cs = containers(k8sWeb);
    const web = cs.find((c) => c.name === "web");
    const photos = cs.find((c) => c.name === "photos");
    expect(photos).toBeTruthy();
    expect(photos.command).toEqual(["npm", "run", "photos"]);
    expect(photos.volumeMounts).toEqual(web.volumeMounts);
    expect(
      k8sWeb.spec.template.spec.volumes.some((v: Any) => v.name === web.volumeMounts[0].name),
    ).toBe(true);
  });

  it("secret 예시 주석에 ANTHROPIC_API_KEY", () => {
    expect(read("k8s/secret.yaml")).toContain("ANTHROPIC_API_KEY");
  });
});

describe("운영 데이터 원천 유지(switch-web-to-data-port D2)", () => {
  // 웹 서비스에 spring을 넣으면 화면이 수집이 멈춘 MySQL 시드를 보여 준다. 전환은 5단계 이전 직후 한 번.
  const isSpring = (v: string | undefined) => v?.trim().toLowerCase() === "spring";
  it("compose 웹 서비스는 AUCTIONBOSS_DATA_SOURCE를 spring으로 두지 않는다", () => {
    const env = compose.services.web.environment;
    expect(isSpring(envValue(env, "AUCTIONBOSS_DATA_SOURCE"))).toBe(false);
    expect(envNames(env)).not.toContain("AUCTIONBOSS_SPRING_BASE");
  });

  it("K8s 웹 배포와 configmap은 AUCTIONBOSS_DATA_SOURCE를 spring으로 두지 않는다", () => {
    for (const c of containers(k8sWeb)) {
      expect(isSpring(envValue(c.env, "AUCTIONBOSS_DATA_SOURCE"))).toBe(false);
      expect(envNames(c.env)).not.toContain("AUCTIONBOSS_SPRING_BASE");
    }
    const cm = load("k8s/configmap.yaml");
    expect(isSpring(cm.data?.AUCTIONBOSS_DATA_SOURCE)).toBe(false);
    expect(Object.keys(cm.data ?? {})).not.toContain("AUCTIONBOSS_SPRING_BASE");
  });

  it("어느 배포 파일에도 AUCTIONBOSS_DATA_SOURCE=spring 문자열이 없다", () => {
    for (const f of ["docker-compose.yml", ...["configmap", "deployment", "deployment-analyzer"].map((n) => `k8s/${n}.yaml`)]) {
      expect(read(f)).not.toMatch(/AUCTIONBOSS_DATA_SOURCE["']?\s*[:=]\s*["']?spring/i);
    }
  });
});

describe("Next 이미지(Dockerfile)", () => {
  // 회귀 방지: runner 단계에 tsconfig.json이 빠지면 컨테이너 안의 워커(tsx)가 `@/` 경로 별칭을
  // 풀지 못해 `Cannot find module '@/lib/domain'`으로 시작하자마자 죽었다(1-B 5장에서 발견).
  it("runner 단계가 tsconfig.json을 복사한다", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    const runner = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
    expect(runner).toMatch(/COPY\s+--from=builder\s+\S*tsconfig\.json/);
  });
});

