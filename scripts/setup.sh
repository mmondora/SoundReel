#!/bin/bash
set -e

echo "🔧 SoundReel Setup"
echo "=================="

# Verifica che Firebase CLI sia installato
if ! command -v firebase &> /dev/null; then
    echo "❌ Firebase CLI non trovato. Installalo con: npm install -g firebase-tools"
    exit 1
fi

# Verifica login Firebase
if ! firebase projects:list &> /dev/null; then
    echo "🔐 Effettua il login a Firebase..."
    firebase login
fi

echo ""
echo "📦 Installazione dipendenze frontend..."
cd frontend && npm install
cd ..

echo ""
echo "📦 Installazione dipendenze functions..."
cd functions && npm install
cd ..

echo ""
echo "✅ Setup completato!"
echo ""
echo "Prossimi passi:"
echo "1. Copia .env.example in .env e compila le variabili"
echo "2. Configura i secrets con: ./scripts/set-secrets.sh"
echo "3. Deploy con: ./scripts/deploy.sh"
