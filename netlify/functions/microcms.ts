import { Handler } from "@netlify/functions";

// TypeScriptがNode.jsの型（@types/node）を認識していない場合のエラー（Cannot find name 'process'）を回避する宣言
declare const process: {
  env: {
    [key: string]: string | undefined;
  };
};

export const handler: Handler = async (event) => {
  const apiKey = process.env.VITE_MICROCMS_API_KEY;
  
  if (!apiKey) {
    console.error("VITE_MICROCMS_API_KEY environment variable not found");
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: "VITE_MICROCMS_API_KEY is not configured",
        message: "API key not found in environment variables"
      }),
    };
  }

  // --- CORS セキュリティ管理 ---
  // 第三者によるAPIキー悪用や不必要コールを防ぐため、オリジンを自サイトと開発用環境のみに制限
  const origin = event.headers.origin || event.headers.referer || "";
  const siteUrl = process.env.URL || ""; // NetlifyサイトURL
  
  let allowedOrigin = "";
  if (origin) {
    const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
    const isOwnDomain = siteUrl && origin.startsWith(siteUrl);
    // ローカル開発、自サイト、またはsiteUrl未定義環境（開発中など）でのみ許可
    if (isLocal || isOwnDomain || !siteUrl) {
      allowedOrigin = origin;
    }
  }

  // もしオリジン許可がなければ安全のため拒否
  if (!allowedOrigin && siteUrl) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: "Access Denied: Cross-Origin Request Blocked" }),
    };
  }

  const query = event.rawQuery || "";
  const url = `https://liangworks.microcms.io/api/v1/taiwanphoto${query ? "?" + query : ""}`;

  // タイムアウトを 5 秒に制御（Netlify Functions のサーバーレス処理時間が過大に消費されるのを防ぐ）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    console.log(`[MicroCMS Proxy] Fetching URL: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        "X-MICROCMS-API-KEY": apiKey,
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

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
        "Access-Control-Allow-Origin": allowedOrigin || "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-MICROCMS-API-KEY",
      },
      body: data,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("[MicroCMS Proxy] Error occurred:", error);
    
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      statusCode: isTimeout ? 504 : 500,
      body: JSON.stringify({ 
        error: isTimeout ? "Gateway Timeout" : "Failed to fetch from MicroCMS",
        details: error instanceof Error ? error.message : String(error)
      }),
    };
  }
};