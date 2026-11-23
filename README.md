# Tracking Pengadaan SMM

Aplikasi pelacakan pengadaan spare parts PT Sentra Mulia Mandiri (RFQ → harga supplier → quotation → PO customer → order supplier → gudang).

- Halaman web statis (GitHub Pages) + Supabase (database, login, fungsi server).
- `config.js` berisi alamat project Supabase dan kunci publik (anon) — aman untuk publik; data dilindungi aturan akses di database.
