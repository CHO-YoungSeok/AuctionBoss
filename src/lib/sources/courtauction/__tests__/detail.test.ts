import { describe, it, expect, vi } from "vitest";
import { fetchItemDetailPhotos, type RawPhotoItem } from "../detail";

describe("fetchItemDetailPhotos (courtauction source adapter)", () => {
  it("매핑 시 소스 고유 형식을 누출하지 않고 RawPhotoItem({ seq, base64 }) 형태로 반환한다", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          picList: [
            {
              maemulSer: 100,
              picGubunCd: "01",
              fileSer: 1,
              picFile: "base64-content-1",
            },
            {
              maemulSer: 100,
              picGubunCd: "01",
              fileSer: 2,
              picFile: "base64-content-2",
            },
          ],
        }),
    } as unknown as Response);

    const photos = await fetchItemDetailPhotos("B000001", "20250130001234", "1", mockFetch);

    expect(photos).toHaveLength(2);
    expect(photos[0]).toEqual({
      seq: 1,
      base64: "base64-content-1",
    });
    expect(photos[1]).toEqual({
      seq: 2,
      base64: "base64-content-2",
    });

    // 소스 고유 속성이 누출되지 않는지 확인
    expect(photos[0]).not.toHaveProperty("fileSer");
    expect(photos[0]).not.toHaveProperty("picFile");
    expect(photos[0]).not.toHaveProperty("maemulSer");
    expect(photos[0]).not.toHaveProperty("picGubunCd");
  });

  it("fileSer 또는 picFile이 유효하지 않은 항목은 필터링한다", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          picList: [
            { fileSer: null, picFile: "valid-base64" },
            { fileSer: 1, picFile: null },
            { fileSer: 2, picFile: "" },
            { fileSer: 3, picFile: "valid-base64-3" },
          ],
        }),
    } as unknown as Response);

    const photos = await fetchItemDetailPhotos("B000001", "20250130001234", undefined, mockFetch);

    expect(photos).toHaveLength(1);
    expect(photos[0]).toEqual({
      seq: 3,
      base64: "valid-base64-3",
    });
  });

  it("HTTP 응답이 ok가 아니면 에러를 던진다", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as unknown as Response);

    await expect(fetchItemDetailPhotos("B000001", "20250130001234", "1", mockFetch)).rejects.toThrow(
      "상세 사진 조회 HTTP 오류: 500"
    );
  });

  it("JSON 파싱에 실패하면 에러를 던진다", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<html>Security check</html>",
    } as unknown as Response);

    await expect(fetchItemDetailPhotos("B000001", "20250130001234", "1", mockFetch)).rejects.toThrow(
      "사진 상세 조회 JSON 파싱 실패"
    );
  });
});
