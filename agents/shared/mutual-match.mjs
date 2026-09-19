function clean(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

export function explainMutualMatch({ candidateSkills, requiredSkills, preferredSkills = [] }) {
  const candidate = clean(candidateSkills);
  const required = clean(requiredSkills);
  const preferred = clean(preferredSkills);
  const known = new Set(candidate.map((skill) => skill.toLowerCase()));
  const matchedRequired = required.filter((skill) => known.has(skill.toLowerCase()));
  const matchedPreferred = preferred.filter((skill) => known.has(skill.toLowerCase()));
  const missingRequired = required.filter((skill) => !known.has(skill.toLowerCase()));
  const requiredCoverage = required.length ? matchedRequired.length / required.length : 1;
  const preferredCoverage = preferred.length ? matchedPreferred.length / preferred.length : 1;
  const score = Math.round((requiredCoverage * 0.8 + preferredCoverage * 0.2) * 100);
  const verdict = score >= 80 && missingRequired.length === 0 ? "strong" : score >= 55 ? "potential" : "weak";
  const reasons = [
    `${matchedRequired.length} of ${required.length} required skills have direct candidate evidence.`,
    `${matchedPreferred.length} of ${preferred.length} preferred skills overlap.`,
    missingRequired.length
      ? `Missing required evidence: ${missingRequired.join(", ")}.`
      : "No required skill gaps were detected.",
  ];
  return {
    score,
    verdict,
    matched_skills: [...matchedRequired, ...matchedPreferred],
    missing_required_skills: missingRequired,
    reasons,
    evidence_basis: "candidate-approved skills compared with employer-published requirements",
  };
}
