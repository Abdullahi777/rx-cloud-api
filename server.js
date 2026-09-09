const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Persistent JSON file paths
const DB_FILE = path.join(__dirname, 'prescriptions_db.json');
const INVENTORY_FILE = path.join(__dirname, 'inventory_db.json');
const TRANSACTIONS_FILE = path.join(__dirname, 'transactions_db.json');
const MPESA_CONFIG_FILE = path.join(__dirname, 'mpesa.config.json');
const MPESA_LOGS_FILE = path.join(__dirname, 'mpesa_transactions.json');

const loadData = (file, defaultValue) => {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.warn(`Could not read ${file}:`, err.message);
  }
  return defaultValue;
};

let prescriptions = loadData(DB_FILE, []);
let inventoryStore = loadData(INVENTORY_FILE, {});
let transactionsStore = loadData(TRANSACTIONS_FILE, {});
let mpesaTransactions = loadData(MPESA_LOGS_FILE, []);

let MPESA_KEYS = loadData(MPESA_CONFIG_FILE, {
  isSandbox: true,
  consumerKey: "ENTER_YOUR_SANDBOX_CONSUMER_KEY_HERE",
  consumerSecret: "ENTER_YOUR_SANDBOX_CONSUMER_SECRET_HERE",
  businessShortCode: "174379",
  passkey: "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
  callbackUrl: "https://rx-cloud-api-c2kx.onrender.com/api/mpesa/callback",
  ownerPin: "1234"
});

const savePrescriptions = () => fs.writeFileSync(DB_FILE, JSON.stringify(prescriptions, null, 2));
const saveInventory = () => fs.writeFileSync(INVENTORY_FILE, JSON.stringify(inventoryStore, null, 2));
const saveTransactions = () => fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactionsStore, null, 2));
const saveMpesaTransactions = () => fs.writeFileSync(MPESA_LOGS_FILE, JSON.stringify(mpesaTransactions, null, 2));
const saveMpesaConfig = () => fs.writeFileSync(MPESA_CONFIG_FILE, JSON.stringify(MPESA_KEYS, null, 2));

const getDarajaBaseUrl = () => MPESA_KEYS.isSandbox ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const getAccessToken = async (req, res, next) => {
  const baseUrl = getDarajaBaseUrl();
  const cKey = String(MPESA_KEYS.consumerKey || '').trim();
  const cSec = String(MPESA_KEYS.consumerSecret || '').trim();

  if (!cKey || cKey.includes("ENTER_YOUR") || !cSec || cSec.includes("ENTER_YOUR")) {
    return res.status(400).json({
      success: false,
      errorMessage: "Please enter your Daraja Consumer Key & Secret in Store Settings."
    });
  }

  try {
    const auth = Buffer.from(`${cKey}:${cSec}`).toString("base64");
    const response = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` }
    });
    req.accessToken = response.data.access_token;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      errorMessage: "Authentication failed with Safaricom. Check your Consumer Key & Secret."
    });
  }
};

app.post("/api/settings", (req, res) => {
  const newKeys = req.body;
  if (newKeys.consumerKey) MPESA_KEYS.consumerKey = newKeys.consumerKey.trim();
  if (newKeys.consumerSecret) MPESA_KEYS.consumerSecret = newKeys.consumerSecret.trim();
  if (newKeys.businessShortCode) MPESA_KEYS.businessShortCode = newKeys.businessShortCode.trim();
  if (newKeys.passkey) MPESA_KEYS.passkey = newKeys.passkey.trim();
  if (newKeys.ownerPin) MPESA_KEYS.ownerPin = String(newKeys.ownerPin).trim();
  if (newKeys.isSandbox !== undefined) MPESA_KEYS.isSandbox = Boolean(newKeys.isSandbox);
  MPESA_KEYS.callbackUrl = "https://rx-cloud-api-c2kx.onrender.com/api/mpesa/callback";

  saveMpesaConfig();
  res.json({ success: true, message: "Settings saved successfully." });
});

app.post("/api/mpesa/stkpush", getAccessToken, async (req, res) => {
  const { phone, phoneNumber, amount, accountReference } = req.body;
  const rawPhone = String(phone || phoneNumber || "").replace(/\s+/g, "");
  
  let formattedPhone = rawPhone;
  if (formattedPhone.startsWith("0")) formattedPhone = "254" + formattedPhone.slice(1);
  if (formattedPhone.startsWith("+")) formattedPhone = formattedPhone.slice(1);
  if (!formattedPhone.startsWith("254")) formattedPhone = "254" + formattedPhone;

  const date = new Date();
  const timestamp = date.getFullYear() +
    ("0" + (date.getMonth() + 1)).slice(-2) +
    ("0" + date.getDate()).slice(-2) +
    ("0" + date.getHours()).slice(-2) +
    ("0" + date.getMinutes()).slice(-2) +
    ("0" + date.getSeconds()).slice(-2);

  const shortcode = (MPESA_KEYS.businessShortCode || "174379").trim();
  const passkey = (MPESA_KEYS.passkey || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919").trim();
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
  const callbackUrl = "https://rx-cloud-api-c2kx.onrender.com/api/mpesa/callback";

  const transactionType = (shortcode === "174379" || shortcode.length <= 6)
    ? "CustomerPayBillOnline"
    : "CustomerBuyGoodsOnline";

  const baseUrl = getDarajaBaseUrl();

  try {
    const response = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        "BusinessShortCode": shortcode,
        "Password": password,
        "Timestamp": timestamp,
        "TransactionType": transactionType,
        "Amount": Math.floor(amount),
        "PartyA": formattedPhone,
        "PartyB": shortcode,
        "PhoneNumber": formattedPhone,
        "CallBackURL": callbackUrl,
        "AccountReference": accountReference || "PharmaLink",
        "TransactionDesc": "Pharmacy Medicine Purchase"
      },
      { headers: { Authorization: `Bearer ${req.accessToken}` } }
    );

    res.json({
      success: true,
      message: "STK Push Sent",
      checkoutRequestId: response.data.CheckoutRequestID || response.data.checkoutRequestID
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      errorMessage: error.response?.data?.errorMessage || "STK Push Failed."
    });
  }
});

app.post("/api/mpesa/callback", (req, res) => {
  try {
    const body = req.body;
    let transaction = null;

    if (body.Body && body.Body.stkCallback) {
      const result = body.Body.stkCallback;
      if (result.ResultCode === 0) {
        const meta = result.CallbackMetadata.Item;
        transaction = {
          id: meta.find(i => i.Name === "MpesaReceiptNumber")?.Value || `STK_${Date.now()}`,
          phone: meta.find(i => i.Name === "PhoneNumber")?.Value?.toString(),
          amount: meta.find(i => i.Name === "Amount")?.Value,
          date: new Date().toISOString(),
          checkoutRequestId: result.CheckoutRequestID
        };
      }
    }

    if (transaction) {
      mpesaTransactions.unshift(transaction);
      saveMpesaTransactions();
    }
    res.json({ result: "success" });
  } catch (error) {
    res.status(500).send("Error");
  }
});

app.get("/api/mpesa/verify", (req, res) => {
  const { phone, amount, checkoutRequestId } = req.query;
  const cleanPhone = phone ? phone.replace(/^254|^0/, "") : "";

  const match = mpesaTransactions.find(t => {
    if (checkoutRequestId && t.checkoutRequestId === checkoutRequestId) return true;
    const tPhone = (t.phone || "").replace(/^254|^0/, "");
    const phoneMatch = !cleanPhone || tPhone.includes(cleanPhone);
    const amountMatch = parseFloat(t.amount) >= parseFloat(amount);
    return phoneMatch && amountMatch;
  });

  if (match) {
    res.json({ success: true, transaction: match });
  } else {
    res.json({ success: false, message: "Waiting for PIN..." });
  }
});

app.post('/api/pos/sync-inventory', (req, res) => {
  const { pharmacyId, items } = req.body;
  if (!pharmacyId || !Array.isArray(items)) return res.status(400).json({ error: 'Invalid payload' });

  inventoryStore[pharmacyId] = items;
  saveInventory();
  res.json({ status: 'success', count: items.length });
});

app.get('/api/pharmacies/:pharmacyId/inventory', (req, res) => {
  const { pharmacyId } = req.params;
  const { search } = req.query;
  const items = inventoryStore[pharmacyId] || [];

  if (!search) return res.json(items);

  const q = search.toLowerCase().trim();
  res.json(items.filter(i => 
    String(i.name || '').toLowerCase().includes(q) || 
    String(i.category || '').toLowerCase().includes(q)
  ));
});

app.post('/api/prescriptions', (req, res) => {
  const { doctorName, patientName, patientPhone, pharmacyId, diagnosis, vitals, items } = req.body;
  if (!patientName || !items || items.length === 0) return res.status(400).json({ error: 'Missing fields' });

  const rxId = 'RX-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const newRx = {
    id: rxId,
    doctorName: doctorName || 'Dr. Abdullahi M.',
    patientName,
    patientPhone: patientPhone || '',
    pharmacyId: pharmacyId || 'garissa-branch',
    diagnosis: diagnosis || 'General Consultation',
    vitals: vitals || {},
    items,
    status: 'pending_dispense',
    createdAt: new Date().toISOString(),
    dispensedAt: null
  };

  prescriptions.unshift(newRx);
  savePrescriptions();
  res.status(201).json(newRx);
});

app.get('/api/prescriptions', (req, res) => res.json(prescriptions));

app.get('/api/pos/:pharmacyId/prescriptions', (req, res) => {
  const { pharmacyId } = req.params;
  const pending = prescriptions.filter(
    rx => rx.pharmacyId === pharmacyId && rx.status === 'pending_dispense'
  );
  res.json(pending);
});

app.post('/api/prescriptions/:id/dispense', (req, res) => {
  const rx = prescriptions.find(r => r.id === req.params.id);
  if (!rx) return res.status(404).json({ error: 'Prescription not found' });

  rx.status = 'dispensed';
  rx.dispensedAt = new Date().toISOString();
  savePrescriptions();
  res.json({ status: 'success', prescription: rx });
});

app.post('/api/pos/sync-transactions', (req, res) => {
  const { pharmacyId, transaction } = req.body;
  if (!pharmacyId || !transaction) return res.status(400).json({ error: 'Missing fields' });

  if (!transactionsStore[pharmacyId]) transactionsStore[pharmacyId] = [];
  transactionsStore[pharmacyId].unshift(transaction);
  saveTransactions();
  res.json({ status: 'success' });
});

// Detailed Summary & Historical Reports Endpoint
app.get('/api/owner/:pharmacyId/summary', (req, res) => {
  const { pharmacyId } = req.params;
  const { pin } = req.query;

  const validPin = String(MPESA_KEYS.ownerPin || '1234').trim();
  if (String(pin || '').trim() !== validPin) {
    return res.status(401).json({ error: 'Invalid Owner Security PIN' });
  }

  const txns = transactionsStore[pharmacyId] || [];
  const inventory = inventoryStore[pharmacyId] || [];

  const todayStr = new Date().toISOString().split('T')[0];
  const todayTxns = txns.filter(t => t.isoDate === todayStr);

  const totalRevenue = todayTxns.reduce((sum, t) => sum + (Number(t.total) || 0), 0);
  const mpesaRevenue = todayTxns.filter(t => t.method === 'MPESA').reduce((sum, t) => sum + (Number(t.total) || 0), 0);
  const cashRevenue = todayTxns.filter(t => t.method === 'CASH').reduce((sum, t) => sum + (Number(t.total) || 0), 0);

  // Group all past transactions by day for historical reports
  const dailyHistory = {};
  txns.forEach(t => {
    const d = t.isoDate || (t.date ? String(t.date).split(',')[0].trim() : 'Unknown');
    if (!dailyHistory[d]) {
      dailyHistory[d] = { date: d, total: 0, mpesa: 0, cash: 0, count: 0 };
    }
    const amt = Number(t.total) || 0;
    dailyHistory[d].total += amt;
    dailyHistory[d].count += 1;
    if (t.method === 'MPESA') dailyHistory[d].mpesa += amt;
    else dailyHistory[d].cash += amt;
  });

  const dailyReports = Object.values(dailyHistory).sort((a, b) => b.date.localeCompare(a.date));
  const allTimeRevenue = txns.reduce((sum, t) => sum + (Number(t.total) || 0), 0);

  res.json({
    pharmacyId,
    today: {
      totalRevenue,
      mpesaRevenue,
      cashRevenue,
      transactionCount: todayTxns.length
    },
    allTime: {
      totalRevenue: allTimeRevenue,
      totalCount: txns.length
    },
    dailyReports,
    recentTransactions: txns.slice(0, 100),
    inventorySummary: {
      totalProducts: inventory.length,
      lowStockCount: inventory.filter(i => Number(i.stock) < 20).length
    }
  });
});

// Endpoint: Change Owner PIN
app.post('/api/owner/:pharmacyId/change-pin', (req, res) => {
  const { currentPin, newPin } = req.body;
  const activePin = String(MPESA_KEYS.ownerPin || '1234').trim();

  if (String(currentPin || '').trim() !== activePin) {
    return res.status(401).json({ success: false, error: 'Current PIN is incorrect.' });
  }

  const cleanNew = String(newPin || '').trim();
  if (!/^\d{4}$/.test(cleanNew)) {
    return res.status(400).json({ success: false, error: 'New PIN must be exactly 4 digits.' });
  }

  MPESA_KEYS.ownerPin = cleanNew;
  saveMpesaConfig();
  console.log(`[SECURITY] Owner PIN updated for ${req.params.pharmacyId}`);
  res.json({ success: true, message: 'PIN updated successfully!' });
});

// ==========================================
// SECURE OWNER MOBILE DASHBOARD (WITH REPORTS & HISTORY)
// ==========================================

app.get('/owner', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>PharmaLink - Owner Live & Reports</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-800 font-sans min-h-screen flex flex-col justify-center p-3 selection:bg-emerald-500 selection:text-white">

  <!-- PIN LOCKPAD SCREEN -->
  <div id="pinScreen" class="max-w-xs mx-auto w-full text-center space-y-6">
    <div class="space-y-2">
      <div class="w-16 h-16 bg-emerald-600/20 border border-emerald-500/30 rounded-3xl flex items-center justify-center mx-auto text-emerald-400">
        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
        </svg>
      </div>
      <h2 class="text-xl font-black text-white">Owner Security Lock</h2>
      <p class="text-xs text-slate-400">Enter your 4-digit PIN to access live monitor & reports</p>
    </div>

    <!-- 4-Dot Display -->
    <div class="flex justify-center gap-4 py-2">
      <span class="w-4 h-4 rounded-full border-2 border-slate-600 bg-slate-800 transition-all" id="dot0"></span>
      <span class="w-4 h-4 rounded-full border-2 border-slate-600 bg-slate-800 transition-all" id="dot1"></span>
      <span class="w-4 h-4 rounded-full border-2 border-slate-600 bg-slate-800 transition-all" id="dot2"></span>
      <span class="w-4 h-4 rounded-full border-2 border-slate-600 bg-slate-800 transition-all" id="dot3"></span>
    </div>

    <p id="errorMsg" class="text-xs font-bold text-red-400 hidden">Incorrect PIN. Try again.</p>

    <!-- Keypad -->
    <div class="grid grid-cols-3 gap-3 pt-2">
      <button onclick="pressKey('1')" class="h-14 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xl rounded-2xl active:scale-95 transition border border-slate-700">1</button>
      <button onclick="pressKey('2')" class="h-14 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xl rounded-2xl active:scale-95 transition border border-slate-700">2</button>
      <button onclick="pressKey('3')" class="h-14 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xl rounded-2xl active:scale-95 transition border border-slate-700">3</button>
      <button onclick="pressKey('4')" class="h-14 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xl rounded-2xl active:scale-95 transition border border-slate-700">4</button>
      <button onclick="pressKey('5')" class="h-14 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xl rounded-2xl active:scale-95 transition border border-slate-700">5</button>
      <button onclick="pressKey('6')" class="h-14 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xl rounded-2xl active:scale-95 transition border border-slate-700">6</button>
      <button onclick="pressKey('7')" class="h-14 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xl rounded-2xl active:scale-95 transition border border-slate-700">7</button>
      <button onclick="pressKey('8')" class="h-14 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xl rounded-2xl active:scale-95 transition border border-slate-700">8</button>
      <button onclick="pressKey('9')" class="h-14 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xl rounded-2xl active:scale-95 transition border border-slate-700">9</button>
      <button onclick="clearPin()" class="h-14 bg-slate-800/40 text-slate-400 font-bold text-xs rounded-2xl active:scale-95 transition">CLEAR</button>
      <button onclick="pressKey('0')" class="h-14 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xl rounded-2xl active:scale-95 transition border border-slate-700">0</button>
      <button onclick="backspace()" class="h-14 bg-slate-800/40 text-slate-400 font-bold text-base rounded-2xl active:scale-95 transition flex items-center justify-center">&#9003;</button>
    </div>
  </div>

  <!-- MAIN DASHBOARD (HIDDEN UNTIL UNLOCKED) -->
  <div id="dashboardScreen" class="max-w-md mx-auto w-full space-y-4 hidden pb-12">
    <!-- Header -->
    <div class="bg-emerald-900 text-white p-5 rounded-3xl shadow-xl flex justify-between items-center border border-emerald-800">
      <div>
        <h1 class="text-lg font-black tracking-wide text-emerald-400">PharmaLink Live</h1>
        <p class="text-xs text-emerald-200">Owner Monitor & Reports</p>
      </div>
      <div class="flex gap-1.5">
        <button onclick="openChangePinModal()" class="bg-emerald-950 hover:bg-emerald-800 text-emerald-200 text-xs font-bold px-2.5 py-1.5 rounded-xl border border-emerald-700 transition">
          PIN
        </button>
        <button onclick="lockScreen()" class="bg-emerald-950 hover:bg-red-900/60 text-emerald-200 hover:text-red-200 text-xs font-bold px-2.5 py-1.5 rounded-xl border border-emerald-700 transition">
          Lock
        </button>
      </div>
    </div>

    <!-- TAB SWITCHER: TODAY vs REPORTS -->
    <div class="grid grid-cols-2 gap-2 bg-slate-200 p-1.5 rounded-2xl">
      <button id="tabTodayBtn" onclick="switchView('today')" class="py-2 text-xs font-bold rounded-xl bg-white text-slate-900 shadow-sm transition">
        Live Today
      </button>
      <button id="tabReportsBtn" onclick="switchView('reports')" class="py-2 text-xs font-bold rounded-xl text-slate-600 hover:text-slate-900 transition">
        Reports & History
      </button>
    </div>

    <!-- VIEW 1: TODAY'S LIVE MONITOR -->
    <div id="todayView" class="space-y-4">
      <div class="bg-white p-5 rounded-3xl shadow-sm border border-slate-200 space-y-3">
        <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">Today's Sales</span>
        <div class="text-3xl font-black text-slate-900" id="totalSales">KES 0</div>
        
        <div class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
          <div class="bg-green-50 p-3 rounded-2xl border border-green-100">
            <span class="text-[10px] font-bold text-green-700 uppercase">M-Pesa</span>
            <p class="text-lg font-bold text-green-800" id="mpesaSales">KES 0</p>
          </div>
          <div class="bg-blue-50 p-3 rounded-2xl border border-blue-100">
            <span class="text-[10px] font-bold text-blue-700 uppercase">Cash</span>
            <p class="text-lg font-bold text-blue-800" id="cashSales">KES 0</p>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <span class="text-[10px] font-bold text-slate-400 uppercase">Catalog Items</span>
          <p class="text-xl font-black text-slate-800" id="catalogCount">0 items</p>
        </div>
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <span class="text-[10px] font-bold text-orange-600 uppercase">Low Stock</span>
          <p class="text-xl font-black text-orange-600" id="lowStockCount">0 items</p>
        </div>
      </div>

      <div class="bg-white p-5 rounded-3xl shadow-sm border border-slate-200 space-y-3">
        <div class="flex justify-between items-center border-b pb-2">
          <h3 class="font-bold text-sm text-slate-800">Today's Receipts</h3>
          <span class="text-xs text-slate-400" id="txCount">0 sales</span>
        </div>
        <div id="txList" class="space-y-2 max-h-80 overflow-y-auto divide-y divide-slate-100 text-xs"></div>
      </div>
    </div>

    <!-- VIEW 2: HISTORICAL REPORTS & DAILY LOGS -->
    <div id="reportsView" class="space-y-4 hidden">
      <!-- All-Time Revenue Card -->
      <div class="bg-gradient-to-r from-slate-900 to-slate-800 text-white p-5 rounded-3xl shadow-md border border-slate-700 space-y-2">
        <span class="text-[10px] font-bold uppercase text-emerald-400 tracking-wider">All-Time Recorded Sales</span>
        <div class="text-3xl font-black text-white" id="allTimeRevenue">KES 0</div>
        <p class="text-xs text-slate-400" id="allTimeCount">0 total transactions</p>
      </div>

      <!-- Daily Sales Summary Breakdown -->
      <div class="bg-white p-5 rounded-3xl shadow-sm border border-slate-200 space-y-3">
        <h3 class="font-bold text-sm text-slate-800 border-b pb-2">Daily Revenue History</h3>
        <div id="dailyList" class="space-y-2.5 max-h-60 overflow-y-auto text-xs divide-y divide-slate-100">
          <p class="text-slate-400 text-center py-3">Loading daily reports...</p>
        </div>
      </div>

      <!-- Full Historical Transactions Feed -->
      <div class="bg-white p-5 rounded-3xl shadow-sm border border-slate-200 space-y-3">
        <div class="flex justify-between items-center border-b pb-2">
          <h3 class="font-bold text-sm text-slate-800">All Past Receipts</h3>
          <span class="text-xs text-slate-400">Click receipt for items</span>
        </div>
        <div id="allTxList" class="space-y-2 max-h-96 overflow-y-auto divide-y divide-slate-100 text-xs"></div>
      </div>
    </div>

  </div>

  <!-- CHANGE PIN MODAL -->
  <div id="changePinModal" class="fixed inset-0 bg-black/70 backdrop-blur-sm hidden items-center justify-center p-4 z-50">
    <div class="bg-slate-900 border border-slate-700 rounded-3xl p-6 w-full max-w-xs text-center space-y-4 shadow-2xl">
      <h3 class="text-white font-bold text-base">Change Security PIN</h3>
      <p class="text-xs text-slate-400">Enter your current PIN and choose a new 4-digit PIN.</p>
      
      <div class="space-y-3 text-left">
        <div>
          <label class="text-[10px] uppercase font-bold text-slate-400">Current PIN</label>
          <input id="oldPinInput" type="password" maxlength="4" placeholder="••••" class="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-white text-center font-mono text-lg outline-none focus:border-emerald-500 mt-1" />
        </div>
        <div>
          <label class="text-[10px] uppercase font-bold text-slate-400">New 4-Digit PIN</label>
          <input id="newPinInput" type="password" maxlength="4" placeholder="••••" class="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-white text-center font-mono text-lg outline-none focus:border-emerald-500 mt-1" />
        </div>
      </div>

      <p id="pinModalMsg" class="text-xs font-bold text-red-400 hidden"></p>

      <div class="flex gap-2 pt-2">
        <button onclick="closeChangePinModal()" class="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition">
          Cancel
        </button>
        <button onclick="submitChangePin()" class="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition">
          Save PIN
        </button>
      </div>
    </div>
  </div>

  <!-- RECEIPT ITEMS DETAIL MODAL -->
  <div id="receiptModal" class="fixed inset-0 bg-black/70 backdrop-blur-sm hidden items-center justify-center p-4 z-50">
    <div class="bg-white rounded-3xl p-5 w-full max-w-sm space-y-4 shadow-2xl text-xs">
      <div class="flex justify-between items-start border-b pb-3">
        <div>
          <h4 class="font-bold text-sm text-slate-800" id="receiptModalRef">Receipt</h4>
          <p class="text-[10px] text-slate-400" id="receiptModalDate"></p>
        </div>
        <button onclick="closeReceiptModal()" class="text-slate-400 hover:text-slate-600 font-bold text-base">&times;</button>
      </div>

      <div>
        <h5 class="font-bold text-slate-600 uppercase text-[10px] mb-2">Sold Medications</h5>
        <div id="receiptModalItems" class="space-y-1.5 divide-y divide-slate-100 max-h-48 overflow-y-auto"></div>
      </div>

      <div class="border-t pt-3 flex justify-between items-center text-sm font-bold">
        <span>Total Paid:</span>
        <span class="text-emerald-700" id="receiptModalTotal">KES 0</span>
      </div>

      <button onclick="closeReceiptModal()" class="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold">
        Close
      </button>
    </div>
  </div>

  <script>
    var currentPin = '';
    var pollTimer = null;
    var cachedData = null;

    function updateDots() {
      for (var i = 0; i < 4; i++) {
        var dot = document.getElementById('dot' + i);
        if (i < currentPin.length) {
          dot.className = "w-4 h-4 rounded-full bg-emerald-400 border-2 border-emerald-400 scale-110 transition-all";
        } else {
          dot.className = "w-4 h-4 rounded-full border-2 border-slate-600 bg-slate-800 transition-all";
        }
      }
    }

    function pressKey(num) {
      if (currentPin.length >= 4) return;
      currentPin += num;
      updateDots();
      if (currentPin.length === 4) {
        submitPin();
      }
    }

    function clearPin() {
      currentPin = '';
      updateDots();
      document.getElementById('errorMsg').classList.add('hidden');
    }

    function backspace() {
      currentPin = currentPin.slice(0, -1);
      updateDots();
    }

    function submitPin() {
      var pin = currentPin;
      fetch('/api/owner/garissa-branch/summary?pin=' + encodeURIComponent(pin))
        .then(function(res) {
          if (res.status === 200) {
            sessionStorage.setItem('pharmalink_owner_pin', pin);
            showDashboard();
          } else {
            document.getElementById('errorMsg').classList.remove('hidden');
            clearPin();
          }
        })
        .catch(function(err) {
          alert('Could not reach server.');
          clearPin();
        });
    }

    function showDashboard() {
      document.getElementById('pinScreen').classList.add('hidden');
      document.getElementById('dashboardScreen').classList.remove('hidden');
      document.body.className = "bg-slate-100 text-slate-800 font-sans min-h-screen p-3";
      fetchOwnerData();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(fetchOwnerData, 4000);
    }

    function lockScreen() {
      sessionStorage.removeItem('pharmalink_owner_pin');
      if (pollTimer) clearInterval(pollTimer);
      document.getElementById('dashboardScreen').classList.add('hidden');
      document.getElementById('pinScreen').classList.remove('hidden');
      document.body.className = "bg-slate-900 text-slate-800 font-sans min-h-screen flex flex-col justify-center p-3";
      clearPin();
    }

    function switchView(tab) {
      var todayView = document.getElementById('todayView');
      var reportsView = document.getElementById('reportsView');
      var tabTodayBtn = document.getElementById('tabTodayBtn');
      var tabReportsBtn = document.getElementById('tabReportsBtn');

      if (tab === 'today') {
        todayView.classList.remove('hidden');
        reportsView.classList.add('hidden');
        tabTodayBtn.className = "py-2 text-xs font-bold rounded-xl bg-white text-slate-900 shadow-sm transition";
        tabReportsBtn.className = "py-2 text-xs font-bold rounded-xl text-slate-600 hover:text-slate-900 transition";
      } else {
        todayView.classList.add('hidden');
        reportsView.classList.remove('hidden');
        tabReportsBtn.className = "py-2 text-xs font-bold rounded-xl bg-white text-slate-900 shadow-sm transition";
        tabTodayBtn.className = "py-2 text-xs font-bold rounded-xl text-slate-600 hover:text-slate-900 transition";
        renderReports();
      }
    }

    function fetchOwnerData() {
      var pin = sessionStorage.getItem('pharmalink_owner_pin');
      if (!pin) return lockScreen();

      fetch('/api/owner/garissa-branch/summary?pin=' + encodeURIComponent(pin))
        .then(function(res) {
          if (res.status === 401) return lockScreen();
          return res.json();
        })
        .then(function(data) {
          if (!data || !data.today) return;
          cachedData = data;

          document.getElementById('totalSales').innerText = 'KES ' + Number(data.today.totalRevenue || 0).toLocaleString();
          document.getElementById('mpesaSales').innerText = 'KES ' + Number(data.today.mpesaRevenue || 0).toLocaleString();
          document.getElementById('cashSales').innerText = 'KES ' + Number(data.today.cashRevenue || 0).toLocaleString();
          document.getElementById('txCount').innerText = data.today.transactionCount + ' sales today';
          document.getElementById('catalogCount').innerText = (data.inventorySummary.totalProducts || 0) + ' items';
          document.getElementById('lowStockCount').innerText = (data.inventorySummary.lowStockCount || 0) + ' items';

          var todayStr = new Date().toISOString().split('T')[0];
          var todayTxns = (data.recentTransactions || []).filter(function(t) { return t.isoDate === todayStr; });

          var list = document.getElementById('txList');
          if (todayTxns.length > 0) {
            list.innerHTML = todayTxns.map(function(t, idx) {
              return '<div onclick="showReceiptDetails(' + idx + ')" class="pt-2 flex justify-between items-center cursor-pointer hover:bg-slate-50 p-1 rounded-lg transition">' +
                '<div>' +
                  '<p class="font-bold text-slate-800">' + (t.refId || 'RECEIPT') + ' <span class="font-normal text-[10px] text-slate-400">(' + (t.method || 'CASH') + ')</span></p>' +
                  '<p class="text-[10px] text-slate-400">' + (t.date || '') + '</p>' +
                '</div>' +
                '<span class="font-bold text-sm text-emerald-700">KES ' + Number(t.total || 0).toLocaleString() + '</span>' +
              '</div>';
            }).join('');
          } else {
            list.innerHTML = '<p class="text-center text-slate-400 py-4">Waiting for live sales today...</p>';
          }

          renderReports();
        })
        .catch(function(e) {});
    }

    function renderReports() {
      if (!cachedData) return;

      document.getElementById('allTimeRevenue').innerText = 'KES ' + Number(cachedData.allTime.totalRevenue || 0).toLocaleString();
      document.getElementById('allTimeCount').innerText = cachedData.allTime.totalCount + ' total sales recorded';

      var dailyList = document.getElementById('dailyList');
      if (cachedData.dailyReports && cachedData.dailyReports.length > 0) {
        dailyList.innerHTML = cachedData.dailyReports.map(function(d) {
          return '<div class="pt-2 flex justify-between items-center">' +
            '<div>' +
              '<p class="font-bold text-slate-800">' + d.date + ' <span class="text-[10px] text-slate-400 font-normal">(' + d.count + ' sales)</span></p>' +
              '<p class="text-[10px] text-slate-500">M-Pesa: KES ' + Number(d.mpesa).toLocaleString() + ' &bull; Cash: KES ' + Number(d.cash).toLocaleString() + '</p>' +
            '</div>' +
            '<span class="font-bold text-slate-900 font-mono">KES ' + Number(d.total).toLocaleString() + '</span>' +
          '</div>';
        }).join('');
      } else {
        dailyList.innerHTML = '<p class="text-slate-400 text-center py-2">No historical sales yet.</p>';
      }

      var allTxList = document.getElementById('allTxList');
      if (cachedData.recentTransactions && cachedData.recentTransactions.length > 0) {
        allTxList.innerHTML = cachedData.recentTransactions.map(function(t, idx) {
          return '<div onclick="showReceiptDetails(' + idx + ')" class="pt-2 flex justify-between items-center cursor-pointer hover:bg-slate-50 p-1.5 rounded-xl transition border border-slate-100">' +
            '<div>' +
              '<p class="font-bold text-slate-800">' + (t.refId || 'RECEIPT') + ' <span class="font-normal text-[10px] text-slate-400">(' + (t.method || 'CASH') + ')</span></p>' +
              '<p class="text-[10px] text-slate-400">' + (t.date || '') + ' &bull; ' + (t.items ? t.items.length : 0) + ' items</p>' +
            '</div>' +
            '<span class="font-bold text-sm text-emerald-700">KES ' + Number(t.total || 0).toLocaleString() + '</span>' +
          '</div>';
        }).join('');
      }
    }

    function showReceiptDetails(index) {
      if (!cachedData || !cachedData.recentTransactions || !cachedData.recentTransactions[index]) return;
      var t = cachedData.recentTransactions[index];

      document.getElementById('receiptModalRef').innerText = (t.refId || 'RECEIPT') + ' (' + (t.method || 'CASH') + ')';
      document.getElementById('receiptModalDate').innerText = t.date || '';
      document.getElementById('receiptModalTotal').innerText = 'KES ' + Number(t.total || 0).toLocaleString();

      var itemsContainer = document.getElementById('receiptModalItems');
      if (t.items && t.items.length > 0) {
        itemsContainer.innerHTML = t.items.map(function(it) {
          return '<div class="pt-1.5 flex justify-between text-xs">' +
            '<span>' + it.name + ' <span class="text-slate-400">x' + (it.qty || it.quantity || 1) + '</span></span>' +
            '<span class="font-bold">KES ' + Number(it.price * (it.qty || it.quantity || 1)).toLocaleString() + '</span>' +
          '</div>';
        }).join('');
      } else {
        itemsContainer.innerHTML = '<p class="text-slate-400 py-2">No individual item details.</p>';
      }

      var m = document.getElementById('receiptModal');
      m.classList.remove('hidden');
      m.classList.add('flex');
    }

    function closeReceiptModal() {
      var m = document.getElementById('receiptModal');
      m.classList.add('hidden');
      m.classList.remove('flex');
    }

    function openChangePinModal() {
      var m = document.getElementById('changePinModal');
      m.classList.remove('hidden');
      m.classList.add('flex');
      document.getElementById('oldPinInput').value = '';
      document.getElementById('newPinInput').value = '';
      document.getElementById('pinModalMsg').classList.add('hidden');
    }

    function closeChangePinModal() {
      var m = document.getElementById('changePinModal');
      m.classList.add('hidden');
      m.classList.remove('flex');
    }

    function submitChangePin() {
      var oldPin = document.getElementById('oldPinInput').value.trim();
      var newPin = document.getElementById('newPinInput').value.trim();
      var msg = document.getElementById('pinModalMsg');

      if (oldPin.length !== 4 || newPin.length !== 4) {
        msg.innerText = 'Both PINs must be 4 digits.';
        msg.classList.remove('hidden');
        return;
      }

      fetch('/api/owner/:pharmacyId/change-pin'.replace(':pharmacyId', 'garissa-branch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPin: oldPin, newPin: newPin })
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) {
          sessionStorage.setItem('pharmalink_owner_pin', newPin);
          alert('Security PIN changed successfully!');
          closeChangePinModal();
        } else {
          msg.innerText = data.error || 'Failed to change PIN.';
          msg.classList.remove('hidden');
        }
      })
      .catch(function() {
        msg.innerText = 'Could not reach server.';
        msg.classList.remove('hidden');
      });
    }

    window.onload = function() {
      var savedPin = sessionStorage.getItem('pharmalink_owner_pin');
      if (savedPin) {
        currentPin = savedPin;
        submitPin();
      }
    };
  </script>
</body>
</html>`;

  res.send(html);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
