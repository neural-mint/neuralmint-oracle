// api/signal.js
// ─────────────────────────────────────────────────────────────────────────────
// NeuralMint AI Oracle — Vercel Serverless Function
//
// Reads TWO free data sources (no API keys needed):
//   1. CoinGecko  → Bitcoin price + 24h % change
//   2. Alternative.me → Bitcoin Fear & Greed Index (0-100)
//
// Combines them into a tokenomics signal for NMNT smart contracts.
// Deployed on Vercel free tier. Called every 4h by Gelato automation.
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ── 1. Fetch Bitcoin price from CoinGecko (free, no key) ─────────────────
    const priceRes = await fetch(
      "https://api.coingecko.com/api/v3/simple/price" +
      "?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_market_cap=true",
      { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8000) }
    );

    let btcPrice = 65000, btcChange = 0, btcMarketCap = 1.2e12;

    if (priceRes.ok) {
      const priceData = await priceRes.json();
      const btc = priceData?.bitcoin;
      btcPrice     = btc?.usd              ?? 65000;
      btcChange    = btc?.usd_24h_change   ?? 0;
      btcMarketCap = btc?.usd_market_cap   ?? 1.2e12;
    }

    // ── 2. Fetch Fear & Greed Index from Alternative.me (free, no key) ────────
    const fgRes = await fetch(
      "https://api.alternative.me/fng/?limit=1&format=json",
      { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8000) }
    );

    let fearGreed = 50, fgLabel = "Neutral";

    if (fgRes.ok) {
      const fgData = await fgRes.json();
      const latest = fgData?.data?.[0];
      fearGreed = parseInt(latest?.value ?? "50", 10);
      fgLabel   = latest?.value_classification ?? "Neutral";
    }

    // ── 3. AI Signal Logic ────────────────────────────────────────────────────
    //
    // Input features:
    //   btcChange  = 24h % price change  (negative = bad)
    //   fearGreed  = 0-100 sentiment     (0=fear, 100=greed)
    //   absChange  = absolute volatility
    //
    // Output parameters for NMNT contracts:
    //   burnRateBps   : 0-500  (higher in volatile/bearish markets)
    //   apyMultiplier : 50-800 (higher to reward holders in fear markets)
    //   mintCapMillions: 1-50  (tighter supply in bearish markets)

    const absChange = Math.abs(btcChange);

    // Combined stress score 0-100:
    // High stress = high volatility + low fear/greed (fear)
    // Low stress  = low volatility  + high fear/greed (greed) = bull run
    const volatilityScore = Math.min(100, absChange * 4);   // 25% change = max
    const fearScore       = 100 - fearGreed;                 // invert: fear=100, greed=0
    const stressScore     = (volatilityScore * 0.5) + (fearScore * 0.5);

    let burnRateBps, apyMultiplier, mintCapMillions, mood;

    if (stressScore >= 75) {
      // 🔴 EXTREME STRESS — Bitcoin crashing + extreme fear
      // Max burn (deflation), high APY (reward diamond hands), tight mint
      burnRateBps     = 450;
      apyMultiplier   = 400;  // 4x APY to incentivize holding
      mintCapMillions = 3;
      mood            = fearGreed < 25 ? "Extreme Fear" : "High Fear";
    } else if (stressScore >= 55) {
      // 🟠 HIGH STRESS — Significant drawdown + fear
      burnRateBps     = 300;
      apyMultiplier   = 250;
      mintCapMillions = 7;
      mood            = "Fear";
    } else if (stressScore >= 35) {
      // 🟡 NEUTRAL — Normal fluctuation
      burnRateBps     = 150;
      apyMultiplier   = 150;
      mintCapMillions = 15;
      mood            = "Neutral";
    } else if (stressScore >= 15) {
      // 🟢 LOW STRESS — Positive momentum + mild greed
      burnRateBps     = 75;
      apyMultiplier   = 100;
      mintCapMillions = 25;
      mood            = "Greed";
    } else {
      // 🟣 EUPHORIA — Bull market, extreme greed
      // Low burn, lower APY (tokens already scarce), generous mint
      burnRateBps     = 25;
      apyMultiplier   = 70;   // Reduce APY — greed is naturally driving price
      mintCapMillions = 40;
      mood            = "Extreme Greed";
    }

    // Override mood if BTC pumping hard regardless of FG index
    if (btcChange > 10) mood = "Extreme Greed";
    if (btcChange < -10) mood = "Extreme Fear";

    // Final clamps
    burnRateBps     = Math.max(0,  Math.min(500,  Math.round(burnRateBps)));
    apyMultiplier   = Math.max(50, Math.min(1000, Math.round(apyMultiplier)));
    mintCapMillions = Math.max(1,  Math.min(100,  Math.round(mintCapMillions)));

    // Convert for on-chain storage
    const btcPriceCents = Math.round(btcPrice * 100);          // $65000 → 6500000
    const btcChangeBps  = Math.round(btcChange * 100);          // -3.5% → -350

    // ── 4. Response ───────────────────────────────────────────────────────────
    const signal = {
      // For smart contract pushSignal() call
      onChain: {
        burnRateBps,
        apyMultiplier,
        mintCapMillions,
        btcPriceCents,
        btcChangeBps,
        fearGreed,
        mood,
      },
      // Human-readable for frontend display
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
        computedAt: new Date().toISOString(),
        sources: ["CoinGecko (BTC price)", "Alternative.me (Fear & Greed)"],
        version: "2.0.0-btc",
      }
    };

    return res.status(200).json(signal);

  } catch (err) {
    // Safe fallback — neutral market parameters
    return res.status(200).json({
      onChain: {
        burnRateBps: 100, apyMultiplier: 150, mintCapMillions: 10,
        btcPriceCents: 6500000, btcChangeBps: 0,
        fearGreed: 50, mood: "Neutral",
      },
      display: {
        btcPrice: "$65,000", btcChange24h: "0.00%",
        fearGreedIndex: 50, fearGreedLabel: "Neutral",
        mood: "Neutral", burnRate: "1.00%",
        apyMultiplier: "1.5×", mintCap: "10M NMNT", stressScore: 50,
      },
      meta: {
        computedAt: new Date().toISOString(),
        fallback: true,
        error: err.message,
        sources: ["fallback"],
        version: "2.0.0-btc",
      }
    });
  }
}
