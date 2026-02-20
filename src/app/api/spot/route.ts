import { NextResponse } from "next/server";

const OUNCE_TO_GRAM = 31.1034768;

type YahooChartMeta = {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  currency?: string;
};

type YahooChartQuote = {
  close?: Array<number | null>;
};

type YahooChartResult = {
  meta?: YahooChartMeta;
  timestamp?: number[];
  indicators?: {
    quote?: YahooChartQuote[];
  };
};

type YahooChartResponse = {
  chart?: {
    result?: YahooChartResult[];
  };
};

function getLastValidNumber(values: Array<number | null> | undefined): number | null {
  if (!values || values.length === 0) {
    return null;
  }

  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

async function fetchChart(symbol: string, range: string, interval: string): Promise<YahooChartResult> {
  const query = new URLSearchParams({ range, interval }).toString();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo request failed for ${symbol} (${response.status})`);
  }

  const data = (await response.json()) as YahooChartResponse;
  const result = data.chart?.result?.[0];

  if (!result) {
    throw new Error(`Yahoo returned empty chart result for ${symbol}`);
  }

  return result;
}

export async function GET() {
  try {
    const [goldChart, fxChart] = await Promise.all([
      fetchChart("GC=F", "1d", "1m"),
      fetchChart("KRW=X", "1d", "1m"),
    ]);

    const goldClose = getLastValidNumber(goldChart.indicators?.quote?.[0]?.close);
    const fxClose = getLastValidNumber(fxChart.indicators?.quote?.[0]?.close);

    const goldPriceUsdPerOunce = goldChart.meta?.regularMarketPrice ?? goldClose;
    const usdKrw = fxChart.meta?.regularMarketPrice ?? fxClose;
    const previousGold = goldChart.meta?.chartPreviousClose ?? goldClose;

    if (
      typeof goldPriceUsdPerOunce !== "number" ||
      !Number.isFinite(goldPriceUsdPerOunce) ||
      typeof usdKrw !== "number" ||
      !Number.isFinite(usdKrw) ||
      typeof previousGold !== "number" ||
      !Number.isFinite(previousGold)
    ) {
      throw new Error("Invalid market values received");
    }

    const domesticKrwPerGram = (goldPriceUsdPerOunce * usdKrw) / OUNCE_TO_GRAM;
    const previousDomesticKrwPerGram = (previousGold * usdKrw) / OUNCE_TO_GRAM;
    const changePercent =
      previousDomesticKrwPerGram !== 0
        ? ((domesticKrwPerGram - previousDomesticKrwPerGram) / previousDomesticKrwPerGram) * 100
        : 0;

    const goldTimestamp = goldChart.timestamp?.at(-1) ?? Math.floor(Date.now() / 1000);
    const fxTimestamp = fxChart.timestamp?.at(-1) ?? Math.floor(Date.now() / 1000);
    const updatedAt = new Date(Math.max(goldTimestamp, fxTimestamp) * 1000).toISOString();

    return NextResponse.json(
      {
        domesticKrwPerGram,
        goldPriceUsdPerOunce,
        usdKrw,
        previousDomesticKrwPerGram,
        changePercent,
        updatedAt,
        source: "Yahoo Finance (GC=F, KRW=X)",
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
