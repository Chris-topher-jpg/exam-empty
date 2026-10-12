import { sanitizeResultDetails } from "./exam-engine.js";

export function resultResponse(result, detailLevel = "none", passScore = 85) {
  const value = {
    id: result.id,
    candidateName: result.candidateName,
    candidateId: result.candidateId,
    attemptNumber: result.attemptNumber,
    automaticScore: result.automaticScore,
    finalScore: result.finalScore,
    passed: result.passed,
    passScore,
    submittedAt: result.submittedAt,
    certificateId: result.certificateId || null,
    reviewNote: result.reviewNote || "",
  };
  if (detailLevel === "candidate") value.details = sanitizeResultDetails(result.details);
  if (detailLevel === "admin") value.details = result.details;
  return value;
}
