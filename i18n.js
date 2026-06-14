// Simple heuristic language detection
export function detectLang(text) {
  if (!text) return "en";
  const hebrewChars = (text.match(/[\u0590-\u05FF]/g) || []).length;
  return hebrewChars > 0 ? "he" : "en";
}

export function t(obj, lang) {
  // obj can be { en: "...", he: "..." } or a plain string
  if (typeof obj === "string") return obj;
  return obj?.[lang] ?? obj?.en ?? "";
}
