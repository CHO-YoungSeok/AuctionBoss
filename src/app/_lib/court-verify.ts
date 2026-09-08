/**
 * 원본 확인 블록(design.md D2)이 쓰는 값을 만드는 순수 함수.
 *
 * **딥링크를 절대 만들지 않는다**는 게 이 함수가 지키는 계약이다(tasks.md 4.2) — 물건별
 * GET URL이 존재하지 않는다는 조사 결과(design.md Context: 상세 화면 XML에
 * `location.search`/`location.hash`/`URLSearchParams`가 0건) 때문에, `homeUrl`은 물건이
 * 무엇이든 항상 같은 고정 문자열이어야 한다. 법원명·사건번호는 홈 URL과 분리해
 * `<input readonly>`로만 노출한다 — 클릭 한 번으로 전체 선택이 되어 클립보드 API 없이도
 * 복사에 가장 가까운 방법이다(프로젝트의 "클라이언트 JS 없음" 규칙을 지킨다).
 *
 * 이 값을 인라인 JSX 리터럴 대신 순수 함수로 뽑은 이유: 이 프로젝트는 인라인 판정이
 * 테스트 불가능해서 잘못된 빈 상태 안내가 배포된 전례가 있다(design.md Context, CLAUDE.md
 * 관례). 딥링크 금지처럼 "절대 이래서는 안 된다"는 불변식일수록 테스트로 고정해 둬야,
 * 나중에 실수로 `?w2xPath=...&csNo=...`가 섞여 들어가도 테스트가 잡는다.
 */
import type { AuctionItem } from "@/lib/domain";

export const COURT_AUCTION_HOME_URL = "https://www.courtauction.go.kr/pgj/index.on";

export interface CourtVerifyLink {
  /** 항상 `COURT_AUCTION_HOME_URL`과 같다 — 물건과 무관한 고정값(딥링크 없음의 증거). */
  homeUrl: string;
  court: string;
  caseNo: string;
}

export type CourtVerifyFields = Pick<AuctionItem, "court" | "caseNo">;

/**
 * 원본 확인 블록에 필요한 값을 만든다. `homeUrl`은 어떤 물건을 넣어도 절대 바뀌지 않는다
 * — 물건 식별자를 URL에 실으면 안 되기 때문이다(design.md D2).
 */
export function buildCourtVerifyLink({ court, caseNo }: CourtVerifyFields): CourtVerifyLink {
  return { homeUrl: COURT_AUCTION_HOME_URL, court, caseNo };
}
