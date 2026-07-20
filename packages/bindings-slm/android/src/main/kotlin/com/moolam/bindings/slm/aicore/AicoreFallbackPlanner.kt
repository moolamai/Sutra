/**
 * Android host contract for AICore absence → next SlmRuntime candidate.
 *
 * TypeScript authority: planEdgeSlmRuntimeLoad / createAicoreSlmRuntimeCandidate
 * in aicore_seam.ts. Production hosts MUST skip null / unavailable / not-ready
 * AICore results and try the next candidate without crash loops or unbounded
 * retries on a single engine.
 */
package com.moolam.bindings.slm.aicore

enum class EdgeSlmSkipReason {
  NULL,
  UNAVAILABLE,
  ABSENT,
  NOT_READY,
  LOAD_ERROR,
}

data class EdgeSlmSkip(
  val candidateId: String,
  val reason: EdgeSlmSkipReason,
  val detail: String? = null,
)

sealed class EdgeSlmBindResult {
  data class Selected(
    val candidateId: String,
    val skipped: List<EdgeSlmSkip>,
  ) : EdgeSlmBindResult()

  data class Exhausted(
    val skipped: List<EdgeSlmSkip>,
    val message: String,
  ) : EdgeSlmBindResult()
}

fun interface EdgeSlmCandidateFactory {
  /**
   * @return null when this engine cannot bind (equivalent to TS null / unavailable).
   */
  fun createOrNull(): String?
}

object AicoreFallbackPlanner {
  /**
   * Try candidates in order. Null factory results are skipped.
   * Bounded by candidates.size — never retries a single candidate unboundedly.
   */
  fun plan(
    candidates: List<Pair<String, EdgeSlmCandidateFactory>>,
    maxCandidates: Int = candidates.size,
  ): EdgeSlmBindResult {
    require(candidates.isNotEmpty()) { "plan requires candidates" }
    val limit = minOf(candidates.size, maxOf(1, maxCandidates))
    val skipped = mutableListOf<EdgeSlmSkip>()

    for (i in 0 until limit) {
      val (id, factory) = candidates[i]
      val bound =
        try {
          factory.createOrNull()
        } catch (err: Exception) {
          skipped +=
            EdgeSlmSkip(
              candidateId = id,
              reason = EdgeSlmSkipReason.LOAD_ERROR,
              detail = err.message,
            )
          continue
        }
      if (bound == null) {
        skipped += EdgeSlmSkip(candidateId = id, reason = EdgeSlmSkipReason.NULL)
        continue
      }
      return EdgeSlmBindResult.Selected(candidateId = id, skipped = skipped.toList())
    }

    return EdgeSlmBindResult.Exhausted(
      skipped = skipped.toList(),
      message = "no SlmRuntime candidate bound after $limit attempt(s)",
    )
  }

  /**
   * Map AICore capability to skip reason for planner telemetry.
   */
  fun skipReasonFor(capability: AicoreCapability): EdgeSlmSkipReason {
    if (capability.onDeviceGenerationAvailable) {
      throw IllegalArgumentException("capable AICore is not a skip")
    }
    return when (capability.absenceReason) {
      AicoreAbsenceReason.MODEL_DOWNLOADING -> EdgeSlmSkipReason.NOT_READY
      AicoreAbsenceReason.AICORE_ABSENT,
      AicoreAbsenceReason.NO_COMPATIBLE_MODEL,
      AicoreAbsenceReason.UNSUPPORTED_PLATFORM,
      null,
      -> EdgeSlmSkipReason.ABSENT
    }
  }
}
