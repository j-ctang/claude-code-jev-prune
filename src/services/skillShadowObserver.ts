import { randomUUID } from "node:crypto";
import type { AnthropicRequest } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import type { SkillShadow } from "./skillShadow.js";

/** Advisory shadow lifecycle; failures cannot affect proxy forwarding. */
export class SkillShadowObserver {
  constructor(
    private readonly shadow: SkillShadow,
    private readonly logger: AppLogger,
  ) {}

  observe(request: AnthropicRequest, sessionId: string): ((reply: string) => void) | undefined {
    try {
      for (const finding of this.shadow.observe(request, sessionId)) {
        this.logger.info("skill_shadow_observed", {
          sessionId,
          skill: finding.skill,
          potentialTokens: finding.potentialTokens,
        });
      }
      const revision = this.shadow.revision(sessionId);
      if (!revision) return undefined;
      return (reply) => {
        void this.shadow.complete(sessionId, reply, revision)
          .then((findings) => {
            for (const finding of findings) {
              this.logger.info("skill_shadow_complete", {
                eventId: randomUUID(),
                sessionId,
                skill: finding.skill,
                potentialTokens: finding.potentialTokens,
                confidence: finding.confidence,
              });
            }
          })
          .catch(() => undefined);
      };
    } catch {
      return undefined;
    }
  }
}
