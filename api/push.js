import { ethers } from "ethers";

const RPC_URL = "https://rpc-amoy.polygon.technology";
const ORACLE_ADDRESS = "0xDd527A5441cdC8b666F0D95a4DF639Bcc5A5b8C8";

// ABI (only required function)
const ABI = [
  "function pushSignal(uint256 burnRate, uint256 apy, uint256 mintCap) external"
];

export default async function handler(req, res) {
  try {
    // 1. Get AI signal
    const response = await fetch("https://neuralmint-oracle.vercel.app/api/signal");
    const data = await response.json();

    const burnRate = Math.floor(data.burnRate * 100);
    const apy = Math.floor(data.apy * 100);
    const mintCap = data.mintCap;

    // 2. Blockchain setup
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const contract = new ethers.Contract(ORACLE_ADDRESS, ABI, wallet);

    // 3. Send transaction
    const tx = await contract.pushSignal(burnRate, apy, mintCap);
    await tx.wait();

    res.status(200).json({ success: true, txHash: tx.hash });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
