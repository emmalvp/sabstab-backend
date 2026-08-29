const assert = require("node:assert/strict");
const test = require("node:test");

const { EXERCISE_DB, oneRMRelevante, normalizarCargaGuardada } = require("./engine");

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
