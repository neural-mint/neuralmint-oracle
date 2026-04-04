// api/signal.js
// ─────────────────────────────────────────────────────────────────────────────
// NeuralMint AI Oracle — Vercel Serverless Function
//
// Reads TWO free data sources (no API keys needed):
//   1. CoinGecko  → Bitcoin price + 24h % change
//   2. Alternative.me → Bitcoin Fear & Greed Index (0-100)
//
// FIX: Binance public API is used as a fallback for BTC price if CoinGecko
// fails, instead of falling back to a stale hardcoded value.
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ── 1. Fetch Bitcoin price — CoinGecko primary, Binance fallback ──────────
    let btcPrice = null, btcChange = null, priceSource = "CoinGecko";

    try {
      const priceRes = await fetch(
        "https://api.coingecko.com/api/v3/simple/price" +
        "?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
        { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8000) }
      );
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        const btc = priceData?.bitcoin;
        if (btc?.usd) {
          btcPrice  = btc.usd;
          btcChange = btc.usd_24h_change ?? 0;
        }
      }
    } catch (_) { /* try fallback */ }

    // FIX: Binance public ticker — no API key, extremely reliable
    if (btcPrice === null) {
      try {
        priceSource = "Binance";
        const [tickerRes, statsRes] = await Promise.all([
          fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
                { signal: AbortSignal.timeout(6000) }),
          fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT",
                { signal: AbortSignal.timeout(6000) }),
        ]);
        if (tickerRes.ok && statsRes.ok) {
          const ticker = await tickerRes.json();
          const stats  = await statsRes.json();
          btcPrice  = parseFloat(ticker.price);
          // priceChangePercent is already a percentage string like "-2.53"
          btcChange = parseFloat(stats.priceChangePercent ?? "0");
        }
      } catch (_) { /* both sources failed */ }
    }

    // If both APIs failed, throw so we return a clean error — not a stale push
    if (btcPrice === null) {
      throw new Error("All BTC price sources unavailable");
    }

    // ── 2. Fetch Fear & Greed Index from Alternative.me (free, no key) ────────
    let fearGreed = 50, fgLabel = "Neutral";

    try {
      const fgRes = await fetch(
        "https://api.alternative.me/fng/?limit=1&format=json",
        { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8000) }
      );
      if (fgRes.ok) {
        const fgData = await fgRes.json();
        const latest = fgData?.data?.[0];
        fearGreed = parseInt(latest?.value ?? "50", 10);
        fgLabel   = latest?.value_classification ?? "Neutral";
      }
    } catch (_) { /* use neutral default */ }

    // ── 3. AI Signal Logic ────────────────────────────────────────────────────
    const absChange = Math.abs(btcChange);

    const volatilityScore = Math.min(100, absChange * 4);
    const fearScore       = 100 - fearGreed;
    const stressScore     = (volatilityScore * 0.5) + (fearScore * 0.5);

    let burnRateBps, apyMultiplier, mintCapMillions, mood;

    if (stressScore >= 75) {
      burnRateBps     = 450;
      apyMultiplier   = 400;
      mintCapMillions = 3;
      mood            = fearGreed < 25 ? "Extreme Fear" : "High Fear";
    } else if (stressScore >= 55) {
      burnRateBps     = 300;
      apyMultiplier   = 250;
      mintCapMillions = 7;
      mood            = "Fear";
    } else if (stressScore >= 35) {
      burnRateBps     = 150;
      apyMultiplier   = 150;
      mintCapMillions = 15;
      mood            = "Neutral";
    } else if (stressScore >= 15) {
      burnRateBps     = 75;
      apyMultiplier   = 100;
      mintCapMillions = 25;
      mood            = "Greed";
    } else {
      burnRateBps     = 25;
      apyMultiplier   = 70;
      mintCapMillions = 40;
      mood            = "Extreme Greed";
    }

    if (btcChange > 10)  mood = "Extreme Greed";
    if (btcChange < -10) mood = "Extreme Fear";

    burnRateBps     = Math.max(0,  Math.min(500,  Math.round(burnRateBps)));
    apyMultiplier   = Math.max(50, Math.min(1000, Math.round(apyMultiplier)));
    mintCapMillions = Math.max(1,  Math.min(100,  Math.round(mintCapMillions)));

    const btcPriceCents = Math.round(btcPrice * 100);
    const btcChangeBps  = Math.round(btcChange * 100);

    // ── 4. Response ───────────────────────────────────────────────────────────
    return res.status(200).json({
      onChain: {
        burnRateBps,
        apyMultiplier,
        mintCapMillions,
        btcPriceCents,
        btcChangeBps,
        fearGreed,
        mood,
      },
      display: {
        btcPrice:       `$${btcPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
        btcChange24h:   `${btcChange >= 0 ? "+" : ""}${btcChange.toFixed(2)}%`,
        fearGreedIndex: fearGreed,
        fearGreedLabel: fgLabel,
        mood,
        burnRate:       `${(burnRateBps / 100).toFixed(2)}%`,
        apyMultiplier:  `${(apyMultiplier / 100).toFixed(1)}×`,
        mintCap:        `${mintCapMillions}M NMNT`,
        stressScore:    Math.round(stressScore),
      },
      meta: {
        computedAt:  new Date().toISOString(),
        priceSource,
        sources:     [`${priceSource} (BTC price)`, "Alternative.me (Fear & Greed)"],
        version:     "2.1.0-btc",
        fallback:    false,
      }
    });

  } catch (err) {
    // FIX: Return an error response — do NOT return fake neutral parameters.
    // The push.js caller checks for status "error" and skips the on-chain push,
    // so a bad API day won't push a stale signal to the blockchain.
    return res.status(503).json({
      status: "error",
      error:  err.message,
      meta: {
        computedAt: new Date().toISOString(),
        fallback:   true,
        sources:    [],
        version:    "2.1.0-btc",
      }
    });
  }
}
