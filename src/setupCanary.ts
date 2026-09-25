export interface CanaryCandidate {
  file: string;
  prefix: string;
}

/** Suggests explicit, quoted response prefixes; the user must confirm them. */
export function findCanaryCandidates(
  content: string,
  file: string,
): CanaryCandidate[] {
  const candidates: CanaryCandidate[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (
      !/\b(?:start|begin|prefix)\b/i.test(line) ||
      !/\b(?:reply|replies|response|responses|message|messages)\b/i.test(line)
    )
      continue;
    const match = /\bwith\s+[`"'“]([^`"'”\r\n]{1,50})[`"'”]/i.exec(line);
    const prefix = match?.[1]?.trim();
    if (
      prefix &&
      !candidates.some((item) => item.file === file && item.prefix === prefix)
    ) {
      candidates.push({ file, prefix });
    }
  }
  return candidates;
}
