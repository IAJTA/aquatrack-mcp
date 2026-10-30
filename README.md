# AquaTrack MCP Server

Servidor MCP (Model Context Protocol) que actúa como puente entre asistentes de IA (Claude, ChatGPT, etc.) y la plataforma **AquaTrack** de monitoreo de consumo de agua IoT.

Permite consultar consumo de agua por edificio, departamentos, historial de facturación, estado de gateways IoT y medidores, todo desde lenguaje natural a través del asistente.

---

## Requisitos

- **Node.js** >= 22
- **npm**
- Una cuenta en **AquaTrack** con credenciales (email/contraseña)

---

## Instalación

```bash
# Clonar el repositorio
git clone <repo-url>
cd aquatrack-mcp

# Instalar dependencias
npm install

# Copiar y configurar variables de entorno
cp .env.example .env
```

---

## Configuración

Editar el archivo `.env` con los siguientes valores:

| Variable | Obligatorio | Descripción |
|---|---|---|
| `PORT` | No (3000) | Puerto del servidor |
| `LOG_LEVEL` | No (info) | `debug`, `info`, `warn`, `error` |
| `AQUATRACK_URL` | No | URL de la API REST de AquaTrack |
| `PUBLIC_URL` | **Sí** | URL pública donde esté desplegado el servidor (ej: `https://tu-dominio.com`) |
| `OAUTH_ENABLED` | No (true) | Habilita flujo OAuth 2.1 |
| `MCP_EVAL_TOKEN` | No | Token estático para evaluación/testing (mín. 24 caracteres) |
| `AQUATRACK_SERVICE_EMAIL` | Sí* | Email de cuenta de servicio (requerido si usas `MCP_EVAL_TOKEN`) |
| `AQUATRACK_SERVICE_PASSWORD` | Sí* | Contraseña de cuenta de servicio (requerido si usas `MCP_EVAL_TOKEN`) |

> **Importante:** `PUBLIC_URL` debe usar HTTPS a menos que sea `localhost`.

---

## Ejecución

### Desarrollo (hot reload)

```bash
npm run dev
```

### Producción

```bash
npm run build
npm start
```

### Con Docker

```bash
docker build -t aquatrack-mcp .
docker run -p 3000:3000 --env-file .env aquatrack-mcp
```

---

## Cómo usarlo desde MCP Jam

[MCP Jam](https://mcpjam.com) es un explorador visual de servidores MCP.

1. Despliega el servidor en una URL pública (o usa `localhost` con tunneling como ngrok).
2. En MCP Jam, agrega un nuevo servidor MCP con:
   - **Tipo:** `Streamable HTTP`
   - **URL:** `https://tu-dominio.com/mcp`
3. MCP Jam detectará automáticamente los 22 tools disponibles.
4. Si el servidor tiene OAuth habilitado, MCP Jam redirigirá al login de AquaTrack para autenticarse.
5. Si configuraste `MCP_EVAL_TOKEN`, úsalo como Bearer token en MCP Jam.

---

## Cómo usarlo desde ChatGPT

Puedes conectar este servidor MCP a ChatGPT usando **Custom GPTs** con **Actions**:

1. En ChatGPT, crea un **Custom GPT**.
2. En la sección **Actions**, agrega una nueva Action con:
   - **Schema:** Importa desde `https://tu-dominio.com/mcp` (el endpoint expone el schema automáticamente vía MCP)
   - O configura manualmente usando el schema OpenAPI/MCP.
3. Para autenticación, elige **OAuth 2.0** o **Bearer Token** según tu configuración.
4. Una vez conectado, puedes preguntar en lenguaje natural cosas como:
   - _"¿Cuál es el consumo de agua de hoy en el edificio?"_
   - _"Muéstrame los departamentos con mayor consumo ayer"_
   - _"¿Cómo está la salud de las baterías de los medidores?"_
   - _"Dame el historial de facturación del edificio principal"_

---

## Cómo usarlo desde Claude Code / Claude Desktop

### Claude Desktop

1. Abre **Claude Desktop** → Configuración → Developers → Edit Config.
2. Edita `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aquatrack": {
      "type": "streamable-http",
      "url": "https://tu-dominio.com/mcp"
    }
  }
}
```

Si usas autenticación con token:

```json
{
  "mcpServers": {
    "aquatrack": {
      "type": "streamable-http",
      "url": "https://tu-dominio.com/mcp",
      "headers": {
        "Authorization": "Bearer TU_TOKEN"
      }
    }
  }
}
```

### Claude Code (terminal)

```bash
claude mcp add aquatrack --type streamable-http --url https://tu-dominio.com/mcp
```

Con token:

```bash
claude mcp add aquatrack --type streamable-http \
  --url https://tu-dominio.com/mcp \
  --header "Authorization: Bearer TU_TOKEN"
```

---

## Tools disponibles

| Tool | Descripción |
|---|---|
| `whoami` | Muestra info de la cuenta actual y rol |
| `my_apartments` | Lista departamentos del usuario (owner/tenant) |
| `list_buildings` | Lista edificios (admin) |
| `get_building` | Detalle de un edificio |
| `list_apartments` | Departamentos de un edificio |
| `get_apartment` | Detalle de departamento + última lectura |
| `get_apartment_consumption_history` | Consumo diario de un departamento (~30 días) |
| `get_building_overview` | Resumen del edificio: consumo hoy, cambio %, top consumidores, estado gateways |
| `get_top_consumers` | Top consumidores de ayer en un edificio |
| `get_building_billing` | Historial de facturación mensual (m³ y Bs) |
| `get_building_daily_change` | Cambio porcentual en consumo diario del edificio |
| `list_centrals` | Gateways IoT de un edificio |
| `list_water_meters` | Todos los medidores con salud de batería (super_admin) |
| `recalculate_consumption` | Recalcula consumo diario (admin, idempotente) |
| `analyze_building_consumption` | Análisis profundo del consumo de un edificio (tendencias, costo) |
| `detect_potential_leaks` | Detecta posibles fugas analizando anomalías en departamentos |
| `generate_executive_summary` | Resumen ejecutivo del edificio (estado general, tendencias, alertas) |
| `compare_periods` | Compara dos meses de consumo de un edificio |
| `find_high_risk_apartments` | Identifica departamentos con alto riesgo de desperdicio o fugas |
| `identify_consumption_anomalies` | Detección estadística de anomalías en consumo mensual |
| `recommend_savings_actions` | Genera recomendaciones accionables para ahorrar agua |
| `generate_building_health_report` | Reporte de salud completo del edificio (diagnóstico general) |

---

## Endpoints HTTP

| Ruta | Método | Descripción |
|---|---|---|
| `/healthz` | GET | Health check |
| `/` | GET | Info del servidor |
| `/login` | GET/POST | Login OAuth |
| `/mcp` | POST | Endpoint MCP (Streamable HTTP) |

---

## Licencia

MIT
