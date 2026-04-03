import { ethers } from "ethers";

export default async function handler(req, res) {
  try {
    // 🔹 1. Fetch signal from your own API
    const signalRes = await fetch(process.env.SIGNAL_URL);
    const data = await signalRes.json();

    const s = data.onChain;

    // 🔹 2. Setup provider + wallet
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // 🔹 3. Oracle contract
    const oracle = new ethers.Contract(
      process.env.ORACLE_ADDRESS,
      [
        "function pushSignal(uint256,uint256,uint256,uint256,int256,uint256,string)"
      ],
      wallet
    );

    // 🔹 4. Send transaction
    const tx = await oracle.pushSignal(
      s.burnRateBps,
      s.apyMultiplier,
      s.mintCapMillions,
      s.btcPriceCents,
      s.btcChangeBps,
      s.fearGreed,
      s.mood
    );

    await tx.wait();

    return res.status(200).json({
      success: true,
      txHash: tx.hash
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
