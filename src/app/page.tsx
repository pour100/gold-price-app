"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

type ViewMode = "live" | "history";
type RangeId = "1mo" | "6mo" | "1y" | "10y" | "20y";

type SpotData = {
  domesticKrwPerGram: number;
  goldPriceUsdPerOunce: number;
  usdKrw: number;
  previousDomesticKrwPerGram: number;
  changePercent: number;
  updatedAt: string;
  source: string;
};

type HistoryPoint = {
  ts: number;
  usdPerOunce: number;
  usdKrw: number;
  krwPerGram: number;
};

type HistoryData = {
  range: RangeId;
  points: HistoryPoint[];
  source: string;
};

const ranges: Array<{ id: RangeId; label: string }> = [
  { id: "1mo", label: "1개월" },
  { id: "6mo", label: "6개월" },
  { id: "1y", label: "1년" },
  { id: "10y", label: "10년" },
  { id: "20y", label: "20년" },
];

const OUNCE_TO_GRAM = 31.1034768;
const AUTO_REFRESH_MS = 3000;

function formatKrw(value: number): string {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatIndex(value: number): string {
  return value.toFixed(1);
}

function buildLinePath(values: number[], width: number, height: number, pad: number): string {
  if (values.length === 0) {
    return "";
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const innerWidth = width - pad * 2;
  const innerHeight = height - pad * 2;

  return values
    .map((value, idx) => {
      const x = pad + (idx / Math.max(values.length - 1, 1)) * innerWidth;
      const y = pad + ((max - value) / range) * innerHeight;
      return `${idx === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildAreaPath(values: number[], width: number, height: number, pad: number): string {
  const line = buildLinePath(values, width, height, pad);
  if (!line) {
    return "";
  }

  const leftX = pad;
  const rightX = width - pad;
  const bottomY = height - pad;
  return `${line} L ${rightX} ${bottomY} L ${leftX} ${bottomY} Z`;
}

function TrendChart({ points }: { points: HistoryPoint[] }) {
  const width = 960;
  const height = 360;
  const pad = 18;
  const first = points[0];
  const domesticIndex = points.map((p) => (p.krwPerGram / first.krwPerGram) * 100);
  const globalIndex = points.map((p) => (p.usdPerOunce / first.usdPerOunce) * 100);

  const domesticPath = buildLinePath(domesticIndex, width, height, pad);
  const globalPath = buildLinePath(globalIndex, width, height, pad);
  const areaPath = buildAreaPath(domesticIndex, width, height, pad);

  return (
    <div className={styles.chartWrap}>
      <svg viewBox={`0 0 ${width} ${height}`} className={styles.chart} role="img" aria-label="금 가격 추이 차트">
        <defs>
          <linearGradient id="domesticFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255, 198, 56, 0.6)" />
            <stop offset="100%" stopColor="rgba(255, 198, 56, 0)" />
          </linearGradient>
        </defs>

        <path d={areaPath} fill="url(#domesticFill)" />
        <path d={globalPath} className={styles.lineGlobal} />
        <path d={domesticPath} className={styles.lineDomestic} />
      </svg>

      <div className={styles.chartLegend}>
        <span className={styles.legendItem}>
          <span className={`${styles.dot} ${styles.dotDomestic}`} />
          국내(원화) 지수 {formatIndex(domesticIndex[domesticIndex.length - 1])}
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.dot} ${styles.dotGlobal}`} />
          국제(달러) 지수 {formatIndex(globalIndex[globalIndex.length - 1])}
        </span>
      </div>
    </div>
  );
}

export default function Home() {
  const [mode, setMode] = useState<ViewMode>("live");
  const [range, setRange] = useState<RangeId>("1mo");
  const [spot, setSpot] = useState<SpotData | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [spotLoading, setSpotLoading] = useState<boolean>(true);
  const [historyLoading, setHistoryLoading] = useState<boolean>(true);
  const [spotError, setSpotError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [domesticFlashKey, setDomesticFlashKey] = useState<number>(0);
  const [globalFlashKey, setGlobalFlashKey] = useState<number>(0);
  const prevSpotRef = useRef<SpotData | null>(null);

  const fetchSpot = useCallback(async () => {
    try {
      const response = await fetch("/api/spot", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("실시간 데이터를 불러오지 못했습니다.");
      }
      const payload = (await response.json()) as SpotData;
      const prevSpot = prevSpotRef.current;

      if (prevSpot) {
        const prevGlobalKrwPerGram = (prevSpot.goldPriceUsdPerOunce * prevSpot.usdKrw) / OUNCE_TO_GRAM;
        const nextGlobalKrwPerGram = (payload.goldPriceUsdPerOunce * payload.usdKrw) / OUNCE_TO_GRAM;

        if (Math.abs(payload.domesticKrwPerGram - prevSpot.domesticKrwPerGram) >= 0.01) {
          setDomesticFlashKey((current) => current + 1);
        }

        if (Math.abs(nextGlobalKrwPerGram - prevGlobalKrwPerGram) >= 0.01) {
          setGlobalFlashKey((current) => current + 1);
        }
      }

      prevSpotRef.current = payload;
      setSpot(payload);
      setSpotError(null);
    } catch (error) {
      setSpotError(error instanceof Error ? error.message : "실시간 데이터를 불러오지 못했습니다.");
    } finally {
      setSpotLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async (selectedRange: RangeId) => {
    try {
      setHistoryLoading(true);
      const response = await fetch(`/api/history?range=${selectedRange}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("히스토리 데이터를 불러오지 못했습니다.");
      }
      const payload = (await response.json()) as HistoryData;
      setHistory(payload);
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "히스토리 데이터를 불러오지 못했습니다.");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSpot();
    const timer = window.setInterval(fetchSpot, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [fetchSpot]);

  useEffect(() => {
    void fetchHistory(range);
  }, [fetchHistory, range]);

  const stats = useMemo(() => {
    if (!history?.points.length) {
      return null;
    }

    const values = history.points.map((p) => p.krwPerGram);
    const first = history.points[0];
    const last = history.points[history.points.length - 1];
    const high = Math.max(...values);
    const low = Math.min(...values);
    const periodChange = ((last.krwPerGram - first.krwPerGram) / first.krwPerGram) * 100;

    return {
      high,
      low,
      latest: last.krwPerGram,
      periodChange,
      from: new Date(first.ts * 1000).toLocaleDateString("ko-KR"),
      to: new Date(last.ts * 1000).toLocaleDateString("ko-KR"),
    };
  }, [history]);

  const deltaSign = (spot?.changePercent ?? 0) >= 0 ? "+" : "";

  return (
    <div className={styles.shell}>
      <div className={styles.noise} />
      <main className={styles.app}>
        <header className={styles.header}>
          <p className={styles.kicker}>Gold Pulse KR</p>
          <h1>실시간 금 가격 대시보드</h1>
          <p className={styles.subtitle}>국내 금값과 국제 금값(원화 환산)을 동시에 확인</p>
        </header>

        <nav className={styles.modeTabs}>
          <button
            type="button"
            className={mode === "live" ? `${styles.tabBtn} ${styles.active}` : styles.tabBtn}
            onClick={() => setMode("live")}
          >
            실시간
          </button>
          <button
            type="button"
            className={mode === "history" ? `${styles.tabBtn} ${styles.active}` : styles.tabBtn}
            onClick={() => setMode("history")}
          >
            과거 추이
          </button>
        </nav>

        {mode === "live" && (
          <section className={styles.panel}>

            {spotError && <p className={styles.error}>{spotError}</p>}

            {spotLoading && !spot ? (
              <p className={styles.loading}>실시간 시세를 불러오는 중...</p>
            ) : (
              spot && (
                <>
                  <div className={styles.compareGrid}>
                    <article className={`${styles.compareCard} ${styles.compareCardDomestic}`}>
                      <p className={styles.compareLabel}>국내 금값</p>
                      <h2 key={`domestic-${domesticFlashKey}`} className={`${styles.compareValue} ${styles.valueFlash}`}>
                        {formatKrw(spot.domesticKrwPerGram)}
                      </h2>
                      <p className={styles.compareUnit}>원 / g</p>
                      <p className={styles.delta}>
                        {deltaSign}
                        {spot.changePercent.toFixed(2)}% (전일 대비)
                      </p>
                    </article>

                    <article className={`${styles.compareCard} ${styles.compareCardGlobal}`}>
                      <p className={styles.compareLabel}>국제 금값 (원화 환산)</p>
                      <h2 key={`global-${globalFlashKey}`} className={`${styles.compareValue} ${styles.valueFlash}`}>
                        {formatKrw((spot.goldPriceUsdPerOunce * spot.usdKrw) / OUNCE_TO_GRAM)}
                      </h2>
                      <p className={styles.compareUnit}>원 / g</p>
                      <p className={styles.compareSub}>USD/oz x 환율 / 31.1035</p>
                    </article>
                  </div>

                  <div className={styles.metrics}>
                    <article className={styles.metricCard}>
                      <p>국제 금 가격</p>
                      <strong>${formatUsd(spot.goldPriceUsdPerOunce)} / oz</strong>
                    </article>
                    <article className={styles.metricCard}>
                      <p>원/달러</p>
                      <strong>{formatUsd(spot.usdKrw)} KRW</strong>
                    </article>
                    <article className={styles.metricCard}>
                      <p>환산식</p>
                      <strong>(국제 금 x 환율) / 31.1035</strong>
                    </article>
                  </div>

                  <p className={styles.updated}>
                    마지막 갱신: {new Date(spot.updatedAt).toLocaleString("ko-KR", { hour12: false })}
                  </p>
                </>
              )
            )}
          </section>
        )}

        {mode === "history" && (
          <section className={styles.panel}>
            <div className={styles.rangeTabs}>
              {ranges.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={range === item.id ? `${styles.pill} ${styles.pillActive}` : styles.pill}
                  onClick={() => setRange(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {historyError && <p className={styles.error}>{historyError}</p>}

            {historyLoading ? (
              <p className={styles.loading}>기간별 데이터를 계산하는 중...</p>
            ) : (
              history &&
              history.points.length > 2 && (
                <>
                  <TrendChart points={history.points} />

                  {stats && (
                    <div className={styles.statsGrid}>
                      <article className={styles.statCard}>
                        <p>최신 국내 1g</p>
                        <strong>{formatKrw(stats.latest)}원</strong>
                      </article>
                      <article className={styles.statCard}>
                        <p>기간 상승률</p>
                        <strong>{stats.periodChange.toFixed(2)}%</strong>
                      </article>
                      <article className={styles.statCard}>
                        <p>기간 최고가</p>
                        <strong>{formatKrw(stats.high)}원</strong>
                      </article>
                      <article className={styles.statCard}>
                        <p>기간 최저가</p>
                        <strong>{formatKrw(stats.low)}원</strong>
                      </article>
                    </div>
                  )}

                  <p className={styles.updated}>
                    조회 구간: {stats?.from} ~ {stats?.to}
                  </p>
                </>
              )
            )}
          </section>
        )}

        <footer className={styles.footer}>
          <span>Source: {spot?.source ?? "Domestic: Naver Finance Gold (KRX). Global: Yahoo Finance (GC=F, KRW=X)."}</span>
          <span>모바일 최적화 UI</span>
        </footer>
      </main>
    </div>
  );
}

