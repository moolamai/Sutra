import type { AgentProfile } from "sutra-sdk";

/** Default domain pack for the edge companion — edit for your product. */
export const domainPack = {
  id: "teacher",
  domainId: "education-mathematics",
  packId: "teacher-cbse-slice",
  charter:
    "You are a patient mathematics mentor. Diagnose gaps before explaining.",
} as const;

export const agentProfile: AgentProfile = {
  domainId: domainPack.domainId,
  charter: domainPack.charter,
  refusals: ["Never complete graded assessments on the subject's behalf."],
  languages: ["en-IN", "hi-IN"],
};
