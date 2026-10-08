/**
 * 오류 클래스는 `@/lib/domain/errors`로 옮겼다(switch-web-to-data-port 1.4). 화면 코드가
 * `@/lib/db`를 가져오지 못하게 막는 린트(D8)와 충돌하지 않도록 도메인 계층에 둔다.
 * 기존 `@/lib/db` import 경로는 이 재수출로 그대로 동작한다.
 */
export { ItemNotFoundError, WorkerRunNotFoundError } from "../domain/errors";
