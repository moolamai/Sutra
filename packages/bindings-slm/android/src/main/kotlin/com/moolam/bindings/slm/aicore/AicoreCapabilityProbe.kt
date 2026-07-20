/**
 * Android host contract for AICore / MediaPipe LLM capability probing.
 *
 * The TypeScript seam in AicoreSlmRuntime is authoritative for CI; production
 * Android hosts MUST implement the same side-effect-free probe (no session
 * materialization, no download kickoff inside probe) and return typed absence
 * when AICore is missing or no compatible model is ready.
 */
package com.moolam.bindings.slm.aicore

enum class AicoreMemoryClass {
  ABSENT,
  LOW,
  MID,
  HIGH,
}

enum class AicoreModelReadiness {
  READY,
  DOWNLOADING,
  UNAVAILABLE,
}

enum class AicoreAbsenceReason {
  AICORE_ABSENT,
  NO_COMPATIBLE_MODEL,
  MODEL_DOWNLOADING,
  UNSUPPORTED_PLATFORM,
}

data class AicoreModelDescriptor(
  val modelId: String,
  val contextWindow: Int,
  val memoryClass: AicoreMemoryClass,
  val memoryFootprintMiB: Int,
  val quantization: String,
  val languages: List<String>,
  val embedDim: Int,
  val readiness: AicoreModelReadiness,
)

/**
 * Truthful capability surface — safe to call before any load().
 */
data class AicoreCapability(
  val aicorePresent: Boolean,
  val onDeviceGenerationAvailable: Boolean,
  val memoryClass: AicoreMemoryClass,
  val models: List<AicoreModelDescriptor>,
  val absenceReason: AicoreAbsenceReason? = null,
  val detail: String? = null,
)

/**
 * Side-effect-free probe of AICore system models.
 * Implementations MUST NOT start downloads or open inference sessions.
 */
fun interface AicoreCapabilityProbe {
  fun probe(): AicoreCapability
}

object AicoreCapabilitySnapshots {
  fun absent(detail: String = "AICore / MediaPipe LLM API not present"): AicoreCapability =
    AicoreCapability(
      aicorePresent = false,
      onDeviceGenerationAvailable = false,
      memoryClass = AicoreMemoryClass.ABSENT,
      models = emptyList(),
      absenceReason = AicoreAbsenceReason.AICORE_ABSENT,
      detail = detail,
    )

  fun downloading(model: AicoreModelDescriptor): AicoreCapability =
    AicoreCapability(
      aicorePresent = true,
      onDeviceGenerationAvailable = false,
      memoryClass = model.memoryClass,
      models = listOf(model.copy(readiness = AicoreModelReadiness.DOWNLOADING)),
      absenceReason = AicoreAbsenceReason.MODEL_DOWNLOADING,
      detail = "AICore model still downloading",
    )
}
