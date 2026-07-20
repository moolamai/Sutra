/**
 * Android host contract for ONNX mobile memory ceilings.
 *
 * The TypeScript load planner in OnnxSlmRuntime is authoritative for CI;
 * production Android hosts MUST enforce the same refuse-before-materialize
 * rule natively (JNI / ORT session options) so peak RSS never exceeds the
 * mid-range device profile.
 *
 * Do not treat weight file size as the budget — use declared
 * memoryFootprintMiB (peak RSS) from the model card sidecar.
 */
package com.moolam.bindings.slm.onnx

/**
 * Mid-range Android device memory profile (MiB peak RSS ceiling).
 */
data class DeviceMemoryProfile(
  val profileId: String,
  val maxMemoryMiB: Int,
  val hardwareClass: String = "mid-range",
)

/**
 * Result of planning an ONNX session load against the device ceiling.
 */
sealed class LoadPlan {
  data object Allowed : LoadPlan()

  data class Rejected(
    val declaredFootprintMiB: Int,
    val maxMemoryMiB: Int,
    val modelId: String,
    val message: String,
  ) : LoadPlan()
}

object OnnxMemoryLoadPlanner {
  /**
   * Refuse before ORT Session materializes weights when the model's
   * declared peak RSS exceeds the configured ceiling.
   */
  fun plan(
    declaredFootprintMiB: Int,
    maxMemoryMiB: Int,
    modelId: String,
  ): LoadPlan {
    if (declaredFootprintMiB <= 0 || maxMemoryMiB <= 0) {
      return LoadPlan.Rejected(
        declaredFootprintMiB = declaredFootprintMiB,
        maxMemoryMiB = maxMemoryMiB,
        modelId = modelId,
        message = "invalid memory budget (declared=$declaredFootprintMiB max=$maxMemoryMiB)",
      )
    }
    if (declaredFootprintMiB > maxMemoryMiB) {
      return LoadPlan.Rejected(
        declaredFootprintMiB = declaredFootprintMiB,
        maxMemoryMiB = maxMemoryMiB,
        modelId = modelId,
        message =
          "model $modelId memoryFootprintMiB=$declaredFootprintMiB exceeds device ceiling maxMemoryMiB=$maxMemoryMiB",
      )
    }
    return LoadPlan.Allowed
  }
}
