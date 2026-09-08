const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Persistent JSON file paths
const DB_FILE = path.join(__dirname, 'prescriptions_db.json');
const INVENTORY_FILE = path.join(__dirname, 'inventory_db.json');
const TRANSACTIONS_FILE = path.join(__dirname, 'transactions_db.json');

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

// In-memory / File collections
let prescriptions = loadData(DB_FILE, []);
let inventoryStore = loadData(INVENTORY_FILE, {});
let transactionsStore = loadData(TRANSACTIONS_FILE, {});

const savePrescriptions = () => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(prescriptions, null, 2));
  } catch (err) {
    console.error("Error saving prescriptions to disk:", err);
  }
};

const saveInventory = () => {
  try {
    fs.writeFileSync(INVENTORY_FILE, JSON.stringify(inventoryStore, null, 2));
  } catch (err) {
    console.error("Error saving inventory to disk:", err);
  }
};

const saveTransactions = () => {
  try {
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactionsStore, null, 2));
  } catch (err) {
    console.error("Error saving transactions to disk:", err);
  }
};

// 1. Health Check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// 2. POS Inventory Sync (Saves to disk)
app.post('/api/pos/sync-inventory', (req, res) => {
  const { pharmacyId, items } = req.body;
  if (!pharmacyId || !Array.isArray(items)) return res.status(400).json({ error: 'Invalid payload' });

  inventoryStore[pharmacyId] = items;
  saveInventory();
  console.log(`[SYNC] Synced ${items.length} items for ${pharmacyId}`);
  res.json({ status: 'success', count: items.length });
});

// 3. Query Stock for Doctor Portal
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

// 4. Doctor Issue Prescription (Saves to disk)
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

// 5. Doctor Live History: Fetch All Prescriptions from disk
app.get('/api/prescriptions', (req, res) => {
  res.json(prescriptions);
});

// 6. POS Queue: Fetch Unfulfilled Prescriptions
app.get('/api/pos/:pharmacyId/prescriptions', (req, res) => {
  const { pharmacyId } = req.params;
  const pending = prescriptions.filter(
    rx => rx.pharmacyId === pharmacyId && rx.status === 'pending_dispense'
  );
  res.json(pending);
});

// 7. Mark as Dispensed (Permanently updates status to 'dispensed')
app.post('/api/prescriptions/:id/dispense', (req, res) => {
  const rx = prescriptions.find(r => r.id === req.params.id);
  if (!rx) return res.status(404).json({ error: 'Prescription not found' });

  rx.status = 'dispensed';
  rx.dispensedAt = new Date().toISOString();
  savePrescriptions();

  console.log(`[DISPENSED] ${rx.id} permanently marked as dispensed!`);
  res.json({ status: 'success', prescription: rx });
});

// 8. POS Transaction Sync (Saves each sale to disk for the owner)
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

// 9. Owner Mobile Summary API
app.get('/api/owner/:pharmacyId/summary', (req, res) => {
  const { pharmacyId } = req.params;
  const txns = transactionsStore[pharmacyId] || [];
  const inventory = inventoryStore[pharmacyId] || [];

  const todayStr = new Date().toISOString().split('T')[0];
  const todayTxns = txns.filter(t => t.isoDate === todayStr);

  const totalRevenue = todayTxns.reduce((sum, t) => sum + (Number(t.total) || 0), 0);
  const mpesaRevenue = todayTxns.filter(t => t.method === 'MPESA').reduce((sum, t) => sum + (Number(t.total) || 0), 0);
  const cashRevenue = todayTxns.filter(t => t.method === 'CASH').reduce((sum, t) => sum + (Number(t.total) || 0), 0);

  const lowStockCount = inventory.filter(i => Number(i.stock) < 20).length;

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
      lowStockCount
    }
  });
});

// 10. Owner Mobile Web Dashboard (Open directly in Safari / Chrome on mobile)
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
        
        <!-- Header -->
        <div class="bg-emerald-900 text-white p-5 rounded-3xl shadow-lg flex justify-between items-center">
          <div>
            <h1 class="text-lg font-black tracking-wide text-emerald-400">PharmaLink Live</h1>
            <p class="text-xs text-emerald-200">Owner Mobile Monitor</p>
          </div>
          <span class="bg-emerald-500/20 text-emerald-300 text-xs px-3 py-1 rounded-full font-bold border border-emerald-500/30">
            Live POS
          </span>
        </div>

        <!-- Today Summary Card -->
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

        <!-- Stock Status Overview -->
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

        <!-- Live Transactions Feed -->
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
        setInterval(fetchOwnerData, 4000); // Polls every 4s for live updates
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`Persistent Cloud API running on http://localhost:${PORT}`));