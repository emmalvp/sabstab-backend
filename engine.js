/**
 * SabStab — motor de generación de rutinas.
 * Puerto directo de sweetswank-algorithm.ts a JS (CommonJS) para correr
 * en el servidor. Misma lógica, mismos nombres de función.
 */
const fs = require("fs");
const path = require("path");

const EXERCISE_DB = JSON.parse(
  fs.readFileSync(path.join(__dirname, "exercises-db.json"), "utf8")
).ejercicios;

// requeridos: si no hay ningún ejercicio disponible (equipo/lesiones) para
// ese patrón, generarDia falla con SinEjerciciosDisponiblesError — solo
// llevan patrones con al menos una variante de solo peso corporal en la
// base de datos. opcionales: se agregan si hay equipo disponible para
// ellos y si no, se omiten en silencio (nunca rompen la generación).
//
// El día compuesto solo (empuje_horizontal + empuje_vertical, o
// traccion_horizontal + traccion_vertical) deja fuera músculos que sí
// participan activamente en ese patrón de movimiento — tríceps y deltoides
// lateral en empuje, bíceps y deltoides posterior en tirón, pantorrillas en
// piernas — que los compuestos estimulan poco comparado con su propio
// rango de movimiento en aislamiento (Schoenfeld & Grgic 2020, revisión de
// volumen por grupo muscular; Nippard/Helms, plantillas push/pull/legs
// basadas en evidencia). Por eso cada día ahora también cubre esos
// patrones accesorios, no solo el/los ejercicios compuestos principales.
const PATRONES_POR_DIA = {
  Empuje: {
    requeridos: ["empuje_horizontal", "empuje_vertical", "extension_codo", "core"],
    opcionales: ["abduccion_hombro"],
  },
  Tiron: {
    requeridos: ["traccion_horizontal", "traccion_vertical", "core"],
    opcionales: ["flexion_codo", "elevacion_posterior_hombro"],
  },
  Piernas: {
    requeridos: ["sentadilla", "bisagra_cadera", "flexion_plantar", "core"],
    opcionales: [],
  },
};

const RANGOS_POR_OBJETIVO = {
  fuerza: { pctMin: 0.85, pctMax: 0.95, series: 4, repMin: 3, repMax: 6 },
  hipertrofia: { pctMin: 0.65, pctMax: 0.8, series: 3, repMin: 8, repMax: 12 },
  ambos: { pctMin: 0.75, pctMax: 0.85, series: 4, repMin: 6, repMax: 10 },
};

function estimate1RM(pesoKg, reps) {
  if (!pesoKg || !reps) return null;
  if (reps === 1) return Math.round(pesoKg);
  return Math.round(pesoKg * (1 + reps / 30));
}

function redondearCarga(kg, incremento = 2.5) {
  return Math.round(kg / incremento) * incremento;
}

function filtrarPorLesiones(ejercicios, lesiones) {
  const zonasExcluyentes = new Set(
    (lesiones || [])
      .filter((l) => l.estado === "activa" || l.estado === "en_rehabilitacion")
      .map((l) => l.zona)
  );
  if (zonasExcluyentes.size === 0) return ejercicios;
  return ejercicios.filter((ej) => !ej.contraindicaciones.some((z) => zonasExcluyentes.has(z)));
}

function filtrarPorEquipo(ejercicios, equipoDisponible) {
  return ejercicios.filter((ej) => ej.equipoNecesario.every((eq) => (equipoDisponible || []).includes(eq)));
}

function esSoloPesoCorporal(ejercicio) {
  return ejercicio.equipoNecesario.length === 1 && ejercicio.equipoNecesario[0] === "peso_corporal";
}

// zona (enum de lesiones.zona) → texto legible, en los dos idiomas que
// soporta la app. El motor genera las notas en el idioma del usuario
// (users.idioma) para no depender de que el cliente re-traduzca texto libre.
const ZONA_LABEL = {
  hombro: { es: "hombro", en: "shoulder" },
  rodilla: { es: "rodilla", en: "knee" },
  espalda_baja: { es: "espalda baja", en: "lower back" },
  codo: { es: "codo", en: "elbow" },
  cadera: { es: "cadera", en: "hip" },
};

function generarNotasBiomecanicas(ejercicio, profile, idioma = "es") {
  const en = idioma === "en";
  const { antropometria, lesiones, edad, pesoCorporalKg } = profile;
  if (ejercicio.patron === "sentadilla" && antropometria.femurCm && antropometria.torsoCm) {
    const ratio = antropometria.femurCm / antropometria.torsoCm;
    if (ratio > 1.05) {
      return en
        ? "You'll lean your torso forward more on the way down — normal for your leg proportions."
        : "Vas a inclinar más el torso al bajar — es normal con tu proporción de piernas.";
    }
  }
  // Brazo largo respecto al torso alarga el recorrido de la barra en press
  // horizontal (Nuckols/Beardsley sobre cómo la longitud de brazo afecta
  // el 1RM comparado entre personas en press banca) — mismo peso relativo
  // se va a sentir más pesado por el ROM más largo, no por falta de fuerza.
  if (ejercicio.patron === "empuje_horizontal" && antropometria.brazoCm && antropometria.torsoCm) {
    const ratioBrazo = antropometria.brazoCm / antropometria.torsoCm;
    if (ratioBrazo > 1.15) {
      return en
        ? "Your arm length means a longer bar path on this lift — the same weight will feel heavier than for someone with shorter arms. Normal, not a strength issue."
        : "Tu longitud de brazo alarga el recorrido de la barra en este ejercicio — el mismo peso se va a sentir más pesado que para alguien con brazos más cortos. Es normal, no falta de fuerza.";
    }
  }
  const lesionRelevante = (lesiones || []).find(
    (l) => l.estado === "resuelta_con_precaucion" && ejercicio.contraindicaciones.includes(l.zona)
  );
  if (lesionRelevante) {
    const zona = ZONA_LABEL[lesionRelevante.zona]?.[en ? "en" : "es"] || lesionRelevante.zona;
    return en
      ? `Controlled movement: watch the end range because of your ${zona} history.`
      : `Movimiento controlado: cuida el rango final por tu historial en ${zona}.`;
  }
  // Sin 1RM de referencia (ver oneRMRelevante) la progresión es por reps, no
  // por kg — así que la carga externa se sugiere como un salto ligado a tu
  // propio peso corporal, en vez de un número arbitrario.
  if (esSoloPesoCorporal(ejercicio) && pesoCorporalKg) {
    const saltoKg = Math.round(pesoCorporalKg * 0.075 * 10) / 10;
    return en
      ? `Bodyweight exercise: once you exceed the top of your rep range at RPE ≤8, instead of adding more reps add ~${saltoKg}kg external (weighted vest or belt) and go back to the bottom of the range.`
      : `Ejercicio con tu propio peso: cuando superes el techo del rango de reps a RPE ≤8, en vez de sumar más reps agrega ~${saltoKg}kg externos (chaleco o cinturón lastrado) y vuelve al piso del rango.`;
  }
  // Fragala et al. 2019 (NSCA position stand, entrenamiento de fuerza en
  // adultos mayores): el riesgo tendinoso/articular baja con más
  // calentamiento específico, sin necesidad de tocar la prescripción numérica.
  if (edad && edad >= 50) {
    return en
      ? "At your age, one extra light warm-up set (same technique, lighter weight) before the working set lowers injury risk without changing your prescription."
      : "A tu edad, una serie extra de calentamiento específico (misma técnica, peso ligero) antes de la serie de trabajo reduce el riesgo de molestias sin cambiar tu prescripción.";
  }
  return "";
}

class SinEjerciciosDisponiblesError extends Error {
  constructor(patron) {
    super(`Sin ejercicios disponibles para el patrón ${patron} con tu equipo/lesiones actuales`);
    this.name = "SinEjerciciosDisponiblesError";
    this.patron = patron;
  }
}

// Prioriza compuestos sobre aislamiento: más músculos secundarios
// involucrados ≈ movimiento más compuesto (mueve más masa muscular por
// serie, mejor relación estímulo/tiempo). Independiente del orden en que
// vengan los ejercicios desde la base de datos. En empate, prioriza
// equipo cargable con disco/mancuerna — evita que el ejercicio por
// defecto de un patrón ligado a un 1RM (ej. empuje_horizontal → press
// banca) termine siendo una variante de peso corporal, para la que
// prescribir un %1RM en kg no tiene sentido.
const PRIORIDAD_EQUIPO = { barra: 0, mancuerna: 1, maquina: 2, polea: 3, banda: 4, peso_corporal: 5 };
function prioridadEquipo(ejercicio) {
  return Math.min(...ejercicio.equipoNecesario.map((eq) => PRIORIDAD_EQUIPO[eq] ?? 6));
}
function esMasCompuesto(a, b) {
  const diff = (b.musculosSecundarios?.length || 0) - (a.musculosSecundarios?.length || 0);
  if (diff !== 0) return diff;
  return prioridadEquipo(a) - prioridadEquipo(b);
}

// Cuántos patrones accesorios (opcionales) incluir según el objetivo —
// no es solo la carga/reps lo que debería cambiar entre fuerza e
// hipertrofia, sino el propio contenido del día. Fuerza (Starting
// Strength, 5/3/1) minimiza accesorios y prioriza el/los compuestos
// principales; hipertrofia (Schoenfeld, Israetel/RP) se beneficia de más
// volumen distribuido en accesorios; "ambos" es un punto medio.
function accesoriosPorObjetivo(opcionales, objetivo) {
  if (objetivo === "fuerza") return [];
  if (objetivo === "ambos") return opcionales.slice(0, Math.ceil(opcionales.length / 2));
  return opcionales; // hipertrofia (default)
}

function seleccionarEjerciciosDelDia(nombreDia, exerciseDB, profile) {
  const spec = PATRONES_POR_DIA[nombreDia];
  if (!spec) throw new Error(`Día desconocido: ${nombreDia}`);
  const disponibles = filtrarPorEquipo(filtrarPorLesiones(exerciseDB, profile.lesiones), profile.equipoDisponible);
  const elegirUno = (patron) => disponibles.filter((ej) => ej.patron === patron).sort(esMasCompuesto)[0] || null;

  const requeridos = spec.requeridos.map((patron) => {
    const ej = elegirUno(patron);
    if (!ej) throw new SinEjerciciosDisponiblesError(patron);
    return ej;
  });
  const patronesOpcionales = accesoriosPorObjetivo(spec.opcionales, profile.objetivo);
  const opcionales = patronesOpcionales.map(elegirUno).filter(Boolean);
  return [...requeridos, ...opcionales];
}

function oneRMRelevante(ejercicio, oneRM) {
  // Un ejercicio sin carga externa (solo peso corporal) no tiene relación
  // válida con el 1RM de un movimiento con barra del mismo patrón — pedirle
  // a alguien "8-12 reps a 72kg" en una flexión no tiene sentido. Progresa
  // por reps (rama sin oneRMBase de prescribirCarga), no por %1RM.
  if (esSoloPesoCorporal(ejercicio)) return null;
  switch (ejercicio.patron) {
    case "sentadilla": return oneRM.sentadilla || null;
    case "bisagra_cadera": return oneRM.pesoMuerto || null;
    case "empuje_horizontal": return oneRM.pressBanca || null;
    case "empuje_vertical": return oneRM.pressMilitar || null;
    default: return null;
  }
}

function prescribirCarga(oneRMBase, objetivo) {
  const rango = RANGOS_POR_OBJETIVO[objetivo] || RANGOS_POR_OBJETIVO.hipertrofia;
  const pctPromedio = (rango.pctMin + rango.pctMax) / 2;
  if (!oneRMBase) {
    return { series: rango.series, repeticiones: `${rango.repMin}-${rango.repMax}`, porcentaje1RM: null, cargaKg: null };
  }
  return {
    series: rango.series,
    repeticiones: `${rango.repMin}-${rango.repMax}`,
    porcentaje1RM: Math.round(pctPromedio * 100),
    cargaKg: redondearCarga(oneRMBase * pctPromedio),
  };
}

// Copia superficial con el nombre en el idioma del usuario — nunca se muta
// el objeto original de EXERCISE_DB (compartido entre requests).
function conNombreLocalizado(ejercicio, idioma) {
  if (idioma !== "en" || !ejercicio.nombreEn) return ejercicio;
  return { ...ejercicio, nombre: ejercicio.nombreEn };
}

function generarDia(nombreDia, exerciseDB, profile, idioma = "es") {
  const ejercicios = seleccionarEjerciciosDelDia(nombreDia, exerciseDB, profile);
  const en = idioma === "en";
  return ejercicios.map((ej) => {
    const rm = oneRMRelevante(ej, profile.oneRM);
    const carga = prescribirCarga(rm, profile.objetivo);
    const lesionActiva = (profile.lesiones || []).find(
      (l) => (l.estado === "activa" || l.estado === "en_rehabilitacion") && ej.contraindicaciones.includes(l.zona)
    );
    const zonaActiva = lesionActiva && (ZONA_LABEL[lesionActiva.zona]?.[en ? "en" : "es"] || lesionActiva.zona);
    return {
      exercise: conNombreLocalizado(ej, idioma),
      series: carga.series,
      repeticiones: carga.repeticiones,
      porcentaje1RM: carga.porcentaje1RM,
      cargaKg: carga.cargaKg,
      nota: generarNotasBiomecanicas(ej, profile, idioma),
      advertenciaLesion: lesionActiva
        ? en
          ? `Adjusted for your ${zonaActiva} history`
          : `Ajustado por tu historial en ${zonaActiva}`
        : null,
    };
  });
}

function distanciaBiomecanica(a, b) {
  let d = 0;
  if (a.patron !== b.patron) d += 100;
  if (a.musculoPrimario !== b.musculoPrimario) d += 40;
  d += Math.abs(a.anguloGrados - b.anguloGrados) * 0.5;
  if (a.unilateral !== b.unilateral) d += 10;
  return d;
}

function buscarAlternativas(ejercicioOcupado, exerciseDB, profile, topN = 3, idioma = "es") {
  const candidatos = filtrarPorEquipo(filtrarPorLesiones(exerciseDB, profile.lesiones), profile.equipoDisponible).filter(
    (ej) => ej.id !== ejercicioOcupado.id
  );
  return candidatos
    .map((ej) => ({ ej, score: distanciaBiomecanica(ejercicioOcupado, ej) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, topN)
    .map((r) => conNombreLocalizado(r.ej, idioma));
}

function ajustarProximaCarga(cargaActual, repsObjetivoMax, registro, incrementoKg = 2.5) {
  const completoRepsObjetivo = registro.repeticionesCompletadas >= repsObjetivoMax;
  if (completoRepsObjetivo && registro.rpe <= 8) return redondearCarga(cargaActual + incrementoKg);
  if (registro.rpe >= 9.5) return redondearCarga(cargaActual - incrementoKg);
  return cargaActual;
}

// ---------------------------------------------------------------------------
// EMPAREJAMIENTO DE SUPERSETS — entrenar el mismo volumen en menos tiempo
// ---------------------------------------------------------------------------
// Empareja ejercicios cuyos músculos (primario + secundarios) no se pisan
// entre sí, para poder alternar series con descanso mínimo sin perder
// rendimiento en ninguno de los dos ("superset no competitivo"). Evidencia:
// Robbins, Young & Clark (2010) y Kelleher et al. (2010) muestran que el
// entrenamiento por pares antagonistas/independientes reduce la duración
// total de la sesión sin comprometer el volumen de carga levantado.
function musculosInvolucrados(ejercicio) {
  return new Set([ejercicio.musculoPrimario, ...(ejercicio.musculosSecundarios || [])]);
}

function sonCompatiblesParaSuperset(prescritoA, prescritoB) {
  const a = prescritoA.exercise;
  const b = prescritoB.exercise;
  if (a.musculoPrimario === b.musculoPrimario) return false;
  const musA = musculosInvolucrados(a);
  const musB = musculosInvolucrados(b);
  for (const m of musA) if (musB.has(m)) return false;
  return true;
}

function sugerirSupersets(prescritos, idioma = "es") {
  const en = idioma === "en";
  const usados = new Set();
  const pares = [];
  for (let i = 0; i < prescritos.length; i++) {
    if (usados.has(i)) continue;
    for (let j = i + 1; j < prescritos.length; j++) {
      if (usados.has(j)) continue;
      if (sonCompatiblesParaSuperset(prescritos[i], prescritos[j])) {
        pares.push({
          rutinaEjercicioIdA: prescritos[i].rutinaEjercicioId,
          rutinaEjercicioIdB: prescritos[j].rutinaEjercicioId,
          ejercicioIdA: prescritos[i].exercise.id,
          ejercicioIdB: prescritos[j].exercise.id,
          motivo: en
            ? "Independent muscles: alternate sets between the two with minimal rest to shorten the session without losing performance."
            : "Músculos independientes: alterna series entre ambos con descanso mínimo para acortar la sesión sin perder rendimiento.",
        });
        usados.add(i);
        usados.add(j);
        break;
      }
    }
  }
  return pares;
}

// ---------------------------------------------------------------------------
// PROGRAMA SEMANAL — qué días son de entreno y cuáles de descanso
// ---------------------------------------------------------------------------
// Reparte diasPorSemana sesiones lo más uniformemente posible a lo largo de
// una semana de 7 días (mismo principio que un ritmo euclidiano / algoritmo
// de Bresenham: floor((d+1)*N/7) > floor(d*N/7) marca el día d como "activo"
// exactamente N veces en 7 pasos, separados lo más parejo que permite la
// aritmética entera). Espaciar el entreno evita juntar sesiones seguidas del
// mismo grupo muscular sin recuperación. diaSemana: 0=lunes … 6=domingo.
const CICLO_SPLIT = ["Empuje", "Tiron", "Piernas"];
// diasDescansoPreferidos: array opcional de días ISO (0=lunes...6=domingo)
// que el usuario eligió como descanso — si viene y calza con diasPorSemana
// (validado en server.js), se respeta tal cual en vez del reparto parejo
// automático. Los días de entrenamiento restantes se numeran en orden de
// calendario para asignarles el split (empuje/tirón/piernas).
function generarProgramaSemanal(diasPorSemana, diasDescansoPreferidos = null) {
  const n = Math.min(7, Math.max(1, diasPorSemana));
  const descansoManual =
    Array.isArray(diasDescansoPreferidos) && diasDescansoPreferidos.length === 7 - n ? new Set(diasDescansoPreferidos) : null;
  let entrenoIndex = 0;
  const programa = [];
  for (let d = 0; d < 7; d++) {
    const esEntreno = descansoManual ? !descansoManual.has(d) : Math.floor(((d + 1) * n) / 7) > Math.floor((d * n) / 7);
    if (esEntreno) {
      programa.push({ diaSemana: d, tipo: CICLO_SPLIT[entrenoIndex % CICLO_SPLIT.length], descanso: false });
      entrenoIndex++;
    } else {
      programa.push({ diaSemana: d, tipo: null, descanso: true });
    }
  }
  return programa;
}

// ---------------------------------------------------------------------------
// DETECCIÓN DE ESTANCAMIENTO — señal para sugerir cambiar de rutina
// ---------------------------------------------------------------------------
// Mira solo los puntos dentro de los últimos `ventanaDias` (por defecto 6
// semanas): si el primero y el último de esa ventana están separados por al
// menos `minDiasEntrePuntos` (3 semanas) y el valor no subió, es una meseta
// real y no solo falta de datos recientes. Evidencia: los mesociclos de
// fuerza/hipertrofia se planifican en bloques de 4-6 semanas precisamente
// porque accommodation (pérdida de respuesta al mismo estímulo) suele
// aparecer en ese rango — cambiar ejercicios o variables reinicia el estímulo.
function detectarEstancamiento(historial, ventanaDias = 42, minDiasEntrePuntos = 21) {
  const ahora = Date.now();
  const enVentana = historial.filter((h) => (ahora - new Date(h.fecha).getTime()) / 86400000 <= ventanaDias);
  if (enVentana.length < 2) return false;
  const primero = enVentana[0];
  const ultimo = enVentana[enVentana.length - 1];
  const diasTranscurridos = (new Date(ultimo.fecha) - new Date(primero.fecha)) / 86400000;
  if (diasTranscurridos < minDiasEntrePuntos) return false;
  return ultimo.valor <= primero.valor;
}

module.exports = {
  EXERCISE_DB,
  estimate1RM,
  generarDia,
  buscarAlternativas,
  ajustarProximaCarga,
  redondearCarga,
  sugerirSupersets,
  generarProgramaSemanal,
  detectarEstancamiento,
  conNombreLocalizado,
  SinEjerciciosDisponiblesError,
};
