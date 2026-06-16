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
  error?: string;
}): string {
  const errorBlock = opts.error
    ? `<div class="error" role="alert">${escapeHtml(opts.error)}</div>`
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
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0;
    min-height: 100vh; display: grid; place-items: center;
    background: linear-gradient(135deg, #0ea5e9 0%, #0d9488 100%); color: #0f172a; }
  .card { background: #fff; width: min(92vw, 380px); padding: 28px; border-radius: 16px;
    box-shadow: 0 18px 40px rgba(2, 32, 64, .28); }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .dot { width: 30px; height: 30px; border-radius: 50%;
    background: linear-gradient(135deg, #0ea5e9, #14b8a6); }
  h1 { font-size: 1.15rem; margin: 0; }
  p.sub { color: #475569; font-size: .85rem; margin: 6px 0 18px; }
  label { display: block; font-size: .8rem; font-weight: 600; margin: 12px 0 6px; }
  input { width: 100%; padding: 11px 12px; border: 1px solid #cbd5e1; border-radius: 9px; font-size: .95rem; }
  input:focus { outline: 2px solid #0ea5e9; border-color: transparent; }
  button { width: 100%; margin-top: 20px; padding: 12px; border: 0; border-radius: 9px; cursor: pointer;
    font-size: .95rem; font-weight: 600; color: #fff; background: linear-gradient(135deg, #0ea5e9, #0d9488); }
  button:hover { filter: brightness(1.05); }
  .error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
    padding: 10px 12px; border-radius: 9px; font-size: .85rem; margin-bottom: 6px; }
  .note { margin-top: 16px; font-size: .72rem; color: #64748b; line-height: 1.4; }
</style>
</head>
<body>
  <form class="card" method="post" action="/login" autocomplete="on">
    <div class="brand"><span class="dot"></span><h1>${escapeHtml(opts.resourceName)}</h1></div>
    <p class="sub">Inicia sesión con tu cuenta de AquaTrack para autorizar el acceso del asistente a tus datos de consumo de agua.</p>
    ${errorBlock}
    <input type="hidden" name="login_id" value="${escapeHtml(opts.loginId)}" />
    <label for="email">Correo electrónico</label>
    <input id="email" name="email" type="email" required autofocus autocomplete="username" />
    <label for="password">Contraseña</label>
    <input id="password" name="password" type="password" required autocomplete="current-password" />
    <button type="submit">Autorizar acceso</button>
    <p class="note">Tus credenciales se verifican directamente contra AquaTrack. Este conector guarda únicamente una sesión temporal y nunca tu contraseña.</p>
  </form>
</body>
</html>`;
}
