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
    ? `<div class="error" role="alert">
  <svg class="error-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 6v4m0 4h.01M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 14h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  <span>${escapeHtml(opts.error)}</span>
</div>`
    : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<link rel="stylesheet" href="/assets/css/login.css" />
<title>${escapeHtml(opts.resourceName)}</title>
</head>
<body>
  <div class="card">
    <div class="card-inner">
      <div class="logo"><img src="/assets/logo-aquatrack.webp" alt="AquaTrack" /></div>
      <h1>${escapeHtml(opts.resourceName)}</h1>
      <p class="sub">Inicia sesión con tu cuenta de AquaTrack para autorizar el acceso del asistente.</p>
      ${errorBlock}
      <form method="post" action="/login" autocomplete="on" id="loginForm">
        <input type="hidden" name="login_id" value="${escapeHtml(opts.loginId)}" />
        <div class="field">
          <label class="field-label" for="email">Correo electrónico</label>
          <div class="input-wrap">
            <input id="email" name="email" type="email" required autofocus autocomplete="username" placeholder="tu@correo.com" />
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="password">Contraseña</label>
          <div class="input-wrap">
            <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="••••••••" />
            <button type="button" class="toggle-pw" id="togglePw" tabindex="-1" aria-label="Mostrar contraseña">
              <svg class="eye-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-10-7-10-7a18.37 18.37 0 0 1 2.06-3.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.06 3.94M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
            </button>
          </div>
        </div>
        <button type="submit" id="submitBtn">
          <span class="spinner"></span>
          <span class="btn-text">Autorizar acceso</span>
        </button>
      </form>
      <p class="note">Tus credenciales se verifican directamente contra AquaTrack. Este conector guarda únicamente una sesión temporal y nunca tu contraseña.</p>
    </div>
  </div>
  <script src="/assets/js/login.js"></script>
</body>
</html>`;
}
