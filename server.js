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
    console.error(`Safaricom Auth Error (${baseUrl}):`, error.response?.data || error.message);
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

  res.json({
    pharmacyId,
    today: {
      totalRevenue,
      mpesaRevenue,
      cashRevenue,
      transactionCount: todayTxns.length
    },
    recentTransactions: txns.slice(0, 30),
    inventorySummary: {
      totalProducts: inventory.length,
      lowStockCount: inventory.filter(i => Number(i.stock) < 20).length
    }
  });
});

app.get('/owner', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>PharmaLink - Owner Security Access</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-800 font-sans min-h-screen flex flex-col justify-center p-4">

  <!-- PIN LOCKPAD SCREEN -->
  <div id="pinScreen" class="max-w-xs mx-auto w-full text-center space-y-6">
    <div class="space-y-2">
      <div class="w-16 h-16 bg-emerald-600/20 border border-emerald-500/30 rounded-3xl flex items-center justify-center mx-auto text-emerald-400">
        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
        </svg>
      </div>
      <h2 class="text-xl font-black text-white">Owner Security Lock</h2>
      <p class="text-xs text-slate-400">Enter your 4-digit PIN to view live sales</p>
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
    <div class="bg-emerald-900 text-white p-5 rounded-3xl shadow-xl flex justify-between items-center border border-emerald-800">
      <div>
        <h1 class="text-lg font-black tracking-wide text-emerald-400">PharmaLink Live</h1>
        <p class="text-xs text-emerald-200">Owner Mobile Monitor</p>
      </div>
      <button onclick="lockScreen()" class="bg-emerald-950 hover:bg-red-900/60 text-emerald-200 hover:text-red-200 text-xs font-bold px-3 py-1.5 rounded-xl border border-emerald-700 transition">
        Lock
      </button>
    </div>

    <div class="bg-white p-5 rounded-3xl shadow-sm border border-slate-200 space-y-3">
      <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">Today's Total Sales</span>
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
        <h3 class="font-bold text-sm text-slate-800">Recent Receipts</h3>
        <span class="text-xs text-slate-400" id="txCount">0 sales</span>
      </div>
      <div id="txList" class="space-y-2 max-h-80 overflow-y-auto divide-y divide-slate-100 text-xs"></div>
    </div>
  </div>

  <script>
    var currentPin = '';
    var pollTimer = null;

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
      document.body.className = "bg-slate-100 text-slate-800 font-sans min-h-screen p-4";
      fetchOwnerData();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(fetchOwnerData, 4000);
    }

    function lockScreen() {
      sessionStorage.removeItem('pharmalink_owner_pin');
      if (pollTimer) clearInterval(pollTimer);
      document.getElementById('dashboardScreen').classList.add('hidden');
      document.getElementById('pinScreen').classList.remove('hidden');
      document.body.className = "bg-slate-900 text-slate-800 font-sans min-h-screen flex flex-col justify-center p-4";
      clearPin();
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
          document.getElementById('totalSales').innerText = 'KES ' + Number(data.today.totalRevenue || 0).toLocaleString();
          document.getElementById('mpesaSales').innerText = 'KES ' + Number(data.today.mpesaRevenue || 0).toLocaleString();
          document.getElementById('cashSales').innerText = 'KES ' + Number(data.today.cashRevenue || 0).toLocaleString();
          document.getElementById('txCount').innerText = data.today.transactionCount + ' sales today';
          document.getElementById('catalogCount').innerText = (data.inventorySummary.totalProducts || 0) + ' items';
          document.getElementById('lowStockCount').innerText = (data.inventorySummary.lowStockCount || 0) + ' items';

          var list = document.getElementById('txList');
          if (data.recentTransactions && data.recentTransactions.length > 0) {
            list.innerHTML = data.recentTransactions.map(function(t) {
              return '<div class="pt-2 flex justify-between items-center">' +
                '<div>' +
                  '<p class="font-bold text-slate-800">' + (t.refId || 'RECEIPT') + ' <span class="font-normal text-[10px] text-slate-400">(' + (t.method || 'CASH') + ')</span></p>' +
                  '<p class="text-[10px] text-slate-400">' + (t.date || '') + '</p>' +
                '</div>' +
                '<span class="font-bold text-sm text-emerald-700">KES ' + Number(t.total || 0).toLocaleString() + '</span>' +
              '</div>';
            }).join('');
          } else {
            list.innerHTML = '<p class="text-center text-slate-400 py-4">No transactions recorded today.</p>';
          }
        })
        .catch(function(e) {});
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
