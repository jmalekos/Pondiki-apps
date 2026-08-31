import { NextRequest, NextResponse } from "next/server";
import { getPortfolio } from "@/lib/solana";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  try {
    const data = await getPortfolio(force);
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=30",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to load portfolio" },
      { status: 500 }
    );
  }
}
