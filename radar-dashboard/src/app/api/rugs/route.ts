import { NextResponse } from "next/server";
import { screenLatest } from "@/lib/rug";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const rugs = await screenLatest(12);
    return NextResponse.json(
      { rugs, count: rugs.length, fetchedAt: Date.now() },
      {
        headers: {
          "Cache-Control": "public, max-age=30",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to screen tokens" },
      { status: 500 }
    );
  }
}
