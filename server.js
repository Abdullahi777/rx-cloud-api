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

// Helper to load data on boot
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

// Data collections
let prescriptions = loadData(DB_FILE, []);
let inventoryStore = loadData(INVENTORY_FILE, {});
let transactionsStore = loadData(TRANSACTIONS_FILE, {});
let mpesaTransactions = loadData(MPESA_LOGS_FILE, []);

// M-Pesa Configuration (Defaults to Daraja Sandbox for Testing)
let MPESA_KEYS = loadData(MPESA_CONFIG_FILE, {
  isSandbox: true,
  consumerKey: "ENTER_YOUR_SANDBOX_CONSUMER_KEY_HERE",
  consumerSecret: "ENTER_YOUR_SANDBOX_CONSUMER_SECRET_HERE",
  businessShortCode: "174379",
  passkey: "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
  callbackUrl: "https://rx-cloud-api-c2kx.onrender.com/api/mpesa/callback"
});

const savePrescriptions = () => fs.writeFileSync(DB_FILE, JSON.stringify(prescriptions, null, 2));
const saveInventory = () => fs.writeFileSync(INVENTORY_FILE, JSON.stringify(inventoryStore, null, 2));
const saveTransactions = () => fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactionsStore, null, 2));
const saveMpesaTransactions = () => fs.writeFileSync(MPESA_LOGS_FILE, JSON.stringify(mpesaTransactions, null, 2));
const saveMpesaConfig = () => fs.writeFileSync(MPESA_CONFIG_FILE, JSON.stringify(MPESA_KEYS, null, 2));

const getDarajaBaseUrl = () => MPESA_KEYS.isSandbox ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";

// 1. Health Check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ==========================================
// M-PESA DARAJA ENGINE (CLOUD HOSTED)
// ==========================================

// Middleware: Generate Safaricom OAuth Access Token
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

// M-Pesa Endpoint 1: Update API Keys from POS Settings
app.post("/api/settings", (req, res) => {
  const newKeys = req.body;
  if (newKeys.consumerKey) MPESA_KEYS.consumerKey = newKeys.consumerKey.trim();
  if (newKeys.consumerSecret) MPESA_KEYS.consumerSecret = newKeys.consumerSecret.trim();
  if (newKeys.businessShortCode) MPESA_KEYS.businessShortCode = newKeys.businessShortCode.trim();
  if (newKeys.passkey) MPESA_KEYS.passkey = newKeys.passkey.trim();
  if (newKeys.isSandbox !== undefined) MPESA_KEYS.isSandbox = Boolean(newKeys.isSandbox);
  MPESA_KEYS.callbackUrl = "https://rx-cloud-api-c2kx.onrender.com/api/mpesa/callback";

  saveMpesaConfig();
  console.log(`M-Pesa Config Updated. Environment: ${MPESA_KEYS.isSandbox ? "Sandbox" : "Production"}`);
  res.json({ success: true, message: "M-Pesa credentials saved." });
});

// M-Pesa Endpoint 2: Trigger STK Push Prompt
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
  console.log(`[STK PUSH] Sending to ${formattedPhone} for Ksh ${amount} (${baseUrl})...`);

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
    const errDetails = error.response?.data || error.message;
    console.error(`[STK ERROR]:`, errDetails);
    res.status(500).json({
      success: false,
      errorMessage: errDetails.errorMessage || "STK Push Failed. Check credentials."
    });
  }
});

// M-Pesa Endpoint 3: Public HTTPS Webhook for Safaricom Callbacks
app.post("/api/mpesa/callback", (req, res) => {
  console.log("[SAFARICOM CALLBACK RECEIVED]:", JSON.stringify(req.body));
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
      console.log("[PAYMENT CONFIRMED]:", transaction.id, "KES", transaction.amount);
      mpesaTransactions.unshift(transaction);
      saveMpesaTransactions();
    }
    res.json({ result: "success" });
  } catch (error) {
    console.error("Callback Error:", error);
    res.status(500).send("Error");
  }
});

// M-Pesa Endpoint 4: Verify Payment Status
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
    res.json({ success: false, message: "Waiting for customer PIN..." });
  }
});

// ==========================================
// POS INVENTORY & PRESCRIPTION ROUTES
// ==========================================

app.post('/api/pos/sync-inventory', (req, res) => {
  const { pharmacyId, items } = req.body;
  if (!pharmacyId || !Array.isArray(items)) return res.status(400).json({ error: 'Invalid payload' });

  inventoryStore[pharmacyId] = items;
  saveInventory();
  console.log(`[SYNC] Synced ${items.length} items for ${pharmacyId}`);
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
  console.log(`[PRESCRIPTION] Created ${rxId} for ${patientName}`);
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

  console.log(`[DISPENSED] ${rx.id} fulfilled!`);
  res.json({ status: 'success', prescription: rx });
});

app.post('/api/pos/sync-transactions', (req, res) => {
  const { pharmacyId, transaction } = req.body;
  if (!pharmacyId || !transaction) return res.status(400).json({ error: 'Missing fields' });

  if (!transactionsStore[pharmacyId]) {
    transactionsStore[pharmacyId] = [];
  }

  transactionsStore[pharmacyId].unshift(transaction);
  saveTransactions();

  console.log(`[SALE SYNC] ${pharmacyId}: KES ${transaction.total} via ${transaction.method}`);
  res.json({ status: 'success' });
});

app.get('/api/owner/:pharmacyId/summary', (req, res) => {
  const { pharmacyId } = req.params;
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

// Owner Mobile Dashboard
app.get('/owner', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>PharmaLink - Owner Mobile Dashboard</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-100 text-slate-800 font-sans p-4">
      <div class="max-w-md mx-auto space-y-4">
        <div class="bg-emerald-900 text-white p-5 rounded-3xl shadow-lg flex justify-between items-center">
          <div>
            <h1 class="text-lg font-black tracking-wide text-emerald-400">PharmaLink Live</h1>
            <p class="text-xs text-emerald-200">Owner Mobile Monitor</p>
          </div>
          <span class="bg-emerald-500/20 text-emerald-300 text-xs px-3 py-1 rounded-full font-bold border border-emerald-500/30">
            Live POS
          </span>
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
            <span class="text-[10px] font-bold text-slate-400 uppercase">Total Catalog</span>
            <p class="text-xl font-black text-slate-800" id="catalogCount">0 items</p>
          </div>
          <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <span class="text-[10px] font-bold text-orange-600 uppercase">Low Stock Alert</span>
            <p class="text-xl font-black text-orange-600" id="lowStockCount">0 items</p>
          </div>
        </div>
        <div class="bg-white p-5 rounded-3xl shadow-sm border border-slate-200 space-y-3">
          <div class="flex justify-between items-center border-b pb-2">
            <h3 class="font-bold text-sm text-slate-800">Recent Receipts</h3>
            <span class="text-xs text-slate-400" id="txCount">0 sales</span>
          </div>
          <div id="txList" class="space-y-2 max-h-80 overflow-y-auto divide-y divide-slate-100 text-xs">
            <p class="text-center text-slate-400 py-4">Waiting for live sales...</p>
          </div>
        </div>
      </div>
      <script>
        async function fetchOwnerData() {
          try {
            const res = await fetch('/api/owner/garissa-branch/summary');
            const data = await res.json();
            document.getElementById('totalSales').innerText = 'KES ' + Number(data.today.totalRevenue || 0).toLocaleString();
            document.getElementById('mpesaSales').innerText = 'KES ' + Number(data.today.mpesaRevenue || 0).toLocaleString();
            document.getElementById('cashSales').innerText = 'KES ' + Number(data.today.cashRevenue || 0).toLocaleString();
            document.getElementById('txCount').innerText = data.today.transactionCount + ' sales today';
            document.getElementById('catalogCount').innerText = (data.inventorySummary.totalProducts || 0) + ' items';
            document.getElementById('lowStockCount').innerText = (data.inventorySummary.lowStockCount || 0) + ' items';

            const list = document.getElementById('txList');
            if (data.recentTransactions && data.recentTransactions.length > 0) {
              list.innerHTML = data.recentTransactions.map(t => \`
                <div class="pt-2 flex justify-between items-center">
                  <div>
                    <p class="font-bold text-slate-800">\${t.refId || 'RECEIPT'} <span class="font-normal text-[10px] text-slate-400">(\${t.method})</span></p>
                    <p class="text-[10px] text-slate-400">\${t.date}</p>
                  </div>
                  <span class="font-bold text-sm text-emerald-700">KES \${Number(t.total || 0).toLocaleString()}</span>
                </div>
              \`).join('');
            }
          } catch(e) {}
        }
        fetchOwnerData();
        setInterval(fetchOwnerData, 4000);
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`Cloud Server with M-Pesa running on http://localhost:${PORT}`));
