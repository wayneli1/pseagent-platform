import { describe, expect, it, vi } from "vitest";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import {
  HighRiskConsensusGate,
  consensusClaimSignature,
} from "./high-risk-consensus.js";
import type { BoundClaim, ClaimSupportDecision } from "./structured-claim.js";
import { hashClaimText } from "./structured-claim.js";

const claims: readonly BoundClaim[] = [
  {
    claimId: "CL1",
    obligationId: "O1",
    domain: "coremail-professional",
    text: "当前正式版本支持受控审计。",
    kind: "fact",
    citationIndexes: [1],
    coveredAspectIds: ["A1"],
    support: "direct",
    evidenceIdentities: ["a".repeat(64)],
  },
  {
    claimId: "CL2",
    obligationId: "O2",
    domain: "presales-general",
    text: "可以写入无条件合同承诺。",
    kind: "boundary",
    citationIndexes: [2],
    coveredAspectIds: ["A1"],
    support: "direct",
    evidenceIdentities: ["b".repeat(64)],
  },
];

const firstVerdicts: readonly ClaimSupportDecision[] = claims.map((claim) => ({
  claimId: claim.claimId,
  claimHash: hashClaimText(claim.text),
  citationIndexes: claim.citationIndexes,
  verdict: "supported",
}));

function modelReturning(verdicts: readonly ("supported" | "insufficient")[]): ModelClient {
  return {
    completeJson: vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) =>
      input.schema.parse({ verdicts: claims.map((claim, index) => ({
        claimId: claim.claimId,
        claimHash: consensusClaimSignature(claim),
        citationIndexes: claim.citationIndexes,
        verdict: verdicts[index] ?? "insufficient",
      })) })),
    completeText: vi.fn(),
  } as unknown as ModelClient;
}

describe("high-risk consensus gate", () => {
  it("retries one invalid structured verdict without selecting among valid answers", async () => {
    const secondVerifier = modelReturning(["supported", "supported"]);
    vi.mocked(secondVerifier.completeJson).mockRejectedValueOnce(
      new InvalidModelPayloadError(
        "invalid_schema:verdicts:required",
        undefined,
        "pse_high_risk_consensus_verdicts",
      ),
    );
    const onModelAttempt = vi.fn();

    const result = await new HighRiskConsensusGate().evaluate({
      claims,
      firstVerdicts,
      firstVerifier: modelReturning(["supported", "supported"]),
      secondVerifier,
      firstModelId: "same-model",
      secondModelId: "same-model",
      signal: new AbortController().signal,
      onModelAttempt,
    });

    expect(result.retainedClaimIds).toEqual(["CL1", "CL2"]);
    expect(secondVerifier.completeJson).toHaveBeenCalledTimes(2);
    expect(onModelAttempt).toHaveBeenCalledTimes(2);
  });

  it("publishes only the exact-signature intersection supported by both verdicts", async () => {
    const gate = new HighRiskConsensusGate();
    const secondVerifier = modelReturning(["supported", "insufficient"]);

    const result = await gate.evaluate({
      claims,
      firstVerdicts,
      firstVerifier: modelReturning(["supported", "supported"]),
      secondVerifier,
      firstModelId: "verifier-a",
      secondModelId: "verifier-b",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      mode: "independent_models",
      retainedClaimIds: ["CL1"],
      rejectedClaimIds: ["CL2"],
      agreed: false,
    });
    expect(secondVerifier.completeJson).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({
        content: expect.stringContaining('{"verdicts":[...]}'),
      })]),
    }));
    const inputMessage = vi.mocked(secondVerifier.completeJson).mock.calls[0]![0]
      .messages[1]!.content;
    expect(inputMessage).toContain("禁止复制输入");
    expect(inputMessage.trimStart().startsWith("{")).toBe(false);
  });

  it("rejects a verdict that changes the claim signature or citation set", async () => {
    const secondVerifier = modelReturning(["supported", "supported"]);
    vi.mocked(secondVerifier.completeJson).mockResolvedValueOnce({ verdicts: [
      {
        claimId: "CL1",
        claimHash: "f".repeat(64),
        citationIndexes: [1],
        verdict: "supported",
      },
      {
        claimId: "CL2",
        claimHash: consensusClaimSignature(claims[1]!),
        citationIndexes: [1, 2],
        verdict: "supported",
      },
    ] } as never);

    const result = await new HighRiskConsensusGate().evaluate({
      claims,
      firstVerdicts,
      firstVerifier: modelReturning(["supported", "supported"]),
      secondVerifier,
      firstModelId: "same-model",
      secondModelId: "same-model",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      mode: "repeated_same_model",
      retainedClaimIds: [],
      rejectedClaimIds: ["CL1", "CL2"],
      agreed: false,
    });
  });

  it("fails closed when the second verdict times out", async () => {
    const secondVerifier = {
      completeJson: vi.fn(async (): Promise<never> =>
        await new Promise<never>(() => undefined)),
      completeText: vi.fn(),
    } as unknown as ModelClient;

    const result = await new HighRiskConsensusGate().evaluate({
      claims,
      firstVerdicts,
      firstVerifier: modelReturning(["supported", "supported"]),
      secondVerifier,
      firstModelId: "verifier-a",
      secondModelId: "verifier-b",
      signal: AbortSignal.timeout(10),
    });

    expect(result.retainedClaimIds).toEqual([]);
    expect(result.rejectedClaimIds).toEqual(["CL1", "CL2"]);
  });
});
