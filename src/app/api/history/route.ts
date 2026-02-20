import { NextRequest, NextResponse } from "next/server";

const OUNCE_TO_GRAM = 31.1034768;

const RANGE_CONFIG = {
  "1mo": { range: "1mo", interval: "1h" },
  "6mo": { range: "6mo", interval: "1d" },
  "1y": { range: "1y", interval: "1d" },
  "10y": { range: "10y", interval: "1wk" },
  "20y": { range: "20y", interval: "1mo" },
} as const;

type RangeKey = keyof typeof RANGE_CONFIG;

type YahooChartMeta = {
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

type Point = {
  ts: number;
  usdPerOunce: number;
  usdKrw: number;
  krwPerGram: number;
};

function parseSeries(chart: YahooChartResult): Array<{ ts: number; close: number }> {
  const timestamps = chart.timestamp ?? [];
  const closes = chart.indicators?.quote?.[0]?.close ?? [];
  const length = Math.min(timestamps.length, closes.length);
  const points: Array<{ ts: number; close: number }> = [];

  for (let i = 0; i < length; i += 1) {
    const ts = timestamps[i];
    const close = closes[i];

    if (typeof ts !== "number" || !Number.isFinite(ts)) {
      continue;
    }
    if (typeof close !== "number" || !Number.isFinite(close)) {
      continue;
    }

    points.push({ ts, close });
  }

  return points.sort((a, b) => a.ts - b.ts);
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

function mergeGoldAndFx(
  goldSeries: Array<{ ts: number; close: number }>,
  fxSeries: Array<{ ts: number; close: number }>,
): Point[] {
  if (goldSeries.length === 0 || fxSeries.length === 0) {
    return [];
  }

  const points: Point[] = [];
  let fxIndex = 0;

  for (const goldPoint of goldSeries) {
    while (fxIndex + 1 < fxSeries.length && fxSeries[fxIndex + 1].ts <= goldPoint.ts) {
      fxIndex += 1;
    }

    const fxPoint = fxSeries[fxIndex];
    if (!fxPoint) {
      continue;
    }

    const usdPerOunce = goldPoint.close;
    const usdKrw = fxPoint.close;
    const krwPerGram = (usdPerOunce * usdKrw) / OUNCE_TO_GRAM;

    points.push({
      ts: goldPoint.ts,
      usdPerOunce,
      usdKrw,
      krwPerGram,
    });
  }

  return points;
}

export async function GET(request: NextRequest) {
  try {
    const selected = request.nextUrl.searchParams.get("range") as RangeKey | null;
    const rangeKey: RangeKey = selected && selected in RANGE_CONFIG ? selected : "1mo";
    const { range, interval } = RANGE_CONFIG[rangeKey];

    const [goldChart, fxChart] = await Promise.all([
      fetchChart("GC=F", range, interval),
      fetchChart("KRW=X", range, interval),
    ]);

    const goldSeries = parseSeries(goldChart);
    const fxSeries = parseSeries(fxChart);
    const points = mergeGoldAndFx(goldSeries, fxSeries);

    return NextResponse.json(
      {
        range: rangeKey,
        points,
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
