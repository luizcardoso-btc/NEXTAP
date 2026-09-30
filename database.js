// Banco de dados SQLite (arquivo local nextap.db).
// Simples de rodar, e fácil de trocar por Postgres depois se precisar escalar.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// No Railway o disco do container é apagado a cada deploy. Para não perder os dados,
// crie um Volume no serviço (ex.: montado em /data) — o Railway expõe o caminho em
// RAILWAY_VOLUME_MOUNT_PATH. Também dá para definir DB_PATH manualmente.
const dbFile =
  process.env.DB_PATH ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'nextap.db')
    : path.join(__dirname, 'nextap.db'));
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS resellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  whatsapp TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  min_qty INTEGER NOT NULL,
  max_qty INTEGER NOT NULL,
  unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  qty_azul INTEGER NOT NULL DEFAULT 0,
  qty_preta INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'aguardando_pagamento', -- aguardando_pagamento | pago | enviado | entregue | cancelado
  payment_method TEXT,          -- pix | credit_card
  mp_payment_id TEXT,           -- id do pagamento no Mercado Pago (Pix)
  mp_preference_id TEXT,        -- id da preferência no Mercado Pago (cartão / Checkout Pro)
  pix_qr_code TEXT,             -- copia e cola
  pix_qr_base64 TEXT,           -- imagem do QR em base64
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS plates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  order_id INTEGER REFERENCES orders(id),
  code TEXT NOT NULL UNIQUE,        -- código único usado no QR/NFC
  color TEXT NOT NULL,              -- azul | preta
  status TEXT NOT NULL DEFAULT 'estoque', -- estoque | ativa
  client_name TEXT,
  plate_label TEXT,
  destination_type TEXT,
  destination_url TEXT,
  cost REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plate_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_id INTEGER NOT NULL REFERENCES plates(id),
  read_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  plate_id INTEGER REFERENCES plates(id),
  client_name TEXT NOT NULL,
  value REAL NOT NULL,
  cost REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Faixas de preço padrão, só na primeira vez que o banco é criado
const tierCount = db.prepare('SELECT COUNT(*) AS n FROM price_tiers').get().n;
if (tierCount === 0) {
  const insert = db.prepare('INSERT INTO price_tiers (min_qty, max_qty, unit_price) VALUES (?, ?, ?)');
  insert.run(1, 1, 25);
  insert.run(2, 49, 20);
  insert.run(50, 299, 17);
  insert.run(300, 1000000, 15);
}

module.exports = db;
