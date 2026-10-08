import { NextRequest, NextResponse } from "next/server";

import { getDataPort } from "@/lib/data-port";

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

  const photo = await getDataPort().getPhotoFile(itemIdNum, seqNum);
  if (photo.status !== 200) {
    return new NextResponse(photo.message, { status: photo.status });
  }

  return new NextResponse(photo.body as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": photo.contentType,
      "Cache-Control": photo.cacheControl,
    },
  });
}
