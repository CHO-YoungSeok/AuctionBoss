/**
 * 목록 화면이 데이터 포트의 `listItems`에 넘기는 조건 만들기(switch-web-to-data-port 4장 결정).
 *
 * URL의 `needsAnalysis`·`promptVersion`은 파서가 읽지만 분석 워커 전용 조건이다. Spring API의 URL
 * 직렬화는 이 필드(와 서버 설정에서만 오는 `reanalysisCooldownHours`)를 표현하지 못해 던지므로,
 * 화면은 포트에 넘기기 전에 제거한다. 그러면 두 원천(SQLite·Spring)이 같은 조건으로 같은 목록을
 * 돌려준다. 화면의 링크·칩은 원래 조건에서 만들며 `itemListHref`가 같은 필드를 따로 버린다.
 */
import type { ItemQuery } from "@/lib/domain";

export function toScreenItemQuery(query: ItemQuery): ItemQuery {
  const screenQuery: ItemQuery = { ...query };
  delete screenQuery.needsAnalysis;
  delete screenQuery.promptVersion;
  delete screenQuery.reanalysisCooldownHours;
  return screenQuery;
}
