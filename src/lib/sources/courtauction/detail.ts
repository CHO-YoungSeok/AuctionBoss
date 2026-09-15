import { z } from "zod";

export interface RawPhotoItem {
  seq: number;
  base64: string;
}

/**
 * 물건상세 사진 갤러리 응답 데이터 스키마 (소스 내부용)
 */
const detailPicItemSchema = z.object({
  maemulSer: z.number().nullable().optional(),
  picGubunCd: z.string().nullable().optional(),
  fileSer: z.number().nullable().optional(),
  /** Base64 인코딩된 사진 데이터 */
  picFile: z.string().nullable().optional(),
});

const detailResponseSchema = z.object({
  picList: z.array(detailPicItemSchema).optional(),
});

/**
 * 상세 페이지에 포함된 사진 갤러리 탭을 호출한다.
 */
export async function fetchItemDetailPhotos(
  cortOfcCd: string,
  csNo: string,
  dspslGdsSeq?: string,
  fetchFn?: typeof fetch,
): Promise<RawPhotoItem[]> {
  const fetchImpl = fetchFn ?? globalThis.fetch;
  const formData = new URLSearchParams();
  formData.append("csNo", csNo);
  formData.append("cortOfcCd", cortOfcCd);
  if (dspslGdsSeq) {
    formData.append("dspslGdsSeq", dspslGdsSeq);
  } else {
    // dspslGdsSeq가 없으면 1로 시도
    formData.append("dspslGdsSeq", "1");
  }

  const url = "https://www.courtauction.go.kr/RetrieveAuctnCsDetailInfo.ajax";
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    throw new Error(`상세 사진 조회 HTTP 오류: ${response.status}`);
  }

  const text = await response.text();
  
  // JSON 응답이 아닐 수 있음(보안 솔루션 등). JSON 파싱 시도.
  try {
    const json = JSON.parse(text);
    const parsed = detailResponseSchema.parse(json);
    const list = parsed.picList ?? [];
    const results: RawPhotoItem[] = [];
    for (const item of list) {
      if (item.fileSer != null && item.picFile) {
        results.push({
          seq: item.fileSer,
          base64: item.picFile,
        });
      }
    }
    return results;
  } catch (error) {
    // 응답이 올바른 JSON이 아닌 경우 예외 처리
    throw new Error("사진 상세 조회 JSON 파싱 실패");
  }
}
