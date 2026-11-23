/* Alamat project Supabase. Kunci publik (anon) disimpan di anon-key.txt — kunci ini memang untuk publik; data dilindungi aturan akses di database. */
(function () {
  var key = "";
  try { var x = new XMLHttpRequest(); x.open("GET", "anon-key.txt?v=" + Date.now(), false); x.send(); if (x.status === 200) key = x.responseText.trim(); } catch (e) {}
  window.SMM_CONFIG = { url: "https://nlxqrqupsjbeyhondyup.supabase.co", key: key };
})();
