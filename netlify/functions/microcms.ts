import { Handler } from "@netlify/functions";

export const handler: Handler = async (event) => {
  // Netlify環境ではVITE_MICROCMS_API_KEYが環境変数として利用可能
  const apiKey = process.env.VITE_MICROCMS_API_KEY;
  
  if (!apiKey) {
    console.error("VITE_MICROCMS_API_KEY environment variable not found");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "VITE_MICROCMS_API_KEY is not configured" }),
    };
  }

  // クエリパラメータを取得
  const query = event.rawQuery || "";
  const url = `https://liangworks.microcms.io/api/v1/taiwanphoto${query ? "?" + query : ""}`;

  try {
    console.log(`Proxying request to MicroCMS: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        "X-MICROCMS-API-KEY": apiKey,
      },
    });

    const data = await response.text();

    if (!response.ok) {
      console.error(`MicroCMS API returned ${response.status}: ${data}`);
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
    console.error("MicroCMS proxy error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch from MicroCMS", details: String(error) }),
    };
  }
};
