// api/push.js
// ─────────────────────────────────────────────────────────────────────────────
// NeuralMint Auto-Pusher — Vercel Cron Job (runs every 4 hours)
//
// What this does:
//   1. Fetches live BTC signal from /api/signal (your AI oracle function)
//   2. Calls pushSignal() on your AIOracle smart contract
//   3. Posts the result to the Polygon blockchain automatically
//
// Required environment variables in Vercel dashboard:
//   PRIVATE_KEY      → your wallet private key (the one you deployed with)
//   ORACLE_ADDRESS   → your AIOracle contract address
//   RPC_URL          → Polygon RPC (we use a free Alchemy one)
//   CRON_SECRET      → any random string you choose (prevents abuse)
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";

// ── AIOracle ABI — only the function we need ──────────────────────────────────
const ORACLE_ABI = [
  "function pushSignal(uint256 _burnRateBps, uint256 _apyMultiplier, uint256 _mintCapMillions, uint256 _btcPriceCents, int256 _btcChangeBps, uint256 _fearGreed, string calldata _mood) external",
  "function lastUpdated() view returns (uint256)",
  "function updateInterval() view returns (uint256)",
  "function authorizedCallers(address) view returns (bool)",
];

export default async function handler(req, res) {

  // ── Security: only allow Vercel cron or requests with secret ─────────────
  const authHeader = req.headers["authorization"];
  const cronHeader = req.headers["x-vercel-cron"]; // set automatically by Vercel cron
  const secret     = process.env.CRON_SECRET;

  const isVercelCron    = cronHeader === "1";
  const hasValidSecret  = secret && authHeader === `Bearer ${secret}`;

  if (!isVercelCron && !hasValidSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Check required env vars ───────────────────────────────────────────────
  const { PRIVATE_KEY, ORACLE_ADDRESS, RPC_URL } = process.env;
  if (!PRIVATE_KEY || !ORACLE_ADDRESS || !RPC_URL) {
    return res.status(500).json({
      error: "Missing env vars",
      missing: [
        !PRIVATE_KEY    && "PRIVATE_KEY",
        !ORACLE_ADDRESS && "ORACLE_ADDRESS",
        !RPC_URL        && "RPC_URL",
      ].filter(Boolean),
    });
  }

  const startTime = Date.now();
  const log = [];

  try {

    // ── Step 1: Fetch the AI signal from our own /api/signal ─────────────────
    log.push("Fetching AI signal...");

    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";

    const signalRes = await fetch(`${baseUrl}/api/signal`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!signalRes.ok) {
      throw new Error(`Signal fetch failed: ${signalRes.status}`);
    }

    const signalData = await signalRes.json();
    const { onChain, display } = signalData;

    log.push(`Signal fetched: BTC ${display.btcPrice} | F&G ${display.fearGreedIndex} | Mood: ${display.mood}`);
    log.push(`Parameters: burn=${display.burnRate} apy=${display.apyMultiplier} cap=${display.mintCap}`);

    // ── Step 2: Connect to Polygon via ethers.js ──────────────────────────────
    log.push("Connecting to Polygon...");

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
    const oracle   = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, wallet);

    // Check wallet balance
    const balance = await provider.getBalance(wallet.address);
    const balancePOL = parseFloat(ethers.formatEther(balance)).toFixed(4);
    log.push(`Wallet: ${wallet.address} | Balance: ${balancePOL} POL`);

    if (balance < ethers.parseEther("0.001")) {
      throw new Error(`Wallet balance too low: ${balancePOL} POL. Need at least 0.001 POL for gas.`);
    }

    // ── Step 3: Check if oracle update interval has passed ───────────────────
    const [lastUpdated, updateInterval] = await Promise.all([
      oracle.lastUpdated(),
      oracle.updateInterval(),
    ]);

    const now            = BigInt(Math.floor(Date.now() / 1000));
    const nextUpdateTime = lastUpdated + updateInterval;
    const secondsUntil   = nextUpdateTime > now ? Number(nextUpdateTime - now) : 0;

    if (secondsUntil > 0) {
      const minutesUntil = Math.ceil(secondsUntil / 60);
      log.push(`Oracle not ready yet. Next update in ${minutesUntil} minutes.`);
      return res.status(200).json({
        status:  "skipped",
        reason:  `Update interval not elapsed. Next update in ${minutesUntil} minutes.`,
        nextUpdateAt: new Date(Number(nextUpdateTime) * 1000).toISOString(),
        log,
        duration: Date.now() - startTime + "ms",
      });
    }

    log.push("Oracle ready for update. Pushing signal on-chain...");

    // ── Step 4: Estimate gas and push the signal ──────────────────────────────
    const gasPrice = await provider.getFeeData();

    // Use 35 Gwei priority fee minimum to avoid the "gas too low" error
    const maxPriorityFee = gasPrice.maxPriorityFeePerGas > ethers.parseUnits("35", "gwei")
      ? gasPrice.maxPriorityFeePerGas
      : ethers.parseUnits("35", "gwei");

    const maxFee = gasPrice.maxFeePerGas > ethers.parseUnits("40", "gwei")
      ? gasPrice.maxFeePerGas
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
        gasLimit:             300_000,   // safe upper bound
      }
    );

    log.push(`Transaction sent: ${tx.hash}`);
    log.push(`Waiting for confirmation on Polygon...`);

    // ── Step 5: Wait for 1 confirmation ──────────────────────────────────────
    const receipt = await tx.wait(1);
    const gasUsed  = receipt.gasUsed.toString();
    const gasCost  = parseFloat(ethers.formatEther(receipt.gasUsed * maxFee)).toFixed(6);

    log.push(`Confirmed in block ${receipt.blockNumber}`);
    log.push(`Gas used: ${gasUsed} units (~${gasCost} POL)`);

    // ── Step 6: Return success ────────────────────────────────────────────────
    return res.status(200).json({
      status:  "success",
      txHash:  tx.hash,
      txUrl:   `https://polygonscan.com/tx/${tx.hash}`,
      block:   receipt.blockNumber,
      signal:  display,
      gasUsed,
      gasCostPOL: gasCost,
      log,
      duration: Date.now() - startTime + "ms",
    });

  } catch (err) {
    log.push(`ERROR: ${err.message}`);

    // Common error hints
    let hint = "";
    if (err.message.includes("gas"))
      hint = "Gas issue — the contract may already be updated, or gas settings need increasing.";
    else if (err.message.includes("Too soon") || err.message.includes("interval"))
      hint = "Update interval not elapsed yet — Gelato/cron triggered too early.";
    else if (err.message.includes("Not authorized"))
      hint = "Your wallet address is not in authorizedCallers. Call setAuthorizedCaller(yourAddress, true) on AIOracle from Remix.";
    else if (err.message.includes("nonce"))
      hint = "Nonce issue — a previous transaction is still pending. Wait a minute and retry.";
    else if (err.message.includes("insufficient funds"))
      hint = "Not enough POL for gas. Top up your pusher wallet with at least 0.1 POL.";

    return res.status(500).json({
      status:   "error",
      error:    err.message,
      hint,
      log,
      duration: Date.now() - startTime + "ms",
    });
  }
}
