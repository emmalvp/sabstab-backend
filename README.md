# SabStab — backend

Este backend implementa `sweetswank-api-spec.md` de verdad, sobre
**PostgreSQL real** (no un archivo JSON de relleno) y con auth real
(bcrypt + JWT). Sin Express — el módulo `http` nativo de Node basta
para las rutas.

## Requisitos

- Node.js ≥ 18 (instalado vía `nvm` si no lo tenías: `nvm install --lts`)
- Postgres, instalado como **Postgres.app** en `~/Applications/Postgres.app`
  (sin `sudo`, autocontenido — no toca `/Applications` del sistema)
- Un clúster de datos en `~/sweetswank-pgdata`, con la base `sweetswank`
  ya creada y `sweetswank-schema.sql` ya aplicado

Si ya lo configuraste una vez, solo necesitas arrancar/parar Postgres:

```bash
npm run db:start   # arranca Postgres en el puerto 5432
npm run db:stop    # lo detiene
```

## Correrlo

```bash
npm install
npm run db:start
npm run seed        # carga exercises-db.json en la tabla `ejercicios` (idempotente)
JWT_SECRET="$(openssl rand -hex 32)" node server.js
# SabStab backend escuchando en http://localhost:4000 (73 ejercicios cargados)
```

Sin `JWT_SECRET` también arranca, pero avisa por consola que está usando
una clave de desarrollo insegura — no lo dejes así en producción.

`DATABASE_URL` por defecto apunta a `postgresql://localhost:5432/sweetswank`
(el Postgres local). En producción, apunta a tu Postgres real con esa
misma variable de entorno — no hace falta tocar código.

## Probarlo

```bash
# 1. Registrarte
curl -X POST http://localhost:4000/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"tu@mail.com","password":"clave123","nombre":"Tu Nombre"}'
# copia el "token" de la respuesta

TOKEN="pega_aquí_el_token"

# 2. Crear tu perfil (esto es lo que llena el onboarding)
curl -X PUT http://localhost:4000/v1/profile \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "antropometria": {"alturaCm":178,"femurCm":46.2,"torsoCm":42,"brazoCm":62},
    "oneRM": {"sentadilla":140,"pressBanca":100,"pesoMuerto":180,"pressMilitar":60},
    "lesiones": [],
    "objetivo":"hipertrofia","nivel":"intermedio","diasPorSemana":4,"duracionSesionMin":60,
    "equipoDisponible":["barra","mancuerna","polea","maquina","peso_corporal"]
  }'

# 3. Pedir la rutina de hoy — el motor la calcula en el servidor
curl "http://localhost:4000/v1/routines/today?dia=Empuje" -H "Authorization: Bearer $TOKEN"

# 4. Buscar una alternativa
curl "http://localhost:4000/v1/exercises/alternatives?ejercicioId=press_banca_plano_barra" -H "Authorization: Bearer $TOKEN"
```

## Qué es esto realmente

- **`engine.js`** — el mismo motor de `sweetswank-algorithm.ts`, portado a
  JS plano. La lógica de negocio no depende de dónde vengan los datos:
  recibe `exerciseDB` y `profile` como parámetros puros. Además de lo
  que ya traía `sweetswank-algorithm.ts`, agrega `sugerirSupersets()`
  (empareja ejercicios de músculos independientes para entrenar el
  mismo volumen en menos tiempo) y prioriza ejercicios compuestos sobre
  aislamiento al elegir el ejercicio por defecto de cada patrón.
- **`db.js`** — Postgres real vía `pg`, contra las tablas exactas de
  `sweetswank-schema.sql`. Traduce entre las columnas snake_case del
  schema y los nombres camelCase que usa `engine.js`.
- **`seed-exercises.js`** — carga `exercises-db.json` (73 ejercicios) en
  la tabla `ejercicios`. Es idempotente: correlo de nuevo cada vez que
  edites el catálogo.
- **`server.js`** — implementa cada endpoint de `sweetswank-api-spec.md`.
  Carga el catálogo de ejercicios desde Postgres una vez al arrancar
  (no cambia en caliente) y lo pasa a `engine.js`.

## Auth

`bcrypt` (12 rounds) para contraseñas y JWT firmado (`jsonwebtoken`) con
expiración de 30 días para los tokens. `/auth/login` bloquea una cuenta
15 minutos después de 5 intentos fallidos (`429 demasiados_intentos`),
como sugiere `sweetswank-api-spec.md`.

### Sign in with Apple (`POST /auth/apple`)

Verifica el `identityToken` de verdad contra las claves públicas reales
de Apple (`https://appleid.apple.com/auth/keys`, vía `jose`) — valida
firma, `iss` y `aud`, no confía ciegamente en lo que mande el cliente.
Si el token es de otra app, está vencido, o no está firmado por Apple,
responde `401 apple_token_invalido`.

Requiere la variable de entorno `APPLE_CLIENT_ID` = el Services ID (o
Bundle ID) que registraste para esta app en Apple Developer con "Sign
in with Apple" habilitado — sin eso no hay contra qué validar el `aud`
del token, y el endpoint responde `501 apple_no_configurado`.

```bash
APPLE_CLIENT_ID="com.tuempresa.sabstab" JWT_SECRET="..." node server.js
```

Si el `sub` del token ya existe, entra a esa cuenta. Si no existe pero
el email sí (cuenta creada con password), la vincula en vez de duplicar.
Si no existe ninguna, crea la cuenta (`esNuevoUsuario: true`) — Apple
solo manda el nombre completo la primera vez que el usuario autoriza, y
solo del lado del cliente (no viaje dentro del `identityToken`), así
que el body acepta un `nombre` opcional para ese primer registro.

**Lo que no pude probar de punta a punta**: un `identityToken` real solo
lo puede emitir Apple, firmado con una clave que nadie más tiene — hace
falta una cuenta de Apple Developer real con esta app dada de alta para
generar uno desde un dispositivo/simulador. Sí verifiqué que la
verificación en sí funciona: probé con un JWT con la forma correcta
pero autofirmado (no por Apple) y lo rechaza (401), como debe ser.

## Integridad de datos

`PUT /profile` y `POST /routines/today` hacen varios INSERT/UPDATE
relacionados seguidos (cerrar perfil viejo + crear el nuevo + registrar
lesiones/1RM; o crear la rutina del día + cada ejercicio). Van
envueltos en una transacción real (`db.transaccion`, BEGIN/COMMIT/
ROLLBACK) — si algo falla a la mitad (ej. una lesión con zona
inválida), no queda un perfil o una rutina a medio guardar.

Los errores de constraint de Postgres (CHECK, NOT NULL, FK, formato de
enum/UUID inválido) se traducen a `400 datos_invalidos` en vez de un
`500` genérico — son errores del cliente, no del servidor.

## Desplegarlo (Render)

`render.yaml` ya deja todo definido como código — Postgres y el
servidor, con `DATABASE_URL` y `JWT_SECRET` generados y conectados
solos. `migrate.js` (aplica `sweetswank-schema.sql`, con `IF NOT
EXISTS` en todo — correrlo de nuevo nunca rompe nada) y el seed de
ejercicios corren automáticamente en cada arranque, antes de
`server.js` (ver `startCommand`).

1. Crea una cuenta en [render.com](https://render.com) (gratis, no
   pide tarjeta para el free tier).
2. Sube esta carpeta a un repo de GitHub.
3. En Render: **New +** → **Blueprint** → conecta ese repo. Detecta
   `render.yaml` solo y te muestra qué va a crear (la base de datos +
   el servidor) — confirma.
4. Cuando termine el primer deploy, la URL pública queda en el
   dashboard del servicio `sabstab-backend` (algo como
   `https://sabstab-backend.onrender.com`). Pruébala:
   `curl https://tu-url.onrender.com/health` → `{"ok":true,"ejerciciosCargados":73}`.
5. Actualiza `API_BASE_URL` en `../mobile/src/api/client.js` con esa URL.

El Postgres del free tier de Render expira a los 90 días (te avisan
antes) — para entonces, o creas uno nuevo y vuelves a aplicar el
schema, o pasas a un plan pago.

Sign in with Apple sigue necesitando que definas `APPLE_CLIENT_ID` a
mano en el dashboard de Render (Environment → Add), y una cuenta de
Apple Developer real — eso no lo resuelve el blueprint.

## Pendiente

- El frontend (React Native/Expo, iOS + Android) vive en `../mobile`.
