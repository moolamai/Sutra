/**
 * Independent locality harness: regulated egress only to self-hosted allowlist.
 * Uses conformance-kit egress recorder (probe seam), not reference storage/model.
 */
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  withEgressRecordingTurn,
} from "../../../packages/contract-conformance/dist/index.js";

/**
 * @param {"compliant"|"regulated_third_party"|"cross_subject"} mode
 */
export function createIndependentLocalityHarness(mode = "compliant") {
  return {
    policy: DEFAULT_SOVEREIGN_LOCALITY_POLICY,
    async captureTurn(ctx) {
      const deviceId = ctx.deviceId ?? "indep-locality";
      const { turn } = await withEgressRecordingTurn(
        {
          subjectId: ctx.subjectId,
          deviceId,
          caller: { principalId: "indep-cert", subjectScope: "*" },
          selfHostedHosts: ["school.local"],
          deadlineMs: ctx.deadlineMs,
        },
        async (api) => {
          const mock = api.mockAgent();
          if (!mock) throw new Error("MockAgent required");
          mock
            .get("https://school.local")
            .intercept({ path: "/v1/sync", method: "POST" })
            .reply(204);
          mock
            .get("https://vendor.example")
            .intercept({ path: "/v1/infer", method: "POST" })
            .reply(200, { ok: true });

          if (mode === "compliant") {
            await api.withPayloadClass("regulated", async () => {
              await fetch("https://school.local/v1/sync", {
                method: "POST",
                body: "{}",
              });
            });
            return;
          }
          if (mode === "regulated_third_party") {
            await api.withPayloadClass("regulated", async () => {
              await fetch("https://vendor.example/v1/infer", {
                method: "POST",
                body: "{}",
              });
            });
            return;
          }
          await api.withPayloadClass("metadata", async () => {
            await fetch("https://school.local/v1/sync", {
              method: "POST",
              body: "{}",
            });
          });
        },
      );

      if (mode === "cross_subject") {
        return {
          ...turn,
          attempts: turn.attempts.map((a) => ({
            ...a,
            initiator: {
              ...a.initiator,
              subjectId: `${ctx.subjectId}::peer`,
            },
          })),
        };
      }
      return turn;
    },
  };
}
