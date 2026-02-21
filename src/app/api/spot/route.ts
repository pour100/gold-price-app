import { NextResponse } from "next/server";

const GOLDKIMP_SIDEBAR_URL = "https://goldkimp.com/wp-json/gk/v1/sidebar";

type YahooChartMeta = {
  regularMarketPrice?: number;
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

type GoldKimpSidebarResponse = {
  meta?: {
    updated_at_kst?: string;
  };
  metal?: {
    krx_gold?: {
      price?: number;
      delta?: number;
      change_pct?: number;
    };
  };
};

type DomesticGoldSnapshot = {
  domesticKrwPerGram: number;
  changePercent: number;
  previousDomesticKrwPerGram: number;
  updatedAt: string | null;
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

function toIsoFromKst(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }

  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+09:00`;
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

async function fetchDomesticGoldSnapshot(): Promise<DomesticGoldSnapshot> {
  const response = await fetch(GOLDKIMP_SIDEBAR_URL, {
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json, text/plain, */*",
    },
  });

  if (!response.ok) {
    throw new Error(`Gold reference request failed (${response.status})`);
  }

  const data = (await response.json()) as GoldKimpSidebarResponse;
  const rawPrice = data.metal?.krx_gold?.price;
  const rawDelta = data.metal?.krx_gold?.delta ?? 0;
  const rawChangePercent = data.metal?.krx_gold?.change_pct ?? 0;

  if (typeof rawPrice !== "number" || !Number.isFinite(rawPrice)) {
    throw new Error("Failed to parse 금 99.99_1kg 금현물 reference price");
  }

  // Some feeds can carry kg-based price; convert to 1g when required.
  const needsKgToGram = rawPrice > 1_000_000;
  const domesticKrwPerGram = needsKgToGram ? rawPrice / 1000 : rawPrice;
  const deltaPerGram = needsKgToGram ? rawDelta / 1000 : rawDelta;
  const changePercent = Number.isFinite(rawChangePercent) ? rawChangePercent : 0;

  let previousDomesticKrwPerGram = domesticKrwPerGram - deltaPerGram;
  if (!(previousDomesticKrwPerGram > 0)) {
    previousDomesticKrwPerGram =
      changePercent === -100 ? domesticKrwPerGram : domesticKrwPerGram / (1 + changePercent / 100);
  }

  return {
    domesticKrwPerGram,
    changePercent,
    previousDomesticKrwPerGram,
    updatedAt: toIsoFromKst(data.meta?.updated_at_kst),
  };
}

export async function GET() {
  try {
    const [domesticGold, goldChart, fxChart] = await Promise.all([
      fetchDomesticGoldSnapshot(),
      fetchChart("GC=F", "1d", "1m"),
      fetchChart("KRW=X", "1d", "1m"),
    ]);

    const goldClose = getLastValidNumber(goldChart.indicators?.quote?.[0]?.close);
    const fxClose = getLastValidNumber(fxChart.indicators?.quote?.[0]?.close);

    const goldPriceUsdPerOunce = goldChart.meta?.regularMarketPrice ?? goldClose;
    const usdKrw = fxChart.meta?.regularMarketPrice ?? fxClose;

    if (
      typeof goldPriceUsdPerOunce !== "number" ||
      !Number.isFinite(goldPriceUsdPerOunce) ||
      typeof usdKrw !== "number" ||
      !Number.isFinite(usdKrw)
    ) {
      throw new Error("Invalid market values received");
    }

    const goldTimestamp = goldChart.timestamp?.at(-1) ?? Math.floor(Date.now() / 1000);
    const fxTimestamp = fxChart.timestamp?.at(-1) ?? Math.floor(Date.now() / 1000);
    const yahooUpdatedAt = new Date(Math.max(goldTimestamp, fxTimestamp) * 1000).toISOString();
    const updatedAt = domesticGold.updatedAt ?? yahooUpdatedAt;

    return NextResponse.json(
      {
        domesticKrwPerGram: domesticGold.domesticKrwPerGram,
        goldPriceUsdPerOunce,
        usdKrw,
        previousDomesticKrwPerGram: domesticGold.previousDomesticKrwPerGram,
        changePercent: domesticGold.changePercent,
        updatedAt,
        source: "Domestic: 금 99.99_1kg 금현물 (KRX, 1g 환산). Global: Yahoo Finance (GC=F, KRW=X).",
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
