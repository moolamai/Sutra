/**
 * Egress-recording execution context.
 *
 * Happy path: fetch during a turn is recorded with destination class + binding.
 * Edge: deadline fails hanging turns; concurrent subjects isolate records.
 * Edge: out-of-scope CallerContext denied; payload markers attach without bodies.
 *
 * Run: pnpm --filter @moolam/contract-conformance test
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  EGRESS_INTERCEPTION_SCOPE,
  EgressCallerDeniedError,
  EgressTurnDeadlineError,
  classifyEgressDestination,
  createLoopbackPermitEgressMockAgent,
  isInsideEgressRecordingTurn,
  normalizeEgressHost,
  withEgressRecordingTurn,
} from "../dist/index.js";

test("happy path: records self-hosted and third-party fetch with initiator binding", async () => {
  const events = [];
  const { turn } = await withEgressRecordingTurn(
    {
      subjectId: "anika-k",
      deviceId: "dev-edge-1",
      caller: { principalId: "teacher-1", subjectScope: ["anika-k", "ravi-m"] },
      selfHostedHosts: ["school.local"],
      emit: (e) => events.push(e),
    },
    async (api) => {
      assert.equal(isInsideEgressRecordingTurn(), true);
      const mock = api.mockAgent();
      assert.ok(mock, "default MockAgent must be installed");
      mock
        .get("https://school.local")
        .intercept({ path: "/v1/sync", method: "POST" })
        .reply(204);
      mock
        .get("https://api.openai.example")
        .intercept({ path: "/v1/chat", method: "POST" })
        .reply(200, { ok: true });

      await api.withPayloadClass("cognitive-state", async () => {
        await fetch("https://school.local/v1/sync", {
          method: "POST",
          body: "{}",
        });
      });
      await api.withPayloadClass("model-prompt", async () => {
        await fetch("https://api.openai.example/v1/chat", {
          method: "POST",
          body: "{}",
        });
      });
      return "ok";
    },
  );

  assert.equal(turn.noEgress, false);
  assert.equal(turn.attempts.length, 2);
  assert.equal(turn.attempts[0].destinationClass, "self-hosted");
  assert.equal(turn.attempts[0].destinationHost, "school.local");
  assert.equal(turn.attempts[0].payloadClass, "cognitive-state");
  assert.equal(turn.attempts[0].initiator.subjectId, "anika-k");
  assert.equal(turn.attempts[0].initiator.principalId, "teacher-1");
  assert.equal(turn.attempts[1].destinationClass, "third-party");
  assert.equal(turn.attempts[1].payloadClass, "model-prompt");
  // No path/query — avoid secret leakage in the record.
  assert.equal(turn.attempts[0].destinationOrigin, "https://school.local");
  assert.ok(events.some((e) => e.outcome === "recorded"));
  assert.ok(EGRESS_INTERCEPTION_SCOPE.inScope.length >= 1);
  assert.ok(EGRESS_INTERCEPTION_SCOPE.outOfScope.some((s) => /socket/i.test(s)));
});

test("edge: hanging turn fails with deadline, not infinite hang", async () => {
  await assert.rejects(
    () =>
      withEgressRecordingTurn(
        {
          subjectId: "subj-hang",
          deviceId: "dev-hang",
          caller: { principalId: "ops", subjectScope: "*" },
          deadlineMs: 50,
        },
        async () => {
          await new Promise(() => {
            /* never resolves */
          });
        },
      ),
    (err) => err instanceof EgressTurnDeadlineError,
  );
});

test("edge: concurrent subjects isolate egress records (ALS)", async () => {
  const run = (subjectId, host) =>
    withEgressRecordingTurn(
      {
        subjectId,
        deviceId: `dev-${subjectId}`,
        caller: { principalId: "ops", subjectScope: "*" },
        selfHostedHosts: [host],
      },
      async (api) => {
        const mock = api.mockAgent();
        assert.ok(mock);
        mock
          .get(`https://${host}`)
          .intercept({ path: "/t", method: "GET" })
          .reply(200, "x");
        // Overlap in flight before fetch
        await new Promise((r) => setTimeout(r, 20));
        await fetch(`https://${host}/t`);
        return api.records().map((a) => a.initiator.subjectId);
      },
    );

  const [a, b] = await Promise.all([
    run("subject-a", "a.local"),
    run("subject-b", "b.local"),
  ]);

  assert.deepEqual(a.value, ["subject-a"]);
  assert.deepEqual(b.value, ["subject-b"]);
  assert.equal(a.turn.attempts[0].destinationHost, "a.local");
  assert.equal(b.turn.attempts[0].destinationHost, "b.local");
});

test("edge: CallerContext out of subject scope is denied (sovereignty)", async () => {
  await assert.rejects(
    () =>
      withEgressRecordingTurn(
        {
          subjectId: "anika-k",
          deviceId: "dev-1",
          caller: { principalId: "teacher-1", subjectScope: ["ravi-m"] },
        },
        async () => "nope",
      ),
    (err) => err instanceof EgressCallerDeniedError,
  );
});

test("edge: on-device-shaped turn records zero egress; classify helper", async () => {
  const { turn } = await withEgressRecordingTurn(
    {
      subjectId: "subj-local",
      deviceId: "dev-local",
      caller: { principalId: "ops", subjectScope: "*" },
      selfHostedHosts: ["vault.local"],
    },
    async () => {
      assert.equal(isInsideEgressRecordingTurn(), true);
      return "offline";
    },
  );
  assert.equal(turn.noEgress, true);
  assert.equal(turn.attempts.length, 0);
  assert.equal(
    classifyEgressDestination("vault.local", new Set([normalizeEgressHost("Vault.Local")])),
    "self-hosted",
  );
  assert.equal(
    classifyEgressDestination("evil.example", new Set(["vault.local"])),
    "third-party",
  );
});

test("loopback permit allows real TCP to host:port under egress recording", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const downstream = createLoopbackPermitEgressMockAgent(["127.0.0.1", "localhost"], {
    ports: [port],
  });

  try {
    const { turn } = await withEgressRecordingTurn(
      {
        subjectId: "s1",
        deviceId: "d1",
        caller: { principalId: "p1", subjectScope: "*" },
        selfHostedHosts: ["127.0.0.1"],
        downstream,
      },
      async () => {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(res.status, 200);
        assert.equal(await res.text(), "ok");
        return true;
      },
    );
    assert.equal(turn.attempts.length, 1);
    assert.equal(turn.attempts[0].destinationClass, "self-hosted");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
