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

const PATRONES_POR_DIA = {
  Empuje: ["empuje_horizontal", "empuje_vertical", "core"],
  Tiron: ["traccion_horizontal", "traccion_vertical", "core"],
  Piernas: ["sentadilla", "bisagra_cadera", "core"],
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

function generarNotasBiomecanicas(ejercicio, profile) {
  const { antropometria, lesiones } = profile;
  if (ejercicio.patron === "sentadilla" && antropometria.femurCm && antropometria.torsoCm) {
    const ratio = antropometria.femurCm / antropometria.torsoCm;
    if (ratio > 1.05) return "Vas a inclinar más el torso al bajar — es normal con tu proporción de piernas.";
  }
  const lesionRelevante = (lesiones || []).find(
    (l) => l.estado === "resuelta_con_precaucion" && ejercicio.contraindicaciones.includes(l.zona)
  );
  if (lesionRelevante) return `Movimiento controlado: cuida el rango final por tu historial en ${lesionRelevante.zona}.`;
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

function seleccionarEjerciciosDelDia(nombreDia, exerciseDB, profile) {
  const patrones = PATRONES_POR_DIA[nombreDia];
  if (!patrones) throw new Error(`Día desconocido: ${nombreDia}`);
  const disponibles = filtrarPorEquipo(filtrarPorLesiones(exerciseDB, profile.lesiones), profile.equipoDisponible);
  return patrones.map((patron) => {
    const candidatos = disponibles.filter((ej) => ej.patron === patron).sort(esMasCompuesto);
    if (candidatos.length === 0) throw new SinEjerciciosDisponiblesError(patron);
    return candidatos[0];
  });
}

function oneRMRelevante(ejercicio, oneRM) {
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

function generarDia(nombreDia, exerciseDB, profile) {
  const ejercicios = seleccionarEjerciciosDelDia(nombreDia, exerciseDB, profile);
  return ejercicios.map((ej) => {
    const rm = oneRMRelevante(ej, profile.oneRM);
    const carga = prescribirCarga(rm, profile.objetivo);
    const lesionActiva = (profile.lesiones || []).find(
      (l) => (l.estado === "activa" || l.estado === "en_rehabilitacion") && ej.contraindicaciones.includes(l.zona)
    );
    return {
      exercise: ej,
      series: carga.series,
      repeticiones: carga.repeticiones,
      porcentaje1RM: carga.porcentaje1RM,
      cargaKg: carga.cargaKg,
      nota: generarNotasBiomecanicas(ej, profile),
      advertenciaLesion: lesionActiva ? `Ajustado por tu historial en ${lesionActiva.zona}` : null,
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

function buscarAlternativas(ejercicioOcupado, exerciseDB, profile, topN = 3) {
  const candidatos = filtrarPorEquipo(filtrarPorLesiones(exerciseDB, profile.lesiones), profile.equipoDisponible).filter(
    (ej) => ej.id !== ejercicioOcupado.id
  );
  return candidatos
    .map((ej) => ({ ej, score: distanciaBiomecanica(ejercicioOcupado, ej) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, topN)
    .map((r) => r.ej);
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

function sugerirSupersets(prescritos) {
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
          motivo: "Músculos independientes: alterna series entre ambos con descanso mínimo para acortar la sesión sin perder rendimiento.",
        });
        usados.add(i);
        usados.add(j);
        break;
      }
    }
  }
  return pares;
}

module.exports = {
  EXERCISE_DB,
  estimate1RM,
  generarDia,
  buscarAlternativas,
  ajustarProximaCarga,
  redondearCarga,
  sugerirSupersets,
  SinEjerciciosDisponiblesError,
};
