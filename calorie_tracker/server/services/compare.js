const fields = ["calories", "protein", "carbohydrates", "fat"];

function relativeDifference(a, b) {
  if (a == null || b == null) return null;
  const denominator = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / denominator;
}

export function compareFoods(foods) {
  if (!foods.length) {
    return { status: "no-data", confidence: 0, sources: [], nutrientAgreement: {} };
  }

  const agreement = {};
  for (const field of fields) {
    const values = foods
      .map(f => f.nutrients[field])
      .filter(v => Number.isFinite(v));
    if (values.length < 2) {
      agreement[field] = { compared: values.length, maxRelativeDifference: null, status: "insufficient-data" };
      continue;
    }
    let maxDiff = 0;
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        maxDiff = Math.max(maxDiff, relativeDifference(values[i], values[j]));
      }
    }
    agreement[field] = {
      compared: values.length,
      maxRelativeDifference: Math.round(maxDiff * 10000) / 100,
      status: maxDiff <= 0.10 ? "agree" : maxDiff <= 0.25 ? "minor-difference" : "discrepancy"
    };
  }

  const meaningful = Object.values(agreement).filter(x => x.compared >= 2);
  const discrepancies = meaningful.filter(x => x.status === "discrepancy").length;
  const minor = meaningful.filter(x => x.status === "minor-difference").length;
  const confidence = discrepancies ? 40 : minor ? 70 : 90;

  return {
    status: discrepancies ? "discrepancy" : minor ? "minor-difference" : "agreement",
    confidence,
    sources: [...new Set(foods.map(f => f.source))],
    nutrientAgreement: agreement
  };
}
