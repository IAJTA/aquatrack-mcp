(function () {
  var form = document.getElementById("loginForm");
  var btn = document.getElementById("submitBtn");
  if (form && btn) {
    form.addEventListener("submit", function () {
      btn.classList.add("loading");
      btn.disabled = true;
    });
  }
  var toggle = document.getElementById("togglePw");
  var pw = document.getElementById("password");
  if (toggle && pw) {
    toggle.addEventListener("click", function () {
      var show = pw.type === "password";
      pw.type = show ? "text" : "password";
      toggle.querySelector(".eye-on").style.display = show ? "none" : "";
      toggle.querySelector(".eye-off").style.display = show ? "" : "none";
      toggle.setAttribute(
        "aria-label",
        show ? "Ocultar contraseña" : "Mostrar contraseña"
      );
    });
  }
})();
