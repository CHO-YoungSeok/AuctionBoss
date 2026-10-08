/**
 * 차단 백오프 기본값. 차단은 IP 단위라 수집 워커와 사진 워커가 같은 값을 쓴다
 * (fix-photo-worker-and-deploy-config design.md D2).
 */

/** 차단 감지 시 기본 백오프. NOTES §6.1이 "최소 1시간 권장"이라 적었다. */
export const DEFAULT_BLOCK_BACKOFF_MS = 60 * 60 * 1000;
