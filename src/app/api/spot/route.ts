import { NextResponse } from "next/server";

const NAVER_GOLD_URL = "https://finance.naver.com/marketindex/goldDetail.naver";

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

  const match = value.match(/(\d{4})[.-](\d{2})[.-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    return null;
  }

  const second = match[6] ?? "00";
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${second}+09:00`;
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function parseNumber(input: string): number | null {
  const normalized = input.replace(/,/g, "").trim();
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
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
  const response = await fetch(NAVER_GOLD_URL, {
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Naver gold request failed (${response.status})`);
  }

  const html = await response.text();
  const todayBlock = html.match(/<p class="no_today">([\s\S]*?)<\/p>/)?.[1];
  const todayEm = todayBlock?.match(/<em[^>]*>([\s\S]*?)<\/em>/)?.[1];
  const todayText = todayEm ? stripTags(todayEm).replace(/[^0-9.,-]/g, "") : "";

  const rawPrice = parseNumber(todayText);
  if (rawPrice === null) {
    throw new Error("Failed to parse domestic gold reference price");
  }

  // Keep explicit kg->g conversion in case upstream feed switches to kg-denominated values.
  const needsKgToGram = rawPrice > 1_000_000;
  const domesticKrwPerGram = needsKgToGram ? rawPrice / 1000 : rawPrice;

  const exdayBlock = html.match(/<p class="no_exday">([\s\S]*?)<\/p>/)?.[1] ?? "";
  const emMatches = [...exdayBlock.matchAll(/<em[^>]*>([\s\S]*?)<\/em>/g)];
  const percentText = emMatches[1]?.[1] ? stripTags(emMatches[1][1]) : "";
  const percentValueMatch = percentText.match(/([0-9]+(?:\.[0-9]+)?)/);
  const rawPercent = percentValueMatch ? Number.parseFloat(percentValueMatch[1]) : 0;

  const isDown = /class="ico\s+down"/.test(exdayBlock);
  const isUp = /class="ico\s+up"/.test(exdayBlock);
  const sign = isDown ? -1 : isUp ? 1 : 1;
  const changePercent = Number.isFinite(rawPercent) ? sign * rawPercent : 0;

  let previousDomesticKrwPerGram =
    changePercent === -100 ? domesticKrwPerGram : domesticKrwPerGram / (1 + changePercent / 100);
  if (!Number.isFinite(previousDomesticKrwPerGram) || previousDomesticKrwPerGram <= 0) {
    previousDomesticKrwPerGram = domesticKrwPerGram;
  }

  const dateText = html.match(/<span class="date">([^<]+)<\/span>/)?.[1]?.trim();

  return {
    domesticKrwPerGram,
    changePercent,
    previousDomesticKrwPerGram,
    updatedAt: toIsoFromKst(dateText),
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
        source: "Domestic: Naver Finance 금 99.99_1kg 금현물 (KRX, 1g 환산). Global: Yahoo Finance (GC=F, KRW=X).",
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
