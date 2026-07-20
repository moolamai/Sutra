import type { AgentProfile } from "sutra-sdk";

/** Domain pack metadata selected at scaffold time. */
export const domainPack = {
  id: "custom",
  domainId: "custom-domain",
  packId: "custom-pack",
  charter: "Describe your companion charter here.",
} as const;

/** Typed AgentProfile stub — edit charter/refusals for your domain. */
export const agentProfile: AgentProfile = {
  domainId: domainPack.domainId,
  charter: domainPack.charter,
  refusals: ["List domain-specific refusals here."] as string[],
  languages: ["en-IN"] as string[],
};

/** Prerequisite task graph rows (data, not code). */
export const taskGraph = [
  {
    "conceptId": "onboarding.intro",
    "title": "Introduce the companion",
    "prerequisites": []
  }
] as const;

export type TaskGraphRow = (typeof taskGraph)[number];
export type DomainPackConfig = typeof domainPack;
