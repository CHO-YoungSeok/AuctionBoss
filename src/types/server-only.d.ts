// `server-only`는 Next가 번들러 별칭으로 처리한다(next/dist/build/create-compiler-aliases.js).
// 패키지를 따로 설치하지 않으므로 타입 선언만 둔다. vitest·tsx는 별칭으로 빈 모듈에 연결한다.
declare module "server-only";
