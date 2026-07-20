/**
 * MLX + Metal host contract for Apple silicon.
 *
 * TypeScript MlxSlmRuntime is authoritative in CI via the in-process Metal
 * stand-in. Production macOS hosts inject a real MLX/Metal backend that
 * honors the same load / generate / generateStream / deadline surface.
 *
 * Streaming: yield incremental token deltas (CK-03.2), never cumulative frames.
 * Deadline: race Task cancellation / deadlineMs — never hang the harness.
 * Intel Macs MUST fail load with a typed unsupported-platform error.
 */
import Foundation

public struct MlxModelCard: Codable, Sendable {
  public let modelId: String
  public let contextWindow: Int
  public let quantization: String
  public let memoryFootprintMiB: Int
  /// BCP-47 languages the export supports.
  public let languages: [String]
  public let embedDim: Int
  public let metalRequired: Bool
}

public struct MlxGenerateResult: Sendable {
  public let text: String
  public let tokensEmitted: Int
  public let deadlineHit: Bool
}

/// Cooperative cancel token passed into Metal work (AbortSignal equivalent).
public final class MlxCancelToken: @unchecked Sendable {
  private let lock = NSLock()
  private var _cancelled = false

  public var isCancelled: Bool {
    lock.lock(); defer { lock.unlock() }
    return _cancelled
  }

  public func cancel() {
    lock.lock(); defer { lock.unlock() }
    _cancelled = true
  }
}

public protocol MlxMetalBackend: Sendable {
  func load(weightsURL: URL, card: MlxModelCard) async throws -> OpaquePointer
  func unload(_ handle: OpaquePointer) async

  /// Single-shot generate. MUST race `cancel` / deadlineMs and set deadlineHit.
  func generate(
    _ handle: OpaquePointer,
    prompt: String,
    maxTokens: Int,
    deadlineMs: Int,
    cancel: MlxCancelToken
  ) async throws -> MlxGenerateResult

  /**
   * Stream incremental token deltas (new text only).
   * Stop promptly when `cancel` is signalled or deadlineMs elapses.
   */
  func generateStream(
    _ handle: OpaquePointer,
    prompt: String,
    maxTokens: Int,
    deadlineMs: Int,
    cancel: MlxCancelToken
  ) -> AsyncThrowingStream<String, Error>

  func embed(_ handle: OpaquePointer, text: String) async throws -> [Float]
}

public enum MlxPlatformError: Error, CustomStringConvertible {
  case unsupportedPlatform(detail: String)

  public var description: String {
    switch self {
    case .unsupportedPlatform(let detail):
      return "unsupported_platform: \(detail)"
    }
  }
}

public enum MlxPlatformProbe {
  /// Apple silicon only (arm64 + macOS).
  public static func assertSupported() throws {
    #if os(macOS) && arch(arm64)
      return
    #else
      throw MlxPlatformError.unsupportedPlatform(
        detail: "MLX/Metal requires Apple silicon (darwin/arm64)"
      )
    #endif
  }
}
