import { Handler } from "@netlify/functions";

export const handler: Handler = async (event) => {
  // 本番環境: Netlifyの環境変数そのまま使用
  // 開発環境: .env.localから自動的に読み込まれる
  const apiKey = process.env.VITE_MICROCMS_API_KEY;
  
  if (!apiKey) {
    console.error("VITE_MICROCMS_API_KEY environment variable not found");
    console.error("Please set VITE_MICROCMS_API_KEY in:");
    console.error("  - Local: .env.local file");
    console.error("  - Production: Netlify Environment Variables");
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: "VITE_MICROCMS_API_KEY is not configured",
        message: "API key not found in environment variables"
      }),
    };
  }

  // クエリパラメータを取得
  const query = event.rawQuery || "";
  const url = `https://liangworks.microcms.io/api/v1/taiwanphoto${query ? "?" + query : ""}`;

  try {
    console.log(`[MicroCMS Proxy] Fetching: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        "X-MICROCMS-API-KEY": apiKey,
      },
    });

    const data = await response.text();

    if (!response.ok) {
      console.error(`[MicroCMS Proxy] API Error ${response.status}: ${data}`);
    } else {
      console.log(`[MicroCMS Proxy] Success ${response.status}`);
    }

    return {
      statusCode: response.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: data,
    };
  } catch (error) {
    console.error("[MicroCMS Proxy] Network error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: "Failed to fetch from MicroCMS",
        details: error instanceof Error ? error.message : String(error)
      }),
    };
  }
};
