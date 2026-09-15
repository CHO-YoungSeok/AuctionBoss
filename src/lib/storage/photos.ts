import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveDbPath } from "../db/client";

export function getPhotosDir(): string {
  // DB 디렉토리와 같은 위치에 photos 디렉토리를 둔다
  const dbDir = path.dirname(resolveDbPath());
  return path.join(dbDir, "photos");
}

function determinePhotoType(buffer: Buffer): { ext: string; mimeType: string } {
  // Magic bytes
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: ".jpg", mimeType: "image/jpeg" };
  }
  // PNG: 89 50 4E 47
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: ".png", mimeType: "image/png" };
  }
  // GIF: GIF87a or GIF89a
  if (buffer.length >= 6 && buffer.toString("utf8", 0, 3) === "GIF" && (buffer.toString("utf8", 3, 6) === "87a" || buffer.toString("utf8", 3, 6) === "89a")) {
    return { ext: ".gif", mimeType: "image/gif" };
  }
  
  // Default fallback if unknown (though we expect JPEG/PNG/GIF)
  return { ext: ".bin", mimeType: "application/octet-stream" };
}

const MAX_BASE64_SIZE = 10 * 1024 * 1024; // 10MB

export function saveBase64Photo(itemId: number, seq: number, base64: string): { filePath: string; fileSize: number; mimeType: string } {
  if (base64.length > MAX_BASE64_SIZE) {
    throw new Error("사진 파일 크기가 10MB를 초과했습니다.");
  }

  const buffer = Buffer.from(base64, "base64");
  const { ext, mimeType } = determinePhotoType(buffer);
  
  const itemDir = path.join(getPhotosDir(), String(itemId));
  mkdirSync(itemDir, { recursive: true });
  
  const relativePath = path.join(String(itemId), `${seq}${ext}`);
  const absolutePath = path.join(getPhotosDir(), relativePath);
  
  writeFileSync(absolutePath, buffer);
  
  return {
    filePath: relativePath,
    fileSize: buffer.length,
    mimeType
  };
}

export function readPhotoFile(filePath: string): Buffer | null {
  try {
    const photosDir = path.resolve(getPhotosDir());
    const resolvedPath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(photosDir, filePath);

    if (!resolvedPath.startsWith(photosDir)) {
      return null;
    }

    return readFileSync(resolvedPath);
  } catch (error) {
    return null;
  }
}
