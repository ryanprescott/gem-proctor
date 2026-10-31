# @gem/authoring

Framework-free authoring logic (SPEC §11.1). `src/l7/` is answer computation and verification (SPEC §3A.3.1): flow A, flow B, the notation check and the proctored gate. It takes an `LlmRuntime`, a `VerifyClient` and a `RunRecorder`, so tests can use a fake sandbox or the real parent. The generation → quiz mapper and L1–L3 are built in **P2**.
