/**
 * SabStab — servidor backend
 * Implementa sweetswank-api-spec.md usando solo el módulo `http` nativo
 * de Node (sin Express) para poder correr sin instalar un framework. La
 * persistencia es Postgres real (db.js, vía sweetswank-schema.sql) — el
 * motor de negocio en engine.js no cambia en absoluto, solo cómo se
 * obtienen y guardan los datos que entran/salen de él.
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const db = require("./db");
const engine = require("./engine");

// Se lee una sola vez al arrancar — es una página estática, no hace falta
// releerla del disco en cada request.
const PRIVACY_POLICY_HTML = fs.readFileSync(path.join(__dirname, "privacy-policy.html"), "utf8");

const PORT = process.env.PORT || 4000;

// --- Recuperar contraseña por email, vía Resend (https://resend.com).
// Sin RESEND_API_KEY configurada, el endpoint responde 501 en vez de
// fingir que mandó el correo. onboarding@resend.dev funciona sin
// verificar un dominio propio — suficiente hasta que tengas uno.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "SabStab <onboarding@resend.dev>";
const APP_SCHEME = process.env.APP_SCHEME || "sabstab";

async function enviarEmail({ to, subject, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    throw new Error(`Resend respondió ${res.status}: ${detalle}`);
  }
}

// --- Sign in with Apple: verifica el identityToken contra las claves
// públicas reales de Apple (JWKS), no una simulación. APPLE_CLIENT_ID es
// el Services ID / Bundle ID configurado en tu cuenta de Apple Developer
// para esta app — sin eso, no hay contra qué validar el "aud" del token.
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID;
const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

async function verificarIdentityTokenApple(identityToken) {
  const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
    issuer: "https://appleid.apple.com",
    audience: APPLE_CLIENT_ID,
  });
  return payload;
}

// --- Auth real: bcrypt para contraseñas, JWT firmado y con expiración para tokens. ---
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn(
    "AVISO: JWT_SECRET no está definido — usando una clave de desarrollo insegura. " +
    "Define JWT_SECRET como variable de entorno antes de desplegar esto de verdad."
  );
}
const JWT_SECRET_EFECTIVO = JWT_SECRET || "clave-dev-insegura-no-usar-en-produccion";
const TOKEN_EXPIRA_EN = "30d";

async function hashPassword(pw) {
  return bcrypt.hash(pw, 12);
}
async function verificarPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}
function makeToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET_EFECTIVO, { expiresIn: TOKEN_EXPIRA_EN });
}
function readToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET_EFECTIVO);
  } catch {
    return null;
  }
}

// --- Rate limiting básico de login, sugerido en sweetswank-api-spec.md ---
const INTENTOS_LOGIN = new Map(); // email -> { intentos, bloqueadoHasta }
const MAX_INTENTOS = 5;
const VENTANA_BLOQUEO_MS = 15 * 60 * 1000;

function registrarIntentoFallido(email) {
  const entrada = INTENTOS_LOGIN.get(email) || { intentos: 0, bloqueadoHasta: 0 };
  entrada.intentos += 1;
  if (entrada.intentos >= MAX_INTENTOS) {
    entrada.bloqueadoHasta = Date.now() + VENTANA_BLOQUEO_MS;
    entrada.intentos = 0;
  }
  INTENTOS_LOGIN.set(email, entrada);
}
function limpiarIntentos(email) {
  INTENTOS_LOGIN.delete(email);
}
function estaBloqueado(email) {
  const entrada = INTENTOS_LOGIN.get(email);
  return !!entrada && entrada.bloqueadoHasta > Date.now();
}

// Mapea la clave del OneRM del motor (camelCase, como en sweetswank-algorithm.ts)
// a la clave de almacenamiento de registros_1rm.levantamiento (snake_case,
// el mismo valor que exige el CHECK constraint de sweetswank-schema.sql).
const LEVANTAMIENTOS = [
  ["sentadilla", "sentadilla"],
  ["pressBanca", "press_banca"],
  ["pesoMuerto", "peso_muerto"],
  ["pressMilitar", "press_militar"],
];

// Catálogo de ejercicios: se carga una vez desde Postgres al arrancar
// (no cambia en caliente) y se pasa como parámetro a las funciones puras
// de engine.js, que no conocen ni les importa de dónde vino.
let EXERCISE_DB = [];

async function perfilParaMotor(userId) {
  const perfil = await db.perfilVigente(userId);
  if (!perfil) return null;
  const lesiones = await db.lesionesActivasDeUsuario(userId);
  const oneRM = {};
  for (const [claveMotor, claveStorage] of LEVANTAMIENTOS) {
    oneRM[claveMotor] = await db.ultimoRegistro1RM(userId, claveStorage);
  }
  return {
    antropometria: {
      alturaCm: Number(perfil.alturaCm),
      femurCm: Number(perfil.femurCm),
      torsoCm: Number(perfil.torsoCm),
      brazoCm: Number(perfil.brazoCm),
    },
    edad: perfil.edad != null ? Number(perfil.edad) : null,
    pesoCorporalKg: perfil.pesoCorporalKg != null ? Number(perfil.pesoCorporalKg) : null,
    oneRM,
    lesiones,
    objetivo: perfil.objetivo,
    nivel: perfil.nivel,
    diasPorSemana: perfil.diasPorSemana,
    equipoDisponible: perfil.equipoDisponible,
  };
}

// Shape completo para GET /profile según sweetswank-api-spec.md: el mismo
// shape que el PUT, más perfilId y vigenteDesde.
async function perfilCompleto(userId) {
  const perfil = await db.perfilVigente(userId);
  if (!perfil) return null;
  const motor = await perfilParaMotor(userId);
  return {
    ...motor,
    duracionSesionMin: perfil.duracionSesionMin,
    perfilId: perfil.id,
    vigenteDesde: perfil.vigenteDesde,
  };
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

async function requireAuth(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const payload = readToken(token);
  if (!payload) return null;
  return db.buscarUsuarioPorId(payload.userId);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function validarPerfilRequest(body) {
  const faltantes = [];
  if (!body.antropometria) faltantes.push("antropometria");
  if (!body.edad) faltantes.push("edad");
  if (!body.pesoCorporalKg) faltantes.push("pesoCorporalKg");
  if (!body.oneRM) faltantes.push("oneRM");
  if (!body.objetivo) faltantes.push("objetivo");
  if (!body.nivel) faltantes.push("nivel");
  if (!body.diasPorSemana) faltantes.push("diasPorSemana");
  if (!body.duracionSesionMin) faltantes.push("duracionSesionMin");
  if (!body.equipoDisponible) faltantes.push("equipoDisponible");
  return faltantes;
}

// CORS abierto — es una API pensada para clientes nativos (iOS/Android),
// pero admitir requests de navegador (Expo web en dev, un futuro panel de
// administración) no cuesta nada y evita bloqueos silenciosos del preflight.
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function handleRequest(req, res) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check — lo esperan casi todos los hosts (Render incluido) para
  // saber si el proceso está vivo antes de enrutarle tráfico real.
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return send(res, 200, { ok: true, ejerciciosCargados: EXERCISE_DB.length });
  }

  if (req.method === "GET" && url.pathname === "/privacy-policy") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PRIVACY_POLICY_HTML);
  }

  // Página pública (sin login) que exige Google Play: debe existir una forma
  // de solicitar el borrado de cuenta y datos aunque la persona ya haya
  // desinstalado la app.
  if (req.method === "GET" && url.pathname === "/account-deletion") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Eliminar cuenta de SabStab</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 20px; line-height: 1.5; color: #23282F; background: #E7E3DA; }
    h1 { font-size: 22px; }
    a { color: #167D74; }
    .card { background: #F7F5EF; border: 1px solid rgba(35,40,47,0.10); border-radius: 10px; padding: 16px 20px; margin: 16px 0; }
  </style>
</head>
<body>
  <h1>Eliminar tu cuenta de SabStab</h1>
  <div class="card">
    <strong>Desde la app (más rápido):</strong>
    <p>Abre SabStab → Ajustes → Cuenta → "Eliminar cuenta". Se borra al instante, sin esperar respuesta de nadie.</p>
  </div>
  <div class="card">
    <strong>Sin la app instalada:</strong>
    <p>Escríbenos a <a href="mailto:sabstab.soporte@gmail.com">sabstab.soporte@gmail.com</a> desde el correo de tu cuenta pidiendo el borrado. Lo procesamos en un plazo máximo de 30 días.</p>
  </div>
  <p><strong>Qué se borra:</strong> tu correo, nombre, perfil físico (antropometría, objetivo, nivel), historial de lesiones, registros de 1RM, rutinas generadas, registro de sesiones de entrenamiento y dispositivos conectados. Todo se elimina de forma permanente, no queda respaldo.</p>
</body>
</html>`);
  }

  const body = req.method !== "GET" && req.method !== "DELETE" ? await readBody(req) : null;

  // ---------------- AUTH ----------------
  if (req.method === "POST" && url.pathname === "/v1/auth/register") {
    if (!body.email || !body.password || !body.nombre) {
      return send(res, 400, { error: "datos_incompletos", mensaje: "Faltan email, password o nombre" });
    }
    let user;
    try {
      user = await db.crearUsuario({ email: body.email, passwordHash: await hashPassword(body.password), nombre: body.nombre });
    } catch (err) {
      if (err instanceof db.EmailEnUsoError) {
        return send(res, 409, { error: "email_en_uso", mensaje: "Ese correo ya está registrado" });
      }
      throw err;
    }
    return send(res, 201, { userId: user.id, token: makeToken(user.id) });
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/login") {
    if (estaBloqueado(body.email)) {
      return send(res, 429, { error: "demasiados_intentos", mensaje: "Demasiados intentos fallidos. Intenta de nuevo en unos minutos." });
    }
    const user = await db.buscarUsuarioPorEmail(body.email);
    const passwordValida = user?.passwordHash && (await verificarPassword(body.password || "", user.passwordHash));
    if (!passwordValida) {
      registrarIntentoFallido(body.email);
      return send(res, 401, { error: "credenciales_invalidas", mensaje: "Correo o contraseña incorrectos" });
    }
    limpiarIntentos(body.email);
    return send(res, 200, { userId: user.id, token: makeToken(user.id) });
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/apple") {
    if (!body.identityToken) {
      return send(res, 400, { error: "datos_incompletos", mensaje: "Falta identityToken" });
    }
    if (!APPLE_CLIENT_ID) {
      return send(res, 501, {
        error: "apple_no_configurado",
        mensaje: "Define APPLE_CLIENT_ID (el Services ID / Bundle ID de esta app en Apple Developer) para habilitar Sign in with Apple.",
      });
    }
    let payload;
    try {
      payload = await verificarIdentityTokenApple(body.identityToken);
    } catch (err) {
      return send(res, 401, { error: "apple_token_invalido", mensaje: "El identityToken de Apple no es válido o expiró" });
    }

    const appleUserId = payload.sub;
    let user = await db.buscarUsuarioPorAppleId(appleUserId);
    let esNuevoUsuario = false;

    if (!user) {
      // Puede que ya exista una cuenta con ese email (creada con password) — se vincula en vez de duplicar.
      if (payload.email) user = await db.buscarUsuarioPorEmail(payload.email);
      if (user) {
        await db.vincularAppleId(user.id, appleUserId);
      } else {
        try {
          user = await db.crearUsuarioApple({
            email: payload.email || `${appleUserId}@privaterelay.appleid.com`,
            appleUserId,
            nombre: body.nombre || (payload.email ? payload.email.split("@")[0] : "Usuario Apple"),
          });
          esNuevoUsuario = true;
        } catch (err) {
          if (err instanceof db.EmailEnUsoError) {
            return send(res, 409, { error: "email_en_uso", mensaje: "Ese correo ya está registrado con otro método de acceso" });
          }
          throw err;
        }
      }
    }
    return send(res, 200, { userId: user.id, token: makeToken(user.id), esNuevoUsuario });
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/forgot-password") {
    if (!body.email) {
      return send(res, 400, { error: "datos_incompletos", mensaje: "Falta email" });
    }
    if (!RESEND_API_KEY) {
      return send(res, 501, {
        error: "email_no_configurado",
        mensaje: "Define RESEND_API_KEY para habilitar la recuperación de contraseña por email.",
      });
    }
    const usuario = await db.buscarUsuarioPorEmail(body.email);
    // Responde 200 exista o no la cuenta — no revelar qué correos están registrados.
    if (usuario) {
      const tokenCrudo = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(tokenCrudo).digest("hex");
      const expiraEn = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
      await db.crearTokenReset(usuario.id, tokenHash, expiraEn);
      const link = `${APP_SCHEME}://reset-password?token=${tokenCrudo}`;
      try {
        await enviarEmail({
          to: usuario.email,
          subject: "Recupera tu contraseña de SabStab",
          html: `<p>Tocá este link desde tu teléfono para elegir una contraseña nueva (vale por 1 hora):</p><p><a href="${link}">${link}</a></p><p>Si no pediste esto, ignora este correo.</p>`,
        });
      } catch (err) {
        console.error("Error mandando email de recuperación:", err.message);
      }
    }
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/reset-password") {
    if (!body.token || !body.newPassword) {
      return send(res, 400, { error: "datos_incompletos", mensaje: "Faltan token o newPassword" });
    }
    if (body.newPassword.length < 6) {
      return send(res, 400, { error: "datos_incompletos", mensaje: "La nueva contraseña debe tener al menos 6 caracteres" });
    }
    const tokenHash = crypto.createHash("sha256").update(body.token).digest("hex");
    const registro = await db.buscarTokenReset(tokenHash);
    if (!registro || registro.usadoEn || new Date(registro.expiraEn) < new Date()) {
      return send(res, 401, { error: "token_invalido", mensaje: "El link de recuperación no es válido o ya expiró" });
    }
    await db.actualizarPassword(registro.userId, await hashPassword(body.newPassword));
    await db.marcarTokenResetUsado(registro.id);
    return send(res, 200, { ok: true });
  }

  // A partir de aquí, todo requiere token
  const user = await requireAuth(req);
  if (!user) return send(res, 401, { error: "no_autenticado", mensaje: "Falta o es inválido el token" });

  // ---------------- PERFIL ----------------
  if (req.method === "PUT" && url.pathname === "/v1/profile") {
    const faltantes = validarPerfilRequest(body);
    if (faltantes.length > 0) {
      return send(res, 400, { error: "datos_incompletos", mensaje: `Faltan campos: ${faltantes.join(", ")}` });
    }

    const perfil = await db.transaccion(async (client) => {
      await db.cerrarPerfilVigente(user.id, client);
      const p = await db.crearPerfil(user.id, {
        alturaCm: body.antropometria.alturaCm,
        femurCm: body.antropometria.femurCm,
        torsoCm: body.antropometria.torsoCm,
        brazoCm: body.antropometria.brazoCm,
        edad: body.edad,
        pesoCorporalKg: body.pesoCorporalKg,
        objetivo: body.objetivo,
        nivel: body.nivel,
        diasPorSemana: body.diasPorSemana,
        duracionSesionMin: body.duracionSesionMin,
        equipoDisponible: body.equipoDisponible,
      }, client);

      if (body.lesiones?.length) await db.agregarLesiones(user.id, body.lesiones, client);
      for (const [claveMotor, claveStorage] of LEVANTAMIENTOS) {
        if (body.oneRM[claveMotor]) {
          await db.agregarRegistro1RM(user.id, claveStorage, body.oneRM[claveMotor], "reportado", client);
        }
      }
      return p;
    });
    return send(res, 200, { perfilId: perfil.id, ...body });
  }

  if (req.method === "GET" && url.pathname === "/v1/profile") {
    const perfil = await perfilCompleto(user.id);
    if (!perfil) return send(res, 404, { error: "sin_perfil", mensaje: "Todavía no completaste el onboarding" });
    return send(res, 200, { nombre: user.nombre, ...perfil });
  }

  if (req.method === "GET" && url.pathname === "/v1/profile/history") {
    const campo = url.searchParams.get("campo") || "";
    const [seccion, subcampo] = campo.split(".");
    if (seccion === "oneRM" && subcampo) {
      const claveStorage = LEVANTAMIENTOS.find(([motor]) => motor === subcampo)?.[1];
      if (!claveStorage) return send(res, 400, { error: "campo_invalido", mensaje: `Levantamiento desconocido: ${subcampo}` });
      const puntos = await db.historial1RM(user.id, claveStorage);
      return send(res, 200, { puntos });
    }
    return send(res, 400, { error: "campo_invalido", mensaje: "Usa ?campo=oneRM.<levantamiento>" });
  }

  // ---------------- RUTINAS ----------------
  if (req.method === "GET" && url.pathname === "/v1/routines/today") {
    const perfilMotor = await perfilParaMotor(user.id);
    if (!perfilMotor) return send(res, 404, { error: "sin_perfil", mensaje: "Completa tu perfil primero" });
    const nombreDia = url.searchParams.get("dia") || "Empuje";
    const prescritos = engine.generarDia(nombreDia, EXERCISE_DB, perfilMotor, user.idioma);

    const { rutinaDiaId, ejerciciosGuardados } = await db.transaccion(async (client) => {
      const rutinaDiaId = await db.crearRutinaDia(user.id, nombreDia, client);
      const ejerciciosGuardados = [];
      for (let i = 0; i < prescritos.length; i++) {
        const p = prescritos[i];
        const rutinaEjercicioId = await db.agregarRutinaEjercicio(rutinaDiaId, {
          ejercicioId: p.exercise.id, orden: i, series: p.series, repeticiones: p.repeticiones,
          porcentaje1RM: p.porcentaje1RM, cargaKg: p.cargaKg, notaBiomecanica: p.nota, advertenciaLesion: p.advertenciaLesion,
        }, client);
        ejerciciosGuardados.push({ rutinaEjercicioId, ...p });
      }
      return { rutinaDiaId, ejerciciosGuardados };
    });
    const supersetsSugeridos = engine.sugerirSupersets(ejerciciosGuardados, user.idioma);
    return send(res, 200, { rutinaDiaId, nombreDia, ejercicios: ejerciciosGuardados, supersetsSugeridos });
  }

  if (req.method === "GET" && url.pathname === "/v1/routines/schedule") {
    const perfil = await db.perfilVigente(user.id);
    if (!perfil) return send(res, 404, { error: "sin_perfil", mensaje: "Completa tu perfil primero" });

    const programa = engine.generarProgramaSemanal(perfil.diasPorSemana);
    const diaSemanaHoy = (new Date().getDay() + 6) % 7; // JS: 0=domingo → ISO: 0=lunes
    const diaSugeridoHoy = programa.find((d) => d.diaSemana === diaSemanaHoy)?.tipo || null;

    const msPorDia = 24 * 60 * 60 * 1000;
    const semanasEnRutinaActual = Math.floor((Date.now() - new Date(perfil.vigenteDesde).getTime()) / (7 * msPorDia));

    let motivoCambio = null;
    if (semanasEnRutinaActual >= 6) {
      motivoCambio = "tiempo";
    } else {
      for (const [, claveStorage] of LEVANTAMIENTOS) {
        const historial = await db.historial1RM(user.id, claveStorage);
        if (engine.detectarEstancamiento(historial)) {
          motivoCambio = "estancamiento";
          break;
        }
      }
    }

    return send(res, 200, {
      diasPorSemana: perfil.diasPorSemana,
      programa,
      diaSemanaHoy,
      diaSugeridoHoy,
      semanasEnRutinaActual,
      sugerenciaCambiarRutina: motivoCambio !== null,
      motivoCambio,
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/v1/routines/") && url.pathname !== "/v1/routines/today" && url.pathname !== "/v1/routines/schedule") {
    const rutinaDiaId = url.pathname.split("/")[3];
    const rutinaDia = await db.rutinaDiaDeUsuario(rutinaDiaId, user.id);
    if (!rutinaDia) return send(res, 404, { error: "rutina_no_encontrada" });
    const filas = await db.ejerciciosDeRutinaDia(rutinaDiaId);
    const ejercicios = filas.map((re) => ({
      rutinaEjercicioId: re.rutinaEjercicioId,
      exercise: engine.conNombreLocalizado(EXERCISE_DB.find((e) => e.id === re.ejercicioId), user.idioma),
      series: re.series, repeticiones: re.repeticiones, porcentaje1RM: re.porcentaje1RM,
      cargaKg: re.cargaKg, nota: re.nota, advertenciaLesion: re.advertenciaLesion,
    }));
    return send(res, 200, { rutinaDiaId: rutinaDia.id, nombreDia: rutinaDia.nombreDia, ejercicios });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/v1/routines/exercises/")) {
    const rutinaEjercicioId = url.pathname.split("/")[4];
    if (!body.ejercicioId) return send(res, 400, { error: "datos_incompletos", mensaje: "Falta ejercicioId" });
    if (!EXERCISE_DB.some((e) => e.id === body.ejercicioId)) {
      return send(res, 400, { error: "ejercicio_invalido", mensaje: "Ese ejercicio no existe" });
    }
    const actualizado = await db.sustituirEjercicioDeRutina(rutinaEjercicioId, user.id, body.ejercicioId);
    if (!actualizado) return send(res, 404, { error: "rutina_ejercicio_no_encontrado" });
    return send(res, 200, { ok: true, rutinaEjercicioId: actualizado.id, ejercicioId: actualizado.ejercicioId });
  }

  // ---------------- ALTERNATIVAS ----------------
  if (req.method === "GET" && url.pathname === "/v1/exercises/alternatives") {
    const perfilMotor = await perfilParaMotor(user.id);
    if (!perfilMotor) return send(res, 404, { error: "sin_perfil", mensaje: "Completa tu perfil primero" });
    const ejercicioId = url.searchParams.get("ejercicioId");
    const ocupado = EXERCISE_DB.find((e) => e.id === ejercicioId);
    if (!ocupado) return send(res, 404, { error: "ejercicio_no_encontrado" });
    const alternativas = engine.buscarAlternativas(ocupado, EXERCISE_DB, perfilMotor, Number(url.searchParams.get("topN")) || 3, user.idioma);
    return send(res, 200, { ocupado: engine.conNombreLocalizado(ocupado, user.idioma), alternativas });
  }

  if (req.method === "GET" && url.pathname === "/v1/exercises") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const resultados = EXERCISE_DB.filter(
      (e) => e.nombre.toLowerCase().includes(q) || e.nombreEn?.toLowerCase().includes(q)
    ).map((e) => engine.conNombreLocalizado(e, user.idioma));
    return send(res, 200, { resultados });
  }

  // ---------------- SESIONES / PROGRESO ----------------
  if (req.method === "POST" && url.pathname === "/v1/sessions") {
    if (!body.rutinaEjercicioId || body.repeticionesCompletadas == null) {
      return send(res, 400, { error: "datos_incompletos", mensaje: "Faltan rutinaEjercicioId o repeticionesCompletadas" });
    }
    const sesionId = await db.crearRegistroSesion(user.id, body);
    const rutinaEj = await db.rutinaEjercicioPorId(body.rutinaEjercicioId);
    const repMax = Number((rutinaEj?.repeticiones || "8-12").split("-")[1]) || 10;
    // Sin carga registrada (ej. ejercicio de peso corporal) no hay carga que ajustar.
    const proximaCargaSugeridaKg = typeof body.cargaUsadaKg === "number"
      ? engine.ajustarProximaCarga(body.cargaUsadaKg, repMax, { repeticionesCompletadas: body.repeticionesCompletadas, rpe: body.rpe })
      : null;
    return send(res, 201, { sesionId, proximaCargaSugeridaKg });
  }

  if (req.method === "GET" && url.pathname === "/v1/progress/summary") {
    const totalSesiones = await db.contarSesionesDeUsuario(user.id);
    const progreso1RM = [];
    for (const [claveMotor, claveStorage] of LEVANTAMIENTOS) {
      const historial = await db.historial1RM(user.id, claveStorage);
      if (historial.length > 0) {
        progreso1RM.push({ levantamiento: claveMotor, antes: historial[0].valor, ahora: historial[historial.length - 1].valor });
      }
    }
    const volumenSemanal = await db.volumenSemanal(user.id, 8);
    const constancia28dias = await db.constancia28dias(user.id, 28);
    return send(res, 200, { rachaSesiones: totalSesiones, totalSesiones, volumenSemanal, progreso1RM, constancia28dias });
  }

  // ---------------- AJUSTES / DISPOSITIVOS ----------------
  if (req.method === "PATCH" && url.pathname === "/v1/settings") {
    await db.actualizarAjustesUsuario(user.id, body);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/v1/auth/change-password") {
    if (!body.newPassword || body.newPassword.length < 6) {
      return send(res, 400, { error: "datos_incompletos", mensaje: "La nueva contraseña debe tener al menos 6 caracteres" });
    }
    // Cuentas creadas solo con Apple no tienen password_hash todavía — se
    // les permite fijar una por primera vez sin pedir "la actual" porque
    // no existe ninguna que verificar.
    if (user.passwordHash) {
      const actualValida = body.currentPassword && (await verificarPassword(body.currentPassword, user.passwordHash));
      if (!actualValida) {
        return send(res, 401, { error: "credenciales_invalidas", mensaje: "La contraseña actual no es correcta" });
      }
    }
    await db.actualizarPassword(user.id, await hashPassword(body.newPassword));
    return send(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && url.pathname === "/v1/auth/account") {
    await db.eliminarUsuario(user.id);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/v1/devices/connect") {
    const dispositivoId = await db.crearDispositivo(user.id, body.tipo);
    return send(res, 201, { dispositivoId });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/v1/devices/")) {
    const dispositivoId = url.pathname.split("/")[3];
    const dispositivo = await db.desactivarDispositivo(dispositivoId, user.id);
    if (!dispositivo) return send(res, 404, { error: "dispositivo_no_encontrado" });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "ruta_no_encontrada", mensaje: `${req.method} ${url.pathname} no existe` });
}

// Códigos de error de Postgres que significan "el cliente mandó datos
// inválidos" (constraint CHECK/NOT NULL/FK violado, enum mal escrito,
// UUID con formato inválido) — no un fallo del servidor. Se traducen a
// 400 en vez de un 500 genérico que ocultaría que el problema es el
// input, no el backend.
const PG_ERRORES_DE_CLIENTE = new Set(["23502", "23503", "23514", "22P02", "22007"]);

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    if (err instanceof engine.SinEjerciciosDisponiblesError) {
      return send(res, 422, { error: "sin_ejercicios_disponibles", mensaje: err.message });
    }
    if (PG_ERRORES_DE_CLIENTE.has(err.code)) {
      return send(res, 400, { error: "datos_invalidos", mensaje: "Los datos enviados no son válidos" });
    }
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: "error_interno", mensaje: "Ocurrió un error inesperado" });
  }
});

async function start() {
  EXERCISE_DB = await db.todosLosEjercicios();
  if (EXERCISE_DB.length === 0) {
    console.warn("AVISO: la tabla ejercicios está vacía — corre `node seed-exercises.js` primero.");
  }
  server.listen(PORT, () => console.log(`SabStab backend escuchando en http://localhost:${PORT} (${EXERCISE_DB.length} ejercicios cargados)`));
}

start().catch((err) => {
  console.error("No se pudo arrancar el servidor:", err.message);
  process.exit(1);
});

module.exports = server;
