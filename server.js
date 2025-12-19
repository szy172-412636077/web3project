
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require("ethers");
const path = require('path'); // ⭐ 這裡只宣告一次，不會再報錯了

const app = express();
app.use(cors());
app.use(express.json());

diagnose();

// ------------------- 設定靜態網頁 -------------------
// 強制指向 public 資料夾
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// 當連線到首頁時，回傳 index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// ------------------- 環境變數檢查 -------------------
if (!process.env.PRIVATE_KEY || !process.env.RPC_URL || !process.env.CONTRACT_ADDRESS) {
    console.error("❌ 錯誤: .env 檔案缺少必要變數");
}

// ------------------- 初始化錢包 -------------------
try {
    const privateKey = process.env.PRIVATE_KEY.startsWith("0x") 
        ? process.env.PRIVATE_KEY 
        : "0x" + process.env.PRIVATE_KEY;

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    // 建立全域 wallet 物件
    global.wallet = new ethers.Wallet(privateKey, provider);
    
    console.log("✅ 錢包已連線:", global.wallet.address);

    // 檢查餘額 (新增功能：啟動時檢查有沒有錢)
    provider.getBalance(global.wallet.address).then((balance) => {
        console.log(`💰 錢包餘額: ${ethers.formatEther(balance)} ETH`);
        if (balance === 0n) {
            console.error("⚠️ 警告: 錢包餘額為 0，交易將會失敗！請轉入測試幣。");
        }
    });

    const CONTRACT_ABI = [
        "function createTrade(bytes32 tradeId, address buyer, uint256 amountWei, string fileHash) external",
        "function deposit(bytes32 tradeId) payable external",
        "function confirmReceived(bytes32 tradeId) external",
        "function raiseDispute(bytes32 tradeId) external",
        "function getTrade(bytes32 tradeId) external view returns (address, address, uint256, string memory, uint8, uint256)"
    ];
    
    global.contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, CONTRACT_ABI, global.wallet);

} catch (error) {
    console.error("❌ 初始化失敗:", error.message);
}

async function diagnose() {
    console.log("🔍 正在驗證合約地址...");
    try {
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const code = await provider.getCode(process.env.CONTRACT_ADDRESS);
        
        if (code === "0x" || code === "0x0") {
            console.error("❌ 嚴重錯誤：合約地址上找不到任何程式碼！");
            console.error("👉 請確認 .env 中的 CONTRACT_ADDRESS 是否正確，且已部署在 Sepolia。");
        } else {
            console.log("✅ 合約地址驗證成功，上面存有程式碼。");
        }
    } catch (err) {
        console.error("❌ 診斷過程出錯：", err.message);
    }
}
setTimeout(diagnose, 2000); // 延遲兩秒執行確保環境已就緒
// -------------------------- API 路由 -------------------------------

// 通用的 ID 轉換函數，確保字串正確轉為 bytes32
const formatId = (id) => (id.startsWith("0x") && id.length === 66) ? id : ethers.encodeBytes32String(id);

// 1. 建立交易 (Seller)
app.post('/createTrade', async (req, res) => {
    try {
        const { tradeId, buyer, priceETH, fileHash } = req.body;
        const id = formatId(tradeId); // 統一格式
        const priceWei = ethers.parseEther(priceETH.toString()); // v6 寫法

        const tx = await global.contract.createTrade(id, buyer, priceWei, fileHash || "N/A");
        await tx.wait();
        res.json({ ok: true, txHash: tx.hash });
    } catch (e) {
        console.error("❌ Create Error:", e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// 2. 查詢交易 (Buyer/Seller)
app.get('/getTrade/:id', async (req, res) => {
    try {
        const id = formatId(req.params.id); // 確保格式一致
        const result = await global.contract.getTrade(id);

        // 如果賣家地址是 0x00... 代表這筆交易不存在
        if (result[0] === "0x0000000000000000000000000000000000000000") {
            return res.status(404).json({ ok: false, error: "查無此交易 ID，請確認是否輸入正確。" });
        }

        res.json({
            ok: true,
            seller: result[0],
            buyer: result[1],
            amountETH: ethers.formatEther(result[2]),
            fileHash: result[3],
            status: Number(result[4]),
            createdAt: result[5].toString()
        });
    } catch (e) {
        console.error("❌ Get Error:", e.message);
        res.status(500).json({ ok: false, error: "讀取合約失敗" });
    }
});
// 3. 買家支付托管金 (Deposit)
app.post('/deposit', async (req, res) => {
    try {
        const { tradeId, priceETH } = req.body;
        const id = formatId(tradeId);
        const tx = await global.contract.deposit(id, { value: ethers.parseEther(priceETH.toString()) });
        await tx.wait();
        res.json({ ok: true, txHash: tx.hash });
    } catch (e) { 
        res.status(500).json({ ok: false, error: e.message }); 
    }
});

// 4. 確認收貨 (Confirm)
app.post('/confirm', async (req, res) => {
    try {
        const { tradeId } = req.body;
        const id = formatId(tradeId);
        const tx = await global.contract.confirmReceived(id);
        await tx.wait();
        res.json({ ok: true, txHash: tx.hash });
    } catch (e) { 
        res.status(500).json({ ok: false, error: e.message }); 
    }
});

// 5. 提出爭議 (Dispute)
app.post('/dispute', async (req, res) => {
    try {
        const { tradeId } = req.body;
        const id = formatId(tradeId);
        const tx = await global.contract.raiseDispute(id);
        await tx.wait();
        res.json({ ok: true, txHash: tx.hash });
    } catch (e) { 
        res.status(500).json({ ok: false, error: e.message }); 
    }
});

// -------------------------- 啟動伺服器 -------------------------------
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
});