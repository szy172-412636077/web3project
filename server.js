require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require("ethers");
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ------------------- 設定靜態網頁 -------------------
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// ------------------- 環境變數檢查 -------------------
if (!process.env.PRIVATE_KEY || !process.env.RPC_URL || !process.env.CONTRACT_ADDRESS) {
    console.error("❌ 錯誤: .env 檔案缺少必要變數");
}

// ------------------- 正確的 ABI (已修正巢狀括號問題) -------------------
const CONTRACT_ABI = [
    { "inputs": [], "stateMutability": "nonpayable", "type": "constructor" },
    { "inputs": [{ "internalType": "bytes32", "name": "tradeId", "type": "bytes32" }], "name": "confirmReceived", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "bytes32", "name": "tradeId", "type": "bytes32" }, { "internalType": "address payable", "name": "buyer", "type": "address" }, { "internalType": "uint256", "name": "amountWei", "type": "uint256" }, { "internalType": "string", "name": "fileHash", "type": "string" }], "name": "createTrade", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "bytes32", "name": "tradeId", "type": "bytes32" }], "name": "deposit", "outputs": [], "stateMutability": "payable", "type": "function" },
    { "inputs": [{ "internalType": "bytes32", "name": "tradeId", "type": "bytes32" }], "name": "markShipped", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "bytes32", "name": "tradeId", "type": "bytes32" }], "name": "raiseDispute", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "bytes32", "name": "tradeId", "type": "bytes32" }], "name": "refundAll", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "bytes32", "name": "tradeId", "type": "bytes32" }, { "internalType": "address payable", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }], "name": "resolveDispute", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "bytes32", "name": "tradeId", "type": "bytes32" }], "name": "getTrade", "outputs": [{ "internalType": "address", "name": "seller", "type": "address" }, { "internalType": "address", "name": "buyer", "type": "address" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "createdAt", "type": "uint256" }, { "internalType": "string", "name": "fileHash", "type": "string" }, { "internalType": "enum SecureSwapEscrow.Status", "name": "status", "type": "uint8" }], "stateMutability": "view", "type": "function" }
];

// ------------------- 初始化錢包與合約 -------------------
let contract;
try {
    const privateKey = process.env.PRIVATE_KEY.startsWith("0x") ? process.env.PRIVATE_KEY : "0x" + process.env.PRIVATE_KEY;
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(privateKey, provider);
    contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    console.log("✅ 系統已就緒，操作錢包:", wallet.address);
} catch (e) {
    console.error("❌ 初始化失敗:", e.message);
}

// 通用的 ID 轉換
const formatId = (id) => (id.startsWith("0x") && id.length === 66) ? id : ethers.encodeBytes32String(id);

// -------------------------- API 路由 -------------------------------

// 1. 建立交易
app.post('/createTrade', async (req, res) => {
    try {
        const { tradeId, buyer, priceETH, fileHash } = req.body;
        const id = formatId(tradeId);
        const priceWei = ethers.parseEther(priceETH.toString());
        const tx = await contract.createTrade(id, buyer, priceWei, fileHash || "N/A");
        await tx.wait();
        res.json({ ok: true, txHash: tx.hash });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// 2. 查詢交易
app.get('/getTrade/:id', async (req, res) => {
    try {
        const id = formatId(req.params.id);
        const result = await contract.getTrade(id);
        if (result.seller === "0x0000000000000000000000000000000000000000") {
            return res.status(404).json({ ok: false, error: "查無此交易 ID" });
        }
        res.json({
            ok: true,
            seller: result.seller,
            buyer: result.buyer,
            amountETH: ethers.formatEther(result.amount),
            fileHash: result.fileHash,
            status: Number(result.status),
            createdAt: result.createdAt.toString()
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// 3. 買家支付 (Deposit)
app.post('/deposit', async (req, res) => {
    try {
        const { tradeId, priceETH } = req.body;
        const tx = await contract.deposit(formatId(tradeId), { value: ethers.parseEther(priceETH.toString()) });
        await tx.wait();
        res.json({ ok: true, txHash: tx.hash });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 4. 確認收貨 (Confirm)
app.post('/confirm', async (req, res) => {
    try {
        const tx = await contract.confirmReceived(formatId(req.body.tradeId));
        await tx.wait();
        res.json({ ok: true, txHash: tx.hash });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 5. 提出爭議 (Dispute)
app.post('/dispute', async (req, res) => {
    try {
        const tx = await contract.raiseDispute(formatId(req.body.tradeId));
        await tx.wait();
        res.json({ ok: true, txHash: tx.hash });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 6. 仲裁解決 (Admin Only)
app.post('/resolveDispute', async (req, res) => {
    try {
        const { tradeId, resolution } = req.body;
        const id = formatId(tradeId);
        let tx;
        if (resolution === 1) {
            tx = await contract.refundAll(id);
        } else {
            const data = await contract.getTrade(id);
            tx = await contract.resolveDispute(id, data.seller, data.amount);
        }
        await tx.wait();
        res.json({ ok: true, txHash: tx.hash });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));