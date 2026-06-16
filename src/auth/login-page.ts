function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

export function renderLoginPage(opts: {
  loginId: string;
  resourceName: string;
  nonce: string;
  error?: string;
}): string {
  const errorBlock = opts.error
    ? `<div class="error" role="alert"><span class="error-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></span><span>${escapeHtml(opts.error)}</span></div>`
    : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Conectar ${escapeHtml(opts.resourceName)}</title>
<style>
  :root { color-scheme: light dark; }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #f1f5f9;
    padding: 16px;
  }
  .card {
    background: #fff; width: min(92vw, 400px); padding: 36px 32px 28px;
    border-radius: 20px;
    box-shadow: 0 20px 60px rgba(2, 32, 64, 0.3);
    animation: fadeUp 0.4s ease-out;
    position: relative;
    overflow: hidden;
  }
  .card::before {
    content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px;
    background: linear-gradient(90deg, #0ea5e9, #14b8a6);
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20%, 60% { transform: translateX(-6px); }
    40%, 80% { transform: translateX(6px); }
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .logo {
    display: flex; justify-content: center; margin-bottom: 20px;
  }
  .logo img { width: 64px; height: 64px; }
  h1 {
    font-size: 1.25rem; font-weight: 700; margin: 0 0 4px;
    text-align: center; color: #0f172a;
  }
  p.sub {
    color: #64748b; font-size: 0.88rem; margin: 0 0 24px;
    text-align: center; line-height: 1.5;
  }
  label {
    display: block; font-size: 0.8rem; font-weight: 600;
    margin: 16px 0 6px; color: #334155;
  }
  .input-wrap {
    position: relative;
  }
  .input-wrap input {
    width: 100%; padding: 12px 14px; border: 1.5px solid #e2e8f0;
    border-radius: 10px; font-size: 0.95rem;
    transition: border-color 0.2s, box-shadow 0.2s;
    background: #f8fafc;
    outline: none;
  }
  .input-wrap input:focus {
    border-color: #0ea5e9;
    box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.15);
    background: #fff;
  }
  .input-wrap input::placeholder {
    color: #94a3b8;
  }
  button {
    width: 100%; margin-top: 24px; padding: 13px; border: 0;
    border-radius: 10px; cursor: pointer;
    font-size: 0.95rem; font-weight: 600; color: #fff;
    background: linear-gradient(135deg, #0ea5e9, #0d9488);
    transition: opacity 0.2s, transform 0.15s;
    display: flex; align-items: center; justify-content: center; gap: 10px;
  }
  button:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
  button:active:not(:disabled) { transform: translateY(0); }
  button:disabled { cursor: not-allowed; opacity: 0.7; }
  .spinner {
    width: 18px; height: 18px; border: 2.5px solid rgba(255,255,255,0.3);
    border-top-color: #fff; border-radius: 50%; animation: spin 0.6s linear infinite;
    display: none;
  }
  button.loading .spinner { display: block; }
  button.loading .btn-text { display: none; }
  .error {
    background: #fef2f2; color: #991b1b; border: 1.5px solid #fecaca;
    border-left: 4px solid #dc2626;
    padding: 14px 14px 14px 12px; border-radius: 0 10px 10px 0;
    font-size: 0.85rem; margin-bottom: 8px;
    animation: shake 0.4s ease-out, fadeIn 0.3s ease-out;
    line-height: 1.5; display: flex; align-items: flex-start; gap: 8px;
  }
  .error-icon {
    flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .error-icon svg { width: 18px; height: 18px; fill: none; stroke: #dc2626; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .note {
    margin-top: 20px; font-size: 0.72rem; color: #94a3b8;
    line-height: 1.5; text-align: center;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0f172a; }
    .card { background: #1e293b; }
    .card::before { background: linear-gradient(90deg, #38bdf8, #2dd4bf); }
    h1 { color: #f1f5f9; }
    p.sub { color: #94a3b8; }
    label { color: #cbd5e1; }
    .input-wrap input {
      background: #0f172a; border-color: #334155; color: #f1f5f9;
    }
    .input-wrap input:focus {
      background: #0f172a; border-color: #38bdf8;
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2);
    }
    .input-wrap input::placeholder { color: #64748b; }
    .error { background: #451a1a; color: #fca5a5; border-color: #7f1d1d; border-left-color: #ef4444; }
    .error-icon svg { stroke: #ef4444; }
    .note { color: #64748b; }
  }
</style>
</head>
<body>
  <form class="card" method="post" action="/login" autocomplete="on" id="loginForm">
    <div class="logo"><img src="/assets/logo-aquatrack.webp" alt="AquaTrack" /></div>
    <h1>${escapeHtml(opts.resourceName)}</h1>
    <p class="sub">Inicia sesión con tu cuenta de AquaTrack para autorizar el acceso del asistente a tus datos de consumo de agua.</p>
    ${errorBlock}
    <input type="hidden" name="login_id" value="${escapeHtml(opts.loginId)}" />
    <label for="email">Correo electrónico</label>
    <div class="input-wrap">
      <input id="email" name="email" type="email" required autofocus autocomplete="username" placeholder="tu@correo.com" />
    </div>
    <label for="password">Contraseña</label>
    <div class="input-wrap">
      <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="••••••••" />
    </div>
    <button type="submit" id="submitBtn">
      <span class="spinner"></span>
      <span class="btn-text">Autorizar acceso</span>
    </button>
    <p class="note">Tus credenciales se verifican directamente contra AquaTrack. Este conector guarda únicamente una sesión temporal y nunca tu contraseña.</p>
  </form>
  <script nonce="${escapeHtml(opts.nonce)}">
    (function() {
      var form = document.getElementById("loginForm");
      var btn = document.getElementById("submitBtn");
      if (!form || !btn) return;
      form.addEventListener("submit", function() {
        btn.classList.add("loading");
        btn.disabled = true;
      });
    })();
  </script>
</body>
</html>`;
}
