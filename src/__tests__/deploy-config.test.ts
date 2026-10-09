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
const smoke = load("docker-compose.smoke.yml");
const k8sWeb = load("k8s/deployment.yaml");
const k8sAnalyzer = load("k8s/deployment-analyzer.yaml");
const k8sBackend = load("k8s/deployment-backend.yaml");
const k8sBackendSvc = load("k8s/service-backend.yaml");
const k8sConfigMap = load("k8s/configmap.yaml");
const k8sSecret = load("k8s/secret.yaml");
const k8sKustomization = load("k8s/kustomization.yaml");
const k8sPvcs: Any[] = yaml.loadAll(read("k8s/pvc.yaml"));
const k8sMysqlDocs: Any[] = yaml.loadAll(read("k8s/statefulset-mysql.yaml"));
const k8sMysql = k8sMysqlDocs.find((d) => d.kind === "StatefulSet");

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

const K8S_FILES = [
  "configmap",
  "configmap-collector",
  "deployment",
  "deployment-analyzer",
  "deployment-backend",
  "service-backend",
  "statefulset-mysql",
  "secret",
  "service",
  "ingress",
  "kustomization",
  "namespace",
  "pvc",
].map((n) => `k8s/${n}.yaml`);
// 환경 변수·인자를 심을 수 있는 모든 경로: compose 둘, 이미지, CI, 스크립트, K8s 매니페스트
const DEPLOY_FILES = [
  "docker-compose.yml",
  "docker-compose.smoke.yml",
  "Dockerfile",
  "backend/Dockerfile",
  ".github/workflows/ci.yml",
  "scripts/dev/compare-screens.sh",
  "scripts/docker-smoke.sh",
  ...K8S_FILES,
];
// 실제로 배포되는 구성(개발 스크립트는 임시 컨테이너·시험용 값을 쓰므로 제외)
const DEPLOYED_FILES = DEPLOY_FILES.filter((f) => !f.startsWith("scripts/"));
// 세 설정을 켜도 되는 파일은 운영 백엔드를 정의하는 두 곳뿐이다.
const SWITCH_ON_ALLOWED = ["docker-compose.yml", "k8s/deployment-backend.yaml"];
const stripComments = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

describe("analyzer가 읽는 서버 주소 변수", () => {
  const apiSrc = read("workers/lib/api.ts");
  it("analyzer 소스가 AUCTIONBOSS_API_BASE를 읽고 기본값은 localhost", () => {
    expect(read("workers/analyzer.ts")).toContain("process.env.AUCTIONBOSS_API_BASE");
    expect(apiSrc).toMatch(/DEFAULT_API_BASE\s*=\s*"http:\/\/localhost/);
  });

  it("compose analyzer는 백엔드 서비스를 본다", () => {
    const env = compose.services.analyzer.environment;
    const names = envNames(env);
    expect(names).toContain("AUCTIONBOSS_API_BASE");
    expect(names).not.toContain("BASE_URL");
    const v = envValue(env, "AUCTIONBOSS_API_BASE")!;
    expect(v).toBe("http://backend:8080");
    expect(v).not.toMatch(/localhost|127\.0\.0\.1|web:3000/);
    expect(compose.services.analyzer.depends_on.backend.condition).toBe("service_healthy");
    expect(names).toContain("ANTHROPIC_API_KEY");
    expect(envValue(env, "ANTHROPIC_API_KEY")).toBe("${ANTHROPIC_API_KEY:-}");
    expect(envValue(env, "AUCTIONBOSS_ANALYZE_MODEL")).toBe("${AUCTIONBOSS_ANALYZE_MODEL:-}");
  });

  it("K8s analyzer는 백엔드 서비스를 본다", () => {
    const env = containers(k8sAnalyzer)[0].env;
    const names = envNames(env);
    expect(names).toContain("AUCTIONBOSS_API_BASE");
    expect(names).not.toContain("BASE_URL");
    const v = envValue(env, "AUCTIONBOSS_API_BASE")!;
    expect(v).toBe(`http://${k8sBackendSvc.metadata.name}:8080`);
    expect(v).not.toMatch(/localhost|127\.0\.0\.1|auctionboss-service/);
  });
});

describe("compose 웹 헬스체크", () => {
  it("web 헬스체크는 curl 없이 node로 /api/health를 확인", () => {
    const test: string[] = compose.services.web.healthcheck.test;
    expect(test[0]).toBe("CMD");
    expect(test[1]).toBe("node");
    expect(test.join(" ")).not.toContain("curl");
    expect(test.join(" ")).toContain("/api/health");
    expect(test.join(" ")).toContain("r.status===200");
    expect(compose.services.web.healthcheck.start_period).toBeTruthy();
  });
});

describe("운영 구성에서만 수집·사진 켬(migrate-data-and-cutover D9)", () => {
  // 수집기는 백엔드 하나뿐이어야 한다: TS collector·photos와 백엔드 스케줄러가 같은 소스에 동시에 요청하면
  // 서로의 백오프를 못 본다. 켜는 곳은 compose backend와 K8s 백엔드뿐이다.
  const SWITCHES = [
    "AUCTIONBOSS_COLLECTOR_ENABLED",
    "AUCTIONBOSS_PHOTOS_ENABLED",
    "AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED",
  ];
  const DOTTED = [
    "auctionboss.collector.enabled",
    "auctionboss.photos.enabled",
    "auctionboss.source.external-requests-allowed",
  ];
  const isOn = (v: unknown) => /^(true|1|yes|on)$/i.test(String(v ?? "").trim());
  const isTsWorkerCommand = (cmd: unknown) =>
    /(^|\s)(npm run (collector|photos)|tsx\s+\S*workers\/(collector|photos)(\.ts)?)(\s|$)/.test(
      Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? ""),
    );

  it("compose backend는 세 설정을 모두 켜고 나머지 서비스는 하나도 켜지 않는다", () => {
    for (const [name, svc] of Object.entries<Any>(compose.services)) {
      for (const key of SWITCHES) {
        expect(isOn(envValue(svc.environment, key)), `${name} ${key}`).toBe(name === "backend");
      }
    }
  });

  it("K8s 백엔드 컨테이너는 세 설정을 모두 켜고 나머지 컨테이너·configmap은 켜지 않는다", () => {
    for (const key of SWITCHES) expect(isOn(envValue(containers(k8sBackend)[0].env, key)), key).toBe(true);
    for (const d of [k8sWeb, k8sAnalyzer]) {
      for (const c of containers(d)) {
        for (const key of SWITCHES) expect(isOn(envValue(c.env, key)), `${c.name} ${key}`).toBe(false);
      }
    }
    for (const doc of [k8sConfigMap, ...k8sMysqlDocs]) {
      for (const key of SWITCHES) expect(JSON.stringify(doc), key).not.toMatch(new RegExp(`${key}"?[:,]"?(true|1)`));
    }
    for (const key of SWITCHES) expect(isOn(k8sConfigMap.data?.[key]), `configmap ${key}`).toBe(false);
  });

  it("스모크 구성은 세 설정을 켜지 않고 외부 요청 허용 이름도 두지 않는다", () => {
    for (const [name, svc] of Object.entries<Any>(smoke.services)) {
      for (const key of SWITCHES) {
        expect(isOn(envValue(svc.environment, key)), `${name} ${key}`).toBe(false);
      }
    }
    expect(read("docker-compose.smoke.yml")).not.toContain("EXTERNAL_REQUESTS_ALLOWED");
    expect(read("scripts/docker-smoke.sh")).not.toContain("EXTERNAL_REQUESTS_ALLOWED");
  });

  it("세 설정을 켜는 문자열은 compose backend와 K8s 백엔드 파일에만 있다(이름·점 표기, 값 표기 변형 포함)", () => {
    for (const f of DEPLOY_FILES.filter((f) => !SWITCH_ON_ALLOWED.includes(f))) {
      const text = read(f);
      for (const key of [...SWITCHES, ...DOTTED]) {
        const escaped = key.replace(/[.]/g, "\\.");
        expect(text, `${f} ${key}`).not.toMatch(
          new RegExp(`${escaped}["']?\\s*[:=]\\s*["']?(true|1|yes|on)\\b`, "i"),
        );
      }
      expect(text, f).not.toContain("EXTERNAL_REQUESTS_ALLOWED");
    }
  });

  it("배포 파일에 1회 실행 모드 이름이 없다(컨테이너가 회차 한 번 뒤 종료·재시작하며 실제 소스에 요청하게 된다)", () => {
    for (const f of DEPLOY_FILES) {
      expect(read(f), f).not.toMatch(/AUCTIONBOSS_RUN_ONCE|auctionboss\.run-once/i);
    }
    for (const [name, svc] of Object.entries<Any>(compose.services)) {
      expect(envNames(svc.environment), name).not.toContain("AUCTIONBOSS_RUN_ONCE");
    }
  });

  it("TS collector·photos 서비스·컨테이너가 없고 npm run collector|photos 명령도 배포 파일에 없다", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["analyzer", "backend", "mysql", "web"]);
    for (const [name, svc] of Object.entries<Any>(compose.services)) {
      expect(isTsWorkerCommand(svc.command), name).toBe(false);
    }
    expect(Object.keys(smoke.services).sort()).toEqual(["backend", "mysql"]);
    expect(containers(k8sWeb).map((c: Any) => c.name)).toEqual(["web"]);
    for (const d of [k8sWeb, k8sAnalyzer, k8sBackend, k8sMysql]) {
      for (const c of containers(d)) {
        expect(isTsWorkerCommand([...(c.command ?? []), ...(c.args ?? [])]), c.name).toBe(false);
      }
    }
    for (const f of DEPLOY_FILES) {
      expect(stripComments(read(f)), f).not.toMatch(/npm run (collector|photos)\b/);
      expect(stripComments(read(f)), f).not.toMatch(/workers\/(collector|photos)(\.ts)?\b/);
    }
  });

  it("수집기가 동시에 둘 이상 켜지는 구성이 없다(compose·K8s 각각 정확히 하나, 그것은 백엔드)", () => {
    const composeCollectors = Object.entries<Any>(compose.services)
      .filter(
        ([, svc]) =>
          isTsWorkerCommand(svc.command) ||
          isOn(envValue(svc.environment, "AUCTIONBOSS_COLLECTOR_ENABLED")) ||
          isOn(envValue(svc.environment, "AUCTIONBOSS_PHOTOS_ENABLED")),
      )
      .map(([name]) => name);
    expect(composeCollectors).toEqual(["backend"]);

    const workloads = [k8sWeb, k8sAnalyzer, k8sBackend, k8sMysql];
    const k8sCollectors = workloads.flatMap((d) =>
      containers(d)
        .filter(
          (c: Any) =>
            isTsWorkerCommand(c.command) ||
            isOn(envValue(c.env, "AUCTIONBOSS_COLLECTOR_ENABLED")) ||
            isOn(envValue(c.env, "AUCTIONBOSS_PHOTOS_ENABLED")),
        )
        .map((c: Any) => `${d.metadata.name}/${c.name}`),
    );
    expect(k8sCollectors).toEqual(["auctionboss-backend/backend"]);
  });

  it("compose backend는 prod 프로필(시드·local 아님)과 사진 볼륨을 쓴다", () => {
    const b = compose.services.backend;
    expect(envValue(b.environment, "SPRING_PROFILES_ACTIVE")).toBe("prod");
    expect(envValue(b.environment, "AUCTIONBOSS_PHOTOS_DIR")).toBe("/app/photos");
    expect(b.volumes).toContain("photos-data:/app/photos");
    expect(b.volumes).toContain("./config/collector.json:/app/config/collector.json:ro");
    expect(Object.keys(compose.volumes)).toEqual(expect.arrayContaining(["photos-data", "mysql-data"]));
    // 포트는 루프백에만
    for (const svc of [b, compose.services.mysql]) {
      for (const p of svc.ports) expect(String(p)).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it("K8s 백엔드는 prod 프로필, 사진 PVC, 수집 설정 마운트를 쓴다", () => {
    const c = containers(k8sBackend)[0];
    expect(envValue(c.env, "SPRING_PROFILES_ACTIVE")).toBe("prod");
    const photosDir = envValue(c.env, "AUCTIONBOSS_PHOTOS_DIR")!;
    expect(c.volumeMounts.find((m: Any) => m.mountPath === photosDir)).toBeTruthy();
    const photosVol = k8sBackend.spec.template.spec.volumes.find((v: Any) => v.name === "photos");
    expect(photosVol.persistentVolumeClaim.claimName).toBe("auctionboss-photos-pvc");
    expect(k8sPvcs.map((p) => p.metadata.name)).toContain("auctionboss-photos-pvc");
  });

  it("K8s 백엔드 Pod는 fsGroup을 이미지의 비루트 사용자(10001)로 둔다(root 소유 PVC에 사진을 쓸 수 있게)", () => {
    expect(k8sBackend.spec.template.spec.securityContext?.fsGroup).toBe(10001);
    expect(read("backend/Dockerfile")).toMatch(/useradd[^\n]*--uid 10001/);
  });

  it("백엔드 이미지가 사진 디렉터리를 비루트 사용자(10001) 소유로 만든다", () => {
    const df = read("backend/Dockerfile");
    expect(df).toMatch(/mkdir -p \/app\/photos\s*&&\s*chown 10001:10001 \/app\/photos/);
    expect(df).toMatch(/useradd[^\n]*--uid 10001/);
  });
});

describe("백엔드 단일 인스턴스(K8s)", () => {
  it("replicas 1과 Recreate 전략", () => {
    expect(k8sBackend.spec.replicas).toBe(1);
    expect(k8sBackend.spec.strategy.type).toBe("Recreate");
  });

  it("백엔드 서비스는 ClusterIP이고 Ingress가 백엔드를 가리키지 않는다", () => {
    expect(k8sBackendSvc.spec.type).toBe("ClusterIP");
    expect(k8sBackendSvc.spec.ports[0].port).toBe(8080);
    expect(read("k8s/ingress.yaml")).not.toContain("auctionboss-backend");
  });

  it("백엔드 프로브는 /api/health", () => {
    const c = containers(k8sBackend)[0];
    expect(c.readinessProbe.httpGet.path).toBe("/api/health");
    expect(c.livenessProbe.httpGet.path).toBe("/api/health");
  });

  it("MySQL은 영속 볼륨을 가진 StatefulSet", () => {
    expect(k8sMysql.spec.volumeClaimTemplates.length).toBeGreaterThan(0);
    expect(containers(k8sMysql)[0].image).toMatch(/^mysql:8\.4/);
    expect(containers(k8sMysql)[0].args).toEqual(
      expect.arrayContaining(["--character-set-server=utf8mb4", "--collation-server=utf8mb4_0900_ai_ci"]),
    );
  });

  it("kustomization이 매니페스트를 빠짐없이 싣는다", () => {
    const listed: string[] = k8sKustomization.resources;
    for (const f of K8S_FILES.filter((f) => !f.endsWith("kustomization.yaml"))) {
      expect(listed, f).toContain(f.replace("k8s/", ""));
    }
  });

  it("collector.json 사본(ConfigMap)이 원본과 같다", () => {
    const cm = load("k8s/configmap-collector.yaml");
    expect(JSON.parse(cm.data["collector.json"])).toEqual(JSON.parse(read("config/collector.json")));
  });
});

describe("웹은 spring 원천(migrate-data-and-cutover D9)", () => {
  it("compose 웹: spring 원천, 백엔드 서비스 주소, 백엔드 헬스 의존, 볼륨·DB 경로 없음", () => {
    const web = compose.services.web;
    expect(envValue(web.environment, "AUCTIONBOSS_DATA_SOURCE")).toBe("spring");
    const base = envValue(web.environment, "AUCTIONBOSS_SPRING_BASE")!;
    expect(base).toBe("http://backend:8080");
    expect(Object.keys(compose.services)).toContain(new URL(base).hostname);
    expect(web.depends_on.backend.condition).toBe("service_healthy");
    expect(web.volumes ?? []).toEqual([]);
    expect(envNames(web.environment)).not.toContain("AUCTIONBOSS_DB");
  });

  it("K8s 웹: 컨테이너 하나, spring 원천, 백엔드 서비스 주소, 볼륨·DB 경로 없음, 프로브", () => {
    expect(containers(k8sWeb)).toHaveLength(1);
    const web = containers(k8sWeb)[0];
    expect(envValue(web.env, "AUCTIONBOSS_DATA_SOURCE")).toBe("spring");
    expect(envValue(web.env, "AUCTIONBOSS_SPRING_BASE")).toBe(
      `http://${k8sBackendSvc.metadata.name}:${k8sBackendSvc.spec.ports[0].port}`,
    );
    expect(k8sWeb.spec.template.spec.volumes ?? []).toEqual([]);
    expect(web.volumeMounts ?? []).toEqual([]);
    expect(envNames(web.env)).not.toContain("AUCTIONBOSS_DB");
    expect(web.readinessProbe.httpGet.path).toBe("/api/health");
    // 백엔드 중단만으로 웹을 재시작하지 않는다: liveness는 /api/health를 보지 않는다.
    expect(web.livenessProbe.httpGet).toBeUndefined();
    expect(web.livenessProbe.tcpSocket.port).toBe(3000);
  });

  it("어느 배포 파일에도 웹·분석 워커용 SQLite 파일 경로(AUCTIONBOSS_DB)가 없다", () => {
    for (const f of DEPLOYED_FILES) {
      expect(stripComments(read(f)), f).not.toMatch(/AUCTIONBOSS_DB\b/);
    }
    expect(Object.keys(k8sConfigMap.data ?? {})).not.toContain("AUCTIONBOSS_DB");
  });

  it("SQLite 볼륨·PVC는 선언만 남고 어느 서비스·워크로드도 마운트하지 않는다(롤백 창)", () => {
    expect(Object.keys(compose.volumes)).toContain("auctionboss-data");
    for (const [name, svc] of Object.entries<Any>(compose.services)) {
      for (const v of svc.volumes ?? []) expect(String(v), name).not.toMatch(/^auctionboss-data:/);
    }
    expect(k8sPvcs.map((p) => p.metadata.name)).toContain("auctionboss-data-pvc");
    for (const d of [k8sWeb, k8sAnalyzer, k8sBackend, k8sMysql]) {
      expect(JSON.stringify(d.spec.template.spec.volumes ?? [])).not.toContain("auctionboss-data-pvc");
    }
  });
});

describe("비밀", () => {
  const dbVars = ["DB_NAME", "DB_USER", "DB_PASSWORD"];

  it("compose DB 변수는 필수 검사(${VAR:?})로 받는다", () => {
    const be = compose.services.backend.environment;
    const my = compose.services.mysql.environment;
    for (const k of dbVars) expect(be[k], k).toMatch(new RegExp(`^\\$\\{${k}:\\?`));
    expect(my.MYSQL_ROOT_PASSWORD).toMatch(/^\$\{MYSQL_ROOT_PASSWORD:\?/);
    expect(my.MYSQL_DATABASE).toMatch(/^\$\{DB_NAME:\?/);
    expect(my.MYSQL_USER).toMatch(/^\$\{DB_USER:\?/);
    expect(my.MYSQL_PASSWORD).toMatch(/^\$\{DB_PASSWORD:\?/);
    // 스모크도 같은 규칙(기본 비밀번호로 대신 접속하지 않는다)
    for (const k of dbVars) expect(smoke.services.backend.environment[k], k).toMatch(/^\$\{[A-Z_]+:\?/);
    expect(smoke.services.mysql.environment.MYSQL_ROOT_PASSWORD).toMatch(/^\$\{MYSQL_ROOT_PASSWORD:\?/);
  });

  it("배포 파일에 비밀번호 리터럴이 없다", () => {
    for (const f of DEPLOYED_FILES) {
      for (const line of stripComments(read(f)).split("\n")) {
        const m = line.match(/(PASSWORD|API_KEY|SECRET)[A-Z_]*["']?\s*[:=]\s*(.+)$/);
        if (!m) continue;
        const rhs = m[2].trim().replace(/^["']|["']$/g, "");
        // 허용: 변수 치환(${...}), 빈 값, 키 이름 참조(secretKeyRef의 key: 줄은 이 패턴이 아니다)
        expect(rhs === "" || rhs.startsWith("${") || rhs.startsWith("$"), `${f}: ${line.trim()}`).toBe(true);
      }
    }
  });

  it("K8s: secret.yaml에 값이 없고, 비밀 변수는 secretKeyRef로만 받는다", () => {
    expect(Object.keys(k8sSecret.data ?? {})).toEqual([]);
    expect(k8sSecret.stringData).toBeUndefined();
    for (const d of [k8sWeb, k8sAnalyzer, k8sBackend, k8sMysql]) {
      for (const c of containers(d)) {
        for (const e of c.env ?? []) {
          if (/PASSWORD|API_KEY|SECRET|^DB_(NAME|USER)$/.test(e.name)) {
            expect(e.value, `${c.name} ${e.name}`).toBeUndefined();
            expect(e.valueFrom.secretKeyRef.name, `${c.name} ${e.name}`).toBe("auctionboss-secret");
          }
        }
      }
    }
    const names = envNames(containers(k8sBackend)[0].env);
    for (const k of dbVars) expect(names).toContain(k);
  });

  it("secret 예시 주석에 키 이름(ANTHROPIC_API_KEY, DB_PASSWORD, MYSQL_ROOT_PASSWORD)", () => {
    const text = read("k8s/secret.yaml");
    for (const k of ["ANTHROPIC_API_KEY", "DB_PASSWORD", "MYSQL_ROOT_PASSWORD"]) expect(text).toContain(k);
  });
});

describe("스모크 격리(migrate-data-and-cutover D9)", () => {
  // 스모크가 운영 MySQL 볼륨을 지우는 사고를 막는다: 별도 파일·프로젝트 이름·볼륨·포트만 쓴다.
  const script = read("scripts/docker-smoke.sh");
  const lines = stripComments(script).split("\n");

  it("docker-smoke.sh는 -p auctionboss-smoke와 docker-compose.smoke.yml만 쓴다", () => {
    expect(script).toContain("-p auctionboss-smoke");
    expect(script).toContain("-f docker-compose.smoke.yml");
    const composeLines = lines.filter((l) => /docker[ -]compose/.test(l));
    expect(composeLines.length).toBeGreaterThan(0);
    for (const l of composeLines) {
      expect(l).toContain("-p auctionboss-smoke -f docker-compose.smoke.yml");
    }
    // 운영 파일을 가리키지 않는다
    expect(lines.join("\n")).not.toMatch(/docker-compose\.yml/);
    // `down -v`는 항상 격리된 DC 배열로
    for (const l of lines.filter((l) => /down\s+-v/.test(l))) expect(l).toContain('"${DC[@]}"');
  });

  it("스모크 구성은 독립 프로젝트 이름·볼륨·호스트 포트를 쓴다", () => {
    expect(smoke.name).toBe("auctionboss-smoke");
    const prodVolumes = Object.keys(compose.volumes);
    for (const v of Object.keys(smoke.volumes)) expect(prodVolumes).not.toContain(v);
    expect(envValue(smoke.services.backend.environment, "SPRING_PROFILES_ACTIVE")).toBe("local,seed");
    expect(smoke.services.mysql.ports).toBeUndefined();
    for (const p of smoke.services.backend.ports) {
      expect(String(p)).toMatch(/^127\.0\.0\.1:/);
      expect(String(p)).not.toMatch(/:8080:8080$/);
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


describe("리허설 구성: 실제 사이트 0요청·운영 자원 격리(migrate-data-and-cutover D13)", () => {
  // compose 덮어쓰기 태그(!override, !reset)는 병합 방식 지시라 값 검사에는 필요 없다. 태그만 떼고 읽는다.
  const loadTagged = (p: string): Any => yaml.load(read(p).replace(/\s!(override|reset)\b/g, ""));

  const rehearsal = loadTagged("scripts/dev/rehearsal.override.yml");
  const rollbackOverride = loadTagged("scripts/dev/rehearsal-rollback.override.yml");
  const rehearsalCollector = JSON.parse(read("scripts/dev/rehearsal-collector.json"));
  const productionCollector = JSON.parse(read("config/collector.json"));
  const script = read("scripts/dev/rehearse-cutover.sh");
  const env = rehearsal.services.backend.environment;

  const sourceUrl = new URL(String(envValue(env, "AUCTIONBOSS_SOURCE_BASE_URL")));

  it("backend는 외부 요청 허용이 거짓이고 소스 주소가 루프백이다(사이드카 가짜 서버)", () => {
    expect(envValue(env, "AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED")).toBe("false");
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(sourceUrl.hostname);
    // 이 덮어쓰기가 세 설정 중 허용 쪽을 켜는 일은 없다(수집·사진 켬은 운영 파일의 값을 그대로 쓴다)
    for (const key of Object.keys(env)) {
      if (key === "AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED") continue;
      if (/ENABLED|ALLOWED/.test(key)) expect(String(env[key]), key).not.toMatch(/^true$/i);
    }
    // 첫 틱은 사이드카가 뜬 뒤(주기 후)에 돈다
    expect(envValue(env, "AUCTIONBOSS_COLLECTOR_RUN_IMMEDIATELY")).toBe("false");
    expect(envValue(env, "AUCTIONBOSS_PHOTOS_RUN_IMMEDIATELY")).toBe("false");
  });

  it("가짜 서버 사이드카는 backend와 같은 네트워크 네임스페이스에서 소스 주소의 포트를 받고 npx를 쓰지 않는다", () => {
    const fake = rehearsal.services["source-fake"];
    expect(fake.network_mode).toBe("service:backend");
    const cmd: string[] = fake.command.map(String);
    expect(cmd[cmd.indexOf("--port") + 1]).toBe(sourceUrl.port);
    // npx는 npm 레지스트리에 접속할 수 있다(외부 연결). 설치된 tsx를 직접 부른다.
    expect(cmd.join(" ")).not.toMatch(/\bnpx\b/);
    expect(cmd.join(" ")).toContain("fake-source-server.ts");
  });

  it("호스트 포트는 루프백에만 열고 운영 구성의 8080·3000·3307과 겹치지 않는다", () => {
    for (const name of ["mysql", "backend", "web"]) {
      const ports: string[] = rehearsal.services[name].ports.map(String);
      expect(ports.length, name).toBeGreaterThan(0);
      for (const p of ports) {
        expect(p, name).toMatch(/^127\.0\.0\.1:/);
        expect(p, name).not.toMatch(/:(8080|3000|3307)(\}|:)/);
        expect(p, name).not.toMatch(/^127\.0\.0\.1:(8080|3000|3307):/);
      }
    }
    for (const p of rollbackOverride.services.web.ports.map(String)) {
      expect(p).toMatch(/^127\.0\.0\.1:/);
      expect(p).not.toMatch(/^127\.0\.0\.1:(3000|8080|3307):/);
    }
  });

  it("분석 워커는 가짜 CLI와 빈 API 키를 쓴다(실제 Claude 호출 0)", () => {
    const e = rehearsal.services.analyzer.environment;
    expect(envValue(e, "ANTHROPIC_API_KEY")).toBe("");
    expect(String(envValue(e, "AUCTIONBOSS_CLAUDE_BIN"))).toMatch(/scripts\/dev\/fake-claude$/);
    const e2 = rollbackOverride.services.analyzer.environment;
    expect(envValue(e2, "ANTHROPIC_API_KEY")).toBe("");
    expect(String(envValue(e2, "AUCTIONBOSS_CLAUDE_BIN"))).toMatch(/scripts\/dev\/fake-claude$/);
  });

  it("롤백 리허설의 옛 TS 수집기·사진 워커는 네트워크가 끊겨 있다(소스 주소를 바꿀 수 없어 실제 사이트로 향하기 때문)", () => {
    expect(rollbackOverride.services.collector.network_mode).toBe("none");
    expect(rollbackOverride.services.photos.network_mode).toBe("none");
  });

  it("리허설 수집 설정은 운영과 같은 법원·예산에 주기만 1분이다", () => {
    expect(rehearsalCollector.scope).toEqual(productionCollector.scope);
    expect(rehearsalCollector.intervalMs).toBe(60000);
    expect(rehearsalCollector.photos.intervalMs).toBe(60000);
    expect(rehearsalCollector.photos.retryAfterHours).toBe(productionCollector.photos.retryAfterHours);
  });

  it("리허설 스크립트의 compose 호출은 별도 프로젝트 이름만 쓰고 운영 프로젝트(auctionboss)를 가리키지 않는다", () => {
    const lines = stripComments(script).split("\n");
    const composeLines = lines.filter((l) => /docker compose/.test(l) && !/^\s*echo\b/.test(l));
    expect(composeLines.length).toBeGreaterThan(0);
    for (const l of composeLines) {
      expect(l, l).toMatch(/-p "?\$(PROJECT|\{PROJECT\})(-old)?"?\s/);
      expect(l, l).not.toMatch(/-p auctionboss(\s|$)/);
    }
    expect(script).toMatch(/^PROJECT=auctionboss-rehearsal$/m);
    // 운영 볼륨 이름을 직접 다루지 않는다(copy·삭제 대상은 리허설 옛 볼륨뿐)
    expect(stripComments(script)).not.toMatch(/auctionboss_auctionboss-data|auctionboss_mysql-data|auctionboss-mysql-dev/);
    // 원본을 쓰기로 열지 않는다: 원본 경로는 내보내기와 해시 계산, 복사의 원본으로만 나온다
    for (const l of stripComments(script).split("\n").filter((l) => /\$SRC_DB|data\/auctionboss\.db/.test(l))) {
      expect(l, l).toMatch(/^SRC_DB=|shasum|--source|cp -p |readonly:true/);
    }
  });
  it("clean은 data/migration 전체가 아니라 리허설이 만든 내보내기 디렉터리만 지운다(실제 전환 백업 보호)", () => {
    const code = stripComments(script);
    expect(code).not.toMatch(/rm -rf[^\n]*data\/migration\/\*/);
    expect(code).toMatch(/exports\.list/);
    // down -v는 리허설 프로젝트(dc 또는 -p $PROJECT[-old])에만 건다
    for (const l of code.split("\n").filter((l) => /\bdown\b.*-v|volume rm/.test(l))) {
      expect(l, l).toMatch(/^\s*dc down|-p "\$PROJECT-old"/);
    }
  });

  it("운영 런북 7은 analyzer를 분리해 올리는 선택지를 적는다(전환 즉시 실제 Claude 호출 방지)", () => {
    const ref = read("docs/REFERENCE.md");
    const sec = ref.slice(ref.indexOf("## 9. 운영 전환 런북"), ref.indexOf("## 10. 롤백 런북"));
    expect(sec).toMatch(/analyzer[\s\S]*실제 Claude/);
    expect(sec).toContain("docker compose up -d --remove-orphans backend web`");
    expect(sec).toContain("docker compose up -d analyzer");
  });
});
