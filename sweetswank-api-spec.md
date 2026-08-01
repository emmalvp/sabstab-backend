# SweetSwank — Especificación de API

Conecta la app (el prototipo `sweet-swank-mockup.jsx`) con el motor
(`sweetswank-algorithm.ts`) y la base de datos (`sweetswank-schema.sql`).
El motor corre **del lado del servidor** — el cliente nunca calcula la
rutina, solo la pide y la muestra.

Base URL: `https://api.sweetswank.app/v1`
Auth: Bearer token (JWT) en el header `Authorization`, salvo donde se indique.

---

## Autenticación

### `POST /auth/register`
```json
// Request
{ "email": "carlos@mail.com", "password": "••••••••", "nombre": "Carlos M." }
// Response 201
{ "userId": "uuid", "token": "jwt..." }
```

### `POST /auth/login`
```json
// Request
{ "email": "carlos@mail.com", "password": "••••••••" }
// Response 200
{ "userId": "uuid", "token": "jwt..." }
```
`401` si las credenciales no coinciden.

### `POST /auth/apple` — "Continuar con Apple" del login
```json
// Request
{ "identityToken": "..." } // token que entrega Sign in with Apple
// Response 200
{ "userId": "uuid", "token": "jwt...", "esNuevoUsuario": true }
```

### `POST /auth/forgot-password`
```json
// Request
{ "email": "carlos@mail.com" }
// Response 200 — siempre, exista o no la cuenta (no revela qué correos están registrados)
{ "ok": true }
```
Si la cuenta existe, manda un email con un link `sabstab://reset-password?token=...`
que abre la app directo en la pantalla de reset. El token vale 1 hora y
es de un solo uso. `501 email_no_configurado` si el servidor no tiene
`RESEND_API_KEY`.

### `POST /auth/reset-password`
```json
// Request
{ "token": "el token del link", "newPassword": "••••••••••" }
// Response 200
{ "ok": true }
```
`401 token_invalido` si el token no existe, ya se usó, o expiró.
`400 datos_incompletos` si `newPassword` tiene menos de 6 caracteres.

---

## Perfil (onboarding)

### `PUT /profile` — crea o actualiza el perfil vigente
Llamado al terminar el wizard de onboarding. El servidor cierra el
perfil anterior (`vigente_hasta = now()`) y crea uno nuevo — nunca
sobrescribe una fila existente.
```json
// Request — mismo shape que UserProfile en sweetswank-algorithm.ts
{
  "antropometria": { "alturaCm": 178, "femurCm": 46.2, "torsoCm": 42, "brazoCm": 62 },
  "oneRM": { "sentadilla": 140, "pressBanca": 100, "pesoMuerto": 180, "pressMilitar": 60 },
  "lesiones": [
    { "zona": "hombro", "lado": "derecho", "estado": "resuelta_con_precaucion", "movimientoQueAgrava": "" }
  ],
  "objetivo": "hipertrofia",
  "nivel": "intermedio",
  "diasPorSemana": 4,
  "duracionSesionMin": 60,
  "equipoDisponible": ["barra", "mancuerna", "polea", "maquina", "peso_corporal"]
}
// Response 200 — el perfil guardado + su id
```

### `GET /profile` — el perfil vigente (para pintar la pantalla Perfil)
```json
// Response 200 — mismo shape que el PUT, más:
{ "...": "...", "perfilId": "uuid", "vigenteDesde": "2026-07-30T..." }
```

### `GET /profile/history?campo=oneRM.sentadilla` — para gráficas de Progreso
```json
// Response 200
{ "puntos": [{ "fecha": "2026-06-01", "valor": 128 }, { "fecha": "2026-07-30", "valor": 140 }] }
```

---

## Rutinas (el motor corre aquí)

### `GET /routines/today?dia=Empuje`
El servidor llama internamente a `generarDia()` con el perfil vigente
del usuario y la tabla `ejercicios` completa, guarda el resultado en
`rutinas_dia` / `rutina_ejercicios`, y lo devuelve.
```json
// Response 200
{
  "rutinaDiaId": "uuid",
  "nombreDia": "Empuje",
  "ejercicios": [
    {
      "rutinaEjercicioId": "uuid",
      "exercise": { "id": "press_banca_inclinado", "nombre": "Press banca inclinado 30°", "anguloGrados": 30, "...": "..." },
      "series": 3, "repeticiones": "8-12", "porcentaje1RM": 72, "cargaKg": 72,
      "nota": "", "advertenciaLesion": null
    }
  ]
}
```

### `GET /routines/:rutinaDiaId` — releer una rutina ya generada (no recalcula)

---

## Alternativas

### `GET /exercises/alternatives?ejercicioId=press_banca_plano&topN=3`
Corre `buscarAlternativas()` en el servidor con el perfil vigente
(para que ya venga filtrado por lesiones y equipo).
```json
// Response 200
{ "ocupado": { "id": "press_banca_plano", "nombre": "Press banca plano" },
  "alternativas": [ { "id": "press_mancuernas", "nombre": "Press con mancuernas", "anguloGrados": 22 } ] }
```

### `GET /exercises?q=press` — búsqueda libre (autocompletar el buscador)

---

## Registro de sesiones (progresión automática)

### `POST /sessions`
Cada serie completada, o el resumen de la sesión completa.
```json
// Request
{
  "rutinaEjercicioId": "uuid",
  "cargaUsadaKg": 72,
  "repeticionesCompletadas": 10,
  "rpe": 8,
  "fuente": "manual" // o "apple_watch"
}
// Response 201 — además dispara internamente ajustarProximaCarga()
// y actualiza el 1RM estimado si corresponde
{ "sesionId": "uuid", "proximaCargaSugeridaKg": 74.5 }
```

### `GET /progress/summary` — para la pantalla Progreso
```json
// Response 200
{
  "rachaSesiones": 12,
  "volumenSemanal": [62, 70, 68, 75, 80, 78, 85, 90],
  "progreso1RM": [
    { "levantamiento": "sentadilla", "antes": 128, "ahora": 140 }
  ],
  "constancia28dias": [1, 1, 0, 1, "..."]
}
```

---

## Ajustes

### `PATCH /settings`
```json
// Request (cualquier subconjunto)
{ "idioma": "en", "unidadPeso": "lb", "notificaciones": true }
```

### `POST /auth/change-password`
Requiere el JWT del login, igual que el resto de `/v1/*` salvo `/auth/*`.
```json
// Request
{ "currentPassword": "••••••••", "newPassword": "••••••••••" }
// Response 200
{ "ok": true }
```
`currentPassword` es obligatoria si la cuenta ya tiene contraseña
(`401 credenciales_invalidas` si no coincide). Las cuentas creadas solo
con Sign in with Apple no tienen contraseña todavía — para esas,
`currentPassword` se ignora y esto fija la primera. `newPassword`
requiere mínimo 6 caracteres (`400 datos_incompletos`).

### `POST /devices/connect`
```json
// Request
{ "tipo": "apple_watch" }
// Response 201
{ "dispositivoId": "uuid" }
```
La sincronización real de datos (descansos, frecuencia cardíaca) se
define aparte en el diseño de integración con HealthKit — este
endpoint solo registra que el dispositivo está vinculado.

### `DELETE /devices/:dispositivoId` — desconectar

---

## Notas de implementación

- **El motor vive en el servidor**, no en el cliente. `sweetswank-algorithm.ts`
  se importa directo en las rutas `/routines/*` y `/exercises/alternatives` —
  es el mismo archivo, sin reescribirlo.
- **Content-Type**: `application/json` en todo. Errores devuelven
  `{ "error": "codigo_error", "mensaje": "..." }` con status HTTP apropiado.
- **Rate limiting** sugerido en `/auth/*` (login) y `/sessions` (evitar
  spam de registros) — no aplica al resto.
- Todos los endpoints salvo `/auth/*` requieren el JWT del login; el
  servidor extrae `userId` del token, nunca del body.
