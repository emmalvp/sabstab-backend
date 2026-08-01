/**
 * SabStab — acceso a datos sobre PostgreSQL real, usando exactamente
 * las tablas de sweetswank-schema.sql. Cada función mapea las columnas
 * snake_case del schema a los nombres camelCase que usan engine.js y
 * server.js. DATABASE_URL apunta al Postgres local por defecto (ver
 * README) — en producción, apunta a un Postgres real vía variable de
 * entorno.
 */
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://localhost:5432/sweetswank",
});

class EmailEnUsoError extends Error {
  constructor() {
    super("Ese correo ya está registrado");
    this.name = "EmailEnUsoError";
  }
}

// Ejecuta varias escrituras relacionadas de forma atómica (BEGIN/COMMIT,
// ROLLBACK si algo falla) — evita dejar filas a medio guardar cuando un
// flujo hace varios INSERT/UPDATE seguidos (ej. cerrar el perfil viejo +
// crear el nuevo + registrar lesiones y 1RM en PUT /profile).
async function transaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resultado = await fn(client);
    await client.query("COMMIT");
    return resultado;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// USUARIOS
// ---------------------------------------------------------------------
async function crearUsuario({ email, passwordHash, nombre }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, nombre) VALUES ($1, $2, $3)
       RETURNING id, email, nombre, idioma, unidad_peso AS "unidadPeso"`,
      [email, passwordHash, nombre]
    );
    return rows[0];
  } catch (err) {
    if (err.code === "23505") throw new EmailEnUsoError();
    throw err;
  }
}

async function buscarUsuarioPorEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash AS "passwordHash", nombre, idioma, unidad_peso AS "unidadPeso"
     FROM users WHERE email = $1`,
    [email]
  );
  return rows[0] || null;
}

async function buscarUsuarioPorId(id) {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash AS "passwordHash", nombre, idioma, unidad_peso AS "unidadPeso"
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function crearUsuarioApple({ email, appleUserId, nombre }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, apple_user_id, nombre) VALUES ($1, $2, $3)
       RETURNING id, email, nombre, idioma, unidad_peso AS "unidadPeso"`,
      [email, appleUserId, nombre]
    );
    return rows[0];
  } catch (err) {
    if (err.code === "23505") throw new EmailEnUsoError();
    throw err;
  }
}

async function buscarUsuarioPorAppleId(appleUserId) {
  const { rows } = await pool.query(
    `SELECT id, email, nombre, idioma, unidad_peso AS "unidadPeso"
     FROM users WHERE apple_user_id = $1`,
    [appleUserId]
  );
  return rows[0] || null;
}

async function vincularAppleId(userId, appleUserId) {
  await pool.query(`UPDATE users SET apple_user_id = $1 WHERE id = $2`, [appleUserId, userId]);
}

async function actualizarPassword(userId, passwordHash) {
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
}

// Borra al usuario; todas las tablas relacionadas (perfiles, lesiones,
// registros_1rm, rutinas_dia, registros_sesion, dispositivos_conectados,
// password_reset_tokens) tienen ON DELETE CASCADE, así que esto basta
// para cumplir con el requisito de Google Play de eliminar cuenta y datos.
async function eliminarUsuario(userId) {
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

async function actualizarAjustesUsuario(id, cambios) {
  const columnas = { idioma: "idioma", unidadPeso: "unidad_peso", nombre: "nombre" };
  const sets = [];
  const valores = [];
  let i = 1;
  for (const [clave, columna] of Object.entries(columnas)) {
    if (cambios[clave] !== undefined) {
      sets.push(`${columna} = $${i++}`);
      valores.push(cambios[clave]);
    }
  }
  if (sets.length === 0) return;
  valores.push(id);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, valores);
}

// ---------------------------------------------------------------------
// PERFIL
// ---------------------------------------------------------------------
async function perfilVigente(userId) {
  const { rows } = await pool.query(
    `SELECT id, altura_cm AS "alturaCm", femur_cm AS "femurCm", torso_cm AS "torsoCm", brazo_cm AS "brazoCm",
            objetivo, nivel, dias_por_semana AS "diasPorSemana", duracion_sesion_min AS "duracionSesionMin",
            equipo_disponible AS "equipoDisponible", vigente_desde AS "vigenteDesde"
     FROM perfiles WHERE user_id = $1 AND vigente_hasta IS NULL`,
    [userId]
  );
  return rows[0] || null;
}

async function cerrarPerfilVigente(userId, client = pool) {
  await client.query(`UPDATE perfiles SET vigente_hasta = now() WHERE user_id = $1 AND vigente_hasta IS NULL`, [userId]);
}

async function crearPerfil(userId, p, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO perfiles (user_id, altura_cm, femur_cm, torso_cm, brazo_cm, objetivo, nivel, dias_por_semana, duracion_sesion_min, equipo_disponible)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, vigente_desde AS "vigenteDesde"`,
    [userId, p.alturaCm, p.femurCm, p.torsoCm, p.brazoCm, p.objetivo, p.nivel, p.diasPorSemana, p.duracionSesionMin, p.equipoDisponible]
  );
  return rows[0];
}

// ---------------------------------------------------------------------
// LESIONES
// ---------------------------------------------------------------------
async function agregarLesiones(userId, lesiones, client = pool) {
  for (const l of lesiones) {
    await client.query(
      `INSERT INTO lesiones (user_id, zona, lado, estado, movimiento_que_agrava) VALUES ($1,$2,$3,$4,$5)`,
      [userId, l.zona, l.lado, l.estado, l.movimientoQueAgrava || null]
    );
  }
}

async function lesionesActivasDeUsuario(userId) {
  const { rows } = await pool.query(
    `SELECT zona, lado, estado FROM lesiones WHERE user_id = $1 AND resuelta_en IS NULL`,
    [userId]
  );
  return rows;
}

// ---------------------------------------------------------------------
// 1RM
// ---------------------------------------------------------------------
async function agregarRegistro1RM(userId, levantamiento, valorKg, origen = "reportado", client = pool) {
  await client.query(
    `INSERT INTO registros_1rm (user_id, levantamiento, valor_kg, origen) VALUES ($1,$2,$3,$4)`,
    [userId, levantamiento, valorKg, origen]
  );
}

async function ultimoRegistro1RM(userId, levantamiento) {
  const { rows } = await pool.query(
    `SELECT valor_kg AS "valorKg" FROM registros_1rm
     WHERE user_id = $1 AND levantamiento = $2
     ORDER BY registrado_en DESC LIMIT 1`,
    [userId, levantamiento]
  );
  return rows[0]?.valorKg ? Number(rows[0].valorKg) : 0;
}

async function historial1RM(userId, levantamiento) {
  const { rows } = await pool.query(
    `SELECT registrado_en AS "fecha", valor_kg AS "valor" FROM registros_1rm
     WHERE user_id = $1 AND levantamiento = $2
     ORDER BY registrado_en ASC`,
    [userId, levantamiento]
  );
  return rows.map((r) => ({ fecha: r.fecha, valor: Number(r.valor) }));
}

// ---------------------------------------------------------------------
// EJERCICIOS (catálogo — poblado por seed-exercises.js desde exercises-db.json)
// ---------------------------------------------------------------------
async function todosLosEjercicios() {
  const { rows } = await pool.query(
    `SELECT id, nombre, patron, musculo_primario AS "musculoPrimario",
            musculos_secundarios AS "musculosSecundarios", angulo_grados AS "anguloGrados",
            equipo_necesario AS "equipoNecesario", unilateral, contraindicaciones
     FROM ejercicios ORDER BY id`
  );
  return rows;
}

// ---------------------------------------------------------------------
// RUTINAS
// ---------------------------------------------------------------------
async function crearRutinaDia(userId, nombreDia, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO rutinas_dia (user_id, nombre_dia) VALUES ($1,$2) RETURNING id`,
    [userId, nombreDia]
  );
  return rows[0].id;
}

async function agregarRutinaEjercicio(rutinaDiaId, re, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO rutina_ejercicios (rutina_dia_id, ejercicio_id, orden, series, repeticiones, porcentaje_1rm, carga_kg, nota_biomecanica, advertencia_lesion)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [rutinaDiaId, re.ejercicioId, re.orden, re.series, re.repeticiones, re.porcentaje1RM, re.cargaKg, re.notaBiomecanica || null, re.advertenciaLesion || null]
  );
  return rows[0].id;
}

async function rutinaDiaDeUsuario(rutinaDiaId, userId) {
  const { rows } = await pool.query(
    `SELECT id, nombre_dia AS "nombreDia" FROM rutinas_dia WHERE id = $1 AND user_id = $2`,
    [rutinaDiaId, userId]
  );
  return rows[0] || null;
}

async function ejerciciosDeRutinaDia(rutinaDiaId) {
  const { rows } = await pool.query(
    `SELECT id AS "rutinaEjercicioId", ejercicio_id AS "ejercicioId", orden, series, repeticiones,
            porcentaje_1rm AS "porcentaje1RM", carga_kg AS "cargaKg",
            nota_biomecanica AS "nota", advertencia_lesion AS "advertenciaLesion"
     FROM rutina_ejercicios WHERE rutina_dia_id = $1 ORDER BY orden ASC`,
    [rutinaDiaId]
  );
  return rows.map((r) => ({
    ...r,
    porcentaje1RM: r.porcentaje1RM != null ? Number(r.porcentaje1RM) : null,
    cargaKg: r.cargaKg != null ? Number(r.cargaKg) : null,
  }));
}

// ---------------------------------------------------------------------
// SESIONES / PROGRESO
// ---------------------------------------------------------------------
async function crearRegistroSesion(userId, s) {
  const { rows } = await pool.query(
    `INSERT INTO registros_sesion (user_id, rutina_ejercicio_id, carga_usada_kg, repeticiones_completadas, rpe, fuente)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, s.rutinaEjercicioId, s.cargaUsadaKg, s.repeticionesCompletadas, s.rpe, s.fuente || "manual"]
  );
  return rows[0].id;
}

async function rutinaEjercicioPorId(id) {
  const { rows } = await pool.query(`SELECT repeticiones FROM rutina_ejercicios WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function contarSesionesDeUsuario(userId) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM registros_sesion WHERE user_id = $1`, [userId]);
  return rows[0].n;
}

// Volumen de entrenamiento (tonelaje: carga × repeticiones) de las
// últimas `semanas` semanas móviles (semana 0 = hace 0-7 días, la más
// reciente al final del array). Es la métrica estándar de volumen en
// entrenamiento de fuerza/hipertrofia — series×reps×carga.
async function volumenSemanal(userId, semanas = 8) {
  const { rows } = await pool.query(
    `SELECT floor(extract(epoch FROM (now() - completada_en)) / (7*86400))::int AS semanas_atras,
            SUM(COALESCE(carga_usada_kg, 0) * repeticiones_completadas) AS volumen
     FROM registros_sesion
     WHERE user_id = $1 AND completada_en >= now() - ($2 || ' weeks')::interval
     GROUP BY semanas_atras`,
    [userId, semanas]
  );
  const porSemana = new Array(semanas).fill(0);
  for (const r of rows) {
    const idx = semanas - 1 - r.semanas_atras;
    if (idx >= 0 && idx < semanas) porSemana[idx] = Math.round(Number(r.volumen));
  }
  return porSemana;
}

// Flags 1/0 de constancia de los últimos `dias` días (posición 0 = hace
// `dias-1` días, la más reciente al final) — 1 si hubo al menos una
// serie/sesión registrada ese día calendario (UTC).
async function constancia28dias(userId, dias = 28) {
  const { rows } = await pool.query(
    `SELECT DISTINCT date_trunc('day', completada_en) AS dia
     FROM registros_sesion
     WHERE user_id = $1 AND completada_en >= now() - ($2 || ' days')::interval`,
    [userId, dias]
  );
  const diasConSesion = new Set(rows.map((r) => r.dia.toISOString().slice(0, 10)));
  const resultado = [];
  for (let i = dias - 1; i >= 0; i--) {
    const fecha = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    resultado.push(diasConSesion.has(fecha) ? 1 : 0);
  }
  return resultado;
}

// ---------------------------------------------------------------------
// DISPOSITIVOS
// ---------------------------------------------------------------------
async function crearDispositivo(userId, tipo) {
  const { rows } = await pool.query(
    `INSERT INTO dispositivos_conectados (user_id, tipo) VALUES ($1,$2) RETURNING id`,
    [userId, tipo]
  );
  return rows[0].id;
}

async function desactivarDispositivo(id, userId) {
  const { rows } = await pool.query(
    `UPDATE dispositivos_conectados SET activo = false WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------
// RECUPERACIÓN DE CONTRASEÑA
// ---------------------------------------------------------------------
async function crearTokenReset(userId, tokenHash, expiraEn) {
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expira_en) VALUES ($1,$2,$3)`,
    [userId, tokenHash, expiraEn]
  );
}

async function buscarTokenReset(tokenHash) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", expira_en AS "expiraEn", usado_en AS "usadoEn"
     FROM password_reset_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function marcarTokenResetUsado(id) {
  await pool.query(`UPDATE password_reset_tokens SET usado_en = now() WHERE id = $1`, [id]);
}

module.exports = {
  pool,
  EmailEnUsoError,
  transaccion,
  crearUsuario,
  crearUsuarioApple,
  buscarUsuarioPorAppleId,
  vincularAppleId,
  buscarUsuarioPorEmail,
  buscarUsuarioPorId,
  actualizarAjustesUsuario,
  actualizarPassword,
  eliminarUsuario,
  perfilVigente,
  cerrarPerfilVigente,
  crearPerfil,
  agregarLesiones,
  lesionesActivasDeUsuario,
  agregarRegistro1RM,
  ultimoRegistro1RM,
  historial1RM,
  todosLosEjercicios,
  crearRutinaDia,
  agregarRutinaEjercicio,
  rutinaDiaDeUsuario,
  ejerciciosDeRutinaDia,
  crearRegistroSesion,
  rutinaEjercicioPorId,
  contarSesionesDeUsuario,
  volumenSemanal,
  constancia28dias,
  crearDispositivo,
  desactivarDispositivo,
  crearTokenReset,
  buscarTokenReset,
  marcarTokenResetUsado,
};
