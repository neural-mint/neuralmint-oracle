const { ethers } = require("ethers");

export default async function handler(req, res) {
  try {
    // 🔐 SECURITY CHECK
    if (req.headers.authorization !== `Bearer ${process.env.SECRET_KEY}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("START PUSH");

    // 1. Fetch AI signal
    const signalRes = await fetch(process.env.SIGNAL_URL);
    const data = await signalRes.json();
    const s = data.onChain;

    console.log("SIGNAL:", s);

    // 2. Blockchain connection
    const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);

    const wallet = new ethers.Wallet(
      process.env.PRIVATE_KEY,
      provider
    );

    console.log("BOT WALLET:", wallet.address);

    // 3. Oracle contract
    const oracle = new ethers.Contract(
      process.env.ORACLE_ADDRESS,
      [
        "function pushSignal(uint256,uint256,uint256,uint256,int256,uint256,string)"
      ],
      wallet
    );

    // 4. Send transaction
    const tx = await oracle.pushSignal(
      s.burnRateBps,
      s.apyMultiplier,
      s.mintCapMillions,
      s.btcPriceCents,
      s.btcChangeBps,
      s.fearGreed,
      s.mood
    );

    console.log("TX SENT:", tx.hash);

    await tx.wait();

    return res.status(200).json({
      success: true,
      txHash: tx.hash
    });

  } catch (err) {
    console.error("ERROR:", err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
