export function buildSearchQuery(address: string | null | undefined, lotNumber?: string | null): string | null {
  if (!address && !lotNumber) return null;
  
  let base = address || lotNumber || "";
  
  // 1. 괄호 안의 내용 제거 (예: "(역삼동, 삼성아파트)")
  base = base.replace(/\([^)]*\)/g, " ");
  
  // 2. 쉼표 이후의 내용 제거 (예: "서울특별시 강남구 테헤란로 123, 4층 401호" -> "서울특별시 강남구 테헤란로 123")
  base = base.split(",")[0];

  // 3. '외 1필지', '외2필지' 등 제거
  base = base.replace(/외\s*\d+필지/g, " ");
  
  base = base.replace(/\s+/g, " ").trim();
  
  return base || null;
}

export function buildKakaoMapUrl(address: string | null | undefined, lotNumber?: string | null): string | null {
  const query = buildSearchQuery(address, lotNumber);
  if (!query) return null;
  return `https://map.kakao.com/link/search/${encodeURIComponent(query)}`;
}

export function buildNaverMapUrl(address: string | null | undefined, lotNumber?: string | null): string | null {
  const query = buildSearchQuery(address, lotNumber);
  if (!query) return null;
  return `https://map.naver.com/p/search/${encodeURIComponent(query)}`;
}
