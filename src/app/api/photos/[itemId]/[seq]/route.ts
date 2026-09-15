import { NextRequest, NextResponse } from "next/server";
import { getItemPhotos } from "@/lib/db/repository";
import { readPhotoFile } from "@/lib/storage/photos";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string; seq: string }> }
) {
  const { itemId, seq } = await params;
  
  const itemIdNum = parseInt(itemId, 10);
  const seqNum = parseInt(seq, 10);
  
  if (isNaN(itemIdNum) || isNaN(seqNum)) {
    return new NextResponse("Invalid ID", { status: 400 });
  }

  const photos = getItemPhotos(itemIdNum);
  const photo = photos.find(p => p.seq === seqNum);
  
  if (!photo) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const buffer = readPhotoFile(photo.filePath);
  
  if (!buffer) {
    return new NextResponse("File Not Found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": photo.mimeType,
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}
