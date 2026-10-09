import { NextResponse } from "next/server";
import { getDataPort } from "@/lib/data-port";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    await getDataPort().health();
    return NextResponse.json(
      {
        status: "ok",
        database: "connected",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        database: "disconnected",
        error: String(error),
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
