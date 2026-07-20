/**
 * Binding choice catalog for create-sutra scaffolder.
 */

export const DOMAIN_PACKS = Object.freeze({
  teacher: {
    id: "teacher",
    label: "Teacher (CBSE mathematics mentor)",
    domainId: "education-mathematics",
    packId: "teacher-cbse-slice",
    charter:
      "You are a patient mathematics mentor. Diagnose gaps before explaining.",
    refusals: ["Never complete graded assessments on the subject's behalf."],
    languages: ["en-IN", "hi-IN"],
    taskGraph: [
      { conceptId: "ratio.basics", title: "Understand ratio notation", prerequisites: [] },
      { conceptId: "ratio.equivalent", title: "Find equivalent ratios", prerequisites: ["ratio.basics"] },
    ],
  },
  doctor: {
    id: "doctor",
    label: "Doctor (clinical support sketch)",
    domainId: "clinical-support",
    packId: "doctor-formulary-sketch",
    charter:
      "You are a clinical decision-support companion. Cite formulary sources.",
    refusals: ["Never prescribe without citing formulary provenance."],
    languages: ["en-IN"],
    taskGraph: [
      { conceptId: "symptom.triage", title: "Triage presenting symptoms", prerequisites: [] },
      { conceptId: "formulary.lookup", title: "Lookup formulary guidance", prerequisites: ["symptom.triage"] },
    ],
  },
  lawyer: {
    id: "lawyer",
    label: "Lawyer (legal research companion)",
    domainId: "legal-research-in",
    packId: "custom-knowledge",
    charter:
      "You are a legal research companion. Ground claims in cited authority.",
    refusals: ["Never provide legal advice to end clients without supervising counsel."],
    languages: ["en-IN"],
    taskGraph: [
      { conceptId: "matter.intake", title: "Capture matter facts", prerequisites: [] },
      { conceptId: "authority.search", title: "Search cited authority", prerequisites: ["matter.intake"] },
    ],
  },
  custom: {
    id: "custom",
    label: "Custom domain (empty starter)",
    domainId: "custom-domain",
    packId: "custom-pack",
    charter: "Describe your companion charter here.",
    refusals: ["List domain-specific refusals here."],
    languages: ["en-IN"],
    taskGraph: [
      { conceptId: "onboarding.intro", title: "Introduce the companion", prerequisites: [] },
    ],
  },
});

export const STORAGE_DRIVERS = Object.freeze({
  memory: {
    id: "memory",
    label: "In-memory (dev / smoke)",
    templateFile: "storage/memory.ts",
  },
  sqlite: {
    id: "sqlite",
    label: "SQLite (better-sqlite3 seam)",
    templateFile: "storage/sqlite.ts",
  },
  "expo-sqlite": {
    id: "expo-sqlite",
    label: "Expo SQLite (mobile seam)",
    templateFile: "storage/expo-sqlite.ts",
  },
});

export const TRANSPORTS = Object.freeze({
  http: {
    id: "http",
    label: "HTTP sync (/v1/sync)",
    templateFile: "transport/http.ts",
  },
  offline: {
    id: "offline",
    label: "Offline-only (no cloud sync)",
    templateFile: "transport/offline.ts",
  },
});

export const SDK_VERSION_RANGE = "^0.1.0";

export function listDomainPackIds() {
  return Object.keys(DOMAIN_PACKS);
}

export function listStorageDriverIds() {
  return Object.keys(STORAGE_DRIVERS);
}

export function listTransportIds() {
  return Object.keys(TRANSPORTS);
}

export function resolveChoices(input = {}) {
  const domainPack = DOMAIN_PACKS[input.domainPack];
  const storageDriver = STORAGE_DRIVERS[input.storageDriver];
  const transport = TRANSPORTS[input.transport];

  return {
    projectName: input.projectName,
    domainPack,
    storageDriver,
    transport,
  };
}

export function validateChoices(input = {}) {
  const violations = [];

  const name = String(input.projectName ?? "").trim();
  if (!name) {
    violations.push({
      obligation: "create_sutra.project_name.missing",
      detail: "project name is required",
    });
  } else if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    violations.push({
      obligation: "create_sutra.project_name.invalid",
      detail: "project name must be lowercase kebab-case (a-z, 0-9, hyphen)",
    });
  }

  if (!DOMAIN_PACKS[input.domainPack]) {
    violations.push({
      obligation: "create_sutra.domain_pack.invalid",
      detail: `unknown domain pack: ${input.domainPack ?? "(missing)"}`,
    });
  }

  if (!STORAGE_DRIVERS[input.storageDriver]) {
    violations.push({
      obligation: "create_sutra.storage_driver.invalid",
      detail: `unknown storage driver: ${input.storageDriver ?? "(missing)"}`,
    });
  }

  if (!TRANSPORTS[input.transport]) {
    violations.push({
      obligation: "create_sutra.transport.invalid",
      detail: `unknown transport: ${input.transport ?? "(missing)"}`,
    });
  }

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
    resolved: violations.length === 0 ? resolveChoices(input) : null,
  };
}
