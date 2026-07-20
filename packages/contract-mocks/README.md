# @moolam/contract-mocks

Private workspace package: typed in-memory reference implementations of
`@moolam/contracts`. Stage 1 keeps this unpublished pending RFC.

**MOCKPACK-001:** `MemoryInterface`, `ModelInterface`, `ReasoningInterface`.  
**MOCKPACK-002:** `KnowledgeConnectorInterface`, `ToolInterface`, `PlanningInterface`.  
**MOCKPACK-003:** `SpeechInterface`, `VisionInterface`, runtime seams (lifecycle / scheduler / bus / storage).

```ts
import {
  createMemoryMock,
  createModelMock,
  createReasoningMock,
  createKnowledgeMock,
  createToolMock,
  createPlanningMock,
  createSpeechMock,
  createVisionMock,
  createRuntimeMock,
} from "@moolam/contract-mocks";
```

Runtime dependency: `@moolam/contracts` only.
