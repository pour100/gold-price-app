import { NextResponse } from "next/server";

const GOLDKIMP_GOLD_URL = "https://goldkimp.com/wp-json/gk/gold/v1";

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

type GoldKimpGoldResponse = {
  updated?: string;
  header?: string[];
  rows?: Array<Array<string | number>>;
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

  const isoMatch = value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  if (isoMatch) {
    return value;
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
  const response = await fetch(GOLDKIMP_GOLD_URL, {
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json, text/plain, */*",
    },
  });

  if (!response.ok) {
    throw new Error(`Gold reference request failed (${response.status})`);
  }

  const data = (await response.json()) as GoldKimpGoldResponse;
  const headers = data.header ?? [];
  const rows = data.rows ?? [];
  const krxIndex = headers.indexOf("krxkrw");

  if (krxIndex < 0 || rows.length === 0) {
    throw new Error("Failed to parse 금 99.99_1kg 금현물 reference price");
  }

  const latestRow = rows[rows.length - 1];
  const previousRow = rows.length > 1 ? rows[rows.length - 2] : rows[rows.length - 1];

  const rawPrice = Number(latestRow?.[krxIndex]);
  const rawPrevious = Number(previousRow?.[krxIndex]);
  if (!Number.isFinite(rawPrice) || !Number.isFinite(rawPrevious)) {
    throw new Error("Invalid gold reference values");
  }

  // Some feeds can carry kg-based price; convert to 1g when required.
  const needsKgToGram = rawPrice > 1_000_000;
  const domesticKrwPerGram = needsKgToGram ? rawPrice / 1000 : rawPrice;
  const previousDomesticKrwPerGram = needsKgToGram ? rawPrevious / 1000 : rawPrevious;

  const changePercent =
    previousDomesticKrwPerGram !== 0
      ? ((domesticKrwPerGram - previousDomesticKrwPerGram) / previousDomesticKrwPerGram) * 100
      : 0;

  return {
    domesticKrwPerGram,
    changePercent,
    previousDomesticKrwPerGram,
    updatedAt: toIsoFromKst(data.updated),
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
