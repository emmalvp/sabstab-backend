const assert = require("node:assert/strict");
const test = require("node:test");

const { EXERCISE_DB, generarDia, oneRMRelevante, normalizarCargaGuardada, parametrosDeEjecucion } = require("./engine");

function ejercicio(id) {
  const encontrado = EXERCISE_DB.find((item) => item.id === id);
  assert.ok(encontrado, `Falta el ejercicio ${id}`);
  return encontrado;
}

const oneRM = { sentadilla: 180, pesoMuerto: 140, pressBanca: 100, pressMilitar: 60 };

test("good mornings never inherit the deadlift 1RM", () => {
  assert.equal(oneRMRelevante(ejercicio("buenos_dias_barra"), oneRM), null);
});

test("only the exact measured lift receives its direct 1RM", () => {
  assert.equal(oneRMRelevante(ejercicio("peso_muerto_convencional"), oneRM), 140);
  assert.equal(oneRMRelevante(ejercicio("peso_muerto_rumano_barra"), oneRM), null);
});

test("legacy percentage-based accessory loads are hidden", () => {
  assert.deepEqual(normalizarCargaGuardada(ejercicio("buenos_dias_barra"), 73, 102.5), {
    porcentaje1RM: null,
    cargaKg: null,
  });
});

test("a direct lift keeps its valid percentage-based load", () => {
  assert.deepEqual(normalizarCargaGuardada(ejercicio("peso_muerto_convencional"), 73, 102.5), {
    porcentaje1RM: 73,
    cargaKg: 102.5,
  });
});

test("core exercise selection is stable for the same date and rotates across dates", () => {
  const profile = {
    antropometria: {},
    lesiones: [],
    objetivo: "hipertrofia",
    nivel: "intermedio",
    duracionSesionMin: 60,
    equipoDisponible: ["barra", "mancuerna", "polea", "maquina", "peso_corporal", "banda"],
    oneRM,
  };
  const coreId = (fecha) => generarDia("Empuje", EXERCISE_DB, profile, "es", fecha)
    .find((item) => item.exercise.patron === "core").exercise.id;

  assert.equal(coreId("2026-09-05"), coreId("2026-09-05"));
  const seleccionados = new Set(Array.from({ length: 14 }, (_, i) => coreId(`2026-09-${String(i + 1).padStart(2, "0")}`)));
  assert.ok(seleccionados.size > 1, "el core debe variar entre sesiones");
});

test("effort targets distinguish experience levels without prescribing failure", () => {
  const press = ejercicio("press_banca_plano_barra");
  assert.equal(parametrosDeEjecucion(press, "hipertrofia", "principiante").rirObjetivo, "3");
  assert.equal(parametrosDeEjecucion(press, "hipertrofia", "intermedio").rirObjetivo, "2");
  assert.equal(parametrosDeEjecucion(press, "hipertrofia", "avanzado").rirObjetivo, "1-2");
  assert.ok(parametrosDeEjecucion(press, "fuerza", "avanzado").descansoSeg >= 180);
});
