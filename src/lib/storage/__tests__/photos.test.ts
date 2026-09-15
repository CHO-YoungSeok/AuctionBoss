import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveBase64Photo, readPhotoFile, getPhotosDir } from "../photos";

describe("photo storage", () => {
  let tempDir: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "auction-photos-test-"));
    originalDbPath = process.env.AUCTION_DB_PATH;
    process.env.AUCTION_DB_PATH = path.join(tempDir, "test.db");
  });

  afterEach(() => {
    if (originalDbPath !== undefined) {
      process.env.AUCTION_DB_PATH = originalDbPath;
    } else {
      delete process.env.AUCTION_DB_PATH;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("saveBase64Photo", () => {
    it("정상적인 base64 이미지를 디스크에 저장하고 파일 경로와 메타데이터를 반환한다", () => {
      // JPEG 매직 바이트: FF D8 FF
      const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]);
      const base64 = jpegHeader.toString("base64");

      const saved = saveBase64Photo(100, 1, base64);

      expect(saved.filePath).toBe(path.join("100", "1.jpg"));
      expect(saved.fileSize).toBe(jpegHeader.length);
      expect(saved.mimeType).toBe("image/jpeg");

      const readBuffer = readPhotoFile(saved.filePath);
      expect(readBuffer).not.toBeNull();
      expect(readBuffer?.equals(jpegHeader)).toBe(true);
    });

    it("10MB를 초과하는 base64 문자열은 에러를 발생시킨다", () => {
      const tenMb = 10 * 1024 * 1024;
      // 10MB + 1 바이트의 더미 문자열
      const oversizedBase64 = "A".repeat(tenMb + 1);

      expect(() => {
        saveBase64Photo(100, 1, oversizedBase64);
      }).toThrow("사진 파일 크기가 10MB를 초과했습니다.");
    });
  });

  describe("readPhotoFile", () => {
    it("Path Traversal 시도(상위 디렉터리 접근) 시 null을 반환한다", () => {
      // tempDir 상위에 파일 생성
      const secretFile = path.join(tempDir, "secret.txt");
      writeFileSync(secretFile, "secret-data");

      // photosDir 내부에서 ../../ 로 secretFile에 접근 시도
      const traversalRelative = path.join("..", "secret.txt");
      expect(readPhotoFile(traversalRelative)).toBeNull();

      // 절대 경로로 photosDir 외부 접근 시도
      expect(readPhotoFile(secretFile)).toBeNull();
      expect(readPhotoFile("/etc/passwd")).toBeNull();
    });

    it("존재하지 않는 파일 경로일 경우 null을 반환한다", () => {
      expect(readPhotoFile("non-existent/file.jpg")).toBeNull();
    });
  });
});
