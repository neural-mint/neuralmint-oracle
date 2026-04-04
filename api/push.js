// api/push.js
// ─────────────────────────────────────────────────────────────────────────────
// NeuralMint Auto-Pusher — called by external cron (GitHub Actions / cron-job.org)
//
// FIXES vs v1:
//   - Uses PRODUCTION_URL env var instead of VERCEL_URL (which is preview-only)
//   - Aborts if signal.js returned a fallback/error — never pushes stale data
//   - Accepts GET requests so cron-job.org simple URL pings work
//   - Cron-job.org replaces Vercel cron (free, every 4h) and broken Gelato
//
// Required environment variables in Vercel dashboard:
//   PRIVATE_KEY      → pusher wallet private key
//   ORACLE_ADDRESS   → your AIOracle contract address on Polygon
//   RPC_URL          → Polygon RPC (e.g. https://polygon-rpc.com or Alchemy)
//   CRON_SECRET      → any random string (protects the endpoint from abuse)
//   PRODUCTION_URL   → your Vercel production domain, e.g. https://neuralmint.vercel.app
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";

const ORACLE_ABI = [
  "function pushSignal(uint256 _burnRateBps, uint256 _apyMultiplier, uint256 _mintCapMillions, uint256 _btcPriceCents, int256 _btcChangeBps, uint256 _fearGreed, string calldata _mood) external",
  "function lastUpdated() view returns (uint256)",
  "function updateInterval() view returns (uint256)",
  "function authorizedCallers(address) view returns (bool)",
];

export default async function handler(req, res) {

  // ── Security ──────────────────────────────────────────────────────────────
  // Accepts either:
  //   Authorization: Bearer <CRON_SECRET>   (cron-job.org custom header)
  //   ?secret=<CRON_SECRET>                 (simple URL param for basic crons)
  const secret     = process.env.CRON_SECRET;
  const authHeader = req.headers["authorization"];
  const querySecret = req.query?.secret;

  const hasValidSecret =
    secret &&
    (authHeader === `Bearer ${secret}` || querySecret === secret);

  if (!hasValidSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Required env vars ─────────────────────────────────────────────────────
  const { PRIVATE_KEY, ORACLE_ADDRESS, RPC_URL, PRODUCTION_URL } = process.env;
  const missing = [
    !PRIVATE_KEY      && "PRIVATE_KEY",
    !ORACLE_ADDRESS   && "ORACLE_ADDRESS",
    !RPC_URL          && "RPC_URL",
    !PRODUCTION_URL   && "PRODUCTION_URL",
  ].filter(Boolean);

  if (missing.length > 0) {
    return res.status(500).json({ error: "Missing env vars", missing });
  }

  const startTime = Date.now();
  const log = [];

  try {

    // ── Step 1: Fetch AI signal from our own /api/signal ─────────────────────
    log.push("Fetching AI signal...");

    // FIX: Use PRODUCTION_URL, not VERCEL_URL.
    // VERCEL_URL points to the specific deployment preview, not production.
    const signalRes = await fetch(`${PRODUCTION_URL}/api/signal`, {
      signal: AbortSignal.timeout(12000),
    });

    if (!signalRes.ok) {
      throw new Error(`Signal fetch failed with HTTP ${signalRes.status}`);
    }

    const signalData = await signalRes.json();

    // FIX: If signal.js returned an error/fallback, abort — don't push stale data.
    if (signalData?.meta?.fallback === true || signalData?.status === "error") {
      log.push("Signal returned a fallback/error — skipping on-chain push to avoid stale data.");
      return res.status(200).json({
        status:   "skipped",
        reason:   "Signal source unavailable — fallback data detected. No on-chain push.",
        signalError: signalData?.error ?? "unknown",
        log,
        duration: Date.now() - startTime + "ms",
      });
    }

    const { onChain, display } = signalData;
    log.push(`Signal OK: BTC ${display.btcPrice} | F&G ${display.fearGreedIndex} | Mood: ${display.mood}`);
    log.push(`Params: burn=${display.burnRate} apy=${display.apyMultiplier} cap=${display.mintCap}`);

    // ── Step 2: Connect to Polygon ────────────────────────────────────────────
    log.push("Connecting to Polygon...");

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
    const oracle   = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, wallet);

    const balance    = await provider.getBalance(wallet.address);
    const balancePOL = parseFloat(ethers.formatEther(balance)).toFixed(4);
    log.push(`Wallet: ${wallet.address} | Balance: ${balancePOL} POL`);

    if (balance < ethers.parseEther("0.001")) {
      throw new Error(`Wallet balance too low: ${balancePOL} POL. Need ≥ 0.001 POL for gas.`);
    }

    // ── Step 3: Check oracle interval ─────────────────────────────────────────
    const [lastUpdated, updateInterval] = await Promise.all([
      oracle.lastUpdated(),
      oracle.updateInterval(),
    ]);

    const now            = BigInt(Math.floor(Date.now() / 1000));
    const nextUpdateTime = lastUpdated + updateInterval;
    const secondsUntil   = nextUpdateTime > now ? Number(nextUpdateTime - now) : 0;

    if (secondsUntil > 0) {
      const minutesUntil = Math.ceil(secondsUntil / 60);
      log.push(`Oracle not ready. Next update in ${minutesUntil} min.`);
      return res.status(200).json({
        status:      "skipped",
        reason:      `Interval not elapsed. Next update in ${minutesUntil} minutes.`,
        nextUpdateAt: new Date(Number(nextUpdateTime) * 1000).toISOString(),
        log,
        duration: Date.now() - startTime + "ms",
      });
    }

    log.push("Oracle ready — pushing signal on-chain...");

    // ── Step 4: Send transaction ───────────────────────────────────────────────
    const gasData = await provider.getFeeData();

    const maxPriorityFee = gasData.maxPriorityFeePerGas > ethers.parseUnits("35", "gwei")
      ? gasData.maxPriorityFeePerGas
      : ethers.parseUnits("35", "gwei");

    const maxFee = gasData.maxFeePerGas > ethers.parseUnits("40", "gwei")
      ? gasData.maxFeePerGas
      : ethers.parseUnits("40", "gwei");

    const tx = await oracle.pushSignal(
      onChain.burnRateBps,
      onChain.apyMultiplier,
      onChain.mintCapMillions,
      onChain.btcPriceCents,
      onChain.btcChangeBps,
      onChain.fearGreed,
      onChain.mood,
      {
        maxPriorityFeePerGas: maxPriorityFee,
        maxFeePerGas:         maxFee,
        gasLimit:             350_000,
      }
    );

    log.push(`TX sent: ${tx.hash}`);
    log.push("Waiting for confirmation...");

    const receipt = await tx.wait(1);
    const gasUsed = receipt.gasUsed.toString();
    const gasCost = parseFloat(ethers.formatEther(receipt.gasUsed * maxFee)).toFixed(6);

    log.push(`Confirmed in block ${receipt.blockNumber}. Gas: ${gasUsed} units (~${gasCost} POL)`);

    return res.status(200).json({
      status:     "success",
      txHash:     tx.hash,
      txUrl:      `https://polygonscan.com/tx/${tx.hash}`,
      block:      receipt.blockNumber,
      signal:     display,
      gasUsed,
      gasCostPOL: gasCost,
      log,
      duration:   Date.now() - startTime + "ms",
    });

  } catch (err) {
    log.push(`ERROR: ${err.message}`);

    let hint = "";
    if (err.message.includes("gas"))
      hint = "Gas issue — contract may already be updated, or increase gas settings.";
    else if (err.message.includes("Too soon") || err.message.includes("interval"))
      hint = "Update interval not elapsed — cron triggered too early.";
    else if (err.message.includes("Not authorized"))
      hint = "Pusher wallet not in authorizedCallers. Call setAuthorizedCaller(yourWallet, true) from Remix.";
    else if (err.message.includes("nonce"))
      hint = "Nonce conflict — a previous TX is still pending. Wait 1 minute and retry.";
    else if (err.message.includes("insufficient funds"))
      hint = "Not enough POL for gas. Top up the pusher wallet with at least 0.1 POL.";

    return res.status(500).json({
      status:   "error",
      error:    err.message,
      hint,
      log,
      duration: Date.now() - startTime + "ms",
    });
  }
}
