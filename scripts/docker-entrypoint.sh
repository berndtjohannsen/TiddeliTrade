#!/bin/sh
set -e

cd /app
DATA_DIR="${TIDDELI_DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

if [ ! -f "$DATA_DIR/config.json" ]; then
  cp config.example.json "$DATA_DIR/config.json"
  echo "[TiddeliTrade] Created $DATA_DIR/config.json from config.example.json — set IG credentials in Settings."
fi

if [ ! -f "$DATA_DIR/transactions.json" ]; then
  printf '%s\n' '{"transactions":[]}' > "$DATA_DIR/transactions.json"
fi

if [ ! -f "$DATA_DIR/scheduled-closes.json" ]; then
  printf '%s\n' '[]' > "$DATA_DIR/scheduled-closes.json"
fi

ln -sf "$DATA_DIR/config.json" /app/config.json
ln -sf "$DATA_DIR/transactions.json" /app/transactions.json
ln -sf "$DATA_DIR/scheduled-closes.json" /app/scheduled-closes.json

export PRICE_RECORDS_DB="${PRICE_RECORDS_DB:-$DATA_DIR/price_records.db}"

exec "$@"
