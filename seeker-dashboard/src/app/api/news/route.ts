import { NextRequest, NextResponse } from "next/server";
import { getNews } from "@/lib/news";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  try {
    const data = await getNews(force);
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "news fetch failed" },
      { status: 500 }
    );
  }
}
